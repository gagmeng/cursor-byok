//! Assembles server dependencies and starts the application services.
use std::{future::IntoFuture, net::SocketAddr, time::Duration};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{
    api,
    config::{Config, ConsoleSource},
    control,
    cursor::{
        prompting::{PromptAssets, PromptCompiler},
        transport::TransportRegistry,
    },
    local_app::CursorHarness,
    plugin::{PluginRegistry, PluginRuntime},
    provider::ProviderRouter,
    search::WebCache,
    store::Store,
    Result,
};

pub struct App {
    config: Config,
    router: axum::Router,
    registry: TransportRegistry,
    harness: CursorHarness,
    store: Store,
    management_session: control::ManagementSession,
    _maintenance: tokio_util::sync::DropGuard,
}

/// Writes the one-file migration bundle into <data>/backups every day and
/// keeps the newest seven, so a broken database or a bad import never costs
/// the user their model configuration.
fn spawn_daily_config_backup(control: crate::control::ControlService, shutdown: CancellationToken) {
    tokio::spawn(async move {
        let backup_root = match crate::config::managed_data_dir() {
            Ok(dir) => dir.join("backups"),
            Err(error) => {
                tracing::warn!(%error, "config backup directory unavailable");
                return;
            }
        };
        run_config_backups(control, backup_root, shutdown).await;
    });
}

async fn run_config_backups(
    control: crate::control::ControlService,
    backup_root: std::path::PathBuf,
    shutdown: CancellationToken,
) {
    let mut delay = Duration::ZERO;
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(delay) => {}
        }
        delay = match crate::control::run_backup_once(&control, &backup_root).await {
            Ok(path) => {
                tracing::info!(path = %path.display(), "daily config backup written");
                Duration::from_secs(24 * 60 * 60)
            }
            Err(error) => {
                tracing::warn!(%error, "daily config backup failed; retrying in one minute");
                Duration::from_secs(60)
            }
        };
    }
}

/// Long-running sessions keep growing the database between restarts; rerun
/// the startup maintenance hourly instead of only at process start.
fn spawn_periodic_maintenance(store: crate::store::Store, shutdown: CancellationToken) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60 * 60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! { _ = shutdown.cancelled() => break, _ = interval.tick() => {} }
            if let Err(error) = store.prune_dead_lineages().await {
                tracing::warn!(%error, "periodic lineage prune skipped");
            }
        }
    });
}

impl App {
    pub async fn new(mut config: Config) -> Result<Self> {
        let store = Store::connect(&config.database_url).await?;
        store.settle_interrupted_calls().await?;
        // Best-effort startup maintenance: dead checkpoint lineages and aged
        // wire blobs are what make the database grow without bound.
        if let Err(error) = store.prune_dead_lineages().await {
            tracing::warn!(%error, "startup lineage prune skipped");
        }
        let maintenance = CancellationToken::new();
        let maintenance_guard = maintenance.clone().drop_guard();
        spawn_periodic_maintenance(store.clone(), maintenance.clone());
        if config.use_persisted_ports {
            config
                .listen_addr
                .set_port(store.port_settings().await?.service_port);
        }
        let assets = PromptAssets::embedded()?;
        let compiler = PromptCompiler::new(assets);
        let plugin_runtime = PluginRuntime::managed()?;
        let plugins = PluginRegistry::managed(
            store.clone(),
            plugin_runtime.clone(),
            config.app_version.clone(),
        )?;
        let clients = crate::network::NetworkClients::new(store.clone());
        let provider = std::sync::Arc::new(ProviderRouter::new(
            store.clone(),
            plugins.clone(),
            clients.clone(),
            config.provider_request_timeout,
            config.provider_stream_idle_timeout,
        ));
        let byok = api::byok::router(
            store.clone(),
            plugins.clone(),
            provider.clone(),
            Some(api::byok::NativeForwarder::new(
                store.clone(),
                clients.clone(),
                config.provider_request_timeout,
                config.provider_stream_idle_timeout,
            )),
        );
        let registry = TransportRegistry::with_plugins(
            store.clone(),
            provider.clone(),
            compiler,
            WebCache::managed()?,
            plugins.clone(),
            crate::config::managed_data_dir()?.join("rules"),
        );
        let control = control::ControlService::new(
            store.clone(),
            provider,
            plugin_runtime,
            plugins,
            clients.clone(),
            config.app_version.clone(),
        )?;
        spawn_daily_config_backup(control.clone(), maintenance);
        let harness = control.cursor_harness().clone();
        let management_session = control.management_session.clone();
        let mut router = api::router(registry.clone(), clients)?.merge(byok);
        router = match &config.console {
            Some(ConsoleSource::Directory(directory)) => {
                router.merge(control::web_router(control.clone(), directory))
            }
            Some(ConsoleSource::Proxy(target)) => {
                router.merge(control::proxy_web_router(control.clone(), target.clone()))
            }
            None => router.merge(control::api_router(control.clone())),
        };
        Ok(Self {
            router,
            registry,
            harness,
            store,
            config,
            management_session,
            _maintenance: maintenance_guard,
        })
    }

    pub fn merge_router(mut self, router: axum::Router) -> Self {
        self.router = self.router.merge(router);
        self
    }

    pub fn merge_management_router(mut self, router: axum::Router) -> Self {
        self.router = self.router.merge(control::protect_management_router(
            router,
            self.management_session.clone(),
        ));
        self
    }

    pub async fn bind(&self) -> Result<TcpListener> {
        let requested = self.config.listen_addr;
        let listener = bind_service_listener(requested, self.config.use_persisted_ports).await?;
        if self.config.use_persisted_ports {
            self.store
                .set_service_port(listener.local_addr()?.port())
                .await?;
        }
        Ok(listener)
    }

    pub fn harness(&self) -> CursorHarness {
        self.harness.clone()
    }

    pub fn store(&self) -> Store {
        self.store.clone()
    }

    pub async fn serve(self) -> Result<()> {
        let listener = self.bind().await?;
        let shutdown = CancellationToken::new();
        let signal_shutdown = shutdown.clone();
        let running = self.serve_on(listener, shutdown);
        tokio::pin!(running);
        tokio::select! {
            result = &mut running => result,
            () = shutdown_signal() => {
                tracing::info!("shutdown signal received; cancelling active runs");
                signal_shutdown.cancel();
                running.await
            }
        }
    }

    pub async fn serve_on(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        let address = listener.local_addr()?;
        self.harness.set_backend_addr(address);
        if let Err(error) = self.harness.restore_persisted_intent().await {
            tracing::warn!(%error, "could not restore Cursor takeover at server startup");
        }
        tracing::info!(%address, "cursor server listening");
        let registry = self.registry;
        let harness = self.harness;
        let graceful = shutdown.clone();
        let server = axum::serve(listener, self.router)
            .with_graceful_shutdown(async move {
                graceful.cancelled().await;
            })
            .into_future();
        tokio::pin!(server);

        tokio::select! {
            result = &mut server => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness after server stop");
                }
                result?
            },
            () = shutdown.cancelled() => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness during shutdown");
                }
                registry.shutdown().await;
                match tokio::time::timeout(Duration::from_secs(10), &mut server).await {
                    Ok(result) => result?,
                    Err(_) => tracing::warn!("graceful shutdown timed out; forcing server close"),
                }
            }
        }
        Ok(())
    }
}

async fn bind_service_listener(
    requested: SocketAddr,
    allow_random_fallback: bool,
) -> Result<TcpListener> {
    match TcpListener::bind(requested).await {
        Ok(listener) => Ok(listener),
        Err(error) if allow_random_fallback && requested.port() != 0 => {
            tracing::warn!(%requested, %error, "configured service port unavailable; selecting a random port");
            Ok(TcpListener::bind(SocketAddr::new(requested.ip(), 0)).await?)
        }
        Err(error) => Err(error.into()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_short_lived_session_creates_a_complete_backup_immediately() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let runtime = PluginRuntime::new(directory.path().join("runtime")).unwrap();
        let plugin_data = directory.path().join("plugins/data");
        let plugins =
            PluginRegistry::for_test(store.clone(), runtime.clone(), plugin_data.clone()).unwrap();
        let clients = crate::network::NetworkClients::new(store.clone());
        let provider = std::sync::Arc::new(ProviderRouter::new(
            store.clone(),
            plugins.clone(),
            clients.clone(),
            Duration::from_secs(1),
            Duration::from_secs(1),
        ));
        let service =
            control::ControlService::new(store, provider, runtime, plugins, clients, "test".into())
                .unwrap();
        let root = directory.path().join("backups");
        for index in 0..8 {
            tokio::fs::create_dir_all(&root).await.unwrap();
            tokio::fs::write(
                root.join(format!("cursor-byok-backup-2000010{index}.json")),
                b"{}",
            )
            .await
            .unwrap();
        }
        let shutdown = CancellationToken::new();
        let running = tokio::spawn(run_config_backups(
            service.clone(),
            root.clone(),
            shutdown.clone(),
        ));
        let path = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(path) = std::fs::read_dir(&root)
                    .unwrap()
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.path())
                    .find(|path| {
                        path.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with("cursor-byok-backup-2")
                            && !path
                                .file_name()
                                .unwrap()
                                .to_string_lossy()
                                .starts_with("cursor-byok-backup-2000")
                            && path
                                .extension()
                                .is_some_and(|extension| extension == "json")
                    })
                {
                    break path;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("a session lasting less than a day must already have a complete backup");
        shutdown.cancel();
        running.await.unwrap();
        let file: control::MigrationFile =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert_eq!(file.version, 3);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 7);
        let backup_names = |root: &std::path::Path| {
            std::fs::read_dir(root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .filter(|name| name.to_string_lossy().starts_with("cursor-byok-backup-"))
                .collect::<std::collections::BTreeSet<_>>()
        };
        let before = backup_names(&root);
        let broken = plugin_data.join("dev.example");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("resources-account.json"), b"{corrupt").unwrap();
        for _ in 0..8 {
            assert!(
                control::run_backup_once(&service, &root).await.is_err(),
                "corrupt persisted accounts must fail the entire backup"
            );
        }
        assert_eq!(
            before,
            backup_names(&root),
            "failed backups must never rotate the last complete snapshots"
        );
        let status: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("backup-status.json")).expect("backup failure is recorded"),
        )
        .unwrap();
        assert!(status["last_error"].is_string());
    }
}
