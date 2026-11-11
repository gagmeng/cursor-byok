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
        tx.commit().await?;
        session.committed();
        Ok(())
    }
}
