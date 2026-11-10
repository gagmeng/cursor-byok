//! Verifies that management requests require a same-origin local session.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use cursor_server::{
    control::{self, ControlService},
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
};
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn private_and_other_loopback_origins_cannot_read_or_change_management_data() {
    let (_dir, store) = fixtures::temp_store().await;
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "test".into()).unwrap();
    let service = ControlService::new(
        store.clone(),
        Arc::new(fake_provider::FakeProvider::default()),
        runtime,
        plugins,
        NetworkClients::new(store),
        "test".into(),
    )
    .unwrap();
    let router = control::api_router(service);
    for origin in [
        "http://192.168.56.1:8080",
        "http://127.0.0.1:9999",
        "https://example.com",
        "null",
    ] {
        for method in ["GET", "PUT"] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/__byok-api__/api/settings/ports")
                        .method(method)
                        .header("host", "127.0.0.1:3000")
                        .header("origin", origin)
                        .header("content-type", "application/json")
                        .body(Body::from(r#"{"service_port":0,"proxy_port":0}"#))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::FORBIDDEN,
                "{origin} {method}"
            );
        }
    }
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/models")
                .header("host", "127.0.0.1:3000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/session")
                .header("host", "127.0.0.1:3000")
                .header("x-cursor-byok-session", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/models")
                .header("host", "127.0.0.1:3000")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        &to_bytes(response.into_body(), 1024).await.unwrap()[..],
        b"[]"
    );
    let response = router
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/models")
                .header("host", "attacker.example:3000")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn listing_models_never_discloses_credentials() {
    let (_dir, store) = fixtures::temp_store().await;
    store.create_model(&serde_json::from_value(serde_json::json!({"display_name":"test","type":"openai","base_url":"https://example.com","api_key":"private-upstream-key","model_id":"test","tooltip_data":"test","custom_headers_enabled":true,"custom_headers":{"Authorization":"Bearer private-header"}})).unwrap()).await.unwrap();
    let runtime = PluginRuntime::managed().unwrap();
    let plugins = PluginRegistry::managed(store.clone(), runtime.clone(), "test".into()).unwrap();
    let service = ControlService::new(
        store.clone(),
        Arc::new(fake_provider::FakeProvider::default()),
        runtime,
        plugins,
        NetworkClients::new(store),
        "test".into(),
    )
    .unwrap();
    let router = control::api_router(service);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/session")
                .header("host", "127.0.0.1:3000")
                .header("x-cursor-byok-session", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let response = router
        .oneshot(
            Request::builder()
                .uri("/__byok-api__/api/models")
                .header("host", "127.0.0.1:3000")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!body.contains("private-upstream-key"));
    assert!(!body.contains("private-header"));
}
