//! Keeps calendar queries and labels on complete local calendar days.
import type { Overview } from "../../shared/api";

export function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function calendarRange(endMs: number) {
  const first = new Date(endMs);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 364);
  return { startMs: first.getTime(), endMs };
}

export function contributionCalendarData(overview: Pick<Overview, "token_usage_series">, endMs: number) {
  const tokensByDate = new Map<string, number>();
  for (const bucket of overview.token_usage_series) {
    const key = localDateKey(new Date(bucket.bucket_start_ms));
    const tokens = bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens;
    tokensByDate.set(key, (tokensByDate.get(key) ?? 0) + tokens);
  }
  const start = new Date(calendarRange(endMs).startMs);
  return Array.from({ length: 365 }, (_, index) => {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    const date = localDateKey(day);
    return { date, tokens: tokensByDate.get(date) ?? 0 };
  });
}
