//! Verifies per-model system prompts, stable conversation snapshots, and recovery.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::BTreeMap, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    Router,
};
use cursor_server::{
    control::{self, ControlService},
    model::ModelConfigInput,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    store::Store,
};
use serde_json::{json, Value};
use tower::ServiceExt;

fn model_input() -> ModelConfigInput {
    serde_json::from_value(json!({
        "sort_order": 0,
        "display_name": "Prompt Test",
        "group_name": "work",
        "type": "openai",
        "base_url": "https://example.com/v1",
        "api_key": "test-key",
        "tooltip_data": "test",
        "model_id": "test-model",
        "openai_endpoint": "/v1/chat/completions"
    }))
    .unwrap()
}

async fn control_router(store: &Store) -> Router {
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "1.0.7".into()).unwrap();
    control::api_router(
        ControlService::new(
            store.clone(),
            Arc::new(fake_provider::FakeProvider::default()),
            runtime,
            plugins,
            NetworkClients::new(store.clone()),
            "1.0.7".into(),
        )
        .unwrap(),
    )
}

async fn request(router: Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    (status, value)
}

#[tokio::test]
#[ignore = "requires PROMPT_MIGRATION_DATABASE_COPY pointing to a freshly backed-up database"]
async fn migration_preserves_rows_on_a_real_database_copy() {
    use sqlx::sqlite::SqlitePoolOptions;

    let path = std::path::PathBuf::from(
        std::env::var("PROMPT_MIGRATION_DATABASE_COPY").expect("provide a database copy"),
    );
    assert!(
        path.parent()
            .and_then(std::path::Path::file_name)
            .unwrap()
            .to_string_lossy()
            .starts_with("cursor-byok-prompt-db-"),
        "measurement must never run on the live database"
    );
    let url = format!("sqlite://{}", path.display());
    let before_pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let before = database_row_counts(&before_pool).await;
    before_pool.close().await;
    let before_bytes = std::fs::metadata(&path).unwrap().len();
    let store = Store::connect(&url).await.unwrap();
    let after = database_row_counts(store.pool()).await;
    for (table, count) in &before {
        if table != "_sqlx_migrations" {
            assert_eq!(
                after.get(table),
                Some(count),
                "migration must preserve rows in {table}"
            );
        }
    }
    // The prompt tables are the ones a table rebuild touches; their rows must
    // survive unchanged instead of being recreated empty.
    for table in ["model_system_prompts", "conversation_system_prompts"] {
        assert_eq!(
            after.get(table),
            before.get(table),
            "rebuilding {table} must keep exactly the rows the copy already had"
        );
    }
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(store.pool())
        .await
        .unwrap();
    store.pool().close().await;
    let after_bytes = std::fs::metadata(&path).unwrap().len();
    println!(
        "{}",
        json!({"before":{"bytes":before_bytes,"rows":before},"after":{"bytes":after_bytes,"rows":after}})
    );
}

async fn database_row_counts(pool: &sqlx::SqlitePool) -> BTreeMap<String, i64> {
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(pool).await.unwrap();
    let mut counts = BTreeMap::new();
    for table in tables {
        let query = format!("SELECT COUNT(*) FROM \"{}\"", table.replace('"', "\"\""));
        counts.insert(
            table,
            sqlx::query_scalar(&query).fetch_one(pool).await.unwrap(),
        );
    }
    counts
}

#[tokio::test]
async fn failed_snapshot_commits_roll_back_and_the_next_attempt_can_recover() {
    use cursor_server::model::ConversationId;

    let (_directory, store) = fixtures::temp_store().await;
    sqlx::query("CREATE TABLE prompt_commit_failure(conversation_id TEXT REFERENCES conversations(conversation_id) DEFERRABLE INITIALLY DEFERRED)").execute(store.pool()).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_prompt_snapshot AFTER INSERT ON conversation_system_prompts BEGIN INSERT INTO prompt_commit_failure VALUES ('missing-conversation'); END").execute(store.pool()).await.unwrap();
    let conversation = ConversationId::new("failed-write");
    let defaults = BTreeMap::from([("agent".into(), "base".into())]);
    let error = store
        .conversation_system_prompt(&conversation, "model", "agent", "base", None, &defaults)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("FOREIGN KEY constraint failed"));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE conversation_id = ?")
            .bind(conversation.as_str())
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(
        count, 0,
        "a failed snapshot transaction must not leave a half-created conversation"
    );
    sqlx::query("DROP TRIGGER reject_prompt_snapshot")
        .execute(store.pool())
        .await
        .unwrap();
    assert_eq!(
        store
            .conversation_system_prompt(&conversation, "model", "agent", "base", None, &defaults)
            .await
            .unwrap(),
        "base",
        "the writer must recover after a failed commit"
    );
}

#[tokio::test]
async fn concurrent_first_requests_adopt_one_identical_system_prompt() {
    use cursor_server::model::ConversationId;

    let (directory, store) = fixtures::temp_store().await;
    let another = Store::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let conversation = ConversationId::new("concurrent");
    let defaults = BTreeMap::from([("agent".into(), "base".into())]);
    let (first, second) = tokio::join!(
        store.conversation_system_prompt(
            &conversation,
            "model",
            "agent",
            "first candidate",
            None,
            &defaults
        ),
        another.conversation_system_prompt(
            &conversation,
            "model",
            "agent",
            "second candidate",
            None,
            &defaults
        ),
    );
    assert_eq!(
        first.unwrap(),
        second.unwrap(),
        "independent connections must not publish different first snapshots"
    );
}

#[tokio::test]
async fn renaming_a_model_preserves_its_settings_and_adopted_snapshot() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    let mut input = model_input();
    let model = store.create_model(&input).await.unwrap();
    let settings = ModelSystemPromptSettings {
        enabled: true,
        content: "preserved".into(),
        position: SystemPromptPosition::After,
    };
    store
        .set_model_system_prompt(&model.model_hash, &settings)
        .await
        .unwrap();
    let conversation = ConversationId::new("rename");
    let defaults = BTreeMap::from([("agent".into(), "base".into())]);
    let original = store
        .conversation_system_prompt(
            &conversation,
            &model.model_hash,
            "agent",
            "base",
            None,
            &defaults,
        )
        .await
        .unwrap();
    input.display_name = "renamed model".into();
    let renamed = store.update_model(&model.model_hash, &input).await.unwrap();
    assert_ne!(renamed.model_hash, model.model_hash);
    assert_eq!(
        store
            .model_system_prompt(&renamed.model_hash)
            .await
            .unwrap(),
        settings
    );
    assert_eq!(
        store
            .conversation_system_prompt(
                &conversation,
                &renamed.model_hash,
                "agent",
                "renamed base",
                Some(&original),
                &defaults
            )
            .await
            .unwrap(),
        original
    );
}

#[tokio::test]
async fn multibyte_prompt_limits_are_measured_in_utf8_bytes() {
    use cursor_server::model::{ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    let exact = ModelSystemPromptSettings {
        enabled: true,
        content: "😀".repeat(8_192),
        position: SystemPromptPosition::Before,
    };
    store
        .set_model_system_prompt("model", &exact)
        .await
        .unwrap();
    let mut oversized = exact.clone();
    oversized.content.push('x');
    assert!(
        store
            .set_model_system_prompt("model", &oversized)
            .await
            .is_err(),
        "32769 bytes must be rejected even when the character count is smaller"
    );
    assert_eq!(store.model_system_prompt("model").await.unwrap(), exact);
}

#[tokio::test]
async fn model_prompt_identifiers_cannot_be_null_in_the_database() {
    let (_directory, store) = fixtures::temp_store().await;
    let result = sqlx::query("INSERT INTO model_system_prompts(model_id, enabled, content, position, updated_at_ms) VALUES (NULL, 0, '', 'after', 0)")
        .execute(store.pool()).await;
    assert!(
        result.is_err(),
        "a model prompt must always belong to a non-null model identifier"
    );
}

#[tokio::test]
async fn default_root_recovery_preserves_exact_bytes_across_checkout_line_endings() {
    use cursor_server::model::ConversationId;

    let (_directory, store) = fixtures::temp_store().await;
    let conversation = ConversationId::new("line-ending-root");
    let defaults = BTreeMap::from([("agent".into(), "original default\r\n".into())]);
    let original = "original default\n";
    assert_eq!(
        store
            .conversation_system_prompt(
                &conversation,
                "model",
                "agent",
                "original default\r\n",
                Some(original),
                &defaults
            )
            .await
            .unwrap(),
        original,
        "recognizing a default must not normalize the provider-visible bytes"
    );
    assert_eq!(
        store
            .conversation_system_prompt(
                &conversation,
                "model",
                "agent",
                "different compiled default",
                Some(original),
                &defaults
            )
            .await
            .unwrap(),
        original
    );
}

#[tokio::test]
async fn saved_edits_do_not_change_an_existing_conversation_or_its_other_modes() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (directory, store) = fixtures::temp_store().await;
    let settings = ModelSystemPromptSettings {
        enabled: true,
        content: "P1".into(),
        position: SystemPromptPosition::After,
    };
    store
        .set_model_system_prompt("model", &settings)
        .await
        .unwrap();
    let conversation = ConversationId::new("stable");
    let defaults = BTreeMap::from([
        ("agent".into(), "base agent".into()),
        ("ask".into(), "base ask".into()),
    ]);
    let first = store
        .conversation_system_prompt(
            &conversation,
            "model",
            "agent",
            "base agent",
            None,
            &defaults,
        )
        .await
        .unwrap();
    assert_eq!(first, "base agent\n\nP1");
    store
        .set_model_system_prompt(
            "model",
            &ModelSystemPromptSettings {
                content: "P2".into(),
                ..settings
            },
        )
        .await
        .unwrap();
    let reopened = Store::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    assert_eq!(
        reopened
            .conversation_system_prompt(
                &conversation,
                "model",
                "agent",
                "changed embedded base",
                Some(&first),
                &defaults
            )
            .await
            .unwrap(),
        first,
        "restart and asset changes must not replace an adopted system prompt"
    );
    assert_eq!(
        reopened
            .conversation_system_prompt(
                &conversation,
                "model",
                "ask",
                "base ask",
                Some(&first),
                &defaults
            )
            .await
            .unwrap(),
        "base ask\n\nP1",
        "first use of another mode must keep the model's adopted configuration"
    );
    assert_eq!(
        reopened
            .conversation_system_prompt(
                &ConversationId::new("new"),
                "model",
                "agent",
                "base agent",
                None,
                &defaults
            )
            .await
            .unwrap(),
        "base agent\n\nP2"
    );
}

#[tokio::test]
async fn an_unbound_system_root_is_rejected_instead_of_reconstructed_from_live_settings() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_model_system_prompt(
            "model",
            &ModelSystemPromptSettings {
                enabled: true,
                content: "new settings".into(),
                position: SystemPromptPosition::After,
            },
        )
        .await
        .unwrap();
    let conversation = ConversationId::new("unknown-root");
    let defaults = BTreeMap::from([("agent".into(), "base".into())]);
    let error = store
        .conversation_system_prompt(
            &conversation,
            "model",
            "agent",
            "base",
            Some("unknown prior instructions"),
            &defaults,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("system prompt root"));
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_system_prompts WHERE conversation_id = ?",
    )
    .bind(conversation.as_str())
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "a failed binding must not leave an adopted snapshot behind"
    );
}

#[tokio::test]
async fn an_existing_default_root_keeps_custom_prompts_disabled_until_a_new_conversation() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_model_system_prompt(
            "model",
            &ModelSystemPromptSettings {
                enabled: true,
                content: "new settings".into(),
                position: SystemPromptPosition::Before,
            },
        )
        .await
        .unwrap();
    let conversation = ConversationId::new("prior-conversation");
    let defaults = BTreeMap::from([
        ("agent".into(), "base agent".into()),
        ("ask".into(), "base ask".into()),
    ]);
    assert_eq!(
        store
            .conversation_system_prompt(
                &conversation,
                "model",
                "agent",
                "base agent",
                Some("base ask"),
                &defaults
            )
            .await
            .unwrap(),
        "base agent",
        "existing history must not acquire a newly enabled system prompt"
    );
    assert_eq!(
        store
            .conversation_system_prompt(
                &conversation,
                "model",
                "ask",
                "base ask",
                Some("base ask"),
                &defaults
            )
            .await
            .unwrap(),
        "base ask",
        "retry of a prior root must remain bound to the same disabled snapshot"
    );
}

#[tokio::test]
async fn replacing_the_system_prompt_discards_the_cursor_original() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_model_system_prompt(
            "model",
            &ModelSystemPromptSettings {
                enabled: true,
                content: "只使用中文回答。".into(),
                position: SystemPromptPosition::Replace,
            },
        )
        .await
        .unwrap();
    let defaults = BTreeMap::from([
        ("agent".into(), "base agent".into()),
        ("ask".into(), "base ask".into()),
    ]);
    for (mode, base) in [("agent", "base agent"), ("ask", "base ask")] {
        assert_eq!(
            store
                .conversation_system_prompt(
                    &ConversationId::new(format!("replace-{mode}")),
                    "model",
                    mode,
                    base,
                    None,
                    &defaults
                )
                .await
                .unwrap(),
            "只使用中文回答。",
            "replace must drop the Cursor prompt instead of adding to it"
        );
    }
}

#[tokio::test]
async fn a_disabled_replacement_keeps_the_cursor_original() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings, SystemPromptPosition};

    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_model_system_prompt(
            "model",
            &ModelSystemPromptSettings {
                enabled: false,
                content: "只使用中文回答。".into(),
                position: SystemPromptPosition::Replace,
            },
        )
        .await
        .unwrap();
    let defaults = BTreeMap::from([("agent".into(), "base agent".into())]);
    assert_eq!(
        store
            .conversation_system_prompt(
                &ConversationId::new("disabled-replace"),
                "model",
                "agent",
                "base agent",
                None,
                &defaults
            )
            .await
            .unwrap(),
        "base agent",
        "a disabled replacement must not change the Cursor prompt"
    );
}

#[tokio::test]
async fn portable_configuration_round_trips_model_system_prompts() {
    use cursor_server::model::{ModelSystemPromptSettings, SystemPromptPosition};

    let (_source_directory, source) = fixtures::temp_store().await;
    let model = source.create_model(&model_input()).await.unwrap();
    let settings = ModelSystemPromptSettings {
        enabled: true,
        content: "portable system instruction".into(),
        position: SystemPromptPosition::Before,
    };
    source
        .set_model_system_prompt(&model.model_hash, &settings)
        .await
        .unwrap();
    let (status, file) = request(
        control_router(&source).await,
        "GET",
        "/__byok-api__/api/migration/export",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        file["version"], 2,
        "the configuration format must include system prompts"
    );
    assert_eq!(file["model_system_prompts"][0]["content"], settings.content);
    let (_destination_directory, destination) = fixtures::temp_store().await;
    let (status, _) = request(
        control_router(&destination).await,
        "POST",
        "/__byok-api__/api/migration/import",
        file,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        destination
            .model_system_prompt(&model.model_hash)
            .await
            .unwrap(),
        settings,
        "configuration import must preserve the prompt and position"
    );
}

#[tokio::test]
async fn a_missing_instructions_snapshot_is_reported_instead_of_regenerated() {
    use cursor_server::model::{ConversationId, ModelSystemPromptSettings};

    let (_directory, store) = fixtures::temp_store().await;
    let conversation = ConversationId::new("empty-snapshot");
    store.ensure_conversation(&conversation).await.unwrap();
    sqlx::query("INSERT INTO conversation_system_prompts(conversation_id, model_id, settings_json, instructions_json, created_at_ms) VALUES (?, 'model', ?, '{}', 0)")
        .bind(conversation.as_str()).bind(serde_json::to_string(&ModelSystemPromptSettings::default()).unwrap()).execute(store.pool()).await.unwrap();
    let defaults = BTreeMap::from([("agent".into(), "base".into())]);
    let error = store
        .conversation_system_prompt(&conversation, "model", "agent", "base", None, &defaults)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("snapshot"));
}

#[tokio::test]
async fn group_edits_do_not_clear_the_models_system_prompt() {
    let (_directory, store) = fixtures::temp_store().await;
    let mut input = model_input();
    let model = store.create_model(&input).await.unwrap();
    let router = control_router(&store).await;
    let settings = json!({"enabled":true,"content":"只使用中文回答。","position":"after"});
    let mut save = settings.clone();
    save["model_id"] = json!(model.model_hash);
    let (status, _) = request(
        router.clone(),
        "PUT",
        "/__byok-api__/api/model-system-prompts",
        save,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "a model's system prompt must be configurable"
    );

    input.group_name = Some("renamed group".into());
    store.update_model(&model.model_hash, &input).await.unwrap();
    let (status, actual) = request(
        router,
        "GET",
        &format!(
            "/__byok-api__/api/model-system-prompts?model_id={}",
            model.model_hash
        ),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        actual, settings,
        "saving a group must preserve its models' prompts"
    );
}

#[tokio::test]
async fn invalid_prompt_changes_leave_the_saved_configuration_untouched() {
    let (_directory, store) = fixtures::temp_store().await;
    let model = store.create_model(&model_input()).await.unwrap();
    let router = control_router(&store).await;
    let settings = json!({"enabled":true,"content":"preserved instruction","position":"before"});
    let mut save = settings.clone();
    save["model_id"] = json!(model.model_hash);
    assert_eq!(
        request(
            router.clone(),
            "PUT",
            "/__byok-api__/api/model-system-prompts",
            save
        )
        .await
        .0,
        StatusCode::OK
    );

    for invalid in [
        json!({"enabled":true,"content":" \n\t\u{3000}","position":"after"}),
        json!({"enabled":true,"content":"x".repeat(32_769),"position":"after"}),
        json!({"enabled":true,"content":"valid","position":"interleave"}),
    ] {
        let mut invalid = invalid;
        invalid["model_id"] = json!(model.model_hash);
        let status = request(
            router.clone(),
            "PUT",
            "/__byok-api__/api/model-system-prompts",
            invalid,
        )
        .await
        .0;
        assert!(
            status.is_client_error(),
            "invalid system prompt settings must be rejected"
        );
    }
    let (_, actual) = request(
        router,
        "GET",
        &format!(
            "/__byok-api__/api/model-system-prompts?model_id={}",
            model.model_hash
        ),
        json!({}),
    )
    .await;
    assert_eq!(
        actual, settings,
        "rejected updates must not change the saved prompt"
    );
}
