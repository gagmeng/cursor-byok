//! Verifies connection evidence, health statistics, and isolated capability probes.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use cursor_server::{
    control::ControlService,
    model::ModelConfigInput,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::{FinishReason, ModelEvent},
};
use serde_json::json;
use std::sync::Arc;

async fn service() -> (
    tempfile::TempDir,
    cursor_server::store::Store,
    ControlService,
    fake_provider::FakeProvider,
    String,
) {
    let (dir, store) = fixtures::temp_store().await;
    let input: ModelConfigInput = serde_json::from_value(json!({"display_name":"test", "type":"openai", "base_url":"https://example.com", "api_key":"test-key", "model_id":"test", "tooltip_data":"test"})).unwrap();
    let id = store.create_model(&input).await.unwrap().model_hash;
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "test".into()).unwrap();
    let provider = fake_provider::FakeProvider::default();
    let service = ControlService::new(
        store.clone(),
        Arc::new(provider.clone()),
        runtime,
        plugins,
        NetworkClients::new(store.clone()),
        "test".into(),
    )
    .unwrap();
    (dir, store, service, provider, id)
}

#[tokio::test]
async fn a_direct_probe_never_claims_cursor_or_ssh_has_been_verified() {
    let (_dir, _store, service, provider, id) = service().await;
    provider.push(vec![
        ModelEvent::TextDelta("ok".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    service.test_model(&id, "direct-test").await.unwrap();
    let diagnostics =
        serde_json::to_value(service.connection_diagnostics().await.unwrap()).unwrap();
    assert_eq!(diagnostics["sessions"], json!([]));
}

#[tokio::test]
async fn capability_results_require_semantic_evidence_and_remain_available_after_restart() {
    use cursor_server::control::Capability;
    let (dir, store, service, provider, id) = service().await;
    provider.push(vec![
        ModelEvent::TextDelta("I cannot call tools".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let result = service
        .test_capability(&id, "tools-failure", Capability::Tools)
        .await
        .unwrap();
    assert_eq!(result.status, "failed");
    provider.push(vec![
        ModelEvent::ThinkingDelta("Use the requested diagnostic tool.".into()),
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: "echo-1".into(),
            name: "diagnostic_echo".into(),
        },
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: r#"{"value":"BYOK_TOOL_OK"}"#.into(),
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    provider.push(vec![
        ModelEvent::TextDelta("BYOK_TOOL_OK".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let result = service
        .test_capability(&id, "tools-success", Capability::Tools)
        .await
        .unwrap();
    assert_eq!(result.status, "passed");
    let requests = provider.requests();
    assert_eq!(
        requests[2].history[..1],
        requests[1].history,
        "tool continuation preserves its input prefix"
    );
    let cursor_server::model::ProjectedContent::Assistant { thinking, .. } =
        &requests[2].history[1].content
    else {
        panic!("tool continuation requires assistant history")
    };
    assert_eq!(
        thinking, "Use the requested diagnostic tool.",
        "tool continuation must preserve provider reasoning alongside replay metadata"
    );
    drop(service);
    store.pool().close().await;
    let reopened = cursor_server::store::Store::connect(&format!(
        "sqlite://{}",
        dir.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let results = reopened.capability_results().await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, "passed");
}

#[tokio::test]
async fn streaming_and_vision_need_incremental_and_visual_evidence() {
    use cursor_server::control::Capability;
    let (_dir, _store, service, provider, id) = service().await;
    for (test, capability, events, expected) in [
        (
            "one-chunk",
            Capability::Streaming,
            vec![
                ModelEvent::TextDelta("one chunk".into()),
                ModelEvent::Done(FinishReason::Stop),
            ],
            "inconclusive",
        ),
        (
            "no-completion",
            Capability::Streaming,
            vec![
                ModelEvent::TextDelta("1 ".into()),
                ModelEvent::TextDelta("2".into()),
            ],
            "failed",
        ),
        (
            "incremental",
            Capability::Streaming,
            vec![
                ModelEvent::TextDelta("1 ".into()),
                ModelEvent::TextDelta("2".into()),
                ModelEvent::Done(FinishReason::Stop),
            ],
            "passed",
        ),
        (
            "wrong-color",
            Capability::Vision,
            vec![
                ModelEvent::TextDelta("green".into()),
                ModelEvent::Done(FinishReason::Stop),
            ],
            "failed",
        ),
        (
            "right-color",
            Capability::Vision,
            vec![
                ModelEvent::TextDelta("red".into()),
                ModelEvent::Done(FinishReason::Stop),
            ],
            "passed",
        ),
    ] {
        provider.push(events);
        assert_eq!(
            service
                .test_capability(&id, test, capability)
                .await
                .unwrap()
                .status,
            expected,
            "{test}"
        );
    }
    let request = provider.requests().pop().unwrap();
    let cursor_server::model::ProjectedContent::Parts(parts) = &request.history[0].content else {
        panic!("vision requires image input")
    };
    assert!(parts.iter().any(|part| matches!(part, cursor_server::model::ContentPart::Image { data, .. } if !data.is_empty())));
    assert_eq!(request.model.max_output_tokens, Some(2048));
}

#[tokio::test]
async fn a_diagnostic_challenge_only_accepts_its_own_cursor_request() {
    let (_dir, store, _service, _provider, _id) = service().await;
    let session = store.start_connection_diagnostic("ssh").await.unwrap();
    store
        .observe_diagnostic_request("unrelated", "conversation", b"hello")
        .await
        .unwrap();
    assert!(store.connection_diagnostic_sessions().await.unwrap()[0]
        .request_id
        .is_none());
    store
        .observe_diagnostic_request("matching", "conversation", session.marker.as_bytes())
        .await
        .unwrap();
    assert_eq!(
        store.connection_diagnostic_sessions().await.unwrap()[0]
            .request_id
            .as_deref(),
        Some("matching")
    );
    store
        .observe_diagnostic_request("duplicate", "other", session.marker.as_bytes())
        .await
        .unwrap();
    assert_eq!(
        store.connection_diagnostic_sessions().await.unwrap()[0]
            .request_id
            .as_deref(),
        Some("matching")
    );
}

#[tokio::test]
async fn cancelled_probes_return_promptly_even_when_the_provider_stops_sending_events() {
    use cursor_server::control::Capability;
    let (_dir, _store, service, provider, id) = service().await;
    provider.push_pending();
    let running = tokio::spawn({
        let service = service.clone();
        let id = id.clone();
        async move {
            service
                .test_capability(&id, "cancel-pending", Capability::Streaming)
                .await
        }
    });
    tokio::task::yield_now().await;
    service.cancel_model_test("cancel-pending");
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.status, "cancelled");
}

#[tokio::test]
async fn cache_continuation_without_a_reported_hit_remains_unverified() {
    use cursor_server::control::Capability;
    let (_dir, _store, service, provider, id) = service().await;
    provider.push(vec![
        ModelEvent::TextDelta("READY".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    provider.push(vec![
        ModelEvent::TextDelta("BLUE".into()),
        ModelEvent::Done(FinishReason::Stop),
    ]);
    let result = service
        .test_capability(&id, "cache-inconclusive", Capability::Cache)
        .await
        .unwrap();
    assert_eq!(result.status, "inconclusive");
    let requests = provider.requests();
    assert_eq!(&requests[1].history[..1], requests[0].history.as_slice());
    assert_eq!(requests[0].prompt, requests[1].prompt);
}

#[tokio::test]
async fn health_excludes_probes_cancellations_and_running_calls_from_success_rate() {
    use cursor_server::model::{NewLlmCall, ProviderType};
    let (_dir, store, _service, _provider, id) = service().await;
    for (call, status) in [
        ("real-success", "completed"),
        ("real-failure", "error"),
        ("real-cancelled", "cancelled"),
        ("real-running", "running"),
        ("capability-probe", "error"),
        ("model-test-probe", "error"),
    ] {
        store
            .start_llm_call(&NewLlmCall {
                call_id: call.into(),
                run_id: call.into(),
                conversation_id: call.into(),
                provider_call_index: 0,
                model_hash: id.clone(),
                provider_type: ProviderType::OpenAiChat,
                provider_url: "https://example.com".into(),
                request_type: ProviderType::OpenAiChat,
                request_url: "https://example.com/v1/chat/completions".into(),
                model_id: "test".into(),
                display_name: "test".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            })
            .await
            .unwrap();
        if status != "running" {
            store
                .finish_llm_call(call, status, None, 1000, None, None)
                .await
                .unwrap();
        }
    }
    let health = store.model_health().await.unwrap();
    assert_eq!(health.len(), 1);
    assert_eq!(
        (
            health[0].completed,
            health[0].failed,
            health[0].cancelled,
            health[0].running
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(health[0].success_rate, Some(0.5));
}

#[tokio::test]
async fn cursor_wire_records_request_stream_provider_and_matching_tool_evidence() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
        routing::post,
        Router,
    };
    use cursor_server::{
        cursor::{
            prompting::{PromptAssets, PromptCompiler},
            protocol::{
                connect,
                proto::{agent::v1 as pb, aiserver::v1 as ai},
            },
            TransportRegistry,
        },
        provider::ProviderRouter,
    };
    use futures_util::StreamExt;
    use prost::Message;
    use tower::ServiceExt;
    let (_dir, store) = fixtures::temp_store().await;
    let challenge = store.start_connection_diagnostic("ssh").await.unwrap();
    let sequence = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let marker = challenge.marker.clone();
    let upstream = Router::new().route("/", post(move || {
        let marker = marker.clone();
        let index = sequence.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        async move {
            let value = if index == 0 {
                json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"diagnostic-shell","type":"function","function":{"name":"Shell","arguments":serde_json::to_string(&json!({"command":format!("echo {marker}")})).unwrap()}}]},"finish_reason":"tool_calls"}]})
            } else { json!({"choices":[{"delta":{"content":marker},"finish_reason":"stop"}]}) };
            ([("content-type","text/event-stream")], format!("data: {value}\n\ndata: [DONE]\n\n"))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}/", listener.local_addr().unwrap());
    let upstream_task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    let input: ModelConfigInput=serde_json::from_value(json!({"display_name":"wire diagnostic","type":"openai","base_url":upstream_url,"use_full_url":true,"api_key":"fixture","model_id":"fixture","tooltip_data":"fixture","openai_endpoint":"/v1/chat/completions"})).unwrap();
    let model = store.create_model(&input).await.unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime, "test".into()).unwrap();
    let clients = NetworkClients::new(store.clone());
    let provider = Arc::new(ProviderRouter::new(
        store.clone(),
        plugins,
        clients.clone(),
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(5),
    ));
    let registry = TransportRegistry::new(
        store.clone(),
        provider,
        PromptCompiler::new(PromptAssets::embedded().unwrap()),
    );
    let router = cursor_server::api::cursor::router(registry.clone(), clients).unwrap();
    let sse = tokio::spawn(
        router.clone().oneshot(
            Request::post("/agent.v1.AgentService/RunSSE")
                .header("content-type", "application/proto")
                .body(Body::from(
                    pb::BidiRequestId {
                        request_id: "diagnostic-wire".into(),
                    }
                    .encode_to_vec(),
                ))
                .unwrap(),
        ),
    );
    let run = pb::AgentClientMessage {
        message: Some(pb::agent_client_message::Message::RunRequest(
            pb::AgentRunRequest {
                conversation_id: Some("diagnostic-conversation".into()),
                run_id: Some("diagnostic-run".into()),
                requested_model: Some(pb::RequestedModel {
                    model_id: model.model_hash,
                    ..Default::default()
                }),
                action: Some(pb::ConversationAction {
                    action: Some(pb::conversation_action::Action::UserMessageAction(
                        pb::UserMessageAction {
                            user_message: Some(pb::UserMessage {
                                text: format!("Use Shell to echo {}", challenge.marker),
                                message_id: "diagnostic-user".into(),
                                mode: pb::AgentMode::Agent as i32,
                                ..Default::default()
                            }),
                            ..Default::default()
                        },
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )),
    };
    let append = |message: pb::AgentClientMessage, seqno: i64| {
        let router = router.clone();
        async move {
            let response = router
                .oneshot(
                    Request::post("/aiserver.v1.BidiService/BidiAppend")
                        .header("content-type", "application/proto")
                        .body(Body::from(
                            ai::BidiAppendRequest {
                                request_id: Some(ai::BidiRequestId {
                                    request_id: "diagnostic-wire".into(),
                                }),
                                append_seqno: seqno,
                                data_binary: message.encode_to_vec(),
                                ..Default::default()
                            }
                            .encode_to_vec(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(
                response.status().is_success(),
                "{:?}",
                to_bytes(response.into_body(), 65536).await.unwrap()
            );
        }
    };
    append(run, 0).await;
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), sse)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(response.status().is_success());
    let mut stream = response.into_body().into_data_stream();
    let mut next = 1;
    loop {
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&bytes).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&payload).unwrap(),
                json!({})
            );
            break;
        }
        let message = pb::AgentServerMessage::decode(payload).unwrap();
        match message.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                append(
                    pb::AgentClientMessage {
                        message: Some(pb::agent_client_message::Message::KvClientMessage(
                            pb::KvClientMessage {
                                id: kv.id,
                                message: Some(pb::kv_client_message::Message::SetBlobResult(
                                    pb::SetBlobResult { error: None },
                                )),
                            },
                        )),
                    },
                    next,
                )
                .await;
                next += 1;
            }
            Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                assert!(matches!(
                    exec.message,
                    Some(pb::exec_server_message::Message::ShellStreamArgs(_))
                ));
                assert!(
                    store.connection_diagnostic_sessions().await.unwrap()[0]
                        .tool_result_at_ms
                        .is_none(),
                    "requesting a tool alone cannot verify a roundtrip"
                );
                for event in [
                    pb::shell_stream::Event::Stdout(pb::ShellStreamStdout {
                        data: challenge.marker.clone(),
                    }),
                    pb::shell_stream::Event::Exit(pb::ShellStreamExit {
                        code: 0,
                        cwd: "/isolated/ssh".into(),
                        ..Default::default()
                    }),
                ] {
                    append(
                        pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::ExecClientMessage(
                                pb::ExecClientMessage {
                                    id: exec.id,
                                    message: Some(pb::exec_client_message::Message::ShellStream(
                                        pb::ShellStream { event: Some(event) },
                                    )),
                                    ..Default::default()
                                },
                            )),
                        },
                        next,
                    )
                    .await;
                    next += 1;
                }
            }
            _ => {}
        }
    }
    let evidence = store
        .connection_diagnostic_sessions()
        .await
        .unwrap()
        .remove(0);
    assert_eq!(evidence.scope, "ssh");
    assert_eq!(evidence.request_id.as_deref(), Some("diagnostic-wire"));
    assert!(evidence.request_seen_at_ms.is_some() && evidence.stream_seen_at_ms.is_some());
    assert!(
        evidence.upstream_response_at_ms.is_some(),
        "actual HTTP provider response must be associated with the diagnostic request"
    );
    assert!(
        evidence.tool_result_at_ms.is_some(),
        "only a successful matching tool output verifies the roundtrip"
    );
    registry.shutdown().await;
    upstream_task.abort();
}
