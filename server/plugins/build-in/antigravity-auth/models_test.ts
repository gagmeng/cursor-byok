import type { JsonValue, NetworkResponse, PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition } from "cursor-byok:model";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityModels, STATIC_ANTIGRAVITY_MODELS } from "./models.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

/** 只在动态目录里出现的模型:静态兜底永远不会返回它。 */
const LIVE_MODEL = "gemini-9-live-only";

type RequestInit = { body?: string; headers?: Record<string, string> };
type Handler = (url: string, init: RequestInit) => NetworkResponse;

function context(handler: Handler): PluginContext {
  return {
    network: {
      fetch: (url, init = {}) => Promise.resolve(handler(url, init)),
      stream: () => Promise.reject(new Error("stream is not expected")),
    },
    signal: new AbortController().signal,
  };
}

function account(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

function expiredAccount(): ResourceSnapshot {
  return account({
    accessToken: "stale-access-token",
    refreshToken: "refresh-token",
    displayName: "user@example.com",
    projectId: "test-project-123",
    expiresAtMs: Date.now() - 1_000,
  });
}

function liveCatalog(): string {
  return JSON.stringify({ models: { [LIVE_MODEL]: { displayName: "Gemini 9 Live" } } });
}

function isTokenExchange(url: string): boolean {
  return url.includes("oauth2.googleapis.com");
}

function isCodeAssist(url: string): boolean {
  return url.includes("/v1internal:loadCodeAssist");
}

Deno.test("an expired account still syncs the live catalog instead of the static fallback", async () => {
  const requests: string[] = [];
  const models: ModelDefinition[] = await antigravityModels.list(
    { resource: expiredAccount() },
    context((url, init) => {
      requests.push(url);
      if (isTokenExchange(url)) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ access_token: "fresh-access-token", expires_in: 3600 }),
        };
      }
      if (isCodeAssist(url)) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ cloudaicompanionProject: "test-project-123" }),
        };
      }
      const authorization = init.headers?.authorization ?? "";
      if (authorization !== "Bearer fresh-access-token") {
        return { status: 401, headers: {}, body: "expired" };
      }
      return { status: 200, headers: {}, body: liveCatalog() };
    }),
  );

  // 过期 token 会让每个端点都 401,目录静默退回静态表,上游新模型永远不出现。
  assert(
    models.some((model) => model.id === LIVE_MODEL),
    `expected the live catalog, received ${models.map((model) => model.id).join(",")}`,
  );
  assert(
    requests.some(isTokenExchange),
    "the expired access token is exchanged before the catalog request",
  );
});

Deno.test("a rejected access token is retried once with a refreshed one", async () => {
  // 时钟偏差会让 token 看起来没过期却已经被上游拒绝;这条路径不经过过期判断。
  let exchanged = 0;
  const models = await antigravityModels.list(
    { resource: account({ accessToken: "rejected", refreshToken: "refresh-token" }) },
    context((url, init) => {
      if (isTokenExchange(url)) {
        exchanged += 1;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ access_token: "fresh-access-token", expires_in: 3600 }),
        };
      }
      if (isCodeAssist(url)) {
        return { status: 200, headers: {}, body: JSON.stringify({}) };
      }
      if ((init.headers?.authorization ?? "") !== "Bearer fresh-access-token") {
        return { status: 401, headers: {}, body: "expired" };
      }
      return { status: 200, headers: {}, body: liveCatalog() };
    }),
  );

  assertEquals(exchanged, 1);
  assert(
    models.some((model) => model.id === LIVE_MODEL),
    `expected the live catalog after one refresh, received ${
      models.map((model) => model.id).join(",")
    }`,
  );
});

Deno.test("a failed token refresh leaves the static catalog usable", async () => {
  const models = await antigravityModels.list(
    { resource: expiredAccount() },
    context((url) => {
      if (isTokenExchange(url)) {
        return { status: 400, headers: {}, body: JSON.stringify({ error: "invalid_grant" }) };
      }
      return { status: 401, headers: {}, body: "expired" };
    }),
  );

  assertEquals(
    models.map((model) => model.id),
    STATIC_ANTIGRAVITY_MODELS.map((model) => model.id),
  );
});

Deno.test("a successful sync replaces the catalog instead of merging retired models into it", async () => {
  // 合并静态表会把已经下线的模型永远留在目录里,用户点进去只会拿到 4xx。
  const models = await antigravityModels.list(
    { resource: account({ accessToken: "live-access-token" }) },
    context(() => ({ status: 200, headers: {}, body: liveCatalog() })),
  );

  assertEquals(models.map((model) => model.id), [LIVE_MODEL]);
});

Deno.test("an account without a resource falls back to the static catalog", async () => {
  const models = await antigravityModels.list(
    { resource: null },
    context(() => {
      throw new Error("no request is made without a resource");
    }),
  );

  assertEquals(
    models.map((model) => model.id),
    STATIC_ANTIGRAVITY_MODELS.map((model) => model.id),
  );
});
