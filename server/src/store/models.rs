//! Persists model and provider configuration.
use std::{collections::HashSet, str::FromStr};

use sqlx::{Row, SqliteConnection};

use crate::{
    model::{
        magpie_model_identity, model_hash, normalize_model_input, ModelConfig, ModelConfigInput,
        ModelType,
    },
    Error, Result,
};

use super::{now_ms, Store};

const MODEL_COLUMNS: &str = r#"
    model_hash, sort_order, display_name, group_name, fallback_model_hash, model_type, base_url, use_full_url, api_key, tooltip_data,
    model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
    openai_extra_params_json, custom_headers_enabled, custom_headers_json,
    anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
    max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
    thinking_budget_tokens, created_at_ms, updated_at_ms
"#;

impl Store {
    pub async fn import_model_configuration(
        &self,
        models: &[(String, ModelConfigInput)],
        prompts: &[crate::model::ModelSystemPromptConfig],
    ) -> Result<usize> {
        crate::model::ModelSystemPromptConfig::validate_all(prompts)?;
        let mut seen = HashSet::new();
        let normalized = models
            .iter()
            .map(|(id, input)| {
                if id.is_empty() || !seen.insert(id.clone()) {
                    return Err(Error::Config(format!(
                        "migration model identity is empty or duplicated: {id}"
                    )));
                }
                Ok((id.clone(), normalize_model_input(input)?))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        let mut added = 0;
        for (id, input) in &normalized {
            added +=
                usize::from(insert_model_with_conflict(&mut tx, id, input, now_ms(), true).await?);
        }
        validate_fallbacks(&mut tx).await?;
        for prompt in prompts.iter().filter(|prompt| {
            !prompt
                .model_id
                .starts_with(crate::plugin::ADAPTER_ID_PREFIX)
        }) {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM model_configs WHERE model_hash = ?)",
            )
            .bind(&prompt.model_id)
            .fetch_one(&mut *tx)
            .await?;
            if !exists {
                return Err(Error::Config(format!(
                    "migration system prompt model does not exist: {}",
                    prompt.model_id
                )));
            }
            super::model_system_prompts::insert_missing(&mut tx, prompt).await?;
        }
        tx.commit().await?;
        session.committed();
        Ok(added)
    }

    pub async fn models(&self) -> Result<Vec<ModelConfig>> {
        let query =
            format!("SELECT {MODEL_COLUMNS} FROM model_configs ORDER BY sort_order, display_name");
        sqlx::query(&query)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(model_from_row)
            .collect()
    }

    pub async fn model(&self, hash: &str) -> Result<Option<ModelConfig>> {
        let query = format!("SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash = ?");
        sqlx::query(&query)
            .bind(hash)
            .fetch_optional(&self.pool)
            .await?
            .map(model_from_row)
            .transpose()
    }

    pub async fn create_model(&self, input: &ModelConfigInput) -> Result<ModelConfig> {
        let mut models = self.create_models(std::slice::from_ref(input)).await?;
        Ok(models.remove(0))
    }

    pub async fn create_models(&self, inputs: &[ModelConfigInput]) -> Result<Vec<ModelConfig>> {
        if inputs.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            let hash = model_hash(&input)?;
            if !hashes.insert(hash.clone()) {
                return Err(Error::Config("model configurations must be unique".into()));
            }
            normalized.push((hash, input));
        }
        let now = now_ms();
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        let existing = sqlx::query(&format!("SELECT {MODEL_COLUMNS} FROM model_configs"))
            .fetch_all(&mut *transaction)
            .await?;
        let fingerprints = existing
            .into_iter()
            .map(model_from_row)
            .collect::<Result<Vec<_>>>()?
            .iter()
            .map(|model| model_hash(&ModelConfigInput::from(model)))
            .collect::<Result<HashSet<_>>>()?;
        for (identity, input) in &mut normalized {
            if fingerprints.contains(identity) {
                return Err(Error::Config("model configuration already exists".into()));
            }
            *identity = uuid::Uuid::new_v4().simple().to_string();
            insert_model(&mut transaction, identity, input, now).await?;
        }
        validate_fallbacks(&mut transaction).await?;
        let mut saved = Vec::with_capacity(normalized.len());
        for (hash, _) in normalized {
            saved.push(model_from_row(
                sqlx::query(&format!(
                    "SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash=?"
                ))
                .bind(hash)
                .fetch_one(&mut *transaction)
                .await?,
            )?);
        }
        transaction.commit().await?;
        session.committed();
        Ok(saved)
    }

    pub async fn create_models_if_missing(&self, inputs: &[ModelConfigInput]) -> Result<usize> {
        let mut normalized = Vec::with_capacity(inputs.len());
        let mut hashes = HashSet::with_capacity(inputs.len());
        for input in inputs {
            let input = normalize_model_input(input)?;
            let hash = model_hash(&input)?;
            if hashes.insert(hash.clone()) {
                normalized.push((hash, input));
            }
        }
        let now = now_ms();
        let mut session = self.write_session().await?;
        let mut transaction = session.begin().await?;
        let existing = sqlx::query(&format!("SELECT {MODEL_COLUMNS} FROM model_configs"))
            .fetch_all(&mut *transaction)
            .await?;
        let existing = existing
            .into_iter()
            .map(model_from_row)
            .collect::<Result<Vec<_>>>()?;
        let magpie = existing
            .iter()
            .map(|model| magpie_model_identity(&ModelConfigInput::from(model)))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<HashSet<_>>();
        let fingerprints = existing
            .iter()
            .map(|model| model_hash(&ModelConfigInput::from(model)))
            .collect::<Result<HashSet<_>>>()?;
        let mut inserted = 0;
        for (fingerprint, input) in &normalized {
            if fingerprints.contains(fingerprint)
                || magpie_model_identity(input)?.is_some_and(|identity| magpie.contains(&identity))
            {
                continue;
            }
            let identity = uuid::Uuid::new_v4().simple().to_string();
            insert_model(&mut transaction, &identity, input, now).await?;
            inserted += 1;
        }
        validate_fallbacks(&mut transaction).await?;
        transaction.commit().await?;
        session.committed();
        Ok(inserted)
    }

    pub async fn update_model(&self, hash: &str, input: &ModelConfigInput) -> Result<ModelConfig> {
        Ok(self
            .update_models(&[(hash.to_owned(), input.clone())])
            .await?
            .remove(0))
    }

    pub async fn update_models(
        &self,
        models: &[(String, ModelConfigInput)],
    ) -> Result<Vec<ModelConfig>> {
        if models.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let mut identities = HashSet::new();
        let inputs = models
            .iter()
            .map(|(hash, input)| {
                if !identities.insert(hash) {
                    return Err(Error::Config(format!("batch update repeats model {hash}")));
                }
                Ok((hash, normalize_model_input(input)?))
            })
            .collect::<Result<Vec<_>>>()?;
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        let now = now_ms();
        for (hash, input) in &inputs {
            update_model_tx(&mut tx, hash, input, now).await?;
        }
        validate_fallbacks(&mut tx).await?;
        let mut saved = Vec::new();
        for (hash, _) in inputs {
            saved.push(model_from_row(
                sqlx::query(&format!(
                    "SELECT {MODEL_COLUMNS} FROM model_configs WHERE model_hash=?"
                ))
                .bind(hash)
                .fetch_one(&mut *tx)
                .await?,
            )?);
        }
        tx.commit().await?;
        session.committed();
        Ok(saved)
    }

    pub async fn delete_model(&self, hash: &str) -> Result<()> {
        self.delete_models(&[hash.to_owned()]).await
    }

    pub async fn delete_models(&self, hashes: &[String]) -> Result<()> {
        if hashes.is_empty() {
            return Err(Error::Config("at least one model is required".into()));
        }
        let targets: HashSet<&str> = hashes.iter().map(String::as_str).collect();
        let mut session = self.write_session().await?;
        let mut tx = session.begin().await?;
        for hash in &targets {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM model_configs WHERE model_hash=?)")
                    .bind(hash)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                return Err(Error::RunNotFound(format!("model {hash}")));
            }
            let users: Vec<String> = sqlx::query_scalar(
                "SELECT model_hash FROM model_configs WHERE fallback_model_hash=?",
            )
            .bind(hash)
            .fetch_all(&mut *tx)
            .await?;
            let settings_users:i64=sqlx::query_scalar("SELECT COUNT(*) FROM service_settings WHERE (setting_key='commit_settings' AND json_extract(value_json,'$.model_id')=?) OR (setting_key='auto_review_model' AND json_extract(value_json,'$')=?)").bind(hash).bind(hash).fetch_one(&mut *tx).await?;
            if settings_users > 0 || users.iter().any(|id| !targets.contains(id.as_str())) {
                return Err(Error::Config(format!(
                    "model {hash} is still referenced by fallback, Commit, or auto-review settings"
                )));
            }
        }
        for hash in &targets {
            sqlx::query("UPDATE model_configs SET fallback_model_hash=NULL WHERE model_hash=?")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
        }
        for hash in &targets {
            sqlx::query("UPDATE llm_calls SET model_hash=NULL WHERE model_hash=?")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
            super::model_system_prompts::remove(&mut tx, hash).await?;
            invalidate_capabilities(&mut tx, hash).await?;
            sqlx::query("DELETE FROM model_capability_tests WHERE model_id=?")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM model_configs WHERE model_hash=?")
                .bind(hash)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        session.committed();
        Ok(())
    }
}

async fn update_model_tx(
    tx: &mut SqliteConnection,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
) -> Result<()> {
    let result = sqlx::query(
        r#"UPDATE model_configs SET
        model_hash = ?, sort_order = ?, display_name = ?, group_name = ?, fallback_model_hash = ?, model_type = ?, base_url = ?,
        use_full_url = ?, api_key = ?, tooltip_data = ?, model_id = ?, reasoning_effort = ?,
        openai_endpoint = ?, openai_extra_params_enabled = ?, openai_extra_params_json = ?,
        custom_headers_enabled = ?, custom_headers_json = ?,
        anthropic_extra_params_enabled = ?, anthropic_extra_params_json = ?,
        context_window_tokens = ?, max_completion_tokens = ?, anthropic_max_tokens = ?,
        anthropic_thinking_effort = ?, thinking_budget_tokens = ?, updated_at_ms = ?
        WHERE model_hash = ?"#,
    )
    .bind(hash)
    .bind(input.sort_order)
    .bind(&input.display_name)
    .bind(&input.group_name)
    .bind(&input.fallback_model_hash)
    .bind(input.model_type.as_str())
    .bind(&input.base_url)
    .bind(input.use_full_url)
    .bind(&input.api_key)
    .bind(&input.tooltip_data)
    .bind(&input.model_id)
    .bind(&input.reasoning_effort)
    .bind(&input.openai_endpoint)
    .bind(input.openai_extra_params_enabled)
    .bind(serde_json::to_string(&input.openai_extra_params)?)
    .bind(input.custom_headers_enabled)
    .bind(serde_json::to_string(&input.custom_headers)?)
    .bind(input.anthropic_extra_params_enabled)
    .bind(serde_json::to_string(&input.anthropic_extra_params)?)
    .bind(input.context_window_tokens.map(to_i64).transpose()?)
    .bind(input.max_completion_tokens.map(to_i64).transpose()?)
    .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
    .bind(&input.anthropic_thinking_effort)
    .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
    .bind(now)
    .bind(hash)
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(Error::RunNotFound(format!("model {hash}")));
    }
    sqlx::query("DELETE FROM model_capability_tests WHERE model_id = ?")
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    invalidate_capabilities(tx, hash).await?;
    Ok(())
}

async fn invalidate_capabilities(tx: &mut SqliteConnection, model_id: &str) -> Result<()> {
    sqlx::query("INSERT INTO model_capability_revisions(model_id, revision) VALUES (?, 1) ON CONFLICT(model_id) DO UPDATE SET revision=revision+1").bind(model_id).execute(&mut *tx).await?;
    Ok(())
}

async fn validate_fallbacks(tx: &mut SqliteConnection) -> Result<()> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT model_hash, fallback_model_hash FROM model_configs")
            .fetch_all(&mut *tx)
            .await?;
    let links: std::collections::HashMap<_, _> = rows.into_iter().collect();
    for source in links.keys() {
        let mut seen = HashSet::new();
        let mut current = source.as_str();
        while let Some(Some(target)) = links.get(current) {
            if !seen.insert(current.to_owned()) {
                return Err(Error::Config(format!(
                    "model fallback chain contains a cycle: {source}"
                )));
            }
            if !links.contains_key(target) {
                return Err(Error::Config(format!(
                    "model fallback target does not exist: {target}"
                )));
            }
            if seen.len() > 4 {
                return Err(Error::Config(format!(
                    "model fallback chain exceeds four hops: {source}"
                )));
            }
            current = target;
        }
    }
    Ok(())
}

async fn insert_model(
    transaction: &mut SqliteConnection,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
) -> Result<()> {
    insert_model_with_conflict(transaction, hash, input, now, false).await?;
    Ok(())
}

async fn insert_model_with_conflict(
    transaction: &mut SqliteConnection,
    hash: &str,
    input: &ModelConfigInput,
    now: i64,
    ignore_existing: bool,
) -> Result<bool> {
    let mut statement = String::from(
        r#"INSERT INTO model_configs(
            model_hash, sort_order, display_name, group_name, fallback_model_hash, model_type, base_url, use_full_url, api_key, tooltip_data,
            model_id, reasoning_effort, openai_endpoint, openai_extra_params_enabled,
            openai_extra_params_json, custom_headers_enabled, custom_headers_json,
            anthropic_extra_params_enabled, anthropic_extra_params_json, context_window_tokens,
            max_completion_tokens, anthropic_max_tokens, anthropic_thinking_effort,
            thinking_budget_tokens, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    );
    if ignore_existing {
        statement.push_str(" ON CONFLICT(model_hash) DO NOTHING");
    }
    let result = sqlx::query(&statement)
        .bind(hash)
        .bind(input.sort_order)
        .bind(&input.display_name)
        .bind(&input.group_name)
        .bind(&input.fallback_model_hash)
        .bind(input.model_type.as_str())
        .bind(&input.base_url)
        .bind(input.use_full_url)
        .bind(&input.api_key)
        .bind(&input.tooltip_data)
        .bind(&input.model_id)
        .bind(&input.reasoning_effort)
        .bind(&input.openai_endpoint)
        .bind(input.openai_extra_params_enabled)
        .bind(serde_json::to_string(&input.openai_extra_params)?)
        .bind(input.custom_headers_enabled)
        .bind(serde_json::to_string(&input.custom_headers)?)
        .bind(input.anthropic_extra_params_enabled)
        .bind(serde_json::to_string(&input.anthropic_extra_params)?)
        .bind(input.context_window_tokens.map(to_i64).transpose()?)
        .bind(input.max_completion_tokens.map(to_i64).transpose()?)
        .bind(input.anthropic_max_tokens.map(to_i64).transpose()?)
        .bind(&input.anthropic_thinking_effort)
        .bind(input.thinking_budget_tokens.map(to_i64).transpose()?)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
    Ok(result.rows_affected() == 1)
}

fn model_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ModelConfig> {
    Ok(ModelConfig {
        fallback_model_hash: row.try_get("fallback_model_hash")?,
        model_hash: row.try_get("model_hash")?,
        sort_order: row.try_get("sort_order")?,
        display_name: row.try_get("display_name")?,
        group_name: row.try_get("group_name")?,
        model_type: ModelType::from_str(row.try_get("model_type")?)?,
        base_url: row.try_get("base_url")?,
        use_full_url: row.try_get("use_full_url")?,
        api_key: row.try_get("api_key")?,
        tooltip_data: row.try_get("tooltip_data")?,
        model_id: row.try_get("model_id")?,
        reasoning_effort: row.try_get("reasoning_effort")?,
        openai_endpoint: row.try_get("openai_endpoint")?,
        openai_extra_params_enabled: row.try_get("openai_extra_params_enabled")?,
        openai_extra_params: serde_json::from_str(
            row.try_get::<String, _>("openai_extra_params_json")?
                .as_str(),
        )?,
        custom_headers_enabled: row.try_get("custom_headers_enabled")?,
        custom_headers: serde_json::from_str(
            row.try_get::<String, _>("custom_headers_json")?.as_str(),
        )?,
        anthropic_extra_params_enabled: row.try_get("anthropic_extra_params_enabled")?,
        anthropic_extra_params: serde_json::from_str(
            row.try_get::<String, _>("anthropic_extra_params_json")?
                .as_str(),
        )?,
        context_window_tokens: optional_u64(&row, "context_window_tokens")?,
        max_completion_tokens: optional_u64(&row, "max_completion_tokens")?,
        anthropic_max_tokens: optional_u64(&row, "anthropic_max_tokens")?,
        anthropic_thinking_effort: row.try_get("anthropic_thinking_effort")?,
        thinking_budget_tokens: optional_u64(&row, "thinking_budget_tokens")?,
        created_at_ms: row.try_get("created_at_ms")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

fn optional_u64(row: &sqlx::sqlite::SqliteRow, column: &str) -> Result<Option<u64>> {
    row.try_get::<Option<i64>, _>(column)?
        .map(|value| {
            u64::try_from(value).map_err(|_| Error::Config(format!("{column} cannot be negative")))
        })
        .transpose()
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| Error::Config("token value is too large".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_input(group_name: Option<&str>) -> ModelConfigInput {
        ModelConfigInput {
            fallback_model_hash: None,
            sort_order: 0,
            display_name: "Test Model".into(),
            group_name: group_name.map(String::from),
            model_type: ModelType::OpenAi,
            base_url: "https://example.com/v1/chat/completions".into(),
            use_full_url: true,
            api_key: "test-key".into(),
            tooltip_data: "Test Model".into(),
            model_id: "test-model".into(),
            reasoning_effort: None,
            openai_endpoint: crate::model::OPENAI_CHAT_ENDPOINT.into(),
            openai_extra_params_enabled: false,
            openai_extra_params: serde_json::json!({}),
            custom_headers_enabled: false,
            custom_headers: serde_json::json!({}),
            anthropic_extra_params_enabled: false,
            anthropic_extra_params: serde_json::json!({}),
            context_window_tokens: None,
            max_completion_tokens: None,
            anthropic_max_tokens: None,
            anthropic_thinking_effort: None,
            thinking_budget_tokens: None,
        }
    }

    /// 分组名是纯展示字段:入库时去除首尾空白、空串归一为 NULL,
    /// 更新分组名不得改变模型身份哈希。
    #[tokio::test]
    async fn group_name_round_trips_without_changing_model_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();

        let created = store
            .create_model(&model_input(Some("  My Group  ")))
            .await
            .unwrap();
        assert_eq!(created.group_name.as_deref(), Some("My Group"));

        let renamed = store
            .update_model(&created.model_hash, &model_input(Some("Renamed")))
            .await
            .unwrap();
        assert_eq!(renamed.model_hash, created.model_hash);
        assert_eq!(renamed.group_name.as_deref(), Some("Renamed"));

        let cleared = store
            .update_model(&created.model_hash, &model_input(Some("   ")))
            .await
            .unwrap();
        assert_eq!(cleared.model_hash, created.model_hash);
        assert_eq!(cleared.group_name, None);
    }

    #[tokio::test]
    async fn editing_model_credentials_and_name_keeps_all_references() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let mut input = model_input(None);
        let backup = store.create_model(&input).await.unwrap();
        input.display_name = "Primary".into();
        input.fallback_model_hash = Some(backup.model_hash.clone());
        let primary = store.create_model(&input).await.unwrap();
        store
            .set_commit_settings(crate::store::CommitSettings {
                model_id: backup.model_hash.clone(),
                ..Default::default()
            })
            .await
            .unwrap();
        store
            .set_auto_review_model(Some(backup.model_hash.clone()))
            .await
            .unwrap();
        let mut edited = model_input(None);
        edited.display_name = "Renamed".into();
        edited.api_key = "rotated-key".into();
        let saved = store
            .update_model(&backup.model_hash, &edited)
            .await
            .unwrap();
        assert_eq!(
            saved.model_hash, backup.model_hash,
            "editable fields must not change persistent model identity"
        );
        assert_eq!(
            store
                .model(&primary.model_hash)
                .await
                .unwrap()
                .unwrap()
                .fallback_model_hash,
            Some(saved.model_hash.clone())
        );
        assert_eq!(
            store.commit_settings().await.unwrap().model_id,
            saved.model_hash
        );
        assert_eq!(
            store.auto_review_model().await.unwrap().as_deref(),
            Some(saved.model_hash.as_str())
        );
    }

    #[tokio::test]
    async fn model_identity_is_independent_of_configuration_and_duplicate_imports_stay_idempotent()
    {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let input = model_input(None);
        let first = store.create_model(&input).await.unwrap();
        assert_ne!(
            first.model_hash,
            model_hash(&input).unwrap(),
            "persistent identity cannot be derived from editable credentials"
        );
        assert_eq!(
            store
                .create_models_if_missing(std::slice::from_ref(&input))
                .await
                .unwrap(),
            0
        );
        let mut edited = input.clone();
        edited.api_key = "rotated".into();
        store
            .update_model(&first.model_hash, &edited)
            .await
            .unwrap();
        assert_eq!(
            store
                .create_models_if_missing(std::slice::from_ref(&edited))
                .await
                .unwrap(),
            0,
            "import deduplication must inspect current settings after credentials rotate"
        );
        let second = store.create_model(&input).await.unwrap();
        assert_ne!(second.model_hash, first.model_hash);
        store.delete_model(&second.model_hash).await.unwrap();
        assert_eq!(store.models().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn missing_and_cyclic_fallbacks_are_rejected_without_partial_updates() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let mut input = model_input(None);
        input.fallback_model_hash = Some("missing".into());
        assert!(store.create_model(&input).await.is_err());
        assert!(store.models().await.unwrap().is_empty());
        input.fallback_model_hash = None;
        let first = store.create_model(&input).await.unwrap();
        input.display_name = "Second".into();
        input.fallback_model_hash = Some(first.model_hash.clone());
        let second = store.create_model(&input).await.unwrap();
        input.fallback_model_hash = Some(second.model_hash.clone());
        assert!(store.update_model(&first.model_hash, &input).await.is_err());
        assert!(store
            .model(&first.model_hash)
            .await
            .unwrap()
            .unwrap()
            .fallback_model_hash
            .is_none());
        assert!(
            store.delete_model(&first.model_hash).await.is_err(),
            "referenced models require explicit reassignment before deletion"
        );
    }
}
