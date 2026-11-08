//! Provides isolated stores and canonical message fixtures for tests.
#![allow(dead_code)]

use std::sync::OnceLock;

use cursor_server::{
    model::{CanonicalMessage, Origin, Role},
    store::Store,
};

static PLUGIN_DATA_DIR: OnceLock<tempfile::TempDir> = OnceLock::new();

/// 把插件数据目录隔离到进程级临时路径。插件目录默认落在真实用户数据
/// 目录下,任何测试一旦经由 PluginRegistry::managed 读取已同步的插件
/// 模型,就会把真实用户数据泄进断言。
pub fn isolate_plugin_data_dir() {
    PLUGIN_DATA_DIR.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap();
        // OnceLock 保证仅首个 setup 执行;此后的测试复用同一路径。
        std::env::set_var("CURSOR_BYOK_DATA_DIR", directory.path());
        directory
    });
}

pub async fn temp_store() -> (tempfile::TempDir, Store) {
    isolate_plugin_data_dir();
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let store = Store::connect(&url).await.unwrap();
    (directory, store)
}

pub fn user(id: &str, text: &str) -> CanonicalMessage {
    CanonicalMessage::text(id, Role::User, Origin::User, text)
}
