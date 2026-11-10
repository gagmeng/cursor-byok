//! Integrates local application settings.
use std::{collections::BTreeMap, fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{Error, Result};

const NO_PROXY_KEY: &str = "http.noProxy";
const REMOTE_INFERENCE_ROUTE: &str = "always";
const KEYS: [&str; 6] = [
    "http.proxy",
    "http.proxyKerberosServicePrincipal",
    "http.proxySupport",
    "cursor.general.disableHttp2",
    "http.experimental.systemCertificatesV2",
    "cursorAgentHost.remoteInferenceRoute",
];

fn path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    match std::env::consts::OS {
        "macos" => Ok(home.join("Library/Application Support/Cursor/User/settings.json")),
        "windows" => Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor/User/settings.json")),
        "linux" => Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor/User/settings.json")),
        platform => Err(Error::Config(format!(
            "Cursor settings are unsupported on {platform}"
        ))),
    }
}

fn read() -> Result<BTreeMap<String, Value>> {
    let path = path()?;
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    if data.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    json5::from_str(&data)
        .map_err(|error| Error::Config(format!("parse Cursor settings JSONC: {error}")))
}

fn write(settings: &BTreeMap<String, Value>) -> Result<()> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(settings)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, [data.as_slice(), b"\n"].concat())?;
    fs::rename(temp, path)?;
    Ok(())
}

#[derive(Default, Serialize, Deserialize)]
struct SettingsOwnership {
    original: BTreeMap<String, Option<Value>>,
    applied: BTreeMap<String, Option<Value>>,
}

impl SettingsOwnership {
    fn apply(&mut self, settings: &mut BTreeMap<String, Value>, proxy_url: &str) {
        for key in KEYS.into_iter().chain([NO_PROXY_KEY]) {
            if self.original.contains_key(key)
                && settings.get(key) != self.applied.get(key).and_then(Option::as_ref)
            {
                self.original.insert(key.into(), settings.get(key).cloned());
            }
            self.original
                .entry(key.into())
                .or_insert_with(|| settings.get(key).cloned());
        }
        apply_proxy_settings(settings, proxy_url);
        self.applied = self
            .original
            .keys()
            .map(|key| (key.clone(), settings.get(key).cloned()))
            .collect();
    }

    fn restore(self, settings: &mut BTreeMap<String, Value>) {
        for (key, original) in self.original {
            if settings.get(&key) != self.applied.get(&key).and_then(Option::as_ref) {
                continue;
            }
            if let Some(value) = original {
                settings.insert(key, value);
            } else {
                settings.remove(&key);
            }
        }
    }
}

fn ownership_path() -> Result<PathBuf> {
    Ok(crate::config::managed_data_dir()?.join("cursor-settings-ownership.json"))
}

pub fn write_proxy_settings(proxy_url: &str) -> Result<()> {
    let mut settings = read()?;
    let journal = ownership_path()?;
    let mut ownership: SettingsOwnership = match fs::read(&journal) {
        Ok(data) => serde_json::from_slice(&data)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
        Err(error) => return Err(error.into()),
    };
    ownership.apply(&mut settings, proxy_url);
    let temp = journal.with_extension("tmp");
    fs::write(&temp, serde_json::to_vec(&ownership)?)?;
    fs::OpenOptions::new().write(true).open(&temp)?.sync_all()?;
    fs::rename(&temp, &journal)?;
    // Persist ownership before touching Cursor so a crash can still restore it.
    write(&settings)
}

fn apply_proxy_settings(settings: &mut BTreeMap<String, Value>, proxy_url: &str) {
    settings.remove(NO_PROXY_KEY);
    settings.insert(KEYS[0].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[1].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[2].into(), Value::String("on".into()));
    settings.insert(KEYS[3].into(), Value::Bool(true));
    settings.insert(KEYS[4].into(), Value::Bool(true));
    // Remote-SSH AgentService must dial through the local Cursor client so the
    // local BYOK proxy and model catalog are visible on the remote window.
    settings.insert(KEYS[5].into(), Value::String(REMOTE_INFERENCE_ROUTE.into()));
}

pub fn clear_proxy_settings() -> Result<()> {
    let journal = ownership_path()?;
    let ownership: SettingsOwnership = match fs::read(&journal) {
        Ok(data) => serde_json::from_slice(&data)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let mut settings = read()?;
    let before = settings.clone();
    ownership.restore(&mut settings);
    if settings != before {
        write(&settings)?;
    }
    fs::remove_file(journal)?;
    Ok(())
}

pub fn settings_match(proxy_url: &str) -> Result<bool> {
    Ok(proxy_settings_match(&read()?, proxy_url))
}

fn proxy_settings_match(settings: &BTreeMap<String, Value>, proxy_url: &str) -> bool {
    settings.get(KEYS[0]) == Some(&Value::String(proxy_url.into()))
        && settings.get(KEYS[1]) == Some(&Value::String(proxy_url.into()))
        && settings.get(KEYS[2]) == Some(&Value::String("on".into()))
        && settings.get(KEYS[3]) == Some(&Value::Bool(true))
        && settings.get(KEYS[4]) == Some(&Value::Bool(true))
        && settings.get(KEYS[5]) == Some(&Value::String(REMOTE_INFERENCE_ROUTE.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applying_and_removing_proxy_preserves_unrelated_settings() {
        let mut settings = BTreeMap::from([
            ("editor.fontSize".into(), json!(14)),
            ("remote.SSH.configFile".into(), json!("/custom/ssh/config")),
            ("[rust]".into(), json!({"editor.formatOnSave": true})),
        ]);
        let mut ownership = SettingsOwnership::default();
        ownership.apply(&mut settings, "http://127.0.0.1:43123");
        assert!(proxy_settings_match(&settings, "http://127.0.0.1:43123"));
        assert_eq!(settings["editor.fontSize"], json!(14));
        assert_eq!(settings["[rust]"], json!({"editor.formatOnSave": true}));
        ownership.restore(&mut settings);
        assert!(!settings.contains_key(KEYS[0]));
        assert_eq!(settings["editor.fontSize"], json!(14));
    }

    #[test]
    fn local_status_requires_every_proxy_setting_and_current_port() {
        let mut settings = BTreeMap::new();
        apply_proxy_settings(&mut settings, "http://127.0.0.1:43123");
        for key in KEYS {
            let mut incomplete = settings.clone();
            incomplete.remove(key);
            assert!(!proxy_settings_match(&incomplete, "http://127.0.0.1:43123"));
        }
        assert!(!proxy_settings_match(&settings, "http://127.0.0.1:43124"));
        apply_proxy_settings(&mut settings, "http://127.0.0.1:43124");
        assert!(proxy_settings_match(&settings, "http://127.0.0.1:43124"));
    }

    #[test]
    fn jsonc_settings_keep_nested_values_when_proxy_is_reapplied() {
        let mut settings: BTreeMap<String, Value> = json5::from_str(
            r#"{
                // An existing Cursor user file, including a trailing comma.
                "http.noProxy": ["example.com"],
                "[rust]": {"editor.formatOnSave": true},
            }"#,
        )
        .unwrap();
        apply_proxy_settings(&mut settings, "http://127.0.0.1:43123");
        let once = settings.clone();
        apply_proxy_settings(&mut settings, "http://127.0.0.1:43123");
        assert_eq!(settings, once);
        assert!(!settings.contains_key(NO_PROXY_KEY));
        assert_eq!(settings["[rust]"], json!({"editor.formatOnSave": true}));
        assert_eq!(settings[KEYS[5]], json!(REMOTE_INFERENCE_ROUTE));
    }

    #[test]
    fn releasing_takeover_restores_original_values_and_preserves_user_edits() {
        let original = BTreeMap::from([
            ("http.proxy".into(), json!("http://company:8080")),
            (NO_PROXY_KEY.into(), json!(["internal"])),
            (KEYS[5].into(), json!("remote")),
        ]);
        let mut settings = original.clone();
        let mut ownership = SettingsOwnership::default();
        ownership.apply(&mut settings, "http://127.0.0.1:43123");
        ownership.apply(&mut settings, "http://127.0.0.1:43124");
        settings.insert(KEYS[3].into(), json!(false));
        ownership.restore(&mut settings);
        assert_eq!(settings["http.proxy"], original["http.proxy"]);
        assert_eq!(settings[NO_PROXY_KEY], original[NO_PROXY_KEY]);
        assert_eq!(settings[KEYS[5]], original[KEYS[5]]);
        assert_eq!(settings[KEYS[3]], json!(false));
        let unchanged = settings.clone();
        SettingsOwnership::default().restore(&mut settings);
        assert_eq!(
            settings, unchanged,
            "releasing unowned settings must do nothing"
        );
    }

    #[test]
    fn serialized_ownership_recovers_after_a_crash_and_reapply_keeps_user_changes() {
        let original = BTreeMap::from([("http.proxy".into(), json!("http://company:8080"))]);
        let mut settings = original;
        let mut ownership = SettingsOwnership::default();
        ownership.apply(&mut settings, "http://127.0.0.1:43123");
        let bytes = serde_json::to_vec(&ownership).unwrap();
        let mut recovered: SettingsOwnership = serde_json::from_slice(&bytes).unwrap();
        settings.insert("http.proxy".into(), json!("http://new-company:8080"));
        recovered.apply(&mut settings, "http://127.0.0.1:43124");
        recovered.restore(&mut settings);
        assert_eq!(settings["http.proxy"], json!("http://new-company:8080"));
    }
}
