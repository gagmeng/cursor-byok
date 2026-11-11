//! Runs bounded semantic probes without executing workspace tools or changing conversation history.
use super::{diagnostics::Capability, ControlService};
use crate::{
    model::{
        ContentPart, ModelInvocation, ModelRequest, ModelSpec, ProjectedContent, ProjectedMessage,
        PromptSpec, Role, ToolCallContent, ToolDefinition, ToolResultContent,
    },
    provider::{FinishReason, ModelEvent},
    store::CapabilityResult,
    Error, Result,
};
use futures_util::StreamExt;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct ProbeResponse {
    text: String,
    thinking: String,
    calls: BTreeMap<usize, (String, String, String)>,
    replay: Option<crate::model::ProviderReplayState>,
    cache_read: Option<u64>,
    deltas: usize,
    done: bool,
}

impl ControlService {
    pub async fn test_capability(
        &self,
        model_id: &str,
        test_id: &str,
        capability: Capability,
    ) -> Result<CapabilityResult> {
        let plugin_model = model_id.starts_with(crate::plugin::ADAPTER_ID_PREFIX);
        let revision = if plugin_model {
            self.plugins.capability_revision(model_id).await?
        } else {
            self.store.model(model_id).await?.ok_or_else(|| {
                Error::Config(format!("capability test model does not exist: {model_id}"))
            })?;
            self.store.capability_revision(model_id).await?
        };
        let cancellation = CancellationToken::new();
        {
            let mut tests = self
                .model_tests
                .lock()
                .expect("model test registry mutex poisoned");
            if tests
                .get(test_id)
                .is_some_and(|token| !token.is_cancelled())
            {
                return Err(Error::Config(format!(
                    "model test id already in use: {test_id}"
                )));
            }
            tests
                .entry(test_id.into())
                .or_insert_with(|| cancellation.clone());
        }
        let cancellation = self
            .model_tests
            .lock()
            .expect("model test registry mutex poisoned")[test_id]
            .clone();
        let started = Instant::now();
        let outcome = tokio::select! {
            _ = cancellation.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(90), self.probe_capability(model_id, capability, cancellation.clone())) => {
                result.unwrap_or_else(|_| Err(Error::Provider("model capability test exceeded 90 seconds".into())))
            }
        };
        cancellation.cancel();
        self.model_tests
            .lock()
            .expect("model test registry mutex poisoned")
            .remove(test_id);
        let (status, detail) = match outcome {
            Ok(result) => result,
            Err(Error::Cancelled) => ("cancelled", "test cancelled".into()),
            Err(error) => ("failed", error.to_string()),
        };
        let mut result = CapabilityResult {
            model_id: model_id.into(),
            capability: capability.as_str().into(),
            status: status.into(),
            tested_at_ms: crate::store::now_ms(),
            duration_ms: started.elapsed().as_millis().min(i64::MAX as u128) as i64,
            detail,
        };
        let saved = if plugin_model {
            self.plugins
                .save_capability_result(&result, revision)
                .await?
        } else {
            self.store
                .save_current_capability_result(&result, revision)
                .await?
        };
        if !saved {
            result.status = "inconclusive".into();
            result.detail = "model configuration changed while the capability test was running; run the test again".into();
        }
        Ok(result)
    }

    async fn probe_capability(
        &self,
        id: &str,
        capability: Capability,
        cancellation: CancellationToken,
    ) -> Result<(&'static str, String)> {
        let mut model = ModelSpec::new(id);
        if id.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
            self.plugins.model_descriptor(id).await?;
        } else {
            self.store
                .model(id)
                .await?
                .ok_or_else(|| {
                    Error::Config(format!("capability test model does not exist: {id}"))
                })?
                .configure(&mut model);
        }
        model.max_output_tokens = Some(2048);
        let mut request = ModelRequest {
            model,
            prompt: PromptSpec {
                instructions: "Follow the diagnostic instruction exactly. Do not add explanation."
                    .into(),
                tools: Vec::new(),
            },
            history: Vec::new(),
        };
        let mut parts = Vec::new();
        let prompt = match capability {
            Capability::Streaming => "Output the numbers 1 through 40 separated by spaces.",
            Capability::Tools => {
                request.prompt.tools.push(ToolDefinition { name:"diagnostic_echo".into(), description:"Returns the supplied diagnostic value. This tool has no external effects.".into(), parameters:serde_json::json!({"type":"object","properties":{"value":{"type":"string","enum":["BYOK_TOOL_OK"]}},"required":["value"],"additionalProperties":false}) });
                "Call diagnostic_echo with value BYOK_TOOL_OK. After the result is returned, reply with its value only."
            }
            Capability::Vision => {
                let mut bytes = std::io::Cursor::new(Vec::new());
                image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                    32,
                    32,
                    image::Rgb([255, 0, 0]),
                ))
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|e| Error::Config(format!("diagnostic image generation failed: {e}")))?;
                parts.push(ContentPart::Image {
                    mime_type: "image/png".into(),
                    data: bytes.into_inner(),
                });
                "Name the dominant color in the attached image in one English word."
            }
            Capability::Cache => "Read this stable context. Reply READY only.",
        };
        let text = if capability == Capability::Cache {
            format!("{prompt}\n{}", "The diagnostic reference is a deterministic blue square; preserve this reference for the next turn. ".repeat(180))
        } else {
            prompt.into()
        };
        parts.insert(0, ContentPart::Text { text });
        request.history.push(ProjectedMessage {
            message_id: "diagnostic-user".into(),
            role: Role::User,
            content: ProjectedContent::Parts(parts),
        });
        let conversation = format!("capability-{}", uuid::Uuid::new_v4());
        let first = self
            .collect_probe(
                &conversation,
                0,
                request.clone(),
                cancellation.clone(),
                capability == Capability::Cache,
            )
            .await?;
        match capability {
            Capability::Streaming => {
                if first.text.trim().is_empty() {
                    return Err(Error::Provider("streaming probe produced no text".into()));
                }
                if first.deltas < 2 {
                    return Ok(("inconclusive", "text arrived in a single event; incremental streaming was not demonstrated".into()));
                }
                Ok((
                    "passed",
                    format!(
                        "received {} incremental text events and a completed stream",
                        first.deltas
                    ),
                ))
            }
            Capability::Vision => {
                if !first
                    .text
                    .split(|c: char| !c.is_ascii_alphabetic())
                    .any(|word| word.eq_ignore_ascii_case("red"))
                {
                    return Err(Error::Provider(format!(
                        "vision probe expected red; received {}",
                        first.text
                    )));
                }
                Ok(("passed", "recognized the generated red image".into()))
            }
            Capability::Tools => {
                if first.calls.len() != 1 {
                    return Err(Error::Provider(
                        "tool probe requires exactly one diagnostic_echo call".into(),
                    ));
                }
                let (index, (call_id, name, args)) = first.calls.iter().next().expect("one call");
                let arguments: serde_json::Value = serde_json::from_str(args).map_err(|e| {
                    Error::Provider(format!("tool probe returned invalid JSON arguments: {e}"))
                })?;
                if name != "diagnostic_echo"
                    || arguments != serde_json::json!({"value":"BYOK_TOOL_OK"})
                {
                    return Err(Error::Provider(
                        "tool probe returned the wrong tool or arguments".into(),
                    ));
                }
                request.history.push(ProjectedMessage {
                    message_id: "diagnostic-assistant".into(),
                    role: Role::Assistant,
                    content: ProjectedContent::Assistant {
                        text: first.text,
                        thinking: first.thinking,
                        replay_state: first.replay,
                        calls: vec![ToolCallContent {
                            index: *index,
                            call_id: call_id.clone(),
                            name: name.clone(),
                            arguments,
                        }],
                    },
                });
                request.history.push(ProjectedMessage {
                    message_id: "diagnostic-result".into(),
                    role: Role::Tool,
                    content: ProjectedContent::ToolResult(ToolResultContent {
                        call_id: call_id.clone(),
                        name: name.clone(),
                        content: "BYOK_TOOL_OK".into(),
                        is_error: false,
                        image: None,
                        provider_parts: Vec::new(),
                    }),
                });
                let second = self
                    .collect_probe(&conversation, 1, request, cancellation, false)
                    .await?;
                if !second.text.contains("BYOK_TOOL_OK") {
                    return Err(Error::Provider(
                        "tool probe continuation did not consume its result".into(),
                    ));
                }
                Ok((
                    "passed",
                    "valid tool arguments and tool-result continuation verified".into(),
                ))
            }
            Capability::Cache => {
                if first.text.trim().is_empty() {
                    return Err(Error::Provider(
                        "cache probe produced no initial text".into(),
                    ));
                }
                request.history.push(ProjectedMessage {
                    message_id: "cache-first-response".into(),
                    role: Role::Assistant,
                    content: ProjectedContent::Assistant {
                        text: first.text,
                        thinking: first.thinking,
                        replay_state: first.replay,
                        calls: Vec::new(),
                    },
                });
                request.history.push(ProjectedMessage {
                    message_id: "cache-followup".into(),
                    role: Role::User,
                    content: ProjectedContent::Parts(vec![ContentPart::Text {
                        text: "What color was the reference square? Reply BLUE only.".into(),
                    }]),
                });
                let second = self
                    .collect_probe(&conversation, 1, request, cancellation, true)
                    .await?;
                if !second.text.to_ascii_uppercase().contains("BLUE") {
                    return Err(Error::Provider(
                        "cache continuation did not retain the reference context".into(),
                    ));
                }
                if second.cache_read.unwrap_or(0) == 0 {
                    return Ok(("inconclusive","continuation succeeded; provider reported no cache hit, so cache support remains unverified".into()));
                }
                Ok((
                    "passed",
                    format!(
                        "continuation retained its context and read {} cached tokens",
                        second.cache_read.unwrap_or(0)
                    ),
                ))
            }
        }
    }

    async fn collect_probe(
        &self,
        conversation: &str,
        index: usize,
        request: ModelRequest,
        cancellation: CancellationToken,
        cache: bool,
    ) -> Result<ProbeResponse> {
        let mut stream = self.provider.stream(
            ModelInvocation {
                call_id: format!("{conversation}-{index}"),
                run_id: conversation.into(),
                conversation_id: conversation.into(),
                prompt_cache_enabled: cache,
                provider_call_index: index as u64,
                request,
            },
            cancellation.clone(),
        );
        let mut response = ProbeResponse::default();
        while let Some(event) = stream.next().await {
            if cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            match event? {
                ModelEvent::TextDelta(text) => {
                    response.deltas += usize::from(!text.is_empty());
                    response.text.push_str(&text);
                    if response.text.len() > 64 * 1024 {
                        return Err(Error::Provider("capability output exceeded 64 KiB".into()));
                    }
                }
                ModelEvent::ThinkingDelta(text) => {
                    response.thinking.push_str(&text);
                    if response.thinking.len() > 64 * 1024 {
                        return Err(Error::Provider(
                            "capability reasoning exceeded 64 KiB".into(),
                        ));
                    }
                }
                ModelEvent::ToolCallStart {
                    index,
                    call_id,
                    name,
                } => {
                    response.calls.insert(index, (call_id, name, String::new()));
                }
                ModelEvent::ToolCallArgumentsDelta { index, delta } => {
                    let call = response.calls.get_mut(&index).ok_or_else(|| {
                        Error::Provider("tool arguments arrived before tool identity".into())
                    })?;
                    call.2.push_str(&delta);
                    if call.2.len() > 4096 {
                        return Err(Error::Provider(
                            "diagnostic tool arguments exceeded 4 KiB".into(),
                        ));
                    }
                }
                ModelEvent::ProviderReplayState(state) => response.replay = Some(state),
                ModelEvent::Usage(usage) => response.cache_read = usage.cache_read_tokens,
                ModelEvent::Done(FinishReason::Length) => {
                    return Err(Error::Provider(
                        "capability probe reached its output limit".into(),
                    ))
                }
                ModelEvent::Done(_) => response.done = true,
                _ => {}
            }
        }
        if !response.done {
            return Err(Error::Provider(
                "capability stream ended without completion".into(),
            ));
        }
        Ok(response)
    }
}
