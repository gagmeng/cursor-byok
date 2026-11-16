import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityProvider, isQuotaError } from "./provider.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${message ? message + ": " : ""}expected ${right}, received ${left}`);
  }
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.\n\nCUSTOM_SYSTEM_PROMPT 中文😀",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-3.7-flash-medium",
        displayName: "Gemini 3.7 Flash Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-3.7-flash-medium");
  const system = (body.request as Record<string, unknown>).systemInstruction as {
    parts: { text: string }[];
  };
  assertEquals(
    system.parts[0].text,
    "You are an AI coding assistant.\n\nCUSTOM_SYSTEM_PROMPT 中文😀",
  );
  assert(!("sessionId" in body), "unsupported sessionId field was sent");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});

type ReplayValue = { thoughtSignature?: string; modelFamily?: string };

function assistantWithSignature(
  callId: string,
  replayState: { providerKind: string; value: ReplayValue } | null,
): LlmRequest["messages"][number] {
  return {
    role: "assistant",
    text: "",
    thinking: "",
    replayState,
    toolCalls: [{ index: 0, callId, name: "ping", arguments: {} }],
  };
}

function toolResult(callId: string): LlmRequest["messages"][number] {
  return { role: "tool", callId, name: "ping", content: "ok", isError: false, parts: [] };
}

/** 一个只回一行文本的 SSE 响应,让调用走到 replay-state 发射点。 */
function stopStream(onBody: (body: string) => void) {
  return (_url: string, init?: { body?: string }) => {
    onBody(init?.body ?? "");
    return {
      status: 200,
      headers: {},
      lines: sse([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}',
      ]),
    };
  };
}

Deno.test("a signature from another model family is never replayed to the current model", async () => {
  // 同一会话里切换模型时,上一个模型族的 thoughtSignature 会被上游判为
  // Corrupted thought signature 而直接 400。
  let captured = "";
  await antigravityProvider.invoke(
    {
      model: { id: "gemini-3.7-flash-medium", displayName: "Gemini", privateData: {} },
      resource: snapshot({ accessToken: "mock-access-token" }),
      request: {
        ...request(),
        messages: [
          { role: "user", content: [{ type: "text", text: "turn 1" }] },
          assistantWithSignature("c1", {
            providerKind: "antigravity",
            value: { thoughtSignature: "claude_sig", modelFamily: "claude" },
          }),
          toolResult("c1"),
          assistantWithSignature("c2", {
            providerKind: "antigravity",
            value: { thoughtSignature: "legacy_untagged_sig" },
          }),
          toolResult("c2"),
          assistantWithSignature("c3", {
            providerKind: "antigravity",
            value: { thoughtSignature: "gemini_37_sig", modelFamily: "gemini-3" },
          }),
          toolResult("c3"),
        ],
      },
    },
    { emit: () => {} },
    context({ stream: stopStream((body) => captured = body) }),
  );

  const contents = (JSON.parse(captured) as {
    request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  }).request.contents;
  const modelTurns = contents.filter((c) => c.role === "model");
  assertEquals(modelTurns[0].parts[0].thoughtSignature, "skip_thought_signature_validator");
  assertEquals(
    modelTurns[1].parts[0].thoughtSignature,
    "skip_thought_signature_validator",
    "a signature stored before families were recorded cannot be trusted for any model",
  );
  assertEquals(
    modelTurns[2].parts[0].thoughtSignature,
    "gemini_37_sig",
    "a signature from the same family must still be replayed",
  );
});

Deno.test("the emitted replay state records which model family produced the signature", async () => {
  const events: ModelEvent[] = [];
  await antigravityProvider.invoke(
    {
      model: { id: "claude-sonnet-4-6", displayName: "Claude", privateData: {} },
      resource: snapshot({ accessToken: "mock-access-token" }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"claude_sig_123"}]},"finishReason":"STOP"}]}}',
        ]),
      }),
    }),
  );

  const replay = events.find((event) => event.type === "replay-state") as
    | { type: string; providerKind: string; value: ReplayValue }
    | undefined;
  assert(replay !== undefined, "the turn emits its replay state");
  assertEquals(replay.providerKind, "antigravity");
  assertEquals(replay.value, { thoughtSignature: "claude_sig_123", modelFamily: "claude" });
});

Deno.test("an alias resolves to its target model family before the signature is checked", async () => {
  // claude-3-5-sonnet 实际发往 claude-sonnet-4-6;按请求 id 算族名会得出 `claude-3-5-sonnet`,
  // 于是同族签名被误判为跨族而丢弃。
  const events: ModelEvent[] = [];
  await antigravityProvider.invoke(
    {
      model: { id: "claude-3-5-sonnet", displayName: "Claude", privateData: {} },
      resource: snapshot({ accessToken: "mock-access-token" }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok","thoughtSignature":"alias_sig"}]},"finishReason":"STOP"}]}}',
        ]),
      }),
    }),
  );

  const replay = events.find((event) => event.type === "replay-state") as
    | { value: ReplayValue }
    | undefined;
  assert(replay !== undefined, "the turn emits its replay state");
  assertEquals(replay.value.modelFamily, "claude");
});
