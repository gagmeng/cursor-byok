//! Verifies yearly coverage and local date boundaries.
import test from "node:test";
import assert from "node:assert/strict";
import { calendarRange, contributionCalendarData } from "./overviewDates.ts";

test("annual_activity_requests_all_365_days_independently_of_the_selected_metrics_range", () => {
  const end = new Date(2026, 10, 10, 12).getTime();
  const range = calendarRange(end);
  assert.equal(contributionCalendarData({token_usage_series: []}, end).length, 365);
  assert.ok(range.startMs <= end - 364 * 86400000);
  const day = new Date(end); day.setHours(0,0,0,0);
  const data = contributionCalendarData({token_usage_series: [{bucket_start_ms: day.getTime(), input_tokens: 7, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 3}]}, end);
  assert.deepEqual(data.at(-1), {date: "2026-11-10", tokens:10});
});
