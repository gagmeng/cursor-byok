//! Verifies that a local magpie gateway's models can be previewed and imported.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::{collections::BTreeSet, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::get,
    Json, Router,
};
use cursor_server::{
    control::{self, ControlService},
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    store::Store,
};
use serde_json::{json, Value};
use tower::ServiceExt;

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
    let session = router
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
    let cookie = session.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", "127.0.0.1:3000")
                .header("cookie", cookie)
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

/// 本机假 magpie:hello 与模型目录,`models` 由每个测试给出。
async fn serve_gateway(models: Value) -> String {
    let router = Router::new()
        .route(
            "/api/hello",
            get(|| async { Json(json!({"name": "magpie", "version": "0.1.3359"})) }),
        )
        .route(
            "/v1/models",
            get(move || async move { Json(json!({"data": models})) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    address
}

fn catalog() -> Value {
    json!([
        {
            "id": "trae-cn/glm-5.3",
            "display_name": "GLM-5.3",
            "owned_by": "trae-cn",
            "context_window": 116000,
            "max_output_tokens": 16000
        },
        {
            "id": "auto/glm-5.3-flash",
            "display_name": "GLM-5.3-Flash",
            "owned_by": "unittec",
            "context_length": 1000000,
            "max_output_tokens": 131072
        },
        {
            "id": "zcode/GLM-5.2",
            "display_name": "GLM-5.2",
            "owned_by": "zcode",
            "native_endpoints": ["/v1/messages"]
        }
    ])
}

async fn preview(router: Router, address: &str) -> (StatusCode, Value) {
    request(
        router,
        "GET",
        &format!("/__byok-api__/api/magpie?address={address}"),
        json!(null),
    )
    .await
}

#[tokio::test]
async fn a_reachable_gateway_lists_its_models_for_import() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = preview(control_router(&store).await, &address).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["address"], address);
    assert_eq!(body["version"], "0.1.3359");

    let models = body["models"].as_array().unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(models[0]["model_id"], "trae-cn/glm-5.3");
    assert_eq!(models[0]["provider"], "trae-cn");
    assert_eq!(models[0]["endpoint"], "openai-chat");
    assert_eq!(models[0]["context_window_tokens"], 116_000);
    assert_eq!(models[2]["endpoint"], "anthropic");
    // 全新数据库里没有任何一个已存在。
    assert!(models.iter().all(|model| model["existing"] == false));
}

#[tokio::test]
async fn routing_groups_are_listed_apart_from_their_member_providers() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = preview(control_router(&store).await, &address).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let models = body["models"].as_array().unwrap();

    // auto/ 是 magpie 的路由组(跨供应商负载均衡),owned_by 只是首个成员供应商;
    // 预览必须标出来,前端才能把它单独成组而不是混进供应商分组。
    let routing = models
        .iter()
        .find(|model| model["model_id"] == "auto/glm-5.3-flash")
        .unwrap();
    assert_eq!(routing["routing_group"], true);
    assert_eq!(routing["provider"], "auto");

    let provider = models
        .iter()
        .find(|model| model["model_id"] == "trae-cn/glm-5.3")
        .unwrap();
    assert_eq!(provider["routing_group"], false);
    assert_eq!(provider["provider"], "trae-cn");
}

#[tokio::test]
async fn a_gateway_that_is_not_magpie_is_reported_not_imported() {
    let router = Router::new().route(
        "/api/hello",
        get(|| async { Json(json!({"name": "some-proxy"})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = preview(control_router(&store).await, &address).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not a magpie gateway"),
        "{body}"
    );
}

#[tokio::test]
async fn a_gateway_that_is_not_running_is_reported_as_unavailable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap().to_string();
    drop(listener);
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = preview(control_router(&store).await, &address).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("not reachable"),
        "{body}"
    );
}

#[tokio::test]
async fn importing_a_gateway_adds_every_selected_model_once() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;
    let router = control_router(&store).await;

    let (status, body) = request(
        router.clone(),
        "POST",
        "/__byok-api__/api/magpie/import",
        json!({ "address": address, "model_ids": ["trae-cn/glm-5.3", "auto/glm-5.3-flash"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["imported"], 2);
    assert_eq!(body["skipped"], 0);
    assert_eq!(body["total"], 2);

    let models = store.models().await.unwrap();
    assert_eq!(models.len(), 2);
    let imported: BTreeSet<_> = models.iter().map(|model| model.model_id.as_str()).collect();
    assert_eq!(
        imported,
        BTreeSet::from(["auto/glm-5.3-flash", "trae-cn/glm-5.3"])
    );
    // 分组名承载 magpie 的 provider,这样「按供应商」视图与 magpie 一致。
    let trae = models
        .iter()
        .find(|model| model.model_id == "trae-cn/glm-5.3")
        .unwrap();
    assert_eq!(trae.group_name.as_deref(), Some("trae-cn"));
    assert_eq!(trae.base_url, format!("http://{address}/v1"));
}

#[tokio::test]
async fn importing_the_same_gateway_twice_adds_no_rows() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;
    let router = control_router(&store).await;
    let body = json!({
        "address": address,
        "model_ids": ["trae-cn/glm-5.3", "auto/glm-5.3-flash", "zcode/GLM-5.2"]
    });

    let (_, first) = request(
        router.clone(),
        "POST",
        "/__byok-api__/api/magpie/import",
        body.clone(),
    )
    .await;
    assert_eq!(first["imported"], 3);

    let (status, second) = request(
        router.clone(),
        "POST",
        "/__byok-api__/api/magpie/import",
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["imported"], 0);
    assert_eq!(second["skipped"], 3);
    assert_eq!(store.models().await.unwrap().len(), 3);

    // 预览也必须如实报告已存在,否则用户会以为又要新增一遍。
    let (_, preview) = preview(router, &address).await;
    assert!(preview["models"]
        .as_array()
        .unwrap()
        .iter()
        .all(|model| model["existing"] == true));
}

#[tokio::test]
async fn importing_only_the_models_the_user_selected() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = request(
        control_router(&store).await,
        "POST",
        "/__byok-api__/api/magpie/import",
        json!({ "address": address, "model_ids": ["zcode/GLM-5.2"] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["imported"], 1);

    let models = store.models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].model_id, "zcode/GLM-5.2");
    // 只有 Messages 的模型必须按 Anthropic 导入,否则会被上游拒绝。
    assert_eq!(models[0].provider_type().to_string(), "anthropic");
}

#[tokio::test]
async fn importing_no_models_changes_nothing() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = request(
        control_router(&store).await,
        "POST",
        "/__byok-api__/api/magpie/import",
        json!({ "address": address, "model_ids": [] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["imported"], 0);
    assert_eq!(body["total"], 0);
    assert!(store.models().await.unwrap().is_empty());
}

#[tokio::test]
async fn an_empty_catalog_previews_as_an_empty_list() {
    let address = serve_gateway(json!([])).await;
    let (_directory, store) = fixtures::temp_store().await;

    let (status, body) = preview(control_router(&store).await, &address).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["models"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_model_removed_since_preview_rejects_the_entire_import_without_saving_a_subset() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;
    let (status, body) = request(
        control_router(&store).await,
        "POST",
        "/__byok-api__/api/magpie/import",
        json!({"address":address,"model_ids":["zcode/GLM-5.2","provider/removed"]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        store.models().await.unwrap().is_empty(),
        "a stale catalog must ask the user to query again rather than silently import a subset"
    );
}

#[tokio::test]
async fn resynchronizing_keeps_renamed_magpie_models_and_their_saved_credentials() {
    let address = serve_gateway(catalog()).await;
    let (_directory, store) = fixtures::temp_store().await;
    let router = control_router(&store).await;
    let body = json!({"address":address,"model_ids":["zcode/GLM-5.2"]});
    assert_eq!(
        request(
            router.clone(),
            "POST",
            "/__byok-api__/api/magpie/import",
            body.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    let original = store.models().await.unwrap().remove(0);
    let mut edited = cursor_server::model::ModelConfigInput::from(&original);
    edited.display_name = "My coding model".into();
    edited.api_key = "my-magpie-client".into();
    store
        .update_model(&original.model_hash, &edited)
        .await
        .unwrap();
    let (_, preview) = preview(router.clone(), &address).await;
    assert!(
        preview["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["model_id"] == "zcode/GLM-5.2" && model["existing"] == true),
        "sync must recognize a model after the user edits its name or key"
    );
    let (_, result) = request(router, "POST", "/__byok-api__/api/magpie/import", body).await;
    assert_eq!(result["imported"], 0);
    assert_eq!(result["skipped"], 1);
    let saved = store.models().await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].model_hash, original.model_hash);
    assert_eq!(saved[0].display_name, "My coding model");
    assert_eq!(saved[0].api_key, "my-magpie-client");
}
