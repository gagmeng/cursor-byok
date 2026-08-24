use std::{collections::BTreeSet, sync::Arc, time::Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::ads::{
    AdDismissalInput, AdRuntime, ADS_ENDPOINT, APP_VERSION_HEADER, DEVICE_ID_HEADER,
    DISABLED_AD_IDS_HEADER, LANGUAGE_HEADER, OS_HEADER,
};

use crate::{
    harness::CursorHarness,
    model::{
        ContentPart, CursorRunTraceArtifact, CursorRunTraceSummary, LlmCallRequest,
        LlmCallResponseChunk, LlmCallSummary, ModelInvocation, ModelRequest, ModelSpec, Overview,
        ProjectedContent, ProjectedMessage, PromptSpec, ProviderEndpoint, ProviderEndpointInput,
        ProviderEndpointSecret, ProviderModel, ProviderModelInput, ProviderType, Role,
    },
    provider::{ModelEvent, Provider},
    store::{
        PortSettings, ProxySettings, ProxySettingsInput, StatisticsStorage, Store, TabSettings,
    },
    Error, Result,
};

#[derive(Clone)]
pub struct ControlService {
    store: Store,
    cursor_harness: CursorHarness,
    provider: Arc<dyn Provider>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredModels {
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelConnectivityResult {
    pub duration_ms: u64,
    pub first_text_ms: Option<u64>,
    pub output_tokens: u64,
    pub tokens_per_second: f64,
    pub tokens_estimated: bool,
    pub output: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallDetail {
    pub call: CallSummary,
    pub request: Option<LlmCallRequest>,
    pub response_chunks: Vec<LlmCallResponseChunk>,
    pub cursor_trace: Option<CursorTraceDetail>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallSummary {
    #[serde(flatten)]
    pub call: LlmCallSummary,
    pub call_kind: &'static str,
    pub route: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorTraceDetail {
    pub trace: CursorRunTraceSummary,
    pub artifacts: Vec<CursorTraceArtifactDetail>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorTraceArtifactDetail {
    pub seq: i64,
    pub artifact_type: String,
    pub source: String,
    pub metadata: serde_json::Value,
    pub created_at_ms: i64,
    pub byte_count: usize,
    pub encoding: &'static str,
    pub data: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ObservabilitySettings {
    pub detailed: bool,
}

impl ControlService {
    pub fn new(store: Store, provider: Arc<dyn Provider>) -> Result<Self> {
        Ok(Self {
            cursor_harness: CursorHarness::new(store.clone())?,
            store,
            provider,
        })
    }

    pub fn cursor_harness(&self) -> &CursorHarness {
        &self.cursor_harness
    }

    pub(super) async fn ads(
        &self,
        disabled_ad_ids: Option<&str>,
        language: &str,
    ) -> Result<AdRuntime> {
        let client = crate::network::client(&self.store).await?;
        let installation_id = self.store.installation_id().await?;
        let mut request = client
            .get(ADS_ENDPOINT)
            .header(DEVICE_ID_HEADER, installation_id)
            .header(OS_HEADER, std::env::consts::OS)
            .header(APP_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
            .header(LANGUAGE_HEADER, language)
            .timeout(std::time::Duration::from_secs(5));
        if let Some(disabled_ad_ids) = disabled_ad_ids.filter(|value| !value.is_empty()) {
            request = request.header(DISABLED_AD_IDS_HEADER, disabled_ad_ids);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(Error::Provider(format!(
                "advertisement service failed ({status}): {}",
                message.chars().take(200).collect::<String>()
            )));
        }
        response.json::<AdRuntime>().await?.into_menu_slots()
    }

    pub(super) async fn dismiss_ad(&self, ad_id: &str, input: &AdDismissalInput) -> Result<()> {
        let client = crate::network::client(&self.store).await?;
        let installation_id = self.store.installation_id().await?;
        let mut endpoint = Url::parse(ADS_ENDPOINT).map_err(|error| {
            Error::Config(format!("advertisement endpoint is invalid: {error}"))
        })?;
        endpoint.set_query(None);
        endpoint
            .path_segments_mut()
            .map_err(|_| Error::Config("advertisement endpoint cannot contain an ad id".into()))?
            .push(ad_id)
            .push("dismissals");
        let response = client
            .post(endpoint)
            .header(DEVICE_ID_HEADER, installation_id)
            .header(OS_HEADER, std::env::consts::OS)
            .header(APP_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
            .json(input)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(Error::Provider(format!(
                "advertisement dismissal failed ({status}): {}",
                message.chars().take(200).collect::<String>()
            )));
        }
        Ok(())
    }

    pub async fn providers(&self) -> Result<Vec<ProviderEndpoint>> {
        self.store.providers().await
    }

    pub async fn create_provider(&self, input: &ProviderEndpointInput) -> Result<ProviderEndpoint> {
        self.store.create_provider(input).await
    }

    pub async fn update_provider(
        &self,
        provider_id: i64,
        input: &ProviderEndpointInput,
    ) -> Result<ProviderEndpoint> {
        self.store.update_provider(provider_id, input).await
    }

    pub async fn delete_provider(&self, provider_id: i64) -> Result<()> {
        self.store.delete_provider(provider_id).await
    }

    pub async fn models(&self) -> Result<Vec<ProviderModel>> {
        self.store.provider_models(false).await
    }

    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        provider_ids: Option<&str>,
    ) -> Result<Overview> {
        self.store
            .overview(start_ms, end_ms, model_hashes, provider_ids)
            .await
    }

    pub async fn save_models(
        &self,
        provider_id: i64,
        models: &[ProviderModelInput],
    ) -> Result<Vec<ProviderModel>> {
        self.store.save_provider_models(provider_id, models).await
    }

    pub async fn delete_model(&self, model_hash: &str) -> Result<()> {
        self.store.delete_provider_model(model_hash).await
    }

    pub async fn update_model(
        &self,
        model_hash: &str,
        input: &ProviderModelInput,
    ) -> Result<ProviderModel> {
        self.store.update_provider_model(model_hash, input).await
    }

    pub async fn test_model(&self, model_hash: &str) -> Result<ModelConnectivityResult> {
        const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
        const TEST_PROMPT: &str = "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation.";

        let configured = self
            .store
            .provider_model(model_hash)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("model {model_hash}")))?;
        let mut model = ModelSpec::new(model_hash);
        if configured.reasoning_enabled {
            model.reasoning.enabled = true;
            model.reasoning.effort = Some(
                configured
                    .reasoning_effort
                    .filter(|effort| !effort.trim().is_empty())
                    .unwrap_or_else(|| "medium".into()),
            );
        }
        let test_id = format!("model-test-{}", uuid::Uuid::new_v4());
        let call_id = test_id.clone();
        let invocation = ModelInvocation {
            call_id: test_id.clone(),
            run_id: test_id.clone(),
            conversation_id: test_id,
            provider_call_index: 0,
            request: ModelRequest {
                prompt: PromptSpec {
                    instructions: String::new(),
                    tools: Vec::new(),
                },
                model,
                history: vec![ProjectedMessage {
                    message_id: "connectivity-test".into(),
                    role: Role::User,
                    content: ProjectedContent::Parts(vec![ContentPart::Text {
                        text: TEST_PROMPT.into(),
                    }]),
                }],
            },
        };
        let cancellation = CancellationToken::new();
        let started = Instant::now();
        let mut first_text_at = None;
        let mut output_tokens = None;
        let mut output = String::new();
        let stream = self.provider.stream(invocation, cancellation.clone());
        let completed = tokio::time::timeout(TEST_TIMEOUT, async {
            futures_util::pin_mut!(stream);
            let mut finished = false;
            while let Some(event) = stream.next().await {
                match event? {
                    ModelEvent::TextDelta(delta) => {
                        if first_text_at.is_none() && !delta.trim().is_empty() {
                            first_text_at = Some(Instant::now());
                        }
                        output.push_str(&delta);
                    }
                    ModelEvent::Usage(usage) => {
                        if let Some(tokens) = usage.output_tokens.filter(|tokens| *tokens > 0) {
                            output_tokens = Some(
                                output_tokens.map_or(tokens, |current: u64| current.max(tokens)),
                            );
                        }
                    }
                    ModelEvent::Done(_) => finished = true,
                    _ => {}
                }
            }
            if !finished {
                return Err(Error::Protocol(
                    "provider stream ended without Done during connectivity test".into(),
                ));
            }
            Ok(())
        })
        .await;
        match completed {
            Ok(result) => result?,
            Err(_) => {
                cancellation.cancel();
                self.store
                    .finish_llm_call(
                        &call_id,
                        "error",
                        None,
                        started.elapsed().as_millis().min(i64::MAX as u128) as i64,
                        Some("timeout"),
                        Some("model connectivity test timed out after 45 seconds"),
                    )
                    .await?;
                return Err(Error::Provider(
                    "model connectivity test timed out after 45 seconds".into(),
                ));
            }
        }
        let elapsed = started.elapsed();
        let output = output.trim().to_string();
        let tokens_estimated = output_tokens.is_none();
        let output_tokens = output_tokens.unwrap_or_else(|| estimate_output_tokens(&output));
        Ok(ModelConnectivityResult {
            duration_ms: elapsed.as_millis().min(u128::from(u64::MAX)) as u64,
            first_text_ms: first_text_at.map(|first| {
                first
                    .duration_since(started)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64
            }),
            output_tokens,
            tokens_per_second: if elapsed.is_zero() {
                0.0
            } else {
                output_tokens as f64 / elapsed.as_secs_f64()
            },
            tokens_estimated,
            output,
        })
    }

    pub async fn create_provider_with_models(
        &self,
        provider: &ProviderEndpointInput,
        models: &[ProviderModelInput],
    ) -> Result<(ProviderEndpoint, Vec<ProviderModel>)> {
        self.store
            .create_provider_with_models(provider, models)
            .await
    }

    pub async fn discover_input(&self, input: &ProviderEndpointInput) -> Result<DiscoveredModels> {
        let client = crate::network::client(&self.store).await?;
        let endpoint = ProviderEndpoint {
            provider_id: 0,
            name: input.name.clone(),
            provider_type: input.provider_type,
            base_url: crate::model::normalize_base_url(&input.base_url)?,
            api_key: input.api_key.clone().unwrap_or_default(),
            has_api_key: input
                .api_key
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            custom_headers: input.custom_headers.clone(),
            extra_params: input.extra_params.clone(),
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        let secret = ProviderEndpointSecret {
            endpoint,
            api_key: input.api_key.clone().unwrap_or_default(),
            custom_headers: input.custom_headers.clone(),
        };
        let mut models = match input.provider_type {
            ProviderType::OpenAiChat | ProviderType::OpenAiResponses => {
                openai_models(&client, &secret).await?
            }
            ProviderType::Anthropic => anthropic_models(&client, &secret).await?,
        };
        models.sort();
        models.dedup();
        Ok(DiscoveredModels { models })
    }

    pub async fn discover_models(&self, provider_id: i64) -> Result<DiscoveredModels> {
        let client = crate::network::client(&self.store).await?;
        let provider = self
            .store
            .provider(provider_id)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("provider {provider_id}")))?;
        let mut models = match provider.endpoint.provider_type {
            ProviderType::OpenAiChat | ProviderType::OpenAiResponses => {
                openai_models(&client, &provider).await?
            }
            ProviderType::Anthropic => anthropic_models(&client, &provider).await?,
        };
        models.sort();
        models.dedup();
        Ok(DiscoveredModels { models })
    }

    pub async fn calls(&self, limit: i64) -> Result<Vec<CallSummary>> {
        let mut calls = self
            .store
            .llm_calls(limit)
            .await?
            .into_iter()
            .map(|call| CallSummary {
                call,
                call_kind: "provider_llm",
                route: "local_byok",
            })
            .collect::<Vec<_>>();
        calls.extend(
            self.store
                .official_cursor_traces(limit)
                .await?
                .into_iter()
                .map(official_call),
        );
        calls.sort_by_key(|call| std::cmp::Reverse(call.call.created_at_ms));
        calls.truncate(limit.clamp(1, 500) as usize);
        Ok(calls)
    }

    pub async fn call(&self, call_id: &str) -> Result<CallDetail> {
        if let Some(call) = self.store.llm_call(call_id).await? {
            let cursor_trace = self.cursor_trace_detail(&call.run_id).await?;
            return Ok(CallDetail {
                request: self.store.llm_call_request(call_id).await?,
                response_chunks: self.store.llm_call_chunks(call_id).await?,
                call: CallSummary {
                    call,
                    call_kind: "provider_llm",
                    route: "local_byok",
                },
                cursor_trace,
            });
        }
        let request_id = call_id.strip_prefix("cursor:").unwrap_or(call_id);
        let trace = self
            .store
            .cursor_trace(request_id)
            .await?
            .filter(|trace| trace.route == "cursor_official")
            .ok_or_else(|| Error::RunNotFound(format!("call {call_id}")))?;
        Ok(CallDetail {
            call: official_call(trace.clone()),
            request: None,
            response_chunks: Vec::new(),
            cursor_trace: Some(self.cursor_trace_detail_from(trace).await?),
        })
    }

    async fn cursor_trace_detail(&self, request_id: &str) -> Result<Option<CursorTraceDetail>> {
        let Some(trace) = self.store.cursor_trace(request_id).await? else {
            return Ok(None);
        };
        Ok(Some(self.cursor_trace_detail_from(trace).await?))
    }

    async fn cursor_trace_detail_from(
        &self,
        trace: CursorRunTraceSummary,
    ) -> Result<CursorTraceDetail> {
        let artifacts = self
            .store
            .cursor_trace_artifacts(&trace.request_id)
            .await?
            .into_iter()
            .map(cursor_artifact)
            .collect();
        Ok(CursorTraceDetail { trace, artifacts })
    }

    pub async fn observability(&self) -> Result<ObservabilitySettings> {
        Ok(ObservabilitySettings {
            detailed: self.store.detailed_logging().await?,
        })
    }

    pub async fn set_observability(
        &self,
        settings: ObservabilitySettings,
    ) -> Result<ObservabilitySettings> {
        self.store.set_detailed_logging(settings.detailed).await?;
        Ok(settings)
    }

    pub async fn ports(&self) -> Result<PortSettings> {
        self.store.port_settings().await
    }

    pub async fn set_ports(&self, settings: PortSettings) -> Result<PortSettings> {
        self.store.set_port_settings(settings).await?;
        Ok(settings)
    }

    pub async fn statistics_storage(&self) -> Result<StatisticsStorage> {
        self.store.statistics_storage().await
    }

    pub async fn clear_statistics_storage(&self) -> Result<StatisticsStorage> {
        self.store.clear_statistics_storage().await
    }

    pub async fn proxy_settings(&self) -> Result<ProxySettings> {
        self.store.proxy_settings().await
    }

    pub async fn set_proxy_settings(&self, settings: ProxySettingsInput) -> Result<ProxySettings> {
        self.store.set_proxy_settings(settings).await
    }

    pub async fn tab_settings(&self) -> Result<TabSettings> {
        self.store.tab_settings().await
    }

    pub async fn set_tab_settings(&self, settings: TabSettings) -> Result<TabSettings> {
        self.cursor_harness.set_tab_settings(settings).await
    }
}

fn official_call(trace: CursorRunTraceSummary) -> CallSummary {
    let model_id = trace.model_id.clone().unwrap_or_else(|| "Cursor".into());
    let ttfb = trace
        .first_response_at_ms
        .map(|value| (value - trace.received_at_ms).max(0));
    let duration = trace
        .finished_at_ms
        .map(|value| (value - trace.received_at_ms).max(0));
    let error = trace.error_message.clone();
    CallSummary {
        call: LlmCallSummary {
            call_id: format!("cursor:{}", trace.request_id),
            run_id: trace.request_id.clone(),
            conversation_id: trace
                .conversation_id
                .clone()
                .unwrap_or_else(|| trace.request_id.clone()),
            provider_call_index: 0,
            model_hash: None,
            provider_type: "cursor-official".into(),
            provider_url: "https://api2.cursor.sh".into(),
            request_type: "cursor-run-sse".into(),
            request_url: "https://api2.cursor.sh/agent.v1.AgentService/RunSSE".into(),
            model_id: model_id.clone(),
            display_name: model_id,
            reasoning_effort: None,
            fast: None,
            status: trace.status.clone(),
            finish_reason: None,
            created_at_ms: trace.received_at_ms,
            request_started_at_ms: Some(trace.received_at_ms),
            response_headers_at_ms: trace.first_response_at_ms,
            first_event_at_ms: trace.first_response_at_ms,
            first_text_at_ms: None,
            finished_at_ms: trace.finished_at_ms,
            queue_ms: None,
            ttfb_ms: ttfb,
            ttft_ms: None,
            duration_ms: duration,
            input_tokens: None,
            output_tokens: None,
            total_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            reasoning_tokens: None,
            usage: None,
            message_count: 0,
            tool_count: 0,
            request_bytes: Some(trace.request_bytes),
            response_bytes: trace.response_bytes,
            stream_event_count: trace.response_event_count,
            http_status: trace.http_status,
            error_kind: error.as_ref().map(|_| "cursor_official".into()),
            error_message: error,
            detailed: true,
        },
        call_kind: "cursor_official",
        route: "cursor_official",
    }
}

fn cursor_artifact(artifact: CursorRunTraceArtifact) -> CursorTraceArtifactDetail {
    let byte_count = artifact.data.len();
    let (encoding, data) = match readable_utf8(&artifact.data) {
        Some(value) => ("utf8", value.into()),
        None => ("base64", STANDARD.encode(&artifact.data)),
    };
    CursorTraceArtifactDetail {
        seq: artifact.seq,
        artifact_type: artifact.artifact_type,
        source: artifact.source,
        metadata: artifact.metadata,
        created_at_ms: artifact.created_at_ms,
        byte_count,
        encoding,
        data,
    }
}

fn readable_utf8(data: &[u8]) -> Option<&str> {
    let value = std::str::from_utf8(data).ok()?;
    value
        .chars()
        .all(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .then_some(value)
}

async fn openai_models(
    client: &reqwest::Client,
    provider: &ProviderEndpointSecret,
) -> Result<Vec<String>> {
    let mut request = client.get(format!("{}/models", provider.endpoint.base_url));
    if !provider.api_key.is_empty() {
        request = request.bearer_auth(&provider.api_key);
    }
    let response = apply_custom_headers(request, &provider.custom_headers)?
        .send()
        .await?;
    let status = response.status();
    let body: serde_json::Value = response.json().await?;
    if !status.is_success() {
        return Err(Error::Provider(format!(
            "model discovery failed ({status}): {body}"
        )));
    }
    Ok(model_ids(body.get("data").unwrap_or(&body)))
}

async fn anthropic_models(
    client: &reqwest::Client,
    provider: &ProviderEndpointSecret,
) -> Result<Vec<String>> {
    let mut after_id = None::<String>;
    let mut found = BTreeSet::new();
    loop {
        let mut request = client
            .get(format!("{}/models", provider.endpoint.base_url))
            .query(&[("limit", "100")])
            .header("anthropic-version", "2023-06-01");
        if !provider.api_key.is_empty() {
            request = request.header("x-api-key", &provider.api_key);
        }
        if let Some(after_id) = &after_id {
            request = request.query(&[("after_id", after_id)]);
        }
        let response = apply_custom_headers(request, &provider.custom_headers)?
            .send()
            .await?;
        let status = response.status();
        let body: serde_json::Value = response.json().await?;
        if !status.is_success() {
            return Err(Error::Provider(format!(
                "model discovery failed ({status}): {body}"
            )));
        }
        found.extend(model_ids(body.get("data").unwrap_or(&body)));
        if body.get("has_more").and_then(serde_json::Value::as_bool) != Some(true) {
            break;
        }
        after_id = body
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        if after_id.is_none() {
            return Err(Error::Provider(
                "Anthropic model response has_more without last_id".into(),
            ));
        }
    }
    Ok(found.into_iter().collect())
}

fn model_ids(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| match item {
            serde_json::Value::String(id) => Some(id.clone()),
            serde_json::Value::Object(object) => object
                .get("id")
                .or_else(|| object.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            _ => None,
        })
        .collect()
}

fn estimate_output_tokens(output: &str) -> u64 {
    let words = output.split_whitespace().count() as u64;
    if words > 0 {
        words
    } else if output.is_empty() {
        0
    } else {
        (output.chars().count() as u64).div_ceil(4)
    }
}

fn apply_custom_headers(
    mut request: reqwest::RequestBuilder,
    headers: &serde_json::Value,
) -> Result<reqwest::RequestBuilder> {
    let object = headers
        .as_object()
        .ok_or_else(|| Error::Config("custom headers must be an object".into()))?;
    for (name, value) in object {
        let value = value
            .as_str()
            .ok_or_else(|| Error::Config(format!("custom header {name} must be a string")))?;
        let name = HeaderName::try_from(name)
            .map_err(|error| Error::Config(format!("invalid header name: {error}")))?;
        let value = HeaderValue::try_from(value)
            .map_err(|error| Error::Config(format!("invalid header value: {error}")))?;
        request = request.header(name, value);
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use tokio_util::sync::CancellationToken;

    use crate::{
        model::{
            ModelInvocation, ProjectedContent, ProviderEndpointInput, ProviderModelInput,
            ProviderType,
        },
        provider::{FinishReason, ModelEvent, Provider, ProviderStream},
        store::Store,
    };

    use super::ControlService;

    struct TestProvider {
        invocation: Arc<Mutex<Option<ModelInvocation>>>,
    }

    impl Provider for TestProvider {
        fn stream(
            &self,
            invocation: ModelInvocation,
            _cancellation: CancellationToken,
        ) -> ProviderStream {
            *self.invocation.lock().unwrap() = Some(invocation);
            Box::pin(futures_util::stream::iter([
                Ok(ModelEvent::Start {
                    model_call_id: "test-call".into(),
                }),
                Ok(ModelEvent::TextStart),
                Ok(ModelEvent::TextDelta("OK".into())),
                Ok(ModelEvent::TextEnd),
                Ok(ModelEvent::Usage(crate::model::Usage {
                    output_tokens: Some(2),
                    ..Default::default()
                })),
                Ok(ModelEvent::Done(FinishReason::Stop)),
            ]))
        }
    }

    #[tokio::test]
    async fn connectivity_test_uses_the_configured_llm_provider() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("control.db").display()
        ))
        .await
        .unwrap();
        let invocation = Arc::new(Mutex::new(None));
        let provider = store
            .create_provider(&ProviderEndpointInput {
                name: "Test".into(),
                provider_type: ProviderType::OpenAiResponses,
                base_url: "https://example.com/v1".into(),
                api_key: None,
                custom_headers: serde_json::json!({}),
                extra_params: serde_json::json!({}),
            })
            .await
            .unwrap();
        let model = store
            .save_provider_model(
                provider.provider_id,
                &ProviderModelInput {
                    model_id: "reasoning-model".into(),
                    display_name: "Reasoning Model".into(),
                    endpoint_type: ProviderType::OpenAiResponses,
                    request_url: String::new(),
                    enabled: true,
                    sort_order: 0,
                    context_window_tokens: None,
                    max_output_tokens: None,
                    reasoning_enabled: true,
                    reasoning_effort: None,
                    supports_image_generation: false,
                },
            )
            .await
            .unwrap();
        let service = ControlService::new(
            store,
            Arc::new(TestProvider {
                invocation: invocation.clone(),
            }),
        )
        .unwrap();

        let result = service.test_model(&model.model_hash).await.unwrap();

        assert_eq!(result.output, "OK");
        assert_eq!(result.output_tokens, 2);
        assert!(!result.tokens_estimated);
        assert!(result.tokens_per_second > 0.0);
        let invocation = invocation.lock().unwrap().clone().unwrap();
        assert_eq!(invocation.request.model.model_id, model.model_hash);
        assert!(invocation.request.model.reasoning.enabled);
        assert_eq!(
            invocation.request.model.reasoning.effort.as_deref(),
            Some("medium")
        );
        assert!(invocation.request.prompt.tools.is_empty());
        assert_eq!(invocation.request.history.len(), 1);
        assert!(matches!(
            &invocation.request.history[0].content,
            ProjectedContent::Parts(parts)
                if matches!(&parts[..], [crate::model::ContentPart::Text { text }] if text == "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation.")
        ));
    }

    #[test]
    fn connectivity_output_token_estimate_handles_words_and_empty_text() {
        assert_eq!(super::estimate_output_tokens("1 2 3"), 3);
        assert_eq!(super::estimate_output_tokens(""), 0);
    }
}
