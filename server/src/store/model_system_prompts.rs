//! Persists model system prompts and immutable per-conversation choices.
use std::collections::BTreeMap;

use sqlx::{Executor, Row, Sqlite, SqliteConnection};

use crate::{
    model::{ConversationId, ModelSystemPromptConfig, ModelSystemPromptSettings},
    Error, Result,
};

use super::{now_ms, Store};

impl Store {
    pub async fn import_missing_system_prompts(
        &self,
        configs: &[ModelSystemPromptConfig],
    ) -> Result<()> {
        ModelSystemPromptConfig::validate_all(configs)?;
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        for config in configs {
            insert_missing(&mut tx, config).await?;
        }
        tx.commit().await?;
        session.committed();
        Ok(())
    }
    pub async fn conversation_system_prompt(
        &self,
        conversation_id: &ConversationId,
        model_id: &str,
        mode: &str,
        base: &str,
        recovered_root: Option<&str>,
        default_roots: &BTreeMap<String, String>,
    ) -> Result<String> {
        if model_id.trim().is_empty() || !default_roots.contains_key(mode) || mode == "compaction" {
            return Err(Error::Config(format!("system prompt snapshot requires a model and a conversation mode: {model_id}/{mode}")));
        }
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        let current = Self::ensure_conversation_tx(&mut transaction, conversation_id).await?;
        let rows = sqlx::query(
            "SELECT model_id, settings_json, instructions_json FROM conversation_system_prompts
             WHERE conversation_id = ? ORDER BY model_id",
        )
        .bind(conversation_id.as_str())
        .fetch_all(&mut *transaction)
        .await?;
        let mut snapshots = BTreeMap::new();
        for row in rows {
            let settings: ModelSystemPromptSettings =
                serde_json::from_str(row.try_get::<&str, _>("settings_json")?)?;
            settings.validate()?;
            let instructions: BTreeMap<String, String> =
                serde_json::from_str(row.try_get::<&str, _>("instructions_json")?)?;
            if instructions.is_empty() {
                return Err(Error::Protocol(format!(
                    "conversation system prompt snapshot has no instructions: {}",
                    conversation_id.as_str()
                )));
            }
            snapshots.insert(
                row.try_get::<String, _>("model_id")?,
                (settings, instructions),
            );
        }
        if let Some(root) = recovered_root {
            let known = snapshots
                .values()
                .any(|(_, instructions)| instructions.values().any(|text| text == root));
            let prior_default = snapshots.is_empty()
                && default_roots
                    .values()
                    .any(|text| is_default_root(text, root));
            if !known && !prior_default {
                return Err(Error::Protocol(format!(
                    "Cursor system prompt root is not bound to conversation {}; start a new conversation",
                    conversation_id.as_str()
                )));
            }
        }
        let existed = snapshots.contains_key(model_id);
        let (settings, mut instructions) = match snapshots.remove(model_id) {
            Some(snapshot) => snapshot,
            None => {
                let has_history: bool = sqlx::query_scalar(
                    "SELECT EXISTS(SELECT 1 FROM checkpoint_messages WHERE checkpoint_id = ?)",
                )
                .bind(current.0)
                .fetch_one(&mut *transaction)
                .await?;
                // A pre-feature conversation has no adopted configuration. Its
                // returned default root is evidence of a disabled prompt, not
                // permission to append whatever was edited most recently.
                let settings = if snapshots.is_empty() && (has_history || recovered_root.is_some())
                {
                    ModelSystemPromptSettings::default()
                } else {
                    read_settings(&mut *transaction, model_id).await?
                };
                let mut instructions = BTreeMap::new();
                if snapshots.is_empty() {
                    if let Some(root) = recovered_root {
                        for (prior_mode, prior_default) in default_roots {
                            if is_default_root(prior_default, root) {
                                instructions.insert(prior_mode.clone(), root.to_owned());
                            }
                        }
                    }
                }
                (settings, instructions)
            }
        };
        let effective = match instructions.get(mode) {
            Some(text) => text.clone(),
            None => {
                let text = settings.instructions(base)?;
                instructions.insert(mode.into(), text.clone());
                text
            }
        };
        let encoded = serde_json::to_string(&instructions)?;
        if existed {
            sqlx::query(
                "UPDATE conversation_system_prompts SET instructions_json = ?
                 WHERE conversation_id = ? AND model_id = ?",
            )
            .bind(encoded)
            .bind(conversation_id.as_str())
            .bind(model_id)
            .execute(&mut *transaction)
            .await?;
        } else {
            sqlx::query(
                "INSERT INTO conversation_system_prompts
                 (conversation_id, model_id, settings_json, instructions_json, created_at_ms)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(conversation_id.as_str())
            .bind(model_id)
            .bind(serde_json::to_string(&settings)?)
            .bind(encoded)
            .bind(now_ms())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        session.committed();
        Ok(effective)
    }

    pub async fn model_system_prompt(&self, model_id: &str) -> Result<ModelSystemPromptSettings> {
        read_settings(&self.pool, model_id).await
    }

    pub async fn model_system_prompts(&self) -> Result<Vec<ModelSystemPromptConfig>> {
        let rows = sqlx::query(
            "SELECT model_id, enabled, content, position FROM model_system_prompts ORDER BY model_id",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let model_id = row.try_get("model_id")?;
                Ok(ModelSystemPromptConfig {
                    model_id,
                    settings: settings_from_row(row)?,
                })
            })
            .collect()
    }

    pub async fn set_model_system_prompt(
        &self,
        model_id: &str,
        settings: &ModelSystemPromptSettings,
    ) -> Result<ModelSystemPromptSettings> {
        self.set_model_system_prompts(&[ModelSystemPromptConfig {
            model_id: model_id.into(),
            settings: settings.clone(),
        }])
        .await?;
        Ok(settings.clone())
    }

    pub async fn set_model_system_prompts(
        &self,
        configs: &[ModelSystemPromptConfig],
    ) -> Result<()> {
        ModelSystemPromptConfig::validate_all(configs)?;
        if configs.is_empty() {
            return Ok(());
        }
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        for config in configs {
            sqlx::query(
                "INSERT INTO model_system_prompts(model_id, enabled, content, position, updated_at_ms)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(model_id) DO UPDATE SET enabled = excluded.enabled,
                     content = excluded.content, position = excluded.position,
                     updated_at_ms = excluded.updated_at_ms",
            )
            .bind(&config.model_id)
            .bind(config.settings.enabled)
            .bind(&config.settings.content)
            .bind(config.settings.position.as_str())
            .bind(now_ms())
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        session.committed();
        Ok(())
    }
}

fn is_default_root(default: &str, root: &str) -> bool {
    // Checkout line endings are not user configuration. Only the comparison
    // is normalized; the recovered instruction bytes stay untouched.
    default.replace("\r\n", "\n") == root.replace("\r\n", "\n")
}

async fn read_settings<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    model_id: &str,
) -> Result<ModelSystemPromptSettings> {
    let row = sqlx::query(
        "SELECT enabled, content, position FROM model_system_prompts WHERE model_id = ?",
    )
    .bind(model_id)
    .fetch_optional(executor)
    .await?;
    row.map(settings_from_row)
        .transpose()
        .map(Option::unwrap_or_default)
}

fn settings_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelSystemPromptSettings> {
    let settings: ModelSystemPromptSettings = serde_json::from_value(serde_json::json!({
        "enabled": row.try_get::<bool, _>("enabled")?,
        "content": row.try_get::<String, _>("content")?,
        "position": row.try_get::<String, _>("position")?,
    }))?;
    settings.validate()?;
    Ok(settings)
}

pub(super) async fn remove(transaction: &mut SqliteConnection, model_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM model_system_prompts WHERE model_id = ?")
        .bind(model_id)
        .execute(transaction)
        .await?;
    Ok(())
}

pub(super) async fn insert_missing(
    tx: &mut SqliteConnection,
    config: &ModelSystemPromptConfig,
) -> Result<()> {
    sqlx::query("INSERT INTO model_system_prompts(model_id, enabled, content, position, updated_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(model_id) DO NOTHING")
        .bind(&config.model_id).bind(config.settings.enabled).bind(&config.settings.content)
        .bind(config.settings.position.as_str()).bind(now_ms()).execute(tx).await?;
    Ok(())
}
