//! 验证系统提示词大小限制和按模型隔离的草稿恢复。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL_SYSTEM_PROMPT_SETTINGS,
  INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR,
  cursorSystemPromptEditorReducer,
  modelSystemPromptStatus,
} from "./cursorSystemPrompt.ts";

const settings = { enabled: true, content: "原有提示词", position: "after" };
const firstTarget = { modelId: "builtin-hash", displayName: "内置模型" };
const secondTarget = { modelId: "plugin/provider/model", displayName: "插件模型" };

function loadedEditor() {
  const opened = cursorSystemPromptEditorReducer(INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR, {
    type: "open", sessionId: 1, target: firstTarget,
  });
  return cursorSystemPromptEditorReducer(opened, { type: "loaded", sessionId: 1, settings });
}

test("chinese_and_emoji_count_as_utf8_bytes_not_characters", () => {
  assert.deepEqual(modelSystemPromptStatus({ ...settings, content: "中🙂" }), { byteLength: 7, error: null });
  assert.equal(modelSystemPromptStatus({ ...settings, content: "中文\n🙂" }).byteLength, 11);
});

test("exactly_32768_utf8_bytes_can_be_saved", () => {
  const content = "🙂".repeat(8192);
  assert.deepEqual(modelSystemPromptStatus({ ...settings, content }), { byteLength: 32768, error: null });
});

test("a_32769_byte_prompt_is_rejected_even_when_disabled", () => {
  const content = `${"🙂".repeat(8192)}a`;
  for (const enabled of [true, false]) {
    assert.deepEqual(modelSystemPromptStatus({ ...settings, enabled, content }), {
      byteLength: 32769, error: "too-large",
    });
  }
});

test("enabled_prompts_reject_empty_and_all_whitespace_content", () => {
  for (const content of ["", " \t\r\n", "　 "]) {
    assert.equal(modelSystemPromptStatus({ ...settings, content }).error, "empty");
    assert.equal(modelSystemPromptStatus({ ...settings, enabled: false, content }).error, null);
  }
});

test("disabling_keeps_complete_multiline_content_and_position", () => {
  const content = "  中文🙂\n第二行\r\n\t ";
  const edited = cursorSystemPromptEditorReducer(loadedEditor(), {
    type: "change", settings: { enabled: true, content, position: "before" },
  });
  const disabled = cursorSystemPromptEditorReducer(edited, {
    type: "change", settings: { ...edited.draft, enabled: false },
  });
  assert.deepEqual(disabled.draft, { enabled: false, content, position: "before" });
  assert.equal(modelSystemPromptStatus(disabled.draft).error, null);
  assert.deepEqual(disabled.loaded, settings);
});

test("new_model_edits_start_disabled_empty_and_after_without_reusing_another_draft", () => {
  assert.deepEqual(DEFAULT_MODEL_SYSTEM_PROMPT_SETTINGS, { enabled: false, content: "", position: "after" });
  const opened = cursorSystemPromptEditorReducer(loadedEditor(), {
    type: "open", sessionId: 2, target: secondTarget,
  });
  assert.deepEqual(opened.target, secondTarget);
  assert.deepEqual(opened.draft, { enabled: false, content: "", position: "after" });
  assert.equal(opened.loaded, null);
  assert.equal(opened.loading, true);
  const changed = cursorSystemPromptEditorReducer(opened, { type: "change", settings });
  assert.deepEqual(changed, opened, "a pending load must not expose an editable placeholder as saved settings");
});

test("late_load_success_and_failure_cannot_replace_the_current_model", () => {
  const current = cursorSystemPromptEditorReducer(loadedEditor(), {
    type: "open", sessionId: 2, target: secondTarget,
  });
  assert.deepEqual(cursorSystemPromptEditorReducer(current, { type: "loaded", sessionId: 1, settings }), current);
  assert.deepEqual(cursorSystemPromptEditorReducer(current, {
    type: "load-failed", sessionId: 1, message: "first model unavailable",
  }), current);
});

test("closing_and_reopening_the_same_model_starts_a_new_editing_session", () => {
  const closed = cursorSystemPromptEditorReducer(loadedEditor(), { type: "close" });
  assert.equal(closed.target, null);
  assert.deepEqual(cursorSystemPromptEditorReducer(closed, { type: "loaded", sessionId: 1, settings }), closed);
  const reopened = cursorSystemPromptEditorReducer(closed, { type: "open", sessionId: 2, target: firstTarget });
  assert.deepEqual(cursorSystemPromptEditorReducer(reopened, { type: "loaded", sessionId: 1, settings }), reopened);
});

test("failed_save_preserves_loaded_settings_and_unsaved_draft_for_retry", () => {
  const draft = { enabled: false, content: "  未保存🙂\n原样保留  ", position: "before" };
  const edited = cursorSystemPromptEditorReducer(loadedEditor(), { type: "change", settings: draft });
  const saving = cursorSystemPromptEditorReducer(edited, { type: "save-started", sessionId: 1 });
  assert.equal(saving.saving, true);
  const failed = cursorSystemPromptEditorReducer(saving, {
    type: "save-failed", sessionId: 1, message: "database write failed",
  });
  assert.deepEqual(failed.target, firstTarget);
  assert.deepEqual(failed.loaded, settings);
  assert.deepEqual(failed.draft, draft);
  assert.equal(failed.saving, false);
  assert.deepEqual(failed.error, { operation: "save", message: "database write failed" });
  const retrying = cursorSystemPromptEditorReducer(failed, { type: "save-started", sessionId: 1 });
  assert.equal(retrying.error, null);
  assert.deepEqual(retrying.draft, draft);
  const saved = cursorSystemPromptEditorReducer(retrying, { type: "saved", sessionId: 1, settings: draft });
  assert.equal(saved.target, null);
  assert.deepEqual(saved.loaded, draft);
  assert.deepEqual(saved.draft, draft);
});

test("late_save_success_and_failure_cannot_close_or_change_another_model", () => {
  const saving = cursorSystemPromptEditorReducer(loadedEditor(), { type: "save-started", sessionId: 1 });
  const current = cursorSystemPromptEditorReducer(saving, { type: "open", sessionId: 2, target: secondTarget });
  assert.deepEqual(cursorSystemPromptEditorReducer(current, { type: "saved", sessionId: 1, settings }), current);
  assert.deepEqual(cursorSystemPromptEditorReducer(current, {
    type: "save-failed", sessionId: 1, message: "old save failed",
  }), current);
});

test("failed_load_never_becomes_saved_settings_and_retry_starts_a_fresh_request", () => {
  const opened = cursorSystemPromptEditorReducer(INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR, {
    type: "open", sessionId: 1, target: firstTarget,
  });
  const failed = cursorSystemPromptEditorReducer(opened, {
    type: "load-failed", sessionId: 1, message: "management service unavailable",
  });
  assert.equal(failed.loading, false);
  assert.equal(failed.loaded, null);
  assert.deepEqual(failed.error, { operation: "load", message: "management service unavailable" });
  assert.deepEqual(cursorSystemPromptEditorReducer(failed, { type: "save-started", sessionId: 1 }), failed);
  const retrying = cursorSystemPromptEditorReducer(failed, { type: "open", sessionId: 2, target: firstTarget });
  assert.equal(retrying.loading, true);
  assert.equal(retrying.error, null);
  const recovered = cursorSystemPromptEditorReducer(retrying, { type: "loaded", sessionId: 2, settings });
  assert.deepEqual(recovered.loaded, settings);
  assert.deepEqual(recovered.draft, settings);
});
