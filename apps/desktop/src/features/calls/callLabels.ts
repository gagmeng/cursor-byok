import type { LlmCall } from "../../shared/api";

export function callStatusText(status: string) {
  switch (status) {
    case "running":
      return t("进行中");
    case "completed":
      return t("已完成");
    case "failed":
    case "error":
      return t("失败");
    case "cancelled":
      return t("已取消");
    default:
      return status;
  }
}

export function callPhaseText(phase: string) {
  switch (phase) {
    case "connecting":
      return t("连接中");
    case "waiting":
      return t("等待首个事件");
    case "generating":
      return t("生成中");
    case "done":
      return t("已完成");
    case "failed":
      return t("失败");
    case "cancelled":
      return t("已取消");
    default:
      return phase;
  }
}

export function callActivityText(activity: string | null) {
  if (!activity) return null;
  try {
    const value = JSON.parse(activity) as {
      kind?: string;
      attempt?: number;
      limit?: number;
      delay_seconds?: number;
      message?: string;
      target?: string;
    };
    if (value.kind === "retry") {
      return t("第 {attempt}/{limit} 次重试，{delay} 秒后继续：{message}", {
        attempt: value.attempt ?? 0,
        limit: value.limit ?? 0,
        delay: value.delay_seconds ?? 0,
        message: value.message ?? "",
      });
    }
    if (value.kind === "failover") return t("切换到 {target}", { target: value.target ?? "" });
  } catch {
    return activity;
  }
  return activity;
}

export function callStateText(call: Pick<LlmCall, "status" | "phase" | "activity">) {
  const activity = callActivityText(call.activity);
  const label = call.status === "running" ? callPhaseText(call.phase) : callStatusText(call.status);
  return activity ? `${label} · ${activity}` : label;
}
