//! Defines desktop management HTTP requests and native desktop actions.
import type { CommitPromptLocale, Locale } from "../i18n/runtime";

export type ModelType = "openai" | "anthropic";

export interface Model {
  model_hash: string;
  sort_order: number;
  display_name: string;
  group_name: string | null;
  fallback_model_hash: string | null;
  type: ModelType;
  base_url: string;
  use_full_url: boolean;
  api_key: string;
  tooltip_data: string;
  model_id: string;
  reasoning_effort: string | null;
  openai_endpoint: string;
  openai_extra_params_enabled: boolean;
  openai_extra_params: Record<string, unknown>;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
  anthropic_extra_params_enabled: boolean;
  anthropic_extra_params: Record<string, unknown>;
  context_window_tokens: number | null;
  max_completion_tokens: number | null;
  anthropic_max_tokens: number | null;
  anthropic_thinking_effort: string | null;
  thinking_budget_tokens: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ModelInput {
  sort_order: number;
  display_name: string;
  group_name: string | null;
  fallback_model_hash: string | null;
  type: ModelType;
  base_url: string;
  use_full_url: boolean;
  api_key: string;
  tooltip_data: string;
  model_id: string;
  reasoning_effort: string | null;
  openai_endpoint: string;
  openai_extra_params_enabled: boolean;
  openai_extra_params: Record<string, unknown>;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
  anthropic_extra_params_enabled: boolean;
  anthropic_extra_params: Record<string, unknown>;
  context_window_tokens: number | null;
  max_completion_tokens: number | null;
  anthropic_max_tokens: number | null;
  anthropic_thinking_effort: string | null;
  thinking_budget_tokens: number | null;
}

export interface ModelDiscoveryInput {
  type: ModelType;
  base_url: string;
  api_key: string;
  custom_headers_enabled: boolean;
  custom_headers: Record<string, string>;
}

export interface LegacyModelImportPreviewItem {
  model_hash: string;
  display_name: string;
  model_id: string;
  type: ModelType;
  existing: boolean;
}

export interface LegacyModelImportPreview {
  source: string;
  total: number;
  new_models: number;
  existing_models: number;
  models: LegacyModelImportPreviewItem[];
}

export interface MigrationFile {
  format: string;
  version: number;
  app_version: string;
  exported_at_ms: number;
  models: (ModelInput & { model_hash: string })[];
  plugin_resources: { plugin_id: string; resource_type: string; accounts: unknown[] }[];
  plugin_models?: { plugin_id: string; provider_id: string; models: unknown[] }[];
  model_system_prompts: (ModelSystemPromptSettings & { model_id: string })[];
}

export interface MigrationResult {
  models_added: number;
  models_updated?: number;
  models_total: number;
  resources_added: number;
  resources_updated: number;
  plugin_models_added?: number;
  plugin_models_updated?: number;
  warnings: string[];
}

export interface LegacyModelImportResult {
  imported: number;
  skipped: number;
  total: number;
}

export interface MagpieImportModel {
  model_id: string;
  display_name: string;
  provider: string;
  /** magpie 的路由组(auto/*、group/*):一条 id 背后是多供应商负载均衡,不是单个供应商模型。 */
  routing_group: boolean;
  endpoint: "openai-chat" | "openai-responses" | "anthropic";
  context_window_tokens: number | null;
  max_completion_tokens: number | null;
  reasoning_levels: string[];
  existing: boolean;
}

export interface MagpieImportPreview {
  address: string;
  version: string;
  models: MagpieImportModel[];
}

export interface ModelConnectivityResult {
  duration_ms: number;
  first_valid_response_ms: number | null;
  output_tokens: number;
  tokens_per_second: number;
  tokens_estimated: boolean;
  output: string;
}

export type CaState = "missing" | "untrusted" | "ready" | "invalid";
export type IntegrationState = "disabled" | "enabled" | "degraded";
export interface CursorHarnessStatus {
  platform: string;
  ca: CaState;
  configured_models: number;
  enabled_models: number;
  integration: IntegrationState;
  settings_applied: boolean;
  proxy_url: string | null;
  ca_install_command: string | null;
  startup_error: string | null;
}

export interface ConnectionDiagnostic {
  diagnostic_id: string;
  scope: "local" | "ssh";
  marker: string;
  created_at_ms: number;
  request_id: string | null;
  conversation_id: string | null;
  request_seen_at_ms: number | null;
  stream_seen_at_ms: number | null;
  upstream_response_at_ms: number | null;
  tool_result_at_ms: number | null;
  error_message: string | null;
}
export interface ConnectionDiagnostics {
  harness: CursorHarnessStatus;
  configured_models: number;
  sessions: ConnectionDiagnostic[];
}
export type ModelCapability = "streaming" | "tools" | "vision" | "cache";
export interface CapabilityResult {
  model_id: string;
  capability: ModelCapability;
  status: "passed" | "failed" | "inconclusive" | "cancelled";
  tested_at_ms: number;
  duration_ms: number;
  detail: string;
}
export interface ModelHealth {
  model_id: string;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  success_rate: number | null;
  average_first_response_ms: number | null;
  tokens_per_second: number | null;
  last_call_at_ms: number;
  last_error: string | null;
}
export interface ModelDiagnostics { health: ModelHealth[]; capabilities: CapabilityResult[] }

export interface PortSettings {
  proxy_port: number;
  service_port: number;
}

export interface ExternalApiSettings {
  enabled: boolean;
  api_key: string;
}

export interface StatisticsStorage {
  call_count: number;
  trace_count: number;
}

export type StatisticsStorageScope = "details" | "all";

export type ProxyMode = "default" | "custom";

export interface ProxySettings {
  mode: ProxyMode;
  address: string;
  auth_enabled: boolean;
  username: string;
  has_password: boolean;
}

export interface ProxySettingsInput {
  mode: ProxyMode;
  address: string;
  auth_enabled: boolean;
  username: string;
  password?: string;
}

export type TabMode = "public" | "direct" | "custom";

export interface TabSettings {
  mode: TabMode;
  address: string;
}

export interface DesktopSettings {
  silent_start: boolean;
  show_dock_icon: boolean;
}

export interface CommitSettings {
  model_id: string;
  prompt: string;
  prompt_locale: CommitPromptLocale;
}

export interface CommitSettingsView extends CommitSettings {
  default_prompt: string;
}

export interface TokenPricingSettings {
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million: number;
  cache_write_per_million: number;
}

/** Cursor's `ModelPickerBadge.Variant` has no hex field, so these five are the whole palette. */
export type ModelBadgeColor = "accent" | "neutral" | "success" | "warn" | "danger";

export interface ModelBadgeSettings {
  color: ModelBadgeColor;
}

export interface ModelSystemPromptSettings {
  enabled: boolean;
  content: string;
  /** 插入到 Cursor 原有提示词之前/之后，或直接替换掉它。 */
  position: "before" | "after" | "replace";
}

export type PluginRuntimeState = "uninitialized" | "initializing" | "ready" | "failed" | "unsupported";
export type PluginRuntimePhase = "checking" | "downloading" | "verifying" | "installing" | "validating";

export interface PluginRuntimeStatus {
  state: PluginRuntimeState;
  version: string;
  target: string | null;
  phase: PluginRuntimePhase | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  error: string | null;
}

/** 插件提供的显示文本:纯字符串或 locale → 文本映射。 */
export type PluginLocalizedText = string | Record<string, string>;

export function pluginText(value: PluginLocalizedText | null | undefined, locale: string): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value[locale]) return value[locale];
  const language = locale.split("-")[0].toLowerCase();
  for (const [key, text] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === language || normalized.startsWith(`${language}-`)) return text;
  }
  return value["en-US"] ?? value["en"] ?? Object.values(value)[0] ?? "";
}

export interface PluginResourceState {
  status: "ready" | "cooling" | "invalid";
  retryAtMs?: number | null;
  message?: string | null;
}

export interface PluginResourceMetric {
  id: string;
  label: PluginLocalizedText;
  unit: "percent" | "count";
  value: number;
  resetAtMs?: number | null;
}

export interface PluginResourceView {
  id: string;
  state: PluginResourceState;
  displayName: string;
  description: PluginLocalizedText | null;
  metrics: PluginResourceMetric[];
  createdAtMs: number;
}

export interface PluginAddMethod {
  type: "oauth2.0" | "oauth2.authorization-code";
  id: string;
  displayName: PluginLocalizedText;
  description: PluginLocalizedText | null;
  callback?: { port: number | null; path: string | null };
}

export interface PluginImportDescriptor {
  displayName: PluginLocalizedText;
  description: PluginLocalizedText | null;
  accept: string[];
  multiple: boolean;
}

export interface PluginResourceAction {
  id: string;
  displayName: PluginLocalizedText;
  description: PluginLocalizedText | null;
  target: "resource" | "card";
  destructive: boolean;
}

export interface PluginResourceActionField {
  id: string;
  label: PluginLocalizedText;
  value: string;
}

export interface PluginResourceActionCard {
  id: string;
  title: PluginLocalizedText;
  status: PluginLocalizedText | null;
  grantedAtMs: number | null;
  expiresAtMs: number | null;
  fields: PluginResourceActionField[];
}

export interface PluginResourceActionResult {
  title: PluginLocalizedText;
  description: PluginLocalizedText | null;
  cards: PluginResourceActionCard[];
}

export interface PluginResourceDescriptor {
  type: string;
  displayName: PluginLocalizedText;
  add: PluginAddMethod[];
  import: PluginImportDescriptor | null;
  canRefresh: boolean;
  canRemove: boolean;
  actions: PluginResourceAction[];
  resources: PluginResourceView[];
}

export interface PluginModelDescriptor {
  id: string;
  pluginId: string;
  pluginName: string;
  providerId: string;
  modelId: string;
  displayName: string;
  description: string | null;
  icon: string;
  providerType: string;
  maxOutputTokens: number | null;
  images: boolean;
  enabled: boolean;
}

export interface PluginProviderDescriptor {
  id: string;
  pluginId: string;
  displayName: PluginLocalizedText;
  description: PluginLocalizedText | null;
  providerType: string;
  resourceType: string | null;
  hasModels: boolean;
  configured: boolean;
  models: PluginModelDescriptor[];
}

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  author: string | null;
  icon: string;
  providers: PluginProviderDescriptor[];
  resources: PluginResourceDescriptor[];
}

export interface PluginOAuthBegin {
  sessionId: string;
  userCode: string | null;
  verificationUrl: string;
  verificationUrlComplete: string | null;
  expiresAtMs: number;
  pollIntervalMs: number;
}

export type PluginOAuthPoll =
  | { status: "pending"; pollIntervalMs: number }
  | { status: "completed"; added: number; updated: number; modelSyncError: string | null }
  | { status: "denied"; message: string | null }
  | { status: "failed"; message: string };

export interface PluginImportFile {
  name: string;
  content: string;
}

export interface PluginImportResult {
  added: number;
  updated: number;
  warnings: string[];
  modelSyncError: string | null;
}

export function configuredPluginModels(plugins: PluginDescriptor[]): PluginModelDescriptor[] {
  return plugins.flatMap((plugin) =>
    plugin.providers.flatMap((provider) => provider.configured ? provider.models.filter((model) => model.enabled) : []));
}

export interface OverviewMetrics {
  llm_calls: number;
  successful_calls: number;
  failed_calls: number;
  token_usage: number;
  prompt_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

export type TokenUsageGranularity = "minute" | "hour" | "day";

export interface OverviewTokenUsageBucket {
  bucket_start_ms: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
}

export interface Overview {
  metrics: OverviewMetrics;
  token_usage_granularity: TokenUsageGranularity;
  token_usage_series: OverviewTokenUsageBucket[];
}

export interface LlmCall {
  call_kind: "provider_llm" | "cursor_official";
  route: "local_byok" | "cursor_official";
  call_id: string;
  run_id: string;
  conversation_id: string;
  provider_call_index: number;
  model_hash: string | null;
  provider_type: string;
  provider_url: string;
  request_type: string;
  request_url: string;
  model_id: string;
  display_name: string;
  reasoning_effort: string | null;
  fast: boolean | null;
  status: string;
  finish_reason: string | null;
  created_at_ms: number;
  ttfb_ms: number | null;
  ttft_ms: number | null;
  ttfr_ms: number | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  message_count: number;
  tool_count: number;
  http_status: number | null;
  error_kind: string | null;
  error_message: string | null;
  detailed: boolean;
  phase: string;
  activity: string | null;
}

export interface CallCursor {
  created_at_ms: number;
  call_id: string;
}

export interface CallPage {
  calls: LlmCall[];
  next: CallCursor | null;
}

export interface CallFilter {
  limit?: number;
  before?: CallCursor | null;
  status?: string;
  conversationId?: string;
  model?: string;
}

export interface RequestBudgetSettings {
  request_timeout_seconds: number;
  stream_idle_timeout_seconds: number;
}

export interface BackupFile {
  name: string;
  bytes: number;
  exported_at_ms: number | null;
  readable: boolean;
}

export interface BackupIndex {
  last_error: string | null;
  last_error_at_ms: number | null;
  backups: BackupFile[];
}

export interface BackupPreview {
  name: string;
  exported_at_ms: number;
  models_added: string[];
  models_changed: string[];
  models_unchanged: number;
  models_only_local: string[];
  plugin_models_added: string[];
  plugin_models_changed: string[];
  plugin_models_only_local: string[];
  accounts_added: number;
  accounts_changed: number;
}

export interface BackupRestore {
  snapshot: string;
  result: MigrationResult;
}

export interface CallDetail {
  call: LlmCall;
  request: { headers: unknown; body: unknown; byte_count: number } | null;
  response_chunks: Array<{ seq: number; received_offset_ms: number; data: string; byte_count: number }>;
  cursor_trace: {
    trace: {
      request_id: string;
      conversation_id: string | null;
      route: "local_byok" | "cursor_official";
      model_id: string | null;
      status: string;
      request_bytes: number;
      response_bytes: number;
      response_event_count: number;
      http_status: number | null;
      received_at_ms: number;
      first_response_at_ms: number | null;
      finished_at_ms: number | null;
      error_message: string | null;
    };
    artifacts: Array<{
      seq: number;
      artifact_type: string;
      source: string;
      metadata: unknown;
      created_at_ms: number;
      byte_count: number;
      encoding: "utf8" | "base64";
      data: string;
    }>;
  } | null;
}

const packagedDesktop = "__TAURI_INTERNALS__" in window
  || window.location.protocol === "tauri:"
  || window.location.hostname === "tauri.localhost";
const API_ROOT = "/__byok-api__/api";

let managementSession: Promise<void> | null = null;
async function ensureManagementSession(): Promise<void> {
  managementSession ??= fetch(`${API_ROOT}/session`, { headers: { "x-cursor-byok-session": "1" }, credentials: "same-origin" }).then((response) => {
    if (!response.ok) throw new Error(t("无法连接本地管理服务"));
  }).catch((cause) => { managementSession = null; throw cause; });
  return managementSession;
}

async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    await ensureManagementSession();
    const send = () => fetch(`${API_ROOT}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
    response = await send();
    if (response.status === 401 && response.headers.get("x-cursor-byok-session") === "required") {
      managementSession = null;
      await ensureManagementSession();
      response = await send();
    }
  } catch (cause) {
    throw new Error(t("无法连接本地管理服务"), { cause });
  }
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // Plain-text errors are already suitable for display.
    }
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestResponse(path, init);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

async function download(path: string, defaultName: string): Promise<void> {
  const response = await requestResponse(path);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/i)?.[1] ?? defaultName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the WebView time to acquire the blob before releasing its URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export const api = {
  connectionDiagnostics: () => request<ConnectionDiagnostics>("/diagnostics/connection"),
  startConnectionDiagnostic: (scope: "local" | "ssh") => request<ConnectionDiagnostic>("/diagnostics/connection", { method: "POST", body: JSON.stringify({ scope }) }),
  modelDiagnostics: () => request<ModelDiagnostics>("/diagnostics/models"),
  testCapability: (model: string, testId: string, capability: ModelCapability) => request<CapabilityResult>(`/models/${encodeURIComponent(model)}/capabilities/${encodeURIComponent(testId)}`, { method: "POST", body: JSON.stringify({ capability }) }),
  models: () => request<Model[]>("/models"),
  deleteModels: (modelHashes: string[]) => request<void>("/models/batch", { method: "DELETE", body: JSON.stringify({ model_hashes: modelHashes }) }),
  updateModels: (models: Array<{model_hash: string; config: ModelInput}>) => request<Model[]>("/models/batch", { method: "PUT", body: JSON.stringify({ models }) }),
  model: (id: string) => request<Model>(`/models/${encodeURIComponent(id)}`),
  createModels: (models: ModelInput[]) => request<Model[]>("/models", { method: "POST", body: JSON.stringify({ models }) }),
  discoverModels: (input: ModelDiscoveryInput) => request<{ models: string[] }>("/models/discover", { method: "POST", body: JSON.stringify(input) }),
  previewV0049Models: () => request<LegacyModelImportPreview>("/models/import-v0049"),
  importV0049Models: () => request<LegacyModelImportResult>("/models/import-v0049", { method: "POST" }),
  previewMagpieModels: (address?: string) => request<MagpieImportPreview>(`/magpie${address ? `?address=${encodeURIComponent(address)}` : ""}`),
  importMagpieModels: (modelIds: string[], address?: string) => request<LegacyModelImportResult>("/magpie/import", { method: "POST", body: JSON.stringify({ model_ids: modelIds, address }) }),
  updateModel: (hash: string, model: ModelInput) => request<Model>(`/models/${hash}`, { method: "PUT", body: JSON.stringify(model) }),
  deleteModel: (hash: string) => request<void>(`/models/${hash}`, { method: "DELETE" }),
  modelSystemPrompt: (modelId: string) => request<ModelSystemPromptSettings>(`/model-system-prompts?model_id=${encodeURIComponent(modelId)}`),
  setModelSystemPrompt: (modelId: string, settings: ModelSystemPromptSettings) => request<ModelSystemPromptSettings>("/model-system-prompts", { method: "PUT", body: JSON.stringify({ model_id: modelId, ...settings }) }),
  exportMigration: () => download("/migration/export", "cursor-byok-migration.json"),
  migrationImport: (file: MigrationFile) => request<MigrationResult>("/migration/import", { method: "POST", body: JSON.stringify(file) }),
  testModel: (hash: string, testId: string, signal?: AbortSignal) => request<ModelConnectivityResult>(`/models/${encodeURIComponent(hash)}/test/${encodeURIComponent(testId)}`, { method: "POST", signal }),
  cancelModelTest: (hash: string, testId: string) => request<void>(`/models/${encodeURIComponent(hash)}/test/${encodeURIComponent(testId)}`, { method: "DELETE" }),
  overview: (filter?: { startMs: number; endMs: number; modelHashes?: string[]; bucketMs?: number }) => {
    const params = new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (filter) {
      params.set("start_ms", String(filter.startMs));
      params.set("end_ms", String(filter.endMs));
      if (filter.modelHashes?.length) params.set("model_hashes", JSON.stringify(filter.modelHashes));
      if (filter.bucketMs) params.set("bucket_ms", String(filter.bucketMs));
    }
    const query = params.toString();
    return request<Overview>(`/overview${query ? `?${query}` : ""}`);
  },
  cursorHarness: () => request<CursorHarnessStatus>("/harness/cursor/status"),
  initializeCursorCa: () => request<CursorHarnessStatus>("/harness/cursor/ca/initialize", { method: "POST" }),
  plugins: () => request<PluginDescriptor[]>("/plugins"),
  pluginOAuthBegin: (pluginId: string, resourceType: string, methodId: string) => request<PluginOAuthBegin>(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/add/${encodeURIComponent(methodId)}/begin`, { method: "POST" }),
  pluginOAuthPoll: (sessionId: string, signal?: AbortSignal) => request<PluginOAuthPoll>(`/plugins/oauth/${encodeURIComponent(sessionId)}/poll`, { method: "POST", signal }),
  importPluginResources: (pluginId: string, resourceType: string, files: PluginImportFile[]) => request<PluginImportResult>(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/import`, { method: "POST", body: JSON.stringify(files) }),
  refreshPluginResource: (pluginId: string, resourceType: string, resourceId: string) => request<void>(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/refresh`, { method: "POST" }),
  pluginResourceAction: (pluginId: string, resourceType: string, resourceId: string, actionId: string, input: unknown = {}) => request<PluginResourceActionResult>(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/actions/${encodeURIComponent(actionId)}`, { method: "POST", body: JSON.stringify(input) }),
  deletePluginResource: (pluginId: string, resourceType: string, resourceId: string) => request<void>(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, { method: "DELETE" }),
  syncPluginModels: (pluginId: string, providerId: string) => request<{ models: number }>(`/plugins/${encodeURIComponent(pluginId)}/providers/${encodeURIComponent(providerId)}/models/sync`, { method: "POST" }),
  setPluginModelEnabled: (pluginId: string, providerId: string, modelId: string, enabled: boolean) => request<void>(`/plugins/${encodeURIComponent(pluginId)}/providers/${encodeURIComponent(providerId)}/models/enabled`, { method: "PUT", body: JSON.stringify({ modelId, enabled }) }),
  exportPluginResources: (pluginId: string, resourceType: string) => download(`/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceType)}/export`, `${pluginId}-${resourceType}.json`),
  removePluginConfiguration: (pluginId: string) => request<void>(`/plugins/${encodeURIComponent(pluginId)}`, { method: "DELETE" }),
  pluginRuntime: () => request<PluginRuntimeStatus>("/plugins/runtime"),
  initializePluginRuntime: () => request<PluginRuntimeStatus>("/plugins/runtime", { method: "POST" }),
  cancelPluginRuntimeInitialization: () => request<PluginRuntimeStatus>("/plugins/runtime", { method: "DELETE" }),
  openCursorCaInstallTerminal: async (command: string) => {
    if (!packagedDesktop) throw new Error(t("请在桌面应用中打开终端安装 CA"));
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_terminal_with_command", { command });
  },
  copyCursorText: async (text: string) => {
    if (!packagedDesktop) { await navigator.clipboard.writeText(text); return; }
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  },
  setCursorEnabled: (enabled: boolean) => request<CursorHarnessStatus>("/harness/cursor/enabled", { method: "PUT", body: JSON.stringify({ enabled }) }),
  calls: (filter: CallFilter = {}) => {
    const params = new URLSearchParams();
    params.set("limit", String(filter.limit ?? 50));
    if (filter.before) {
      params.set("before_created_at_ms", String(filter.before.created_at_ms));
      params.set("before_call_id", filter.before.call_id);
    }
    if (filter.status) params.set("status", filter.status);
    if (filter.conversationId) params.set("conversation_id", filter.conversationId);
    if (filter.model) params.set("model", filter.model);
    return request<CallPage>(`/llm-calls?${params}`);
  },
  call: (id: string) => request<CallDetail>(`/llm-calls/${encodeURIComponent(id)}`),
  requestBudget: () => request<RequestBudgetSettings>("/settings/request-budget"),
  setRequestBudget: (settings: RequestBudgetSettings) => request<RequestBudgetSettings>("/settings/request-budget", { method: "PUT", body: JSON.stringify(settings) }),
  backups: () => request<BackupIndex>("/backups"),
  previewBackup: (name: string) => request<BackupPreview>(`/backups/${encodeURIComponent(name)}/preview`, { method: "POST" }),
  restoreBackup: (name: string, mode: "skip" | "overwrite") => request<BackupRestore>(`/backups/${encodeURIComponent(name)}/restore`, { method: "POST", body: JSON.stringify({ mode }) }),
  openExternalUrl: (url: string) => request<void>("/desktop/open-external-url", { method: "POST", body: JSON.stringify({ url }) }),
  observability: () => request<{ detailed: boolean }>("/settings/observability"),
  setObservability: (detailed: boolean) => request<{ detailed: boolean }>("/settings/observability", { method: "PUT", body: JSON.stringify({ detailed }) }),
  ports: () => request<PortSettings>("/settings/ports"),
  setPorts: (settings: PortSettings) => request<PortSettings>("/settings/ports", { method: "PUT", body: JSON.stringify(settings) }),
  externalApiSettings: () => request<ExternalApiSettings>("/settings/external-api"),
  setExternalApiSettings: (settings: ExternalApiSettings) => request<ExternalApiSettings>("/settings/external-api", { method: "PUT", body: JSON.stringify(settings) }),
  statisticsStorage: () => request<StatisticsStorage>("/settings/storage/statistics"),
  clearStatisticsStorage: (scope: StatisticsStorageScope) => request<StatisticsStorage>("/settings/storage/statistics", { method: "DELETE", body: JSON.stringify({ scope }) }),
  proxySettings: () => request<ProxySettings>("/settings/proxy"),
  setProxySettings: (settings: ProxySettingsInput) => request<ProxySettings>("/settings/proxy", { method: "PUT", body: JSON.stringify(settings) }),
  tabSettings: () => request<TabSettings>("/settings/tab"),
  setTabSettings: (settings: TabSettings) => request<TabSettings>("/settings/tab", { method: "PUT", body: JSON.stringify(settings) }),
  desktopSettings: () => request<DesktopSettings>("/settings/desktop"),
  setDesktopSettings: (settings: DesktopSettings) => request<DesktopSettings>("/settings/desktop", { method: "PUT", body: JSON.stringify(settings) }),
  commitSettings: (locale: Locale) => request<CommitSettingsView>("/settings/commit", { headers: { "accept-language": locale } }),
  setCommitSettings: (settings: CommitSettings) => request<CommitSettingsView>("/settings/commit", { method: "PUT", body: JSON.stringify(settings) }),
  pricingSettings: () => request<TokenPricingSettings>("/settings/pricing"),
  setPricingSettings: (settings: TokenPricingSettings) => request<TokenPricingSettings>("/settings/pricing", { method: "PUT", body: JSON.stringify(settings) }),
  autoReviewModel: () => request<string | null>("/settings/auto-review-model"),
  setAutoReviewModel: (model: string | null) => request<string | null>("/settings/auto-review-model", { method: "PUT", body: JSON.stringify(model) }),
  modelBadgeSettings: () => request<ModelBadgeSettings>("/settings/model-badges"),
  setModelBadgeSettings: (settings: ModelBadgeSettings) => request<ModelBadgeSettings>("/settings/model-badges", { method: "PUT", body: JSON.stringify(settings) }),
};
