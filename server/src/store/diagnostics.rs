//! Persists connection evidence and capability results and aggregates model health.
use super::{now_ms, Store};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionDiagnostic {
    pub diagnostic_id: String,
    pub scope: String,
    pub marker: String,
    pub created_at_ms: i64,
    pub request_id: Option<String>,
    pub conversation_id: Option<String>,
    pub request_seen_at_ms: Option<i64>,
    pub stream_seen_at_ms: Option<i64>,
    pub upstream_response_at_ms: Option<i64>,
    pub tool_result_at_ms: Option<i64>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityResult {
    pub model_id: String,
    pub capability: String,
    pub status: String,
    pub tested_at_ms: i64,
    pub duration_ms: i64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelHealth {
    pub model_id: String,
    pub completed: i64,
    pub failed: i64,
    pub cancelled: i64,
    pub running: i64,
    pub success_rate: Option<f64>,
    pub average_first_response_ms: Option<f64>,
    pub tokens_per_second: Option<f64>,
    pub last_call_at_ms: i64,
    pub last_error: Option<String>,
}

impl Store {
    pub async fn invalidate_plugin_capabilities(&self, plugin_id: &str) -> Result<()> {
        let prefix = format!("plugin:{plugin_id}/");
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        sqlx::query("UPDATE model_capability_revisions SET revision=revision+1 WHERE substr(model_id,1,length(?))=?").bind(&prefix).bind(&prefix).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM model_capability_tests WHERE substr(model_id,1,length(?))=?")
            .bind(&prefix)
            .bind(&prefix)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        session.committed();
        Ok(())
    }
    pub async fn capability_revision(&self, model_id: &str) -> Result<i64> {
        let _write = self.writes.lock().await;
        if !model_id.starts_with(crate::plugin::ADAPTER_ID_PREFIX)
            && self.model(model_id).await?.is_none()
        {
            return Err(Error::Config(format!(
                "capability test model does not exist: {model_id}"
            )));
        }
        sqlx::query(
            "INSERT OR IGNORE INTO model_capability_revisions(model_id, revision) VALUES (?, 0)",
        )
        .bind(model_id)
        .execute(&self.pool)
        .await?;
        Ok(
            sqlx::query_scalar("SELECT revision FROM model_capability_revisions WHERE model_id=?")
                .bind(model_id)
                .fetch_one(&self.pool)
                .await?,
        )
    }

    pub async fn save_current_capability_result(
        &self,
        result: &CapabilityResult,
        revision: i64,
    ) -> Result<bool> {
        let _write = self.writes.lock().await;
        let saved = sqlx::query("INSERT INTO model_capability_tests(model_id, capability, status, tested_at_ms, duration_ms, detail) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM model_capability_revisions WHERE model_id=? AND revision=?) ON CONFLICT(model_id, capability) DO UPDATE SET status=excluded.status, tested_at_ms=excluded.tested_at_ms, duration_ms=excluded.duration_ms, detail=excluded.detail")
            .bind(&result.model_id).bind(&result.capability).bind(&result.status).bind(result.tested_at_ms).bind(result.duration_ms).bind(&result.detail).bind(&result.model_id).bind(revision).execute(&self.pool).await?;
        Ok(saved.rows_affected() == 1)
    }

    pub async fn start_connection_diagnostic(&self, scope: &str) -> Result<ConnectionDiagnostic> {
        if !matches!(scope, "local" | "ssh") {
            return Err(Error::Config(format!(
                "diagnostic scope must be local or ssh: {scope}"
            )));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let marker = format!("BYOK_DIAGNOSTIC_{}", id.replace('-', ""));
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        sqlx::query("INSERT INTO connection_diagnostics(diagnostic_id, scope, marker, created_at_ms) VALUES (?, ?, ?, ?)")
            .bind(&id).bind(scope).bind(&marker).bind(now_ms()).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM connection_diagnostics WHERE diagnostic_id NOT IN (SELECT diagnostic_id FROM connection_diagnostics ORDER BY created_at_ms DESC, rowid DESC LIMIT 10)")
            .execute(&mut *tx).await?;
        tx.commit().await?;
        session.committed();
        self.connection_diagnostic_sessions()
            .await?
            .into_iter()
            .find(|s| s.diagnostic_id == id)
            .ok_or_else(|| {
                Error::Store("new connection diagnostic was removed before it could be read".into())
            })
    }

    pub async fn observe_diagnostic_request(
        &self,
        request_id: &str,
        conversation_id: &str,
        payload: &[u8],
    ) -> Result<()> {
        let candidates: Vec<(String, String)> = sqlx::query_as("SELECT diagnostic_id, marker FROM connection_diagnostics WHERE request_id IS NULL AND created_at_ms >= ?")
            .bind(now_ms() - 15 * 60_000).fetch_all(&self.pool).await?;
        for (id, marker) in candidates {
            if payload
                .windows(marker.len())
                .any(|part| part == marker.as_bytes())
            {
                let _write = self.writes.lock().await;
                sqlx::query("UPDATE connection_diagnostics SET request_id = ?, conversation_id = ?, request_seen_at_ms = ? WHERE diagnostic_id = ? AND request_id IS NULL")
                    .bind(request_id).bind(conversation_id).bind(now_ms()).bind(id).execute(&self.pool).await?;
            }
        }
        Ok(())
    }

    pub async fn observe_diagnostic_stream(&self, request_id: &str) -> Result<()> {
        let _write = self.writes.lock().await;
        sqlx::query("UPDATE connection_diagnostics SET stream_seen_at_ms = COALESCE(stream_seen_at_ms, ?) WHERE request_id = ?")
            .bind(now_ms()).bind(request_id).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn connection_diagnostic_sessions(&self) -> Result<Vec<ConnectionDiagnostic>> {
        let rows = sqlx::query("SELECT d.diagnostic_id, d.scope, d.marker, d.created_at_ms, d.request_id, d.conversation_id, d.request_seen_at_ms, d.stream_seen_at_ms,
            (SELECT MAX(c.first_valid_response_at_ms) FROM llm_calls c JOIN runs r USING(run_id) WHERE r.cursor_request_id = d.request_id) AS upstream_response_at_ms,
            (SELECT MAX(tc.completed_at_ms) FROM tool_round_calls tc JOIN tool_rounds tr USING(round_id) JOIN runs r USING(run_id)
              WHERE r.cursor_request_id = d.request_id AND tc.status = 'completed' AND tc.result_is_error = 0 AND instr(tc.result_content, d.marker) > 0) AS tool_result_at_ms,
            (SELECT c.error_message FROM llm_calls c JOIN runs r USING(run_id) WHERE r.cursor_request_id = d.request_id AND c.error_message IS NOT NULL ORDER BY c.created_at_ms DESC LIMIT 1) AS error_message
            FROM connection_diagnostics d ORDER BY d.created_at_ms DESC, d.rowid DESC")
            .fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                Ok(ConnectionDiagnostic {
                    diagnostic_id: r.try_get("diagnostic_id")?,
                    scope: r.try_get("scope")?,
                    marker: r.try_get("marker")?,
                    created_at_ms: r.try_get("created_at_ms")?,
                    request_id: r.try_get("request_id")?,
                    conversation_id: r.try_get("conversation_id")?,
                    request_seen_at_ms: r.try_get("request_seen_at_ms")?,
                    stream_seen_at_ms: r.try_get("stream_seen_at_ms")?,
                    upstream_response_at_ms: r.try_get("upstream_response_at_ms")?,
                    tool_result_at_ms: r.try_get("tool_result_at_ms")?,
                    error_message: r.try_get("error_message")?,
                })
            })
            .collect()
    }

    pub async fn capability_results(&self) -> Result<Vec<CapabilityResult>> {
        sqlx::query("SELECT model_id, capability, status, tested_at_ms, duration_ms, detail FROM model_capability_tests ORDER BY model_id, capability")
            .fetch_all(&self.pool).await?.into_iter().map(|r| Ok(CapabilityResult { model_id:r.try_get("model_id")?, capability:r.try_get("capability")?, status:r.try_get("status")?, tested_at_ms:r.try_get("tested_at_ms")?, duration_ms:r.try_get("duration_ms")?, detail:r.try_get("detail")? })).collect()
    }

    pub async fn model_health(&self) -> Result<Vec<ModelHealth>> {
        let rows = sqlx::query("SELECT c.model_hash AS model_id,
            SUM(c.status = 'completed') AS completed, SUM(c.status NOT IN ('completed','running','cancelled')) AS failed,
            SUM(c.status = 'cancelled') AS cancelled, SUM(c.status = 'running') AS running,
            AVG(CASE WHEN c.status = 'completed' THEN c.ttfr_ms END) AS first_response,
            SUM(CASE WHEN c.status='completed' AND c.output_tokens > 0 AND c.duration_ms > COALESCE(c.ttfr_ms, 0) THEN c.output_tokens END) * 1000.0 /
            NULLIF(SUM(CASE WHEN c.status='completed' AND c.output_tokens > 0 AND c.duration_ms > COALESCE(c.ttfr_ms,0) THEN c.duration_ms - COALESCE(c.ttfr_ms,0) END), 0) AS speed,
            MAX(c.created_at_ms) AS last_call,
            (SELECT e.error_message FROM llm_calls e WHERE e.model_hash=c.model_hash AND e.status NOT IN ('completed','running','cancelled') AND e.created_at_ms >= ? AND e.call_id NOT LIKE 'capability-%' AND e.call_id NOT LIKE 'model-test-%' ORDER BY e.created_at_ms DESC LIMIT 1) AS last_error
            FROM llm_calls c WHERE c.model_hash IS NOT NULL AND c.created_at_ms >= ? AND c.call_id NOT LIKE 'capability-%' AND c.call_id NOT LIKE 'model-test-%'
            GROUP BY c.model_hash ORDER BY last_call DESC")
            .bind(now_ms()-7*86_400_000).bind(now_ms()-7*86_400_000).fetch_all(&self.pool).await?;
        rows.into_iter()
            .map(|r| {
                let completed: i64 = r.try_get("completed")?;
                let failed: i64 = r.try_get("failed")?;
                Ok(ModelHealth {
                    model_id: r.try_get("model_id")?,
                    completed,
                    failed,
                    cancelled: r.try_get("cancelled")?,
                    running: r.try_get("running")?,
                    success_rate: (completed + failed > 0)
                        .then(|| completed as f64 / (completed + failed) as f64),
                    average_first_response_ms: r.try_get("first_response")?,
                    tokens_per_second: r.try_get("speed")?,
                    last_call_at_ms: r.try_get("last_call")?,
                    last_error: r.try_get("last_error")?,
                })
            })
            .collect()
    }
}
