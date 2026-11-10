//! Verifies explicit untested states and challenge-specific connection progress.
import test from "node:test";
import assert from "node:assert/strict";
import { connectionSteps, diagnosticInstruction } from "./connectionSteps.ts";

test("missing_evidence_never_appears_as_a_successful_connection", () => {
  assert.deepEqual(connectionSteps({}).map(step => step.state), ["waiting", "waiting", "waiting", "waiting"]);
  assert.deepEqual(connectionSteps({ request_seen_at_ms:1, stream_seen_at_ms:2, error_message:"upstream failed" }).map(step => step.state), ["passed", "passed", "failed", "waiting"]);
});
test("the_user_instruction_requests_a_bounded_tool_roundtrip_with_its_marker", () => {
  const instruction = diagnosticInstruction("BYOK_DIAGNOSTIC_TEST");
  assert.match(instruction, /echo BYOK_DIAGNOSTIC_TEST/);
  assert.match(instruction, /Do not modify any files/);
});
