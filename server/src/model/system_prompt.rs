//! Defines per-model system prompt settings and deterministic text composition.
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{Error, Result};

pub const SYSTEM_PROMPT_MAX_BYTES: usize = 32_768;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemPromptPosition {
    Before,
    #[default]
    After,
    /// Replaces the Cursor original instead of adding to it. Every provider
    /// turn starts from this text, so the prompt the user wrote is the whole
    /// system prompt.
    Replace,
}

impl SystemPromptPosition {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::Replace => "replace",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModelSystemPromptSettings {
    pub enabled: bool,
    pub content: String,
    pub position: SystemPromptPosition,
}

impl ModelSystemPromptSettings {
    pub fn validate(&self) -> Result<()> {
        if self.content.len() > SYSTEM_PROMPT_MAX_BYTES {
            return Err(Error::Config(format!(
                "system prompt content exceeds {SYSTEM_PROMPT_MAX_BYTES} UTF-8 bytes: {}",
                self.content.len()
            )));
        }
        if self.enabled && self.content.trim().is_empty() {
            return Err(Error::Config(
                "enabled system prompt content must contain non-whitespace text".into(),
            ));
        }
        Ok(())
    }

    pub fn instructions(&self, base: &str) -> Result<String> {
        self.validate()?;
        if !self.enabled {
            return Ok(base.into());
        }
        Ok(match self.position {
            SystemPromptPosition::Replace => self.content.clone(),
            _ if base.is_empty() => self.content.clone(),
            SystemPromptPosition::Before => format!("{}\n\n{base}", self.content),
            SystemPromptPosition::After => format!("{base}\n\n{}", self.content),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ModelSystemPromptConfig {
    pub model_id: String,
    #[serde(flatten)]
    pub settings: ModelSystemPromptSettings,
}

impl ModelSystemPromptConfig {
    pub fn validate_all(configs: &[Self]) -> Result<()> {
        let mut models = BTreeSet::new();
        for config in configs {
            if config.model_id.trim().is_empty() {
                return Err(Error::Config(
                    "system prompt model id must not be empty".into(),
                ));
            }
            if !models.insert(&config.model_id) {
                return Err(Error::Config(format!(
                    "system prompt model id repeated in configuration: {}",
                    config.model_id
                )));
            }
            config.settings.validate()?;
        }
        Ok(())
    }
}
