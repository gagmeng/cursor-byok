//! Reproduces V1.1.4 review findings with disposable stores and local fake providers.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{sync::Arc, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::post,
    Router,
};
use cursor_server::{
    api::byok,
    control::{Capability, ControlService},
    model::{
        ConversationId, ModelConfigInput, ModelSpec, NewLlmCall, PreparedRun, PromptSpec,
        ProviderType, RunAction, RunId, RunKind,
    },
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::{FinishReason, ModelEvent},
    run::{self, RunEngine, RunEvent, RunOutcome},
    store::{ExternalApiSettings, Store},
    App, Config, Error,
};
use serde_json::json;
use tower::ServiceExt;

fn input(name: &str, order: i64) -> ModelConfigInput {
    serde_json::from_value(json!({
        "display_name":name, "sort_order":order, "group_name":"work", "type":"openai",
        "base_url":"https://example.com/v1", "api_key":"dummy-audit-key",
        "model_id":name, "tooltip_data":name, "openai_endpoint":"/v1/chat/completions"
    }))
    .unwrap()
}

async fn control(store: &Store) -> (ControlService, fake_provider::FakeProvider) {
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "1.1.4".into()).unwrap();
    let provider = fake_provider::FakeProvider::default();
    let service = ControlService::new(
        store.clone(),
        Arc::new(provider.clone()),
        runtime,
        plugins,
        NetworkClients::new(store.clone()),
        "1.1.4".into(),
    )
    .unwrap();
    (service, provider)
}

async fn wait_for_request(provider: &fake_provider::FakeProvider) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while provider.requests().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn backups_must_not_silently_omit_saved_accounts_when_runtime_is_unavailable() {
    let (_directory, store) = fixtures::temp_store().await;
    let plugin = "dev.cursorbyok.examples.codex-auth";
    let data_root = std::path::PathBuf::from(std::env::var_os("CURSOR_BYOK_DATA_DIR").unwrap());
    let plugin_root = data_root.join("plugins/data").join(plugin);
    std::fs::create_dir_all(&plugin_root).unwrap();
    let account_path = plugin_root.join("resources-chatgpt-account.json");
    std::fs::write(&account_path, serde_json::to_vec(&json!([{
        "id":"audit-account", "key":"audit-account", "private_data":{"accessToken":"dummy-audit-token","refreshToken":null,"accountId":"audit-account","displayName":"Audit","quota":null},
        "state":{"status":"ready"}, "created_at_ms":1, "updated_at_ms":1
    }])).unwrap()).unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    assert!(
        runtime.executable().is_none(),
        "this isolated fixture has no managed runtime"
    );
    let (service, _) = control(&store).await;
    let bundle = serde_json::to_value(service.migration_export().await.unwrap()).unwrap();
    let resources = bundle["plugin_resources"].as_array().unwrap();
    eprintln!("AUDIT backup: saved_accounts=1 runtime={:?} exported_resource_groups={} export_returned_success=true", runtime.status().state, resources.len());
    assert!(account_path.exists());
    assert!(resources.iter().any(|resource| resource["plugin_id"] == plugin),
        "a successful backup must include persisted plugin credentials even when the runtime is unavailable");
}

#[tokio::test]
async fn native_stream_without_a_terminal_event_must_not_count_as_completed() {
    let (_directory, store) = fixtures::temp_store().await;
    store
        .set_external_api_settings(ExternalApiSettings {
            enabled: true,
            api_key: "local-audit-secret".into(),
        })
        .await
        .unwrap();
    let partial = "data: {\"id\":\"partial\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"incomplete\"},\"finish_reason\":null}]}\n\n";
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move || async move { ([(header::CONTENT_TYPE, "text/event-stream")], partial) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let mut config = input("truncated", 0);
    config.base_url = format!("http://{address}/v1");
    store.create_model(&config).await.unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime, "1.1.4".into()).unwrap();
    let router = byok::router(
        store.clone(),
        plugins,
        Arc::new(fake_provider::FakeProvider::default()),
        Some(byok::NativeForwarder::new(
            store.clone(),
            NetworkClients::new(store.clone()),
            Duration::from_secs(5),
            Duration::from_secs(5),
        )),
    );
    let response = router.oneshot(Request::builder().method("POST").uri("/byok/v1/chat/completions")
        .header(header::AUTHORIZATION,"Bearer local-audit-secret")
        .header(header::CONTENT_TYPE,"application/json")
        .body(Body::from(json!({"model":"work/truncated", "messages":[{"role":"user","content":"hi"}],"stream":true}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(
        bytes.as_ref(),
        partial.as_bytes(),
        "the passthrough must preserve bytes"
    );
    let calls = store.llm_calls(10).await.unwrap();
    let call = &calls[0];
    let health = store.model_health().await.unwrap();
    server.abort();
    eprintln!(
        "AUDIT native EOF: status={} finish_reason={:?} success_rate={:?}",
        call.status, call.finish_reason, health[0].success_rate
    );
    assert_ne!(
        call.status, "completed",
        "an HTTP EOF without protocol completion cannot be reported as a successful model response"
    );
}

#[tokio::test]
async fn discarding_a_native_body_before_polling_cancels_its_call_and_invalid_json_fails() {
    for stream in [true, false] {
        let (_directory, store) = fixtures::temp_store().await;
        store
            .set_external_api_settings(ExternalApiSettings {
                enabled: true,
                api_key: "local-secret".into(),
            })
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let upstream = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/v1/chat/completions",
                    post(|| async { "invalid native response" }),
                ),
            )
            .await
            .unwrap()
        });
        let mut config = input("native-boundary", 0);
        config.base_url = format!("http://{address}/v1");
        store.create_model(&config).await.unwrap();
        let runtime = PluginRuntime::managed().unwrap();
        let plugins = PluginRegistry::managed(store.clone(), runtime, "test".into()).unwrap();
        let router = byok::router(
            store.clone(),
            plugins,
            Arc::new(fake_provider::FakeProvider::default()),
            Some(byok::NativeForwarder::new(
                store.clone(),
                NetworkClients::new(store.clone()),
                Duration::from_secs(2),
                Duration::from_secs(2),
            )),
        );
        let response=router.oneshot(Request::builder().method("POST").uri("/byok/v1/chat/completions").header(header::AUTHORIZATION,"Bearer local-secret").header(header::CONTENT_TYPE,"application/json").body(Body::from(json!({"model":"work/native-boundary","messages":[{"role":"user","content":"hi"}],"stream":stream}).to_string())).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        if stream {
            drop(response);
        } else {
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                b"invalid native response"
            );
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let call = store.llm_calls(1).await.unwrap().remove(0);
                if call.status != "running" {
                    assert_eq!(call.status, if stream { "cancelled" } else { "error" });
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("discarding the response body must settle the call even when it was never polled");
        upstream.abort();
    }
}

#[tokio::test]
async fn restarting_the_application_must_settle_calls_left_running_by_a_dead_process() {
    let (directory, store) = fixtures::temp_store().await;
    let model = store.create_model(&input("crash", 0)).await.unwrap();
    store
        .start_llm_call(&NewLlmCall {
            call_id: "external-api:crashed".into(),
            run_id: "external-api:crashed".into(),
            conversation_id: "external-api:crashed".into(),
            provider_call_index: 0,
            model_hash: model.model_hash.clone(),
            provider_type: ProviderType::OpenAiChat,
            provider_url: "https://example.com/v1/chat/completions".into(),
            request_type: ProviderType::OpenAiChat,
            request_url: "https://example.com/v1/chat/completions".into(),
            model_id: "crash".into(),
            display_name: "crash".into(),
            reasoning_effort: None,
            fast: false,
            message_count: 1,
            tool_count: 0,
            detailed: false,
        })
        .await
        .unwrap();
    store.pool().close().await;
    let app = App::new(Config {
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        database_url: format!("sqlite://{}", directory.path().join("test.db").display()),
        provider_request_timeout: Duration::from_secs(5),
        provider_stream_idle_timeout: Duration::from_secs(5),
        console: None,
        use_persisted_ports: false,
        app_version: "1.1.4".into(),
    })
    .await
    .unwrap();
    let call = app.store().llm_calls(10).await.unwrap().remove(0);
    let health = app.store().model_health().await.unwrap().remove(0);
    eprintln!(
        "AUDIT restart: status={} finished_at_ms={:?} health.running={}",
        call.status, call.finished_at_ms, health.running
    );
    drop(app);
    assert_ne!(
        call.status, "running",
        "a new process cannot keep a dead process's HTTP call running"
    );
}

async fn capability_race(delete: bool) {
    let (_directory, store) = fixtures::temp_store().await;
    let original = store
        .create_model(&input("capability-race", 0))
        .await
        .unwrap();
    let id = original.model_hash.clone();
    let (service, provider) = control(&store).await;
    let ready = provider.push_gated(vec![
        ModelEvent::TextDelta("1 ".into()),
        ModelEvent::TextDelta("2".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let test_id = id.clone();
    let task = tokio::spawn(async move {
        service
            .test_capability(&test_id, "racing-probe", Capability::Streaming)
            .await
            .unwrap()
    });
    wait_for_request(&provider).await;
    if delete {
        store.delete_model(&id).await.unwrap();
    } else {
        let mut next = ModelConfigInput::from(&original);
        next.base_url = "https://changed-endpoint.example.com/v1".into();
        next.api_key = "changed-dummy-key".into();
        store.update_model(&id, &next).await.unwrap();
    }
    assert!(store.capability_results().await.unwrap().is_empty());
    ready.notify_one();
    let response = task.await.unwrap();
    let results = store.capability_results().await.unwrap();
    eprintln!(
        "AUDIT capability {}: returned_status={} persisted_results={} model_exists={}",
        if delete { "delete" } else { "edit" },
        response.status,
        results.len(),
        store.model(&id).await.unwrap().is_some()
    );
    assert!(results.is_empty(),"completion of an outdated probe must not restore results invalidated by model editing or deletion");
}

#[tokio::test]
async fn editing_a_model_must_discard_the_outstanding_probe_for_its_old_configuration() {
    capability_race(false).await;
}

#[tokio::test]
async fn deleting_a_model_must_not_allow_an_outstanding_probe_to_recreate_its_results() {
    capability_race(true).await;
}

#[tokio::test]
async fn deleting_a_group_must_not_depend_on_the_display_order_of_internal_fallback_links() {
    let (_directory, store) = fixtures::temp_store().await;
    let target = store.create_model(&input("backup-first", 0)).await.unwrap();
    let mut source = input("primary-second", 1);
    source.fallback_model_hash = Some(target.model_hash);
    store.create_model(&source).await.unwrap();
    let group = store.models().await.unwrap();
    store
        .delete_models(
            &group
                .into_iter()
                .map(|model| model.model_hash)
                .collect::<Vec<_>>(),
        )
        .await
        .unwrap();
    let remaining = store.models().await.unwrap();
    eprintln!(
        "AUDIT group delete: remaining={:?}",
        remaining
            .iter()
            .map(|m| &m.display_name)
            .collect::<Vec<_>>()
    );
    assert!(
        remaining.is_empty(),
        "deleting a whole group with only internal fallback references must delete every member"
    );
}

async fn failover(status: u16) -> (RunOutcome, usize) {
    let (_directory, store) = fixtures::temp_store().await;
    let backup = store.create_model(&input("backup", 1)).await.unwrap();
    let mut primary = input("primary", 0);
    primary.fallback_model_hash = Some(backup.model_hash);
    let primary = store.create_model(&primary).await.unwrap();
    let conversation_id = ConversationId::new(format!("fallback-{status}"));
    let base_checkpoint_id = store.ensure_conversation(&conversation_id).await.unwrap();
    let prepared = PreparedRun {
        run_id: RunId::new(format!("fallback-{status}")),
        cursor_request_id: None,
        conversation_id,
        kind: RunKind::Root,
        model: ModelSpec::new(primary.model_hash),
        prompt: PromptSpec {
            instructions: String::new(),
            tools: Vec::new(),
        },
        initial_messages: Vec::new(),
        action: RunAction::Resume {
            pending_tool_round: None,
        },
        base_checkpoint_id,
    };
    let provider = fake_provider::FakeProvider::default();
    provider.push_error(Error::Provider(format!(
        "OpenAI {status}: upstream request rejected"
    )));
    provider.push(vec![
        ModelEvent::Start {
            model_call_id: "backup".into(),
        },
        ModelEvent::TextStart,
        ModelEvent::TextDelta("recovered".into()),
        ModelEvent::TextEnd,
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let observed = provider.clone();
    let (port, mut session, handle) = run::channel(prepared.run_id.clone(), 32);
    let cancellation = handle.cancellation();
    let task = tokio::spawn(async move {
        RunEngine::new(store, Arc::new(provider))
            .run(prepared, port, cancellation)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = session.events.recv().await {
            match event {
                RunEvent::MessagesCommitted(committed) => committed.barrier.complete(Ok(())),
                RunEvent::Ended(_) => break,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let outcome = task.await.unwrap();
    eprintln!(
        "AUDIT failover {status}: outcome={outcome:?} provider_calls={}",
        observed.requests().len()
    );
    (outcome, observed.requests().len())
}

#[tokio::test]
async fn a_configured_backup_must_be_tried_when_the_primary_rejects_credentials_or_model_before_output(
) {
    let mut observations = Vec::new();
    for status in [401, 403, 404] {
        observations.push((status, failover(status).await));
    }
    assert!(observations.iter().all(|(_, (outcome,calls))| *outcome==RunOutcome::Completed && *calls==2),"permanent errors on one endpoint must not disable a distinct configured backup: {observations:?}");
}

#[tokio::test]
async fn baseline_a_temporary_primary_failure_does_use_the_configured_backup() {
    assert_eq!(failover(503).await, (RunOutcome::Completed, 2));
}

#[tokio::test]
async fn a_failed_batch_update_leaves_every_model_and_its_capability_results_unchanged() {
    let (_directory, store) = fixtures::temp_store().await;
    let first = store.create_model(&input("first", 0)).await.unwrap();
    let second = store.create_model(&input("second", 1)).await.unwrap();
    let revision = store.capability_revision(&first.model_hash).await.unwrap();
    let result = cursor_server::store::CapabilityResult {
        model_id: first.model_hash.clone(),
        capability: "streaming".into(),
        status: "passed".into(),
        tested_at_ms: 1,
        duration_ms: 1,
        detail: "previous result".into(),
    };
    assert!(store
        .save_current_capability_result(&result, revision)
        .await
        .unwrap());
    let mut changed = ModelConfigInput::from(&first);
    changed.base_url = "https://changed.example.com/v1".into();
    let mut invalid = ModelConfigInput::from(&second);
    invalid.fallback_model_hash = Some("missing-backup".into());
    assert!(store
        .update_models(&[
            (first.model_hash.clone(), changed),
            (second.model_hash.clone(), invalid)
        ])
        .await
        .is_err());
    assert_eq!(
        store
            .model(&first.model_hash)
            .await
            .unwrap()
            .unwrap()
            .base_url,
        first.base_url,
        "the first row must roll back when the last row violates a constraint"
    );
    assert_eq!(
        store.capability_revision(&first.model_hash).await.unwrap(),
        revision
    );
    assert_eq!(
        store.capability_results().await.unwrap().len(),
        1,
        "failed editing must preserve valid capability results"
    );
}

#[tokio::test]
async fn removing_a_plugin_used_by_commit_or_review_preserves_its_saved_accounts() {
    for auto_review in [false, true] {
        let (_directory, store) = fixtures::temp_store().await;
        let plugin = "dev.cursorbyok.regression.referenced-plugin";
        let root = std::path::PathBuf::from(std::env::var_os("CURSOR_BYOK_DATA_DIR").unwrap())
            .join("plugins/data")
            .join(plugin);
        std::fs::create_dir_all(&root).unwrap();
        let saved = root.join("resources-account.json");
        std::fs::write(&saved, b"[]").unwrap();
        let id = format!("plugin:{plugin}/codex/model");
        if auto_review {
            store.set_auto_review_model(Some(id)).await.unwrap();
        } else {
            store
                .set_commit_settings(cursor_server::store::CommitSettings {
                    model_id: id,
                    ..Default::default()
                })
                .await
                .unwrap();
        }
        let (service, _) = control(&store).await;
        assert!(
            service.remove_plugin_configuration(plugin).await.is_err(),
            "plugin removal must reject a model still selected by Commit or auto-review"
        );
        assert!(
            saved.exists(),
            "rejecting removal must preserve plugin credentials"
        );
    }
}

#[tokio::test]
async fn a_group_with_external_references_cannot_be_partially_deleted() {
    let (_directory, store) = fixtures::temp_store().await;
    let first = store.create_model(&input("first", 0)).await.unwrap();
    let second = store.create_model(&input("second", 1)).await.unwrap();
    let mut outside = input("outside", 2);
    outside.fallback_model_hash = Some(second.model_hash.clone());
    store.create_model(&outside).await.unwrap();
    assert!(store
        .delete_models(&[first.model_hash.clone(), second.model_hash.clone()])
        .await
        .is_err());
    assert_eq!(
        store.models().await.unwrap().len(),
        3,
        "an external reference must leave the whole group intact"
    );
}

#[tokio::test]
async fn invalidating_a_plugin_discards_pending_probes_without_touching_other_plugins() {
    let (_directory, store) = fixtures::temp_store().await;
    for plugin in ["dev.example", "dev.example-other"] {
        let id = format!("plugin:{plugin}/provider/model");
        let revision = store.capability_revision(&id).await.unwrap();
        let result = cursor_server::store::CapabilityResult {
            model_id: id,
            capability: "streaming".into(),
            status: "passed".into(),
            tested_at_ms: 1,
            duration_ms: 1,
            detail: "previous result".into(),
        };
        assert!(store
            .save_current_capability_result(&result, revision)
            .await
            .unwrap());
    }
    let id = "plugin:dev.example/provider/model";
    let revision = store.capability_revision(id).await.unwrap();
    store
        .invalidate_plugin_capabilities("dev.example")
        .await
        .unwrap();
    let result = cursor_server::store::CapabilityResult {
        model_id: id.into(),
        capability: "streaming".into(),
        status: "passed".into(),
        tested_at_ms: 2,
        duration_ms: 1,
        detail: "late result".into(),
    };
    assert!(!store
        .save_current_capability_result(&result, revision)
        .await
        .unwrap());
    assert_eq!(
        store.capability_results().await.unwrap()[0].model_id,
        "plugin:dev.example-other/provider/model"
    );
}

#[tokio::test]
#[ignore = "requires CURSOR_REVIEW_DATABASE_COPY pointing to target/fixes-v1.1.4/real-database-copy.db"]
async fn upgrading_a_real_database_copy_preserves_rows_and_recovery_checkpoints() {
    use std::collections::BTreeMap;
    let path = std::path::PathBuf::from(
        std::env::var_os("CURSOR_REVIEW_DATABASE_COPY").expect("database copy required"),
    )
    .canonicalize()
    .unwrap();
    let allowed = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../target/fixes-v1.1.4")
        .canonicalize()
        .unwrap();
    assert_eq!(
        path.parent(),
        Some(allowed.as_path()),
        "measurement only permits the disposable workspace copy"
    );
    assert_eq!(path.file_name().unwrap(), "real-database-copy.db");
    let url = format!(
        "sqlite://{}",
        path.to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .replace('\\', "/")
    );
    async fn rows(pool: &sqlx::SqlitePool) -> BTreeMap<String, i64> {
        let tables:Vec<String>=sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetch_all(pool).await.unwrap();
        let mut counts = BTreeMap::new();
        for table in tables {
            let count = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM \"{}\"",
                table.replace('"', "\"\"")
            ))
            .fetch_one(pool)
            .await
            .unwrap();
            counts.insert(table, count);
        }
        counts
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    let before = rows(&pool).await;
    pool.close().await;
    let before_bytes = std::fs::metadata(&path).unwrap().len();
    let store = Store::connect(&url).await.unwrap();
    store.settle_interrupted_calls().await.unwrap();
    let after = rows(store.pool()).await;
    for (table, count) in &before {
        if table != "_sqlx_migrations" {
            assert_eq!(
                after.get(table),
                Some(count),
                "upgrade and recovery must preserve rows in {table}"
            );
        }
    }
    assert_eq!(after.get("model_capability_revisions"), Some(&0));
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(store.pool())
        .await
        .unwrap();
    store.pool().close().await;
    let report = json!({"before":{"bytes":before_bytes,"rows":before},"after":{"bytes":std::fs::metadata(&path).unwrap().len(),"rows":after}});
    std::fs::write(
        allowed.join("database-after.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{report}");
}
