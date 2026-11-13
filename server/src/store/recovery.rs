//! Settles calls owned by an exited process without discarding resumable conversation checkpoints.
use super::{now_ms, Store};
use crate::Result;

impl Store {
    pub async fn settle_interrupted_calls(&self) -> Result<()> {
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        let now = now_ms();
        sqlx::query("UPDATE llm_calls SET status='cancelled', finished_at_ms=?, duration_ms=MAX(0, ?-created_at_ms), error_kind='process_interrupted', error_message='previous process exited before the call finished' WHERE status='running'")
            .bind(now).bind(now).execute(&mut *tx).await?;
        sqlx::query("UPDATE runs SET status='cancelled', updated_at_ms=? WHERE status='running'")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE cursor_run_traces SET status='cancelled', finished_at_ms=?, error_message='previous process exited before the request finished' WHERE status='running'")
            .bind(now).execute(&mut *tx).await?;
        // finish_run is what normally drops this pointer. A run cancelled above
        // never reaches it, so the conversation would still claim a dead owner.
        sqlx::query("UPDATE conversations SET active_run_id = NULL, updated_at_ms = ? WHERE active_run_id IS NOT NULL AND active_run_id IN (SELECT run_id FROM runs WHERE status = 'cancelled')")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        session.committed();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interrupted_run_releases_conversation_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversations(conversation_id, updated_at_ms) VALUES ('live', 1), ('done', 1)",
        )
        .execute(store.pool())
        .await
        .unwrap();
        let live: i64 = sqlx::query_scalar(
            "INSERT INTO conversation_checkpoints(conversation_id, parent_checkpoint_id, state_digest, created_at_ms)
             VALUES ('live', NULL, ?, 1) RETURNING checkpoint_id",
        )
        .bind(vec![0_u8; 32])
        .fetch_one(store.pool())
        .await
        .unwrap();
        let done: i64 = sqlx::query_scalar(
            "INSERT INTO conversation_checkpoints(conversation_id, parent_checkpoint_id, state_digest, created_at_ms)
             VALUES ('done', NULL, ?, 1) RETURNING checkpoint_id",
        )
        .bind(vec![1_u8; 32])
        .fetch_one(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO runs(run_id, conversation_id, base_checkpoint_id, head_checkpoint_id, run_kind, status, created_at_ms, updated_at_ms)
             VALUES ('run-live', 'live', ?, ?, 'primary', 'running', 1, 1),
                    ('run-done', 'done', ?, ?, 'primary', 'completed', 1, 1)",
        )
        .bind(live)
        .bind(live)
        .bind(done)
        .bind(done)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE conversations SET current_checkpoint_id = ?, active_run_id = 'run-live' WHERE conversation_id = 'live'",
        )
        .bind(live)
        .execute(store.pool())
        .await
        .unwrap();
        sqlx::query(
            "UPDATE conversations SET current_checkpoint_id = ?, active_run_id = 'run-done' WHERE conversation_id = 'done'",
        )
        .bind(done)
        .execute(store.pool())
        .await
        .unwrap();

        store.settle_interrupted_calls().await.unwrap();

        let live: Option<String> = sqlx::query_scalar(
            "SELECT active_run_id FROM conversations WHERE conversation_id = 'live'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM runs WHERE run_id = 'run-live'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        let kept: Option<String> = sqlx::query_scalar(
            "SELECT active_run_id FROM conversations WHERE conversation_id = 'done'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(status, "cancelled");
        assert_eq!(live, None);
        assert_eq!(kept.as_deref(), Some("run-done"));
    }
}
