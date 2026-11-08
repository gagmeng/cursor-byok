import type { NetworkEventStream, PluginContext } from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import { isFreeChatModel, isResponsesModel, opencodeModels } from "./models.ts";
import { opencodeProvider } from "./provider.ts";
import {
  mintOpencodeId,
  opencodeEnvironmentBlock,
  refreshLatestVersionForTest,
} from "./identity.ts";
function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message = ""): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message ? message + ": " : ""}expected ${right}, received ${left}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;
type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

function context(stream: StreamHandler, fetch?: FetchHandler): PluginContext {
  return {
    network: {
      fetch: fetch ?? (() => {
        throw new Error("fetch was not expected");
      }),
      stream: (url, init) => Promise.resolve(stream(url, init)),
    },
    signal: new AbortController().signal,
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

const CHAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
const RESPONSES_URL = "https://opencode.ai/inference/openai/v1/responses";

function request(): LlmRequest {
  return {
    instructions: "You are a coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "fast",
    maxOutputTokens: 128_000,
    cacheKey: "conversation-1",
  };
}

function snapshot(modelId: string) {
  return {
    id: modelId,
    displayName: modelId,
    privateData: {},
  };
}

const CHAT_OK = [
  'data: {"choices":[{"delta":{"content":"ok"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
  "data: [DONE]",
];

// 真铸造 ID 的形状校验,与上游 openCodeRealSession 相同:
// ses_ + 12 hex + 14 base62,hex 尾部 12 bit 的计数器必须 <16。
function assertRealOpencodeId(id: string, prefix: string): void {
  assert(id.startsWith(`${prefix}_`), `${id} keeps the ${prefix}_ prefix`);
  const rest = id.slice(prefix.length + 1);
  assert(/^[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(rest), `${id} matches the mint shape`);
  const low = parseInt(rest.slice(9, 12), 16);
  assert(0xfff - low < 16, `${id} carries a small mint counter, not a hash`);
}

Deno.test("minted ids match the shape OpenCode's identifier lays out", () => {
  assertRealOpencodeId(mintOpencodeId("ses", true), "ses");
  const first = mintOpencodeId("ses", true);
  const second = mintOpencodeId("ses", true);
  assert(first !== second, "every mint is fresh");
});

Deno.test("environment block matches the OpenCode builtin shape", () => {
  const block = opencodeEnvironmentBlock();
  assert(block.startsWith("Here is some useful information about the environment you are running in:"));
  assert(block.includes("<env>"));
  assert(/Working directory: .+/m.test(block));
  assert(/Workspace root folder: .+/m.test(block));
  assert(block.includes("Is directory a git repo: no"));
  assert(/Platform: (win32|darwin|linux)/m.test(block));
  assert(block.includes("over generic system temporary directories"));
  assert(block.trimEnd().endsWith("</env>"));
});

Deno.test("free model gate auto-admits free tiers minus exclusions", () => {
  assert(isFreeChatModel("big-pickle"), "big-pickle is the suffix-less free model");
  assert(isFreeChatModel("mimo-v2.6-flash-free"), "-free suffix is auto-admitted");
  assert(isFreeChatModel("space-bunny-free"), "space-bunny is auto-admitted");
  assert(
    isFreeChatModel("some-brand-new-free"),
    "new upstream -free models are admitted without a code change",
  );
  assert(
    !isFreeChatModel("muse-spark-1.3-contributor-free"),
    "responses-only muse excluded from chat lane",
  );
  assert(
    !isFreeChatModel("muse-spark-1.2-contributor-free"),
    "responses-only muse excluded from chat lane",
  );
  assert(
    isResponsesModel("muse-spark-1.3-contributor-free"),
    "responses-only muse accepted on responses lane",
  );
  assert(!isResponsesModel("big-pickle"), "chat models are not responses-only");
  assert(!isFreeChatModel("union-alpha"), "messages-only / no free tier excluded");
  assert(!isFreeChatModel("gpt-5.6-luna"), "paid model excluded");
  assert(!isFreeChatModel("jev-1.13-free"), "jev free is out of scope");
  assert(!isFreeChatModel("jev-1.14-free"), "later jev versions stay excluded");
  assert(!isFreeChatModel("deepseek-v4-flash-free"), "dead free model excluded");
});

Deno.test("provider uses a stable lowercase product type", () => {
  assertEquals(opencodeProvider.providerType, "opencode");
});

Deno.test("models.list returns upstream free models without a static catalog", async () => {
  const models = await opencodeModels.list(
    { resource: null },
    {
      network: {
        fetch: async () => ({
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [
              { id: "big-pickle", name: "Big Pickle" },
              { id: "mimo-v2.5-free" },
              { id: "space-bunny-free" },
              { id: "muse-spark-1.3-contributor-free" },
              { id: "muse-spark-1.2-contributor-free" },
              { id: "brand-new-2.0-free" },
              { id: "jev-1.13-free" },
              { id: "jev-2.0-free" },
              { id: "deepseek-v4-flash-free" },
              { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
              { id: "union-alpha" },
            ],
          }),
        }),
        stream: async () => {
          throw new Error("stream not expected in model discovery");
        },
      },
      signal: new AbortController().signal,
    },
  );
  assertEquals(models.map((model) => model.id), [
    "big-pickle",
    "mimo-v2.5-free",
    "space-bunny-free",
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor-free",
    "brand-new-2.0-free",
  ]);
  assertEquals(models[1].displayName, "Mimo V2.5 Free");
});

Deno.test("models.list surfaces HTTP errors instead of returning a built-in catalog", async () => {
  let failure: unknown;
  try {
    await opencodeModels.list(
      { resource: null },
      {
        network: {
          fetch: async () => ({
            status: 500,
            headers: {},
            body: "boom",
          }),
          stream: async () => {
            throw new Error("stream not expected in model discovery");
          },
        },
        signal: new AbortController().signal,
      },
    );
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error);
  assertEquals(failure.message, "OpenCode model discovery failed with HTTP 500");
});

Deno.test("models.list rejects an empty free-model result", async () => {
  let failure: unknown;
  try {
    await opencodeModels.list(
      { resource: null },
      {
        network: {
          fetch: async () => ({
            status: 200,
            headers: {},
            body: JSON.stringify({ data: [] }),
          }),
          stream: async () => {
            throw new Error("stream not expected in model discovery");
          },
        },
        signal: new AbortController().signal,
      },
    );
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error);
  assertEquals(failure.message, "OpenCode model discovery returned no free models");
});

Deno.test("invoke carries the OpenCode 2.x gateway fingerprint", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];
  const result = await opencodeProvider.invoke(
    { model: snapshot("big-pickle"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context((url, init) => {
      assertEquals(url, CHAT_URL);
      requestBody = init?.body ?? "";
      requestHeaders = init?.headers ?? {};
      return { status: 200, headers: {}, lines: sse(CHAT_OK) };
    }),
  );

  assertEquals(result, { status: "completed" });

  // 层 1/2:身份与路由头。四个会话头同一 ID,无 1.x 的 x-opencode-request。
  assert(requestHeaders.authorization === "Bearer public", "anonymous public bearer");
  assert(requestHeaders.accept === "*/*", "gateway expects */*");
  assert(
    /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/.test(requestHeaders["user-agent"]),
    `2.x live UA, got ${requestHeaders["user-agent"]}`,
  );
  assert(requestHeaders["x-opencode-client"] === "cli", "2.x client id is cli");
  assert(/^[0-9a-f]{40}$/.test(requestHeaders["x-opencode-project"]), "project id is a sha1");
  const session = requestHeaders["x-opencode-session"];
  assertRealOpencodeId(session, "ses");
  assertEquals(requestHeaders["x-opencode-session-id"], session);
  assertEquals(requestHeaders["x-session-affinity"], session);
  assertEquals(requestHeaders["x-session-id"], session);
  assertEquals(requestHeaders["x-opencode-request"], undefined);
  assert(
    /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/.test(requestHeaders.b3),
    "b3 trace header follows the captured shape",
  );
  assert(
    requestHeaders.traceparent ===
      `00-${requestHeaders.b3.split("-")[0]}-${requestHeaders.b3.split("-")[1]}-01`,
    "traceparent shares the b3 trace and span",
  );

  // 层 4/5:请求体。环境块在最前,五个核心工具全部带真实 schema。
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.model, "big-pickle");
  assertEquals(body.stream, true);
  assertEquals(body.stream_options, { include_usage: true });
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  assertEquals(messages[0].role, "system");
  const system = messages[0].content as string;
  assert(system.startsWith("Here is some useful information about the environment"), "env block first");
  assert(system.includes("<env>") && system.includes("</env>"), "env block present");
  assert(system.includes("You are a coding assistant."), "host instructions preserved after env");
  assertEquals(body.prompt_cache_key, undefined, "OpenCode does not send prompt_cache_key");
  assertEquals(body.service_tier, undefined, "OpenCode does not send service_tier");
  const tools = body.tools as Array<{ function: { name: string; parameters: unknown; strict?: boolean } }>;
  const names = tools.map((tool) => tool.function.name).sort();
  assertEquals(names, ["edit", "glob", "grep", "read", "shell"]);
  for (const tool of tools) {
    const parameters = tool.function.parameters as { properties?: Record<string, unknown> };
    assert(
      parameters.properties !== undefined && Object.keys(parameters.properties).length > 0,
      `${tool.function.name} must carry a real parameter schema`,
    );
    assertEquals(tool.function.strict, false);
  }
  assertEquals(body.tool_choice, "none", "no caller tools, stubs must not be picked");

  assertEquals(events, [
    { type: "text-start" },
    { type: "text-delta", text: "ok" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("invoke keeps caller tools and appends only missing core tools", async () => {
  let requestBody = "";
  const req = request();
  req.tools = [{
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  }];
  await opencodeProvider.invoke(
    { model: snapshot("big-pickle"), resource: null, request: req },
    { emit: (_event) => undefined },
    context((_url, init) => {
      requestBody = init?.body ?? "";
      return { status: 200, headers: {}, lines: sse(CHAT_OK) };
    }),
  );
  const body = JSON.parse(requestBody) as { tools: Array<{ function: { name: string } }>; tool_choice: string };
  const names = body.tools.map((tool) => tool.function.name).sort();
  assertEquals(names, ["bash", "edit", "glob", "grep", "read", "shell"]);
  assertEquals(body.tool_choice, "auto", "caller tools exist, model may call them");
});

Deno.test("invoke rejects paid models before reaching the network", async () => {
  const events: ModelEvent[] = [];
  let called = false;
  const result = await opencodeProvider.invoke(
    { model: snapshot("gpt-5.6-luna"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context(() => {
      called = true;
      throw new Error("network must not be reached");
    }),
  );
  assert(!called, "paid model must be blocked locally");
  assertEquals(result.status, "request-error");
  assertEquals(events, []);
});

Deno.test("invoke routes muse to the 2.x responses endpoint", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];
  const result = await opencodeProvider.invoke(
    { model: snapshot("muse-spark-1.3-contributor-free"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context((url, init) => {
      assertEquals(url, RESPONSES_URL);
      requestBody = init?.body ?? "";
      requestHeaders = init?.headers ?? {};
      return {
        status: 200,
        headers: {},
        lines: sse([
          'data: {"type":"response.created","response":{"id":"r_1","status":"in_progress"}}',
          'data: {"type":"response.reasoning_text.delta","delta":"think"}',
          'data: {"type":"response.reasoning_text.done"}',
          'data: {"type":"response.output_text.delta","delta":"Hel"}',
          'data: {"type":"response.output_text.delta","delta":"lo"}',
          'data: {"type":"response.output_text.done","text":"Hello","output_index":1}',
          'data: {"type":"response.completed","response":{"id":"r_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7,"output_tokens_details":{"reasoning_tokens":1}}}}',
          "data: [DONE]",
        ]),
      };
    }),
  );
  assertEquals(result.status, "completed");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.model, "muse-spark-1.3-contributor-free");
  assertEquals(body.tool_choice, "auto");
  assert(
    typeof body.instructions === "string" && (body.instructions as string).includes("<env>"),
    "env block on responses lane",
  );
  assertEquals(body.prompt_cache_key, undefined);
  const tools = body.tools as Array<{ name: string; parameters: Record<string, unknown> }>;
  const names = tools.map((tool) => tool.name).sort();
  assertEquals(names, ["edit", "glob", "grep", "read", "shell"]);
  for (const tool of tools) {
    assert(Object.keys(tool.parameters.properties ?? {}).length > 0, `${tool.name} has a real schema`);
  }
  assertRealOpencodeId(requestHeaders["x-opencode-session"], "ses");
  assertEquals(events.filter((event) => event.type === "thinking-delta").length, 1);
  assertEquals(events.filter((event) => event.type === "text-delta").length, 2);
});

Deno.test("invoke clamps max effort to xhigh on the responses lane", async () => {
  let requestBody = "";
  const events: ModelEvent[] = [];
  const req = request();
  req.reasoning.effort = "max";
  const result = await opencodeProvider.invoke(
    { model: snapshot("muse-spark-1.3-contributor-free"), resource: null, request: req },
    { emit: (event) => events.push(event) },
    context((_url, init) => {
      requestBody = init?.body ?? "";
      return {
        status: 200,
        headers: {},
        lines: sse([
          'data: {"type":"response.created","response":{"id":"r_1","status":"in_progress"}}',
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.output_text.done","text":"ok","output_index":0}',
          'data: {"type":"response.completed","response":{"id":"r_1","status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
          "data: [DONE]",
        ]),
      };
    }),
  );
  assertEquals(result.status, "completed");
  const body = JSON.parse(requestBody) as { reasoning: { effort: string } };
  assertEquals(body.reasoning.effort, "xhigh");
});

Deno.test("invoke maps 429 and FreeUsageLimit to a request error", async () => {
  const events: ModelEvent[] = [];
  const result = await opencodeProvider.invoke(
    { model: snapshot("big-pickle"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context(() => {
      return {
        status: 429,
        headers: {},
        lines: sse([
          'data: {"error":{"message":"FreeUsageLimitError: retry after 600s"}}',
        ]),
      };
    }),
  );
  assertEquals(result.status, "request-error");
  assertEquals(events, []);
});

Deno.test("invoke keeps one session per conversation and fresh spans per request", async () => {
  const sessions: string[] = [];
  const b3Spans: string[] = [];
  const handler: StreamHandler = (_url, init) => {
    sessions.push(init?.headers?.["x-opencode-session"] ?? "");
    b3Spans.push((init?.headers?.b3 ?? "").split("-")[1] ?? "");
    return { status: 200, headers: {}, lines: sse(CHAT_OK) };
  };
  for (let round = 0; round < 2; round++) {
    await opencodeProvider.invoke(
      { model: snapshot("big-pickle"), resource: null, request: request() },
      { emit: (_event) => undefined },
      context(handler),
    );
  }
  assertEquals(sessions.length, 2);
  assertRealOpencodeId(sessions[0], "ses");
  assertEquals(sessions[0], sessions[1], "same conversation keeps the same session");
  assert(b3Spans[0] !== b3Spans[1], "each request carries a fresh span");
  await opencodeProvider.invoke(
    {
      model: snapshot("big-pickle"),
      resource: null,
      request: {
        ...request(),
        cacheKey: "conversation-2",
        messages: [{ role: "user", content: [{ type: "text", text: "different question" }] }],
      },
    },
    { emit: (_event) => undefined },
    context(handler),
  );
  assert(sessions[2] !== sessions[0], "a different conversation mints its own session");
  assertRealOpencodeId(sessions[2], "ses");
});

Deno.test("invoke reuses a stable session when cacheKey is absent", async () => {
  const sessions: string[] = [];
  const handler: StreamHandler = (_url, init) => {
    sessions.push(init?.headers?.["x-opencode-session"] ?? "");
    return { status: 200, headers: {}, lines: sse(CHAT_OK) };
  };
  const base = request();
  base.cacheKey = null;
  for (let round = 0; round < 2; round++) {
    await opencodeProvider.invoke(
      { model: snapshot("big-pickle"), resource: null, request: { ...base } },
      { emit: (_event) => undefined },
      context(handler),
    );
  }
  assertEquals(sessions.length, 2);
  assertRealOpencodeId(sessions[0], "ses");
  assertEquals(sessions[0], sessions[1], "same question reuses the same session");
});

Deno.test("invoke retries a 500 once and completes", async () => {
  let calls = 0;
  const handler: StreamHandler = (_url, _init) => {
    calls++;
    if (calls === 1) {
      return {
        status: 500,
        headers: {},
        lines: sse(['data: {"error":{"message":"Internal server error"}}']),
      };
    }
    return { status: 200, headers: {}, lines: sse(CHAT_OK) };
  };
  const events: ModelEvent[] = [];
  const result = await opencodeProvider.invoke(
    { model: snapshot("big-pickle"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context(handler),
  );
  assert(calls === 2, "one retry after the 500");
  assertEquals(result.status, "completed");
});

Deno.test("invoke reports a 500 after one retry as request-error", async () => {
  let calls = 0;
  const handler: StreamHandler = (_url, _init) => {
    calls++;
    return {
      status: 500,
      headers: {},
      lines: sse(['data: {"error":{"message":"Internal server error"}}']),
    };
  };
  const events: ModelEvent[] = [];
  const result = await opencodeProvider.invoke(
    { model: snapshot("big-pickle"), resource: null, request: request() },
    { emit: (event) => events.push(event) },
    context(handler),
  );
  assert(calls === 2, "exactly one retry, then reports");
  assertEquals(result.status, "request-error");
  assertEquals(events, []);
});

Deno.test("user agent tracks the live updater version and survives failures", async () => {
  const seen: string[] = [];
  const version = await refreshLatestVersionForTest({
    network: {
      fetch: async (url) => {
        seen.push(url);
        return { status: 200, headers: {}, body: JSON.stringify({ version: "9.9.9" }) };
      },
      stream: async () => {
        throw new Error("stream not expected from the updater");
      },
    },
    signal: new AbortController().signal,
  });
  assertEquals(version, "9.9.9");
  assertEquals(seen, ["https://opencode.ai/update/api/latest/cli/npm"]);
  const stale = await refreshLatestVersionForTest({
    network: {
      fetch: async () => {
        throw new Error("updater must not be polled again within the TTL");
      },
      stream: async () => {
        throw new Error("stream not expected from the updater");
      },
    },
    signal: new AbortController().signal,
  });
  assertEquals(stale, "9.9.9", "the cached version serves within the TTL");
});
