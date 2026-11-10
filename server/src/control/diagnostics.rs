//! Exposes connection evidence and active model capability probes.
use super::ControlService;
use crate::{
    local_app::CursorHarnessStatus,
    store::{CapabilityResult, ConnectionDiagnostic, ModelHealth},
    Result,
};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Streaming,
    Tools,
    Vision,
    Cache,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::Tools => "tools",
            Self::Vision => "vision",
            Self::Cache => "cache",
        }
    }
}

#[derive(Deserialize)]
pub struct StartDiagnostic {
    scope: String,
}
#[derive(Deserialize)]
pub struct TestCapability {
    capability: Capability,
}

#[derive(Serialize)]
pub struct ConnectionDiagnostics {
    harness: CursorHarnessStatus,
    configured_models: usize,
    sessions: Vec<ConnectionDiagnostic>,
}

#[derive(Serialize)]
pub struct ModelDiagnostics {
    pub health: Vec<ModelHealth>,
    pub capabilities: Vec<CapabilityResult>,
}

impl ControlService {
    pub async fn connection_diagnostics(&self) -> Result<ConnectionDiagnostics> {
        let plugin_count = self
            .plugins
            .plugins()
            .await
            .iter()
            .flat_map(|p| &p.providers)
            .filter(|p| p.configured)
            .flat_map(|p| &p.models)
            .filter(|m| m.enabled)
            .count();
        Ok(ConnectionDiagnostics {
            harness: self.cursor_harness.status().await?,
            configured_models: self.store.models().await?.len() + plugin_count,
            sessions: self.store.connection_diagnostic_sessions().await?,
        })
    }

    pub async fn model_diagnostics(&self) -> Result<ModelDiagnostics> {
        Ok(ModelDiagnostics {
            health: self.store.model_health().await?,
            capabilities: self.store.capability_results().await?,
        })
    }
}

pub async fn connection(
    State(service): State<ControlService>,
) -> Result<Json<ConnectionDiagnostics>> {
    Ok(Json(service.connection_diagnostics().await?))
}
pub async fn start(
    State(service): State<ControlService>,
    Json(input): Json<StartDiagnostic>,
) -> Result<Json<ConnectionDiagnostic>> {
    Ok(Json(
        service
            .store
            .start_connection_diagnostic(&input.scope)
            .await?,
    ))
}
pub async fn models(State(service): State<ControlService>) -> Result<Json<ModelDiagnostics>> {
    Ok(Json(service.model_diagnostics().await?))
}
pub async fn test(
    State(service): State<ControlService>,
    Path((id, test_id)): Path<(String, String)>,
    Json(input): Json<TestCapability>,
) -> Result<Json<CapabilityResult>> {
    Ok(Json(
        service
            .test_capability(&id, &test_id, input.capability)
            .await?,
    ))
}
