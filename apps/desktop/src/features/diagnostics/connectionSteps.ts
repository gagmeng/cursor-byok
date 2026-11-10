//! Derives connection progress only from evidence associated with a diagnostic challenge.
import type { ConnectionDiagnostic } from "../../shared/api";

export type DiagnosticStepState = "passed" | "waiting" | "failed";
export function connectionSteps(session: ConnectionDiagnostic) {
  return [
    { key: "request", state: session.request_seen_at_ms ? "passed" : "waiting" },
    { key: "stream", state: session.stream_seen_at_ms ? "passed" : "waiting" },
    { key: "upstream", state: session.upstream_response_at_ms ? "passed" : session.error_message ? "failed" : "waiting" },
    { key: "tool", state: session.tool_result_at_ms ? "passed" : "waiting" },
  ] as { key: "request" | "stream" | "upstream" | "tool"; state: DiagnosticStepState }[];
}

export function diagnosticInstruction(marker: string) {
  return `Connection diagnostic ${marker}. Use your terminal tool to run exactly: echo ${marker}. Then reply with the tool output only. Do not modify any files.`;
}
