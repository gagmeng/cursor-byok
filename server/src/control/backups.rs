//! Lists automatic configuration backups and restores one chosen snapshot.
use std::path::{Path, PathBuf};

use axum::{
    extract::{Path as UrlPath, State},
    Json,
};
use serde::{Deserialize, Serialize};

use super::migration::{MigrationFile, MigrationModel, RestoreMode};
use super::service::ControlService;
use crate::{Error, Result};

const STATUS_FILE: &str = "backup-status.json";

#[derive(Clone, Debug, Serialize)]
pub struct BackupIndex {
    pub last_error: Option<String>,
    pub last_error_at_ms: Option<i64>,
    pub backups: Vec<BackupFile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackupFile {
    pub name: String,
    pub bytes: u64,
    pub exported_at_ms: Option<i64>,
    pub readable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackupPreview {
    pub name: String,
    pub exported_at_ms: i64,
    pub models_added: Vec<String>,
    pub models_changed: Vec<String>,
    pub models_unchanged: usize,
    pub models_only_local: Vec<String>,
    pub plugin_models_added: Vec<String>,
    pub plugin_models_changed: Vec<String>,
    pub plugin_models_only_local: Vec<String>,
    pub accounts_added: usize,
    pub accounts_changed: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct BackupRestore {
    pub snapshot: String,
    pub result: super::migration::MigrationResult,
}

#[derive(Deserialize)]
pub struct RestoreRequest {
    pub mode: String,
}

#[derive(Default, Serialize, Deserialize)]
struct BackupStatus {
    last_error: Option<String>,
    last_error_at_ms: Option<i64>,
}

pub async fn list(State(service): State<ControlService>) -> Result<Json<BackupIndex>> {
    Ok(Json(service.backup_index().await?))
}

pub async fn preview(
    State(service): State<ControlService>,
    UrlPath(name): UrlPath<String>,
) -> Result<Json<BackupPreview>> {
    Ok(Json(service.preview_backup(&name).await?))
}

pub async fn restore(
    State(service): State<ControlService>,
    UrlPath(name): UrlPath<String>,
    Json(request): Json<RestoreRequest>,
) -> Result<Json<BackupRestore>> {
    let mode = match request.mode.as_str() {
        "skip" => RestoreMode::SkipExisting,
        "overwrite" => RestoreMode::Overwrite,
        other => {
            return Err(Error::Config(format!(
                "backup restore mode must be skip or overwrite: {other}"
            )))
        }
    };
    Ok(Json(service.restore_backup(&name, mode).await?))
}

impl ControlService {
    pub async fn backup_index(&self) -> Result<BackupIndex> {
        let root = backup_root()?;
        let status = read_status(&root).await?;
        let mut backups = Vec::new();
        if tokio::fs::metadata(&root).await.is_ok() {
            let mut entries = tokio::fs::read_dir(&root).await?;
            while let Some(entry) = entries.next_entry().await? {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_backup_name(&name) {
                    continue;
                }
                let bytes = entry.metadata().await?.len();
                let readable = match read_backup(&root, &name).await {
                    Ok(file) => {
                        backups.push(BackupFile {
                            name,
                            bytes,
                            exported_at_ms: Some(file.exported_at_ms),
                            readable: true,
                        });
                        continue;
                    }
                    Err(_) => false,
                };
                backups.push(BackupFile {
                    name,
                    bytes,
                    exported_at_ms: None,
                    readable,
                });
            }
        }
        backups.sort_by(|left, right| right.name.cmp(&left.name));
        Ok(BackupIndex {
            last_error: status.last_error,
            last_error_at_ms: status.last_error_at_ms,
            backups,
        })
    }

    pub async fn preview_backup(&self, name: &str) -> Result<BackupPreview> {
        let root = backup_root()?;
        let file = read_backup(&root, name).await?;
        let current = self.migration_export().await?;
        Ok(diff_backup(name, &current, &file))
    }

    pub async fn restore_backup(&self, name: &str, mode: RestoreMode) -> Result<BackupRestore> {
        let root = backup_root()?;
        let file = read_backup(&root, name).await?;
        let snapshot = write_config_backup(self, &root).await?;
        let result = self.apply_migration(file, mode).await?;
        Ok(BackupRestore {
            snapshot: snapshot
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default(),
            result,
        })
    }
}

pub(crate) async fn run_backup_once(
    control: &ControlService,
    backup_root: &Path,
) -> Result<PathBuf> {
    match write_config_backup(control, backup_root).await {
        Ok(path) => {
            clear_backup_failure(backup_root).await?;
            Ok(path)
        }
        Err(error) => {
            let _ = record_backup_failure(backup_root, &error).await;
            Err(error)
        }
    }
}

pub(crate) async fn write_config_backup(
    control: &ControlService,
    backup_root: &Path,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(backup_root).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(backup_root, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let bundle = control.migration_export().await?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let path = backup_root.join(format!(
        "cursor-byok-backup-{stamp}-{}.json",
        uuid::Uuid::new_v4()
    ));
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(&bundle)?;
    tokio::fs::write(&temporary, data).await?;
    tokio::fs::OpenOptions::new()
        .write(true)
        .open(&temporary)
        .await?
        .sync_all()
        .await?;
    tokio::fs::rename(&temporary, &path).await?;
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(backup_root).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        if is_backup_name(&name.to_string_lossy()) {
            names.push(name);
        }
    }
    names.sort();
    while names.len() > 7 {
        let oldest = names.remove(0);
        tokio::fs::remove_file(backup_root.join(oldest)).await?;
    }
    Ok(path)
}

fn diff_backup(name: &str, current: &MigrationFile, file: &MigrationFile) -> BackupPreview {
    let mut models_added = Vec::new();
    let mut models_changed = Vec::new();
    let mut models_unchanged = 0;
    for model in &file.models {
        match current
            .models
            .iter()
            .find(|item| item.model_hash == model.model_hash)
        {
            None => models_added.push(model.config.display_name.clone()),
            Some(existing) if model_changed(existing, model) => {
                models_changed.push(model.config.display_name.clone())
            }
            Some(_) => models_unchanged += 1,
        }
    }
    let models_only_local = current
        .models
        .iter()
        .filter(|model| {
            !file
                .models
                .iter()
                .any(|item| item.model_hash == model.model_hash)
        })
        .map(|model| model.config.display_name.clone())
        .collect();
    let mut plugin_models_added = Vec::new();
    let mut plugin_models_changed = Vec::new();
    for group in &file.plugin_models {
        let current_group = current.plugin_models.iter().find(|item| {
            item.plugin_id == group.plugin_id && item.provider_id == group.provider_id
        });
        for model in &group.models {
            let label = model_label(&group.plugin_id, model);
            match current_group.and_then(|group| {
                group
                    .models
                    .iter()
                    .find(|item| model_id(item) == model_id(model))
            }) {
                None => plugin_models_added.push(label),
                Some(existing) if existing != model => plugin_models_changed.push(label),
                Some(_) => {}
            }
        }
    }
    let plugin_models_only_local = current
        .plugin_models
        .iter()
        .flat_map(|group| {
            let saved = file.plugin_models.iter().find(|item| {
                item.plugin_id == group.plugin_id && item.provider_id == group.provider_id
            });
            group.models.iter().filter_map(move |model| {
                let present = saved.is_some_and(|saved| {
                    saved
                        .models
                        .iter()
                        .any(|item| model_id(item) == model_id(model))
                });
                (!present).then(|| model_label(&group.plugin_id, model))
            })
        })
        .collect();
    let mut accounts_added = 0;
    let mut accounts_changed = 0;
    for group in &file.plugin_resources {
        let current_group = current.plugin_resources.iter().find(|item| {
            item.plugin_id == group.plugin_id && item.resource_type == group.resource_type
        });
        for account in &group.accounts {
            match current_group.and_then(|group| {
                group
                    .accounts
                    .iter()
                    .find(|item| account_key(item) == account_key(account))
            }) {
                None => accounts_added += 1,
                Some(existing) if existing != account => accounts_changed += 1,
                Some(_) => {}
            }
        }
    }
    BackupPreview {
        name: name.to_owned(),
        exported_at_ms: file.exported_at_ms,
        models_added,
        models_changed,
        models_unchanged,
        models_only_local,
        plugin_models_added,
        plugin_models_changed,
        plugin_models_only_local,
        accounts_added,
        accounts_changed,
    }
}

fn model_changed(current: &MigrationModel, saved: &MigrationModel) -> bool {
    current.config.display_name != saved.config.display_name
        || current.config.model_id != saved.config.model_id
        || current.config.base_url != saved.config.base_url
        || current.config.fallback_model_hash != saved.config.fallback_model_hash
        || current.config.api_key != saved.config.api_key
}

fn model_id(value: &serde_json::Value) -> String {
    value
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn model_label(plugin_id: &str, value: &serde_json::Value) -> String {
    let id = model_id(value);
    let name = value
        .get("display_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(id.as_str());
    format!("{plugin_id}/{name}")
}

fn account_key(value: &serde_json::Value) -> String {
    value
        .get("accountId")
        .or_else(|| value.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn backup_root() -> Result<PathBuf> {
    Ok(crate::config::managed_data_dir()?.join("backups"))
}

fn is_backup_name(name: &str) -> bool {
    name.starts_with("cursor-byok-backup-") && name.ends_with(".json") && !name.contains("..")
}

fn backup_file(root: &Path, name: &str) -> Result<PathBuf> {
    if name.contains('/') || name.contains('\\') || !is_backup_name(name) {
        return Err(Error::Config(format!("unknown backup: {name}")));
    }
    Ok(root.join(name))
}

async fn read_backup(root: &Path, name: &str) -> Result<MigrationFile> {
    let path = backup_file(root, name)?;
    let bytes = tokio::fs::read(&path).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| Error::Config(format!("backup {name} cannot be read: {error}")))
}

async fn read_status(root: &Path) -> Result<BackupStatus> {
    match tokio::fs::read(root.join(STATUS_FILE)).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BackupStatus::default()),
        Err(error) => Err(error.into()),
    }
}

async fn record_backup_failure(root: &Path, error: &Error) -> Result<()> {
    let status = BackupStatus {
        last_error: Some(error.to_string()),
        last_error_at_ms: Some(chrono::Utc::now().timestamp_millis()),
    };
    write_status(root, &status).await
}

async fn clear_backup_failure(root: &Path) -> Result<()> {
    match tokio::fs::remove_file(root.join(STATUS_FILE)).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn write_status(root: &Path, status: &BackupStatus) -> Result<()> {
    tokio::fs::create_dir_all(root).await?;
    let path = root.join(STATUS_FILE);
    let temporary = path.with_extension("tmp");
    tokio::fs::write(&temporary, serde_json::to_vec(status)?).await?;
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}
