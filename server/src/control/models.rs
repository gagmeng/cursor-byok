//! Implements model configuration endpoints.
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;

use crate::{
    model::{ModelConfig, ModelConfigInput},
    Result,
};

use super::{
    ControlService, DiscoveredModels, LegacyModelImportPreview, LegacyModelImportResult,
    MagpieImportPreview, ModelConnectivityResult, ModelDiscoveryInput,
};

#[derive(Deserialize)]
pub struct ImportMagpieModels {
    /// 用户勾选的模型 id;空数组表示一个都不导(不是"全部")。
    pub model_ids: Vec<String>,
    /// 显式指定的网关地址;缺省时由服务端按 MAGPIE_ADDR / settings.json / 默认端口探测。
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Deserialize)]
pub struct MagpiePreviewQuery {
    #[serde(default)]
    pub address: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveModels {
    pub models: Vec<ModelConfigInput>,
}

#[derive(Deserialize)]
pub struct DeleteModels {
    pub model_hashes: Vec<String>,
}

#[derive(Deserialize)]
pub struct UpdateModels {
    pub models: Vec<UpdateModel>,
}

#[derive(Deserialize)]
pub struct UpdateModel {
    pub model_hash: String,
    pub config: ModelConfigInput,
}

pub async fn remove_batch(
    State(service): State<ControlService>,
    Json(input): Json<DeleteModels>,
) -> Result<StatusCode> {
    service.store.delete_models(&input.model_hashes).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_batch(
    State(service): State<ControlService>,
    Json(input): Json<UpdateModels>,
) -> Result<Json<Vec<ModelConfig>>> {
    let inputs = input
        .models
        .into_iter()
        .map(|model| (model.model_hash, model.config))
        .collect::<Vec<_>>();
    Ok(Json(service.store.update_models(&inputs).await?))
}

pub async fn list(State(service): State<ControlService>) -> Result<Json<Vec<ModelConfig>>> {
    let mut models = service.models().await?;
    for model in &mut models {
        model.api_key.clear();
        model.custom_headers = serde_json::json!({});
    }
    Ok(Json(models))
}

pub async fn detail(
    State(service): State<ControlService>,
    Path(model_hash): Path<String>,
) -> Result<Json<ModelConfig>> {
    Ok(Json(service.store.model(&model_hash).await?.ok_or_else(
        || crate::Error::RunNotFound(format!("model {model_hash}")),
    )?))
}

pub async fn create(
    State(service): State<ControlService>,
    Json(input): Json<SaveModels>,
) -> Result<(StatusCode, Json<Vec<ModelConfig>>)> {
    Ok((
        StatusCode::CREATED,
        Json(service.create_models(&input.models).await?),
    ))
}

pub async fn remove(
    State(service): State<ControlService>,
    Path(model_hash): Path<String>,
) -> Result<StatusCode> {
    service.delete_model(&model_hash).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update(
    State(service): State<ControlService>,
    Path(model_hash): Path<String>,
    Json(input): Json<ModelConfigInput>,
) -> Result<Json<ModelConfig>> {
    Ok(Json(service.update_model(&model_hash, &input).await?))
}

pub async fn test(
    State(service): State<ControlService>,
    Path((model_hash, test_id)): Path<(String, String)>,
) -> Result<Json<ModelConnectivityResult>> {
    Ok(Json(service.test_model(&model_hash, &test_id).await?))
}

pub async fn cancel(
    State(service): State<ControlService>,
    Path((_model_hash, test_id)): Path<(String, String)>,
) -> Result<StatusCode> {
    service.cancel_model_test(&test_id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn discover(
    State(service): State<ControlService>,
    Json(input): Json<ModelDiscoveryInput>,
) -> Result<Json<DiscoveredModels>> {
    Ok(Json(service.discover_models(&input).await?))
}

pub async fn magpie_preview(
    State(service): State<ControlService>,
    Query(query): Query<MagpiePreviewQuery>,
) -> Result<Json<MagpieImportPreview>> {
    Ok(Json(service.magpie_models(query.address.as_deref()).await?))
}

pub async fn magpie_import(
    State(service): State<ControlService>,
    Json(input): Json<ImportMagpieModels>,
) -> Result<Json<LegacyModelImportResult>> {
    Ok(Json(
        service
            .import_magpie_models(input.address.as_deref(), &input.model_ids)
            .await?,
    ))
}

pub async fn import_v0049(
    State(service): State<ControlService>,
) -> Result<Json<LegacyModelImportResult>> {
    Ok(Json(service.import_v0049_models().await?))
}

pub async fn preview_v0049(
    State(service): State<ControlService>,
) -> Result<Json<LegacyModelImportPreview>> {
    Ok(Json(service.preview_v0049_models().await?))
}
