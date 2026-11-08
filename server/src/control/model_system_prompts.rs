//! Exposes per-model system prompt settings through the management HTTP API.
use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::{
    model::{ModelSystemPromptConfig, ModelSystemPromptSettings},
    Result,
};

use super::ControlService;

#[derive(Deserialize)]
pub struct ModelSelection {
    model_id: String,
}

pub async fn get(
    State(service): State<ControlService>,
    Query(selection): Query<ModelSelection>,
) -> Result<Json<ModelSystemPromptSettings>> {
    Ok(Json(
        service.model_system_prompt(&selection.model_id).await?,
    ))
}

pub async fn update(
    State(service): State<ControlService>,
    Json(input): Json<ModelSystemPromptConfig>,
) -> Result<Json<ModelSystemPromptSettings>> {
    Ok(Json(
        service
            .set_model_system_prompt(&input.model_id, &input.settings)
            .await?,
    ))
}
