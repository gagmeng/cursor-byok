import type {
  LlmMessage,
  LlmRequest,
  LlmTool,
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import {
  HttpError as ResponsesHttpError,
  streamOpenAiResponses,
} from "cursor-byok:protocol/openai-responses";
import { isFreeChatModel, isResponsesModel, opencodeModels } from "./models.ts";
import {
  opencodeGatewayHeaders,
  refreshLatestVersion,
  withEnvironmentBlock,
} from "./identity.ts";

// OpenCode 2.x 免费档网关。路径是 2.x 的 /inference/*,/zen/v1 是 1.x
// 的旧路径且已被按 UA 一刀切拒绝。
const CHAT_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
const RESPONSES_URL = "https://opencode.ai/inference/openai/v1/responses";

// 5xx 仅在响应流开始前重试一次。
const RETRYABLE_5XX_DELAY_MS = 1000;
const RETRYABLE_5XX_MAX_ATTEMPTS = 2;

// 免费档校验核心工具:必须出现、参数 schema 必须非空(403 拦截空参
// 占位)。调用方已有的工具原样保留——改名会让宿主的工具分发失配。
const STUB_DESCRIPTION = "Not available in this session. Never call this tool.";
const CORE_TOOL_SCHEMAS: Record<string, JsonValue> = {
  edit: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      oldString: { type: "string", description: "Exact text to find and replace" },
      newString: {
        type: "string",
        description: "Text to replace oldString with (must differ from oldString)",
      },
      replaceAll: {
        type: "boolean",
        description:
          "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  glob: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against" },
      path: {
        type: "string",
        description: "Directory to search. Defaults to the current working directory.",
      },
      hidden: {
        type: "boolean",
        description: "Include hidden files and directories (default: false).",
      },
      limit: {
        type: "integer",
        exclusiveMinimum: 0,
        description: "Maximum number of matching files to return (default: 100)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  grep: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: "Regular expression or literal text to match in file contents.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the current working directory.",
      },
      include: {
        type: "string",
        description: "Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")",
      },
      literal: {
        type: "boolean",
        description:
          "Treat `pattern` as exact text instead of a regular expression (default: false).",
      },
      caseSensitive: {
        type: "boolean",
        description: "Use case-sensitive matching (default: true).",
      },
      limit: {
        type: "integer",
        exclusiveMinimum: 0,
        description: "Maximum number of matching files to return (default: 100)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  read: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to read" },
      offset: {
        type: "integer",
        minimum: 0,
        description: "The line or directory entry to start reading from (1-based)",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description:
          "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  shell: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command string to execute" },
      workdir: {
        type: "string",
        description:
          "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        description:
          "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

function withCoreTools(tools: LlmTool[]): LlmTool[] {
  const missing = Object.entries(CORE_TOOL_SCHEMAS)
    .filter(([name]) => !tools.some((tool) => tool.name === name))
    .map(([name, parameters]) => ({
      name,
      description: STUB_DESCRIPTION,
      parameters,
      strict: false,
    }));
  return [...tools, ...missing];
}

function isQuotaHttpError(error: { status: number; body: string }): boolean {
  if (error.status === 429) return true;
  const body = error.body.toLowerCase();
  return body.includes("freetier") ||
    body.includes("freeusage") ||
    body.includes("insufficient_quota") ||
    body.includes("quota_exceeded") ||
    body.includes("usage_limit");
}

function lastUserText(messages: readonly LlmMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const text = message.content
      .map((part) => part.type === "text" ? part.text : "")
      .join(" ")
      .trim();
    if (text) return text.slice(-600);
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function callOnce(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<void> {
  // 会话种子:优先会话级缓存键,退化为最后一条用户文本,使重试与多轮
  // 复用同一会话(配额按会话路由)。
  const seed = input.request.cacheKey ?? (lastUserText(input.request.messages) || null);
  const headers = await opencodeGatewayHeaders(seed);
  // Muse 免费档只接受 Responses auto tool choice,max effort 会返回 400。
  if (isResponsesModel(input.model.id)) {
    const effort = input.request.reasoning.effort === "max"
      ? "xhigh"
      : input.request.reasoning.effort;
    await streamOpenAiResponses(
      {
        url: RESPONSES_URL,
        model: input.model.id,
        request: {
          ...input.request,
          instructions: withEnvironmentBlock(input.request.instructions),
          reasoning: { ...input.request.reasoning, effort },
          tools: withCoreTools(input.request.tools),
        },
        extraBody: {
          tool_choice: "auto" as JsonValue,
          // 这两个是宿主通用字段,OpenCode 自家请求不带;置 undefined
          // 在 JSON 序列化时剔除,以免成为指纹。
          prompt_cache_key: undefined,
          service_tier: undefined,
        },
        headers,
      },
      output,
      context,
    );
    return;
  }
  await streamOpenAiChat(
    {
      url: CHAT_URL,
      model: input.model.id,
      request: {
        ...input.request,
        instructions: withEnvironmentBlock(input.request.instructions),
        tools: withCoreTools(input.request.tools),
      },
      extraBody: {
        // 无调用方工具时禁止选择指纹占位工具。
        tool_choice: input.request.tools.length === 0 ? "none" : "auto",
      },
      includePromptCacheKey: false,
      includeServiceTier: false,
      headers,
    },
    output,
    context,
  );
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!isFreeChatModel(input.model.id) && !isResponsesModel(input.model.id)) {
    return { status: "request-error", message: `model ${input.model.id} is not a free model` };
  }
  // 版本号后台刷新;首个请求用兜底版本,后续请求用最新值。
  refreshLatestVersion(context);
  let attempt = 0;
  while (true) {
    try {
      await callOnce(input, output, context);
      return { status: "completed" };
    } catch (error) {
      if (error instanceof HttpError || error instanceof ResponsesHttpError) {
        if (isQuotaHttpError(error)) {
          return { status: "request-error", message: error.message };
        }
        // 仅首字节前重试,避免流式响应重复产生下游调用。
        if (error.status >= 500 && attempt + 1 < RETRYABLE_5XX_MAX_ATTEMPTS) {
          attempt++;
          await sleep(RETRYABLE_5XX_DELAY_MS * attempt);
          continue;
        }
        return { status: "request-error", message: error.message };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { status: "request-error", message };
    }
  }
}

export const opencodeProvider: ProviderSupport = {
  id: "opencode",
  displayName: {
    "en-US": "OpenCode Free",
    "zh-CN": "OpenCode Free",
  },
  description: {
    "en-US":
      "OpenCode Zen free tier through the official chat endpoint; no account or API key required.",
    "zh-CN": "通过官方 OpenCode Zen 免费层直连,无需账号或 API Key。",
  },
  providerType: "opencode",
  models: opencodeModels,
  invoke,
};
