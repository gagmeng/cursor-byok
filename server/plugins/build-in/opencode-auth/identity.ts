import type { PluginContext } from "cursor-byok:plugin";

// OpenCode 2.x 网关的客户端指纹。上游按 2026-10-26 起的规则只把免费档
// 服务给"长得像 OpenCode 自己"的请求:magpie(yetone/magpie)逆向出的
// 五层形态在这里逐层还原——活版本 UA、真铸造的会话 ID、b3/traceparent
// 追踪头、项目哈希与 <env> 环境块。

export const OPENCODE_ANONYMOUS_KEY = "public";

// 版本从 OpenCode 自更新通道取,6 小时刷新一次;取不到时用写入时刻的
// 已知最新版,保证 UA 永远是 2.x 形状(1.x UA 被无条件 429)。
const UPDATER_URL = "https://opencode.ai/update/api/latest/cli/npm";
const FALLBACK_VERSION = "2.2.5";
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;

let cachedVersion = FALLBACK_VERSION;
let versionCheckedAt = 0;
let versionRefreshing: Promise<void> | null = null;

/** 后台刷新最新版本号;失败静默保留旧值且不进入冷却,绝不阻塞调用。 */
export function refreshLatestVersion(context: PluginContext): void {
  if (Date.now() - versionCheckedAt < VERSION_TTL_MS || versionRefreshing !== null) return;
  versionRefreshing = Promise.resolve()
    .then(() => context.network.fetch(UPDATER_URL, { method: "GET", headers: { accept: "application/json" } }))
    .then((response) => {
      if (response.status < 200 || response.status >= 300) return;
      const parsed = JSON.parse(response.body) as { version?: unknown };
      if (typeof parsed.version === "string" && /^\d+\.\d+\.\d+/.test(parsed.version)) {
        cachedVersion = parsed.version;
        versionCheckedAt = Date.now();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      versionRefreshing = null;
    });
}

/** 测试钩子:同步等待一次版本刷新完成。 */
export async function refreshLatestVersionForTest(context: PluginContext): Promise<string> {
  refreshLatestVersion(context);
  await versionRefreshing;
  return cachedVersion;
}

export function opencodeUserAgent(): string {
  return `opencode/latest/${cachedVersion}/cli`;
}

// —— 会话 ID 铸造 ————————————————————————————————————————————————

// 与 packages/core/src/identifier.ts 一致:12 位 hex 的毫秒时间戳
// ×0x1000 + 毫秒内计数器(会话按位取反, newest-first),后接 14 位 base62。
// 网关校验 hex 尾部 12 bit:0xfff - 低12位 < 16(计数器必须 <16),
// 哈希剪裁的假 ID 过不了这一关。
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastMs = 0;
let msCounter = 0;

export function mintOpencodeId(prefix: string, descending: boolean): string {
  const ms = Date.now();
  if (ms !== lastMs) {
    lastMs = ms;
    msCounter = 0;
  }
  msCounter++;
  let current = BigInt(ms) * 0x1000n + BigInt(msCounter);
  if (descending) current = ~current;
  const time = (current & 0xffffffffffffn).toString(16).padStart(12, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  let random = "";
  for (const byte of bytes) random += BASE62[byte % BASE62.length];
  return `${prefix}_${time}${random}`;
}

// —— 会话与追踪的会话级稳定 ——————————————————————————————————————

// 会话 ID 按对话保持稳定(网关按它路由和计配额),追踪 ID 按
// 会话保持稳定、每请求一个新 span。LRU 上限防止长驻进程无限增长。
const KEEP = 256;

const sessionIds = new Map<string, string>();
const traceIds = new Map<string, string>();

export function sessionIdFor(seed: string | null): string {
  if (seed === null) return mintOpencodeId("ses", true);
  const existing = sessionIds.get(seed);
  if (existing !== undefined) {
    sessionIds.delete(seed);
    sessionIds.set(seed, existing);
    return existing;
  }
  const id = mintOpencodeId("ses", true);
  sessionIds.set(seed, id);
  if (sessionIds.size > KEEP) {
    const oldest = sessionIds.keys().next().value;
    if (oldest !== undefined) {
      sessionIds.delete(oldest);
      const trace = traceIds.get(oldest);
      if (trace !== undefined) traceIds.delete(oldest);
    }
  }
  return id;
}

function traceIdFor(session: string): string {
  const existing = traceIds.get(session);
  if (existing !== undefined) {
    traceIds.delete(session);
    traceIds.set(session, existing);
    return existing;
  }
  const trace = hexRandom(16);
  traceIds.set(session, trace);
  return trace;
}

function hexRandom(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// —— 项目 ID 与 <env> 环境块 —————————————————————————————————————

// manifest 声明的 env 名单内读取;权限缺失时静默降级到插件目录,
// 保证请求仍能发出(只是指纹强度下降)。
function firstEnv(...names: string[]): string | null {
  for (const name of names) {
    try {
      const value = Deno.env.get(name);
      if (value !== undefined && value.trim()) return value;
    } catch {
      break;
    }
  }
  return null;
}

function homeDirectory(): string {
  return firstEnv("USERPROFILE", "HOME") ?? Deno.cwd();
}

function tempDirectory(): string {
  return firstEnv("TEMP", "TMP", "TMPDIR") ?? homeDirectory();
}

function platformName(): string {
  switch (Deno.build.os) {
    case "windows":
      return "win32";
    case "darwin":
      return "darwin";
    default:
      return "linux";
  }
}

function joinPath(base: string, leaf: string): string {
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  return base.endsWith(separator) ? `${base}${leaf}` : `${base}${separator}${leaf}`;
}

/** sha1("directory:" + 目录),与 OpenCode 的 project.ts 非仓库分支一致。 */
let cachedProjectKey: string | null = null;

export async function opencodeProjectKey(): Promise<string> {
  if (cachedProjectKey !== null) return cachedProjectKey;
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`directory:${homeDirectory()}`));
  cachedProjectKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return cachedProjectKey;
}

/** OpenCode 2.x 的环境块,逐字复刻;免费档按它区分"自家客户端"与过路请求。 */
export function opencodeEnvironmentBlock(): string {
  const directory = homeDirectory();
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: no",
    `  Platform: ${platformName()}`,
    `  Prefer ${joinPath(tempDirectory(), "opencode")} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
}

export function hasEnvironmentBlock(system: string): boolean {
  return /<env>[\s\S]*Working directory:[\s\S]*<\/env>/.test(system);
}

/** 把环境块放到系统指令最前;已携带环境块的指令原样返回。 */
export function withEnvironmentBlock(instructions: string): string {
  if (hasEnvironmentBlock(instructions)) return instructions;
  return `${opencodeEnvironmentBlock()}\n\n${instructions}`;
}

// —— 网关请求头 ————————————————————————————————————————————————

export async function opencodeGatewayHeaders(
  seed: string | null,
): Promise<Record<string, string>> {
  const session = sessionIdFor(seed);
  const trace = traceIdFor(session);
  const span = hexRandom(8);
  return {
    authorization: `Bearer ${OPENCODE_ANONYMOUS_KEY}`,
    accept: "*/*",
    "user-agent": opencodeUserAgent(),
    b3: `${trace}-${span}-1-${hexRandom(8)}`,
    traceparent: `00-${trace}-${span}-01`,
    "x-opencode-client": "cli",
    "x-opencode-project": await opencodeProjectKey(),
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
  };
}
