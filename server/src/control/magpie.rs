//! Probes a local magpie gateway and maps its model catalog to model configurations.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;

use crate::{
    model::{ModelConfigInput, ModelType},
    Error, Result,
};

/// magpie's default gateway port; its settings.json moves it.
pub const DEFAULT_GATEWAY_PORT: u16 = 3425;
/// 本应用在 magpie 的 Usage 与请求日志里的名字。magpie 对本机调用接受任意 key,
/// 用固定值是为了让用户能把自己这边的调用和别的客户端分开看。
const APP_KEY: &str = "magpie-cursor-byok";
/// 探测是回环调用:3 秒没有应答按"magpie 没运行"处理,不让 UI 干等。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// 本仓库 `normalize_effort` 接受的档位;上游多出的 minimal/none/ultra 存不下,
/// 预览里也不展示,免得用户选了却保存不了。
const SUPPORTED_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const SETTINGS_DIRECTORY: &str = "magpie";
const SETTINGS_FILE: &str = "settings.json";

/// magpie 会按模型所在上游原生协议直接转发;列在 `native_endpoints` 里的是
/// 它不翻译的裸端点,发错端口会被上游拒绝("model not allowed")。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Chat,
    Responses,
    Messages,
}

impl Endpoint {
    fn from_native(endpoints: &[String]) -> Self {
        let has = |path: &str| endpoints.iter().any(|endpoint| endpoint == path);
        if has("/v1/chat/completions") {
            Self::Chat
        } else if has("/v1/messages") {
            Self::Messages
        } else if has("/v1/responses") {
            Self::Responses
        } else {
            // 路由组没有 native_endpoints,但 magpie 会把它们的请求翻译成成员
            // 上游要的形状,chat 对它们始终可用(本机实测)。
            Self::Chat
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Chat => "openai-chat",
            Self::Responses => "openai-responses",
            Self::Messages => "anthropic",
        }
    }
}

/// 网关目录里的一个模型,已归一成导入所需的展示字段。
#[derive(Clone, Debug)]
pub struct Model {
    pub model_id: String,
    pub display_name: String,
    pub provider: String,
    /// magpie 的路由组(`auto/*`、`group/*`):一条 id 背后是多个供应商模型。
    pub routing_group: bool,
    pub endpoint: Endpoint,
    pub context_window_tokens: Option<u64>,
    pub max_completion_tokens: Option<u64>,
    pub reasoning_levels: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Gateway {
    pub address: String,
    pub version: String,
    pub models: Vec<Model>,
}

/// 探测专用的 HTTP 客户端:不走系统代理(代理接管 127.0.0.1 会让探测失败),
/// 3 秒超时。聊天请求仍走用户配置的代理客户端,两者互不影响。
pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .use_native_tls()
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(Error::from)
}

/// 探测一个地址;`address` 为空时按 MAGPIE_ADDR、默认端口、settings.json 的顺序找。
/// 用户也可以显式给地址(非默认端口、远程机器),路由把查询参数透传到这里。
pub async fn resolve(client: &reqwest::Client, address: Option<&str>) -> Result<Gateway> {
    match address.map(str::trim).filter(|value| !value.is_empty()) {
        Some(address) => probe(client, address).await,
        None => find(client).await,
    }
}

/// 按 MAGPIE_ADDR、默认端口、settings.json 的顺序找第一个应答的 magpie。
/// 地址全部不可用时返回最后一次失败原因——它来自最具体的那个候选地址。
pub async fn find(client: &reqwest::Client) -> Result<Gateway> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let settings = std::fs::read_to_string(settings_path(&home, xdg.as_deref())).ok();
    let env_address = std::env::var("MAGPIE_ADDR").ok();
    let addresses = candidate_addresses(env_address.as_deref(), gateway_port(settings.as_deref()));
    let mut last = None;
    for address in &addresses {
        match probe(client, address).await {
            Ok(gateway) => return Ok(gateway),
            Err(error) => last = Some(error),
        }
    }
    Err(last.expect("candidate addresses are never empty"))
}

/// settings.json 的位置:magpie 自己按 `$XDG_CONFIG_HOME/magpie` 优先、否则
/// 用户目录下的 `.config/magpie`(Windows 同理)保存,见 its internal/appdir.
pub fn settings_path(home: &Path, xdg_config_home: Option<&Path>) -> PathBuf {
    let base = match xdg_config_home {
        Some(directory) if directory.is_absolute() => directory.to_path_buf(),
        _ => home.join(".config"),
    };
    base.join(SETTINGS_DIRECTORY).join(SETTINGS_FILE)
}

/// settings.json 里的端口,读不到、解析失败、越界(1024 以下要管理员权限)
/// 都按 magpie 自己的规则回落到默认端口。
fn gateway_port(settings: Option<&str>) -> u16 {
    settings
        .and_then(|text| serde_json::from_str::<GatewaySettings>(text).ok())
        .and_then(|settings| settings.port)
        .filter(|port| (1024..=65535).contains(port))
        .unwrap_or(DEFAULT_GATEWAY_PORT)
}

#[derive(Deserialize)]
struct GatewaySettings {
    #[serde(default)]
    port: Option<u16>,
}

/// MAGPIE_ADDR 指定了地址时就是唯一候选——它挪走的是"这份设置属于哪个网关",
/// 再探默认端口只会连到另一个实例。否则先探默认端口,配置过别的端口再补一次。
fn candidate_addresses(env_address: Option<&str>, port: u16) -> Vec<String> {
    if let Some(address) = env_address.map(str::trim).filter(|value| !value.is_empty()) {
        return vec![normalize_address(address)];
    }
    let default = format!("127.0.0.1:{DEFAULT_GATEWAY_PORT}");
    if port == DEFAULT_GATEWAY_PORT {
        vec![default]
    } else {
        vec![default, format!("127.0.0.1:{port}")]
    }
}

fn normalize_address(value: &str) -> String {
    let value = value.trim().trim_end_matches('/');
    value.strip_prefix("http://").unwrap_or(value).to_owned()
}

/// 探测一个地址。非 magpie 的应答(含占用了同一端口的别的服务)必须报错,
/// 不能把它返回的任何目录当成模型清单导入。
pub async fn probe(client: &reqwest::Client, address: &str) -> Result<Gateway> {
    let address = normalize_address(address);
    let hello_url = format!("http://{address}/api/hello");
    let hello = match client.get(&hello_url).send().await {
        Ok(response) => response,
        Err(error) => {
            return Err(Error::Provider(format!(
                "magpie gateway is not reachable at {address}: {error}; start magpie and try again"
            )))
        }
    };
    if !hello.status().is_success() {
        return Err(Error::Config(format!(
            "{address} is not a magpie gateway: {hello_url} answered {}",
            hello.status()
        )));
    }
    let hello: Value = hello.json().await.map_err(|error| {
        Error::Config(format!(
            "{address} is not a magpie gateway: {hello_url} did not answer JSON: {error}"
        ))
    })?;
    let name = hello
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name != "magpie" {
        return Err(Error::Config(format!(
            "{address} is not a magpie gateway: {hello_url} named '{name}'"
        )));
    }
    let version = hello
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let models = catalog(client, &address).await?;
    Ok(Gateway {
        address,
        version,
        models,
    })
}

async fn catalog(client: &reqwest::Client, address: &str) -> Result<Vec<Model>> {
    let url = format!("http://{address}/v1/models");
    let response = client
        .get(&url)
        .header("authorization", format!("Bearer {APP_KEY}"))
        .send()
        .await
        .map_err(|error| {
            Error::Provider(format!(
                "magpie model catalog request to {url} failed: {error}"
            ))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Provider(format!(
            "magpie model catalog at {url} answered {status}"
        )));
    }
    let body: Value = response.json().await.map_err(|error| {
        Error::Provider(format!(
            "magpie model catalog at {url} is not JSON: {error}"
        ))
    })?;
    let entries = match &body {
        Value::Array(entries) => entries.clone(),
        body => body
            .get("data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };
    let mut models = Vec::with_capacity(entries.len());
    let mut seen = HashSet::with_capacity(entries.len());
    for entry in entries {
        let entry: CatalogModel = serde_json::from_value(entry).map_err(|error| {
            Error::Protocol(format!(
                "magpie model catalog at {url} has an entry that is not a model: {error}"
            ))
        })?;
        let id = entry.id.trim().to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        models.push(entry.into_model(&id));
    }
    Ok(models)
}

#[derive(Deserialize)]
struct CatalogModel {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    owned_by: Option<String>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<u64>,
    #[serde(default)]
    supported_reasoning_levels: Vec<ReasoningLevel>,
    #[serde(default)]
    reasoning_levels: Vec<String>,
    #[serde(default)]
    native_endpoints: Vec<String>,
}

#[derive(Deserialize)]
struct ReasoningLevel {
    effort: String,
}

impl CatalogModel {
    fn into_model(self, id: &str) -> Model {
        let display_name = non_empty(self.display_name).unwrap_or_else(|| id.to_owned());
        // 路由组的 owned_by 是首个成员供应商,按它分组会让同一个路由组散落在
        // 不同供应商下,预览里看着像供应商模型被导入了两遍。改成按 id 前缀分组,
        // 前端据此把所有路由组集中成一组。
        let routing_group = routing_group_provider(id);
        let provider = routing_group
            .map(str::to_owned)
            .or_else(|| non_empty(self.owned_by))
            .unwrap_or_else(|| SETTINGS_DIRECTORY.to_owned());
        let mut levels = Vec::new();
        let mut seen = HashSet::new();
        // 两个字段是同一事实的两种写法:`reasoning_levels` 是展示顺序,
        // `supported_reasoning_levels` 是同一批档位的结构化形式。已有 `reasoning_levels`
        // 的顺序为优先,缺的再由结构化字段补上。
        for effort in self.reasoning_levels.into_iter().chain(
            self.supported_reasoning_levels
                .into_iter()
                .map(|level| level.effort),
        ) {
            if SUPPORTED_EFFORTS.contains(&effort.as_str()) && seen.insert(effort.clone()) {
                levels.push(effort);
            }
        }
        Model {
            model_id: id.to_owned(),
            display_name,
            provider,
            routing_group: routing_group.is_some(),
            endpoint: Endpoint::from_native(&self.native_endpoints),
            // 0 不是"零上下文",是上游没报;本仓库的 positive() 会拒绝 0 并让
            // 整批导入失败,所以统一归一为 None。
            context_window_tokens: non_zero(self.context_window).or(non_zero(self.context_length)),
            max_completion_tokens: non_zero(self.max_output_tokens),
            reasoning_levels: levels,
        }
    }
}

/// 路由组的 id 前缀。magpie 用 `auto/<model>` 列出自动发现的路由组,
/// 用 `group/<id>` 列出用户手工建的组;两者都是一条跨上游入口。
fn routing_group_provider(id: &str) -> Option<&'static str> {
    let prefix = id.split('/').next()?;
    if !id.contains('/') {
        return None;
    }
    match prefix {
        "auto" => Some("auto"),
        "group" => Some("group"),
        _ => None,
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn non_zero(value: Option<u64>) -> Option<u64> {
    value.filter(|value| *value > 0)
}

/// 一个目录条目对应的本仓库模型配置。端点跟随 magpie 的 `native_endpoints`:
/// 原生说 Messages 的上游只有 `/v1/messages` 能过,发 chat 会被上游拒。
pub fn candidate_input(model: &Model, address: &str) -> ModelConfigInput {
    let mut input = ModelConfigInput {
        sort_order: 0,
        display_name: model.display_name.clone(),
        group_name: Some(model.provider.clone()).filter(|value| !value.trim().is_empty()),
        fallback_model_hash: None,
        model_type: ModelType::OpenAi,
        base_url: format!("http://{address}/v1"),
        use_full_url: false,
        api_key: APP_KEY.to_owned(),
        tooltip_data: SETTINGS_DIRECTORY.to_owned(),
        model_id: model.model_id.clone(),
        reasoning_effort: None,
        openai_endpoint: "/v1/chat/completions".to_owned(),
        openai_extra_params_enabled: false,
        openai_extra_params: serde_json::json!({}),
        custom_headers_enabled: false,
        custom_headers: serde_json::json!({}),
        anthropic_extra_params_enabled: false,
        anthropic_extra_params: serde_json::json!({}),
        context_window_tokens: model.context_window_tokens,
        max_completion_tokens: model.max_completion_tokens,
        anthropic_max_tokens: None,
        anthropic_thinking_effort: None,
        thinking_budget_tokens: None,
    };
    match model.endpoint {
        Endpoint::Chat => {}
        Endpoint::Responses => input.openai_endpoint = "/v1/responses".to_owned(),
        Endpoint::Messages => {
            input.model_type = ModelType::Anthropic;
            // 协议层会自动追加 /v1/messages;带上 /v1 会拼成 /v1/v1/messages。
            input.base_url = format!("http://{address}");
            input.openai_endpoint = String::new();
        }
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};

    fn gateway_settings(port: u16) -> String {
        format!(r#"{{"theme":"dark","port":{port}}}"#)
    }

    #[test]
    fn missing_settings_read_as_the_default_port() {
        assert_eq!(gateway_port(None), DEFAULT_GATEWAY_PORT);
    }

    #[test]
    fn a_settings_port_moves_the_gateway_port() {
        assert_eq!(gateway_port(Some(&gateway_settings(5000))), 5000);
    }

    #[test]
    fn unreadable_settings_fall_back_to_the_default_port() {
        assert_eq!(gateway_port(Some("not json")), DEFAULT_GATEWAY_PORT);
    }

    #[test]
    fn a_privileged_port_falls_back_to_the_default_port() {
        assert_eq!(
            gateway_port(Some(&gateway_settings(80))),
            DEFAULT_GATEWAY_PORT
        );
    }

    #[test]
    fn the_default_port_is_probed_once_when_settings_name_it() {
        assert_eq!(
            candidate_addresses(None, DEFAULT_GATEWAY_PORT),
            vec!["127.0.0.1:3425".to_owned()]
        );
    }

    #[test]
    fn a_configured_port_is_probed_after_the_default_one() {
        assert_eq!(
            candidate_addresses(None, 5000),
            vec!["127.0.0.1:3425".to_owned(), "127.0.0.1:5000".to_owned()]
        );
    }

    #[test]
    fn magpie_addr_names_the_only_gateway_to_probe() {
        assert_eq!(
            candidate_addresses(Some("http://127.0.0.1:5000/"), 5000),
            vec!["127.0.0.1:5000".to_owned()]
        );
    }

    #[test]
    fn settings_live_under_xdg_config_home_when_it_is_set() {
        // 绝对路径在两个平台上都成立;Windows 的 "/xdg" 不算绝对路径。
        let xdg = std::env::temp_dir();
        assert_eq!(
            settings_path(Path::new("/home/me"), Some(&xdg)),
            xdg.join("magpie").join("settings.json")
        );
    }

    #[test]
    fn settings_live_under_the_home_folder_without_xdg() {
        assert_eq!(
            settings_path(Path::new("/home/me"), None),
            Path::new("/home/me/.config/magpie/settings.json")
        );
    }

    #[test]
    fn a_model_without_native_endpoints_is_served_on_chat() {
        assert_eq!(Endpoint::from_native(&[]), Endpoint::Chat);
    }

    #[test]
    fn a_model_native_to_messages_is_served_as_anthropic() {
        assert_eq!(
            Endpoint::from_native(&["/v1/messages".into()]),
            Endpoint::Messages
        );
    }

    #[test]
    fn a_model_native_to_responses_is_served_on_responses() {
        assert_eq!(
            Endpoint::from_native(&["/v1/responses".into()]),
            Endpoint::Responses
        );
    }

    #[test]
    fn routing_group_ids_are_recognized_by_their_prefix() {
        assert_eq!(routing_group_provider("auto/glm-5.3-flash"), Some("auto"));
        assert_eq!(routing_group_provider("group/daily-coding"), Some("group"));
        assert_eq!(routing_group_provider("trae-cn/glm-5.3"), None);
        // 供应商名里含 auto 不代表它是路由组。
        assert_eq!(routing_group_provider("autohome/glm-5.3"), None);
    }

    #[tokio::test]
    async fn routing_groups_keep_their_own_prefix_instead_of_a_member_provider() {
        let address = serve(catalog_router()).await;
        let gateway = probe(&client().unwrap(), &address).await.unwrap();

        // 路由组的 owned_by 只是首个成员供应商;按它分组会把路由组拆散到
        // 各供应商下,看起来像重复导入。
        let found = gateway
            .models
            .iter()
            .find(|model| model.model_id == "auto/glm-5.3-flash")
            .unwrap();
        assert!(found.routing_group);
        assert_eq!(found.provider, "auto");
        let saved = gateway
            .models
            .iter()
            .find(|model| model.model_id == "group/daily-coding")
            .unwrap();
        assert!(saved.routing_group);
        assert_eq!(saved.provider, "group");

        let provider = gateway
            .models
            .iter()
            .find(|model| model.model_id == "trae-cn/glm-5.3")
            .unwrap();
        assert!(!provider.routing_group);
        assert_eq!(provider.provider, "trae-cn");
    }

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        address
    }

    fn catalog_router() -> Router {
        Router::new()
            .route(
                "/api/hello",
                get(|| async {
                    Json(serde_json::json!({"name": "magpie", "version": "0.1.3359"}))
                }),
            )
            .route(
                "/v1/models",
                get(|| async {
                    Json(serde_json::json!({"data": [
                        {
                            "id": "trae-cn/glm-5.3",
                            "display_name": "GLM-5.3",
                            "owned_by": "trae-cn",
                            "context_window": 116000,
                            "max_output_tokens": 16000,
                            "reasoning_levels": ["low", "high", "xhigh"],
                            "supported_reasoning_levels": [{"effort": "low"}, {"effort": "xhigh"}]
                        },
                        {
                            "id": "auto/glm-5.3-flash",
                            "display_name": "GLM-5.3-Flash",
                            "owned_by": "unittec",
                            "context_length": 1000000,
                            "max_output_tokens": 131072
                        },
                        {
                            "id": "group/daily-coding",
                            "display_name": "Daily coding",
                            "owned_by": "daily-coding",
                            "context_window": 200000
                        },
                        {
                            "id": "zcode/GLM-5.2",
                            "display_name": "GLM-5.2",
                            "owned_by": "zcode",
                            "context_window": 0,
                            "max_output_tokens": 0,
                            "native_endpoints": ["/v1/messages"]
                        },
                        {
                            "id": "opencode-zen-free/crouton-alpha-free",
                            "display_name": "Crouton Alpha Free",
                            "owned_by": "opencode-zen-free",
                            "context_window": 1048576,
                            "max_output_tokens": 270000,
                            "native_endpoints": ["/v1/responses"]
                        }
                    ]}))
                }),
            )
    }

    #[tokio::test]
    async fn refuses_a_gateway_that_is_not_magpie() {
        let address = serve(Router::new().route(
            "/api/hello",
            get(|| async { Json(serde_json::json!({"name": "something-else"})) }),
        ))
        .await;
        let error = probe(&client().unwrap(), &address).await.unwrap_err();
        assert!(
            matches!(&error, Error::Config(message) if message.contains("not a magpie gateway")),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn refuses_an_address_where_nothing_listens() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        drop(listener);
        let error = probe(&client().unwrap(), &address).await.unwrap_err();
        assert!(
            matches!(&error, Error::Provider(message) if message.contains("not reachable")),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn lists_models_with_their_provider_and_context_window() {
        let address = serve(catalog_router()).await;
        let gateway = probe(&client().unwrap(), &address).await.unwrap();
        assert_eq!(gateway.version, "0.1.3359");
        assert_eq!(gateway.address, address);

        let glm = model(&gateway, "trae-cn/glm-5.3");
        assert_eq!(glm.display_name, "GLM-5.3");
        assert_eq!(glm.provider, "trae-cn");
        assert_eq!(glm.endpoint, Endpoint::Chat);
        assert_eq!(glm.context_window_tokens, Some(116_000));
        assert_eq!(glm.max_completion_tokens, Some(16_000));
        // 两个字段是同一事实的两种写法,取并集并保持 reasoning_levels 的顺序。
        assert_eq!(glm.reasoning_levels, vec!["low", "high", "xhigh"]);

        // context_length 是老字段,context_window 缺失时用它补齐。
        let routing = model(&gateway, "auto/glm-5.3-flash");
        assert_eq!(routing.context_window_tokens, Some(1_000_000));
        assert!(routing.reasoning_levels.is_empty());

        // 上游用 0 表示"没报";0 会让本仓库的模型校验整批失败,必须归一为 None。
        let messages_only = model(&gateway, "zcode/GLM-5.2");
        assert_eq!(messages_only.context_window_tokens, None);
        assert_eq!(messages_only.max_completion_tokens, None);
        assert_eq!(messages_only.endpoint, Endpoint::Messages);
        assert_eq!(
            model(&gateway, "opencode-zen-free/crouton-alpha-free").endpoint,
            Endpoint::Responses
        );
    }

    fn model<'a>(gateway: &'a Gateway, model_id: &str) -> &'a Model {
        gateway
            .models
            .iter()
            .find(|model| model.model_id == model_id)
            .unwrap_or_else(|| panic!("catalog is missing {model_id}"))
    }

    #[tokio::test]
    async fn chat_models_import_as_openai_chat_against_the_gateway() {
        let address = serve(catalog_router()).await;
        let gateway = probe(&client().unwrap(), &address).await.unwrap();
        let input = candidate_input(model(&gateway, "trae-cn/glm-5.3"), &gateway.address);
        assert_eq!(input.model_type, ModelType::OpenAi);
        assert_eq!(input.base_url, format!("http://{address}/v1"));
        assert_eq!(input.openai_endpoint, "/v1/chat/completions");
        assert_eq!(input.model_id, "trae-cn/glm-5.3");
        assert_eq!(input.group_name.as_deref(), Some("trae-cn"));
        assert_eq!(input.tooltip_data, "magpie");
        assert_eq!(input.api_key, APP_KEY);
        assert_eq!(input.context_window_tokens, Some(116_000));
        // 归一化必须通过,否则导入会整批失败。
        crate::model::normalize_model_input(&input).unwrap();
    }

    #[tokio::test]
    async fn messages_only_models_import_as_anthropic() {
        let address = serve(catalog_router()).await;
        let gateway = probe(&client().unwrap(), &address).await.unwrap();
        let input = candidate_input(model(&gateway, "zcode/GLM-5.2"), &gateway.address);
        assert_eq!(input.model_type, ModelType::Anthropic);
        assert_eq!(input.base_url, format!("http://{address}"));
        assert_eq!(input.openai_endpoint, "");
        let normalized = crate::model::normalize_model_input(&input).unwrap();
        assert_eq!(
            crate::model::resolve_request_url(
                normalized.model_type,
                &normalized.base_url,
                &normalized.openai_endpoint,
                normalized.use_full_url
            )
            .unwrap(),
            format!("http://{address}/v1/messages")
        );
    }

    #[tokio::test]
    async fn responses_only_models_import_on_the_responses_endpoint() {
        let address = serve(catalog_router()).await;
        let gateway = probe(&client().unwrap(), &address).await.unwrap();
        let input = candidate_input(
            model(&gateway, "opencode-zen-free/crouton-alpha-free"),
            &gateway.address,
        );
        assert_eq!(input.model_type, ModelType::OpenAi);
        assert_eq!(input.openai_endpoint, "/v1/responses");
        crate::model::normalize_model_input(&input).unwrap();
    }
}
