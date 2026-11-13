//! Implements provider call inspection endpoints.
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::Result;

use super::{CallDetail, CallList, ControlService};
use crate::store::CallMatch;

#[derive(Deserialize)]
pub struct CallQuery {
    #[serde(default = "default_limit")]
    limit: i64,
    before_created_at_ms: Option<i64>,
    before_call_id: Option<String>,
    status: Option<String>,
    conversation_id: Option<String>,
    model: Option<String>,
}

pub async fn list(
    State(service): State<ControlService>,
    Query(query): Query<CallQuery>,
) -> Result<Json<CallList>> {
    let cursor = query.before_created_at_ms.zip(blank(query.before_call_id));
    Ok(Json(
        service
            .calls(CallMatch {
                limit: query.limit,
                before_created_at_ms: cursor.as_ref().map(|cursor| cursor.0),
                before_call_id: cursor.map(|cursor| cursor.1),
                status: blank(query.status),
                conversation_id: blank(query.conversation_id),
                model: blank(query.model),
            })
            .await?,
    ))
}

fn blank(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

pub async fn detail(
    State(service): State<ControlService>,
    Path(call_id): Path<String>,
) -> Result<Json<CallDetail>> {
    Ok(Json(service.call(&call_id).await?))
}

fn default_limit() -> i64 {
    100
}
