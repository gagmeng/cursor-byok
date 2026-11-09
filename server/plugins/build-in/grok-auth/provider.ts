import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { grokModels } from "./models.ts";
import { type AccountData, accountData, quotaExhaustedPatch, RESOURCE_TYPE } from "./resources.ts";
import { renewAccessToken } from "./oauth.ts";

const CHAT_URL = "https://api.x.ai/v1/chat/completions";

/** 流内错误只有文本可用,按积分/额度关键词分类。 */
export function isQuotaError(error: string): boolean {
  const message = error.toLowerCase();
  return message.includes("insufficient_quota") ||
    message.includes("credits exhausted") ||
    message.includes("out of credits") ||
    message.includes("quota_exceeded") ||
    (message.includes("429") &&
      (message.includes("quota") || message.includes("credit") ||
        message.includes("insufficient")));
}

/** HTTP 失败携带结构化状态码,429 一律按额度耗尽处理并冷却账号。 */
function isQuotaHttpError(error: HttpError): boolean {
  if (error.status === 429) return true;
  const body = error.body.toLowerCase();
  return body.includes("insufficient_quota") ||
    body.includes("credits exhausted") ||
    body.includes("out of credits") ||
    // 免费账号触达消费上限时返回 403 spending-limit,属于额度而非授权问题。
    body.includes("spending-limit") ||
    body.includes("run out of credits") ||
    body.includes("quota_exceeded");
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

async function streamGrok(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
  accessToken: string,
): Promise<void> {
  await streamOpenAiChat(
    {
      url: CHAT_URL,
      model: input.model.id,
      // xAI 不接受 reasoning_effort 与 service_tier;思考由模型自身决定。
      request: {
        ...input.request,
        reasoning: { enabled: false, effort: null },
        latency: "standard",
      },
      headers: { authorization: `Bearer ${accessToken}` },
    },
    output,
    context,
  );
}

/** 把 HttpError 归类成 provider 结果;额度类附带冷却 patch。 */
function httpOutcome(error: HttpError, data: AccountData): ProviderResult {
  if ((error.status === 401 || error.status === 403) && !isQuotaHttpError(error)) {
    return invalidResult(error.message, "Grok authorization expired; sign in again");
  }
  if (isQuotaHttpError(error)) {
    return {
      status: "resource-error",
      message: error.message,
      patch: quotaExhaustedPatch(data),
    };
  }
  return { status: "request-error", message: error.message };
}

function requestErrorResult(message: string): ProviderResult {
  return { status: "request-error", message };
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a Grok account before calling Grok" };
  }
  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }
  try {
    await streamGrok(input, output, context, data.accessToken);
    return { status: "completed" };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      const message = error instanceof Error ? error.message : String(error);
      if (isQuotaError(message)) {
        return { status: "resource-error", message, patch: quotaExhaustedPatch(data) };
      }
      return requestErrorResult(message);
    }
    // 401/403 且还有 refresh_token:静默续期一次再试;新凭据经 patch 持久化。
    if (
      (error.status === 401 || error.status === 403) &&
      !isQuotaHttpError(error) &&
      data.refreshToken
    ) {
      let renewed: { accessToken: string; refreshToken: string | null } | null;
      try {
        renewed = await renewAccessToken(data.refreshToken, context);
      } catch (renewError) {
        return requestErrorResult(
          renewError instanceof Error ? renewError.message : String(renewError),
        );
      }
      if (!renewed) {
        return invalidResult(error.message, "Grok authorization expired; sign in again");
      }
      const next: AccountData = { ...data, accessToken: renewed.accessToken, refreshToken: renewed.refreshToken };
      try {
        await streamGrok(input, output, context, next.accessToken);
        return {
          status: "completed",
          patch: { privateData: next as unknown as JsonValue },
        };
      } catch (retryError) {
        if (retryError instanceof HttpError) {
          return httpOutcome(retryError, next);
        }
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        if (isQuotaError(message)) {
          return { status: "resource-error", message, patch: quotaExhaustedPatch(next) };
        }
        return requestErrorResult(message);
      }
    }
    return httpOutcome(error, data);
  }
}

export const grokProvider: ProviderSupport = {
  id: "grok",
  displayName: "xAI Grok",
  description: {
    "en-US": "SuperGrok subscription access through the official Grok CLI endpoint.",
    "zh-CN": "通过官方 Grok CLI 接口使用 SuperGrok 订阅。",
  },
  providerType: "xai",
  resourceType: RESOURCE_TYPE,
  models: grokModels,
  invoke,
};
