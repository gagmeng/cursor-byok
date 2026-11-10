//! Exposes the local desktop application integration.
mod account;
mod ca;
mod proxy;
mod settings;

use std::{net::SocketAddr, sync::Arc};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{
    store::{Store, TabMode, TabSettings},
    Error, Result,
};

use self::{ca::CaManager, proxy::ProxyRuntime};

pub(crate) fn proxy_host_allowed(host: &str) -> bool {
    proxy::is_cursor_host(host)
}

pub(crate) fn request_uses_local_cursor_token(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(account::is_local_cursor_authorization)
}

#[cfg(test)]
pub(crate) fn local_cursor_authorization() -> String {
    format!("Bearer {}", account::local_token().unwrap())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaState {
    Missing,
    Untrusted,
    Ready,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationState {
    Disabled,
    Enabled,
    Degraded,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorHarnessStatus {
    pub platform: &'static str,
    pub ca: CaState,
    pub configured_models: usize,
    pub enabled_models: usize,
    pub integration: IntegrationState,
    pub settings_applied: bool,
    pub proxy_url: Option<String>,
    pub ca_install_command: Option<String>,
    pub startup_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct SetEnabled {
    pub enabled: bool,
}

#[derive(Clone)]
pub struct CursorHarness {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    ca: CaManager,
    ca_initialization: Mutex<()>,
    backend_addr: RwLock<Option<SocketAddr>>,
    startup_error: RwLock<Option<String>>,
    tab_mode: Arc<RwLock<TabMode>>,
    proxy: Mutex<ProxyRuntime>,
}

impl CursorHarness {
    pub fn new(store: Store) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                store,
                ca: CaManager::managed()?,
                ca_initialization: Mutex::new(()),
                backend_addr: RwLock::new(None),
                startup_error: RwLock::new(None),
                tab_mode: Arc::new(RwLock::new(TabMode::default())),
                proxy: Mutex::new(ProxyRuntime::default()),
            }),
        })
    }

    pub fn set_backend_addr(&self, addr: SocketAddr) {
        *self.inner.backend_addr.write() = Some(addr);
    }

    pub async fn proxy_port(&self) -> Option<u16> {
        self.inner.proxy.lock().await.port()
    }

    pub async fn restore_persisted_intent(&self) -> Result<()> {
        settings::clear_proxy_settings()?;
        if self.inner.store.cursor_takeover_enabled().await?
            && matches!(self.inner.ca.state()?, CaState::Ready)
        {
            if let Err(error) = self.enable().await {
                *self.inner.startup_error.write() = Some(error.to_string());
                return Err(error);
            }
        }
        *self.inner.startup_error.write() = None;
        Ok(())
    }

    pub async fn status(&self) -> Result<CursorHarnessStatus> {
        let models = self.inner.store.models().await?;
        let configured_models = models.len();
        let enabled_models = configured_models;
        let ca = self.inner.ca.state()?;
        let proxy = self.inner.proxy.lock().await;
        let proxy_url = proxy.url();
        let settings_applied = proxy_url
            .as_deref()
            .map(settings::settings_match)
            .transpose()?
            .unwrap_or(false);
        let integration = match (proxy.running(), settings_applied) {
            (false, false) => IntegrationState::Disabled,
            (true, true) => IntegrationState::Enabled,
            _ => IntegrationState::Degraded,
        };
        Ok(CursorHarnessStatus {
            platform: std::env::consts::OS,
            ca,
            configured_models,
            enabled_models,
            integration,
            settings_applied,
            proxy_url,
            ca_install_command: self.inner.ca.install_command(),
            startup_error: self.inner.startup_error.read().clone(),
        })
    }

    pub async fn initialize_ca(&self) -> Result<CursorHarnessStatus> {
        let _initialization = self.inner.ca_initialization.lock().await;
        let manager = self.inner.ca.clone();
        tokio::task::spawn_blocking(move || manager.initialize_local())
            .await
            .map_err(|error| Error::Store(format!("CA initialization task failed: {error}")))??;
        self.status().await
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<CursorHarnessStatus> {
        if enabled {
            self.enable().await?;
            self.inner.store.set_cursor_takeover_enabled(true).await?;
            *self.inner.startup_error.write() = None;
        } else {
            self.inner.store.set_cursor_takeover_enabled(false).await?;
            self.disable().await?;
        }
        self.status().await
    }

    pub async fn set_tab_settings(&self, settings: TabSettings) -> Result<TabSettings> {
        let saved = self.inner.store.set_tab_settings(settings).await?;
        *self.inner.tab_mode.write() = saved.mode;
        Ok(saved)
    }

    async fn enable(&self) -> Result<()> {
        let mut proxy = self.inner.proxy.lock().await;
        if !matches!(self.inner.ca.state()?, CaState::Ready) {
            return Err(Error::Config(
                "initialize and trust the CA before enabling Cursor".into(),
            ));
        }
        let backend_addr = self
            .inner
            .backend_addr
            .read()
            .ok_or_else(|| Error::Config("desktop management server is not ready".into()))?;
        if proxy.running() {
            if let Some(url) = proxy.url() {
                apply_cursor_configuration(&url).await?;
            }
            return Ok(());
        }
        let ca = self.inner.ca.load()?;
        let requested_port = self.inner.store.port_settings().await?.proxy_port;
        *self.inner.tab_mode.write() = self.inner.store.tab_settings().await?.mode;
        let (url, actual_port) = proxy
            .start(
                backend_addr,
                ca,
                requested_port,
                self.inner.tab_mode.clone(),
            )
            .await?;
        if let Err(error) = self.inner.store.set_proxy_port(actual_port).await {
            proxy.stop().await;
            return Err(error);
        }
        if let Err(error) = apply_cursor_configuration(&url).await {
            proxy.stop().await;
            if let Err(restore) = settings::clear_proxy_settings() {
                tracing::warn!(%restore, "failed to restore settings after takeover initialization failed");
            }
            return Err(error);
        }
        Ok(())
    }

    pub async fn disable(&self) -> Result<()> {
        let mut proxy = self.inner.proxy.lock().await;
        proxy.stop().await;
        settings::clear_proxy_settings()?;
        Ok(())
    }
}

async fn apply_cursor_configuration(proxy_url: &str) -> Result<()> {
    account::inject_if_missing().await?;
    settings::write_proxy_settings(proxy_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn persisted_takeover_starts_without_status_reads_and_status_never_reapplies_settings() {
        if std::env::var_os("CURSOR_BYOK_LIFECYCLE_CHILD").is_none() {
            let directory = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "local_app::tests::persisted_takeover_starts_without_status_reads_and_status_never_reapplies_settings", "--nocapture"])
                .env("CURSOR_BYOK_LIFECYCLE_CHILD", "1")
                .env("CURSOR_BYOK_DATA_DIR", directory.path().join("data"))
                .env("APPDATA", directory.path().join("config"))
                .env("XDG_CONFIG_HOME", directory.path().join("config"))
                .env("HOME", directory.path())
                .env("USERPROFILE", directory.path())
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let directory = crate::config::managed_data_dir().unwrap();
        let store = Store::connect(&format!("sqlite://{}", directory.join("test.db").display()))
            .await
            .unwrap();
        let mut harness = CursorHarness::new(store.clone()).unwrap();
        Arc::get_mut(&mut harness.inner)
            .unwrap()
            .ca
            .assume_trusted_for_test();
        let ca = harness.inner.ca.clone();
        tokio::task::spawn_blocking(move || ca.initialize_local())
            .await
            .unwrap()
            .unwrap();
        store.set_cursor_takeover_enabled(true).await.unwrap();
        harness.set_backend_addr("127.0.0.1:12345".parse().unwrap());
        assert!(harness.proxy_port().await.is_none());
        let status = harness.status().await.unwrap();
        assert!(matches!(status.integration, IntegrationState::Disabled));
        assert!(
            harness.proxy_port().await.is_none(),
            "status cannot start the proxy or apply takeover"
        );
        assert!(!directory.join("cursor-settings-ownership.json").exists());
        harness.restore_persisted_intent().await.unwrap();
        assert!(
            harness.proxy_port().await.is_some(),
            "startup must restore takeover without any WebView or management request"
        );
        assert!(matches!(
            harness.status().await.unwrap().integration,
            IntegrationState::Enabled
        ));
        let before = std::fs::read(directory.join("cursor-settings-ownership.json")).unwrap();
        harness.status().await.unwrap();
        assert_eq!(
            std::fs::read(directory.join("cursor-settings-ownership.json")).unwrap(),
            before
        );
        harness.disable().await.unwrap();
        assert!(!directory.join("cursor-settings-ownership.json").exists());
        assert!(
            store.cursor_takeover_enabled().await.unwrap(),
            "normal shutdown preserves the next startup's takeover intent"
        );
    }
}
