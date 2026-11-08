//! 校验系统提示词并管理按模型隔离的编辑草稿。
import type { ModelSystemPromptSettings } from "../../shared/api";

export const MODEL_SYSTEM_PROMPT_MAX_BYTES = 32768;
export const DEFAULT_MODEL_SYSTEM_PROMPT_SETTINGS: ModelSystemPromptSettings = {
  enabled: false, content: "", position: "after",
};

export function modelSystemPromptStatus(settings: ModelSystemPromptSettings): {
  byteLength: number;
  error: "too-large" | "empty" | null;
} {
  const byteLength = new TextEncoder().encode(settings.content).byteLength;
  const error = byteLength > MODEL_SYSTEM_PROMPT_MAX_BYTES
    ? "too-large"
    : settings.enabled && !settings.content.trim() ? "empty" : null;
  return { byteLength, error };
}

export type CursorSystemPromptEditorState = {
  sessionId: number;
  target: { modelId: string; displayName: string } | null;
  loaded: ModelSystemPromptSettings | null;
  draft: ModelSystemPromptSettings;
  loading: boolean;
  saving: boolean;
  error: { operation: "load" | "save"; message: string } | null;
};

export const INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR: CursorSystemPromptEditorState = {
  sessionId: 0,
  target: null,
  loaded: null,
  draft: DEFAULT_MODEL_SYSTEM_PROMPT_SETTINGS,
  loading: false,
  saving: false,
  error: null,
};

export type CursorSystemPromptEditorAction =
  | { type: "open"; sessionId: number; target: NonNullable<CursorSystemPromptEditorState["target"]> }
  | { type: "close" }
  | { type: "change"; settings: ModelSystemPromptSettings }
  | { type: "loaded" | "saved"; sessionId: number; settings: ModelSystemPromptSettings }
  | { type: "load-failed" | "save-failed"; sessionId: number; message: string }
  | { type: "save-started"; sessionId: number };

export function cursorSystemPromptEditorReducer(
  state: CursorSystemPromptEditorState,
  action: CursorSystemPromptEditorAction,
): CursorSystemPromptEditorState {
  if (action.type === "open") {
    return {
      ...INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR,
      sessionId: action.sessionId,
      target: action.target,
      draft: { ...DEFAULT_MODEL_SYSTEM_PROMPT_SETTINGS },
      loading: true,
    };
  }
  if (action.type === "close") return { ...INITIAL_CURSOR_SYSTEM_PROMPT_EDITOR, sessionId: state.sessionId };
  if (!state.target) return state;
  if (action.type === "change") {
    if (!state.loaded || state.loading || state.saving) return state;
    return { ...state, draft: action.settings, error: null };
  }
  // 同一模型可被反复打开，必须用编辑会话标识隔离上一次打开时的迟到响应。
  if (action.sessionId !== state.sessionId) return state;
  switch (action.type) {
    case "loaded":
      if (!state.loading) return state;
      return { ...state, loaded: action.settings, draft: action.settings, loading: false, error: null };
    case "load-failed":
      if (!state.loading) return state;
      return { ...state, loading: false, error: { operation: "load", message: action.message } };
    case "save-started":
      if (!state.loaded || state.loading || state.saving || modelSystemPromptStatus(state.draft).error) return state;
      return { ...state, saving: true, error: null };
    case "saved":
      if (!state.saving) return state;
      return { ...state, target: null, loaded: action.settings, draft: action.settings, saving: false, error: null };
    case "save-failed":
      if (!state.saving) return state;
      return { ...state, saving: false, error: { operation: "save", message: action.message } };
  }
}
