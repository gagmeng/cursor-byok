//! 计算 Cursor 模型分组及共享的展开状态。
import type { Model, PluginModelDescriptor } from "../../shared/api";

export type CursorModelGrouping = "flat" | "provider" | "type";
export type CursorModelGroup = { id: string; key: string; label: string; models: Model[] };
export type CursorPluginGroup = { id: string; pluginId: string; pluginName: string; icon: string; models: PluginModelDescriptor[] };
export type CursorGroupingState = { grouping: CursorModelGrouping; openById: ReadonlyMap<string, boolean> };
export type CursorGroupingAction =
  | { type: "change-view"; grouping: CursorModelGrouping }
  | { type: "toggle-one"; grouping: CursorModelGrouping; id: string }
  | { type: "toggle-all" | "retain-groups"; grouping: CursorModelGrouping; ids: readonly string[] };

export function cursorGroupId(grouping: CursorModelGrouping, kind: "builtin" | "plugin", key: string): string {
  return `${grouping}:${kind}:${key}`;
}

export function cursorModelGroups(models: Model[], grouping: Exclude<CursorModelGrouping, "flat">): CursorModelGroup[] {
  const groups = new Map<string, CursorModelGroup>();
  for (const model of models) {
    const descriptor = grouping === "provider" ? providerGroup(model) : typeGroup(model);
    const group = groups.get(descriptor.key);
    if (group) group.models.push(model);
    else groups.set(descriptor.key, { ...descriptor, id: cursorGroupId(grouping, "builtin", descriptor.key), models: [model] });
  }
  return [...groups.values()];
}

export function cursorPluginGroups(models: PluginModelDescriptor[], grouping: CursorModelGrouping): CursorPluginGroup[] {
  const groups = new Map<string, CursorPluginGroup>();
  for (const model of models) {
    const group = groups.get(model.pluginId);
    if (group) group.models.push(model);
    else groups.set(model.pluginId, {
      id: cursorGroupId(grouping, "plugin", model.pluginId), pluginId: model.pluginId,
      pluginName: model.pluginName, icon: model.icon, models: [model],
    });
  }
  return [...groups.values()];
}

export function createCursorGroupingState(): CursorGroupingState {
  return { grouping: "flat", openById: new Map() };
}

export function cursorGroupIsOpen(state: CursorGroupingState, id: string): boolean {
  return state.openById.get(id) ?? state.grouping === "flat";
}

export function cursorAllGroupsExpanded(state: CursorGroupingState, ids: readonly string[]): boolean {
  return state.grouping !== "flat" && ids.length > 0 && ids.every((id) => cursorGroupIsOpen(state, id));
}

export function cursorGroupingReducer(state: CursorGroupingState, action: CursorGroupingAction): CursorGroupingState {
  if (action.type === "change-view") {
    return action.grouping === state.grouping ? state : { grouping: action.grouping, openById: new Map() };
  }
  // 视图切换后的旧事件不能重新打开已退出视图的分组。
  if (action.grouping !== state.grouping) return state;
  switch (action.type) {
    case "toggle-one": {
      if (!action.id.startsWith(`${state.grouping}:`)) return state;
      const openById = new Map(state.openById);
      openById.set(action.id, !cursorGroupIsOpen(state, action.id));
      return { ...state, openById };
    }
    case "toggle-all": {
      if (state.grouping === "flat" || action.ids.length === 0) return state;
      const open = !cursorAllGroupsExpanded(state, action.ids);
      return { ...state, openById: new Map(action.ids.map((id) => [id, open])) };
    }
    case "retain-groups": {
      const live = new Set(action.ids);
      const openById = new Map([...state.openById].filter(([id]) => live.has(id)));
      return openById.size === state.openById.size ? state : { ...state, openById };
    }
  }
}

function providerGroup(model: Model) {
  const key = providerDomain(model.base_url);
  return { key, label: model.group_name?.trim() || key };
}

function providerDomain(baseUrl: string) {
  const value = baseUrl.trim();
  try {
    return new URL(value).hostname.toLowerCase() || value;
  } catch {
    try {
      return new URL(`https://${value}`).hostname.toLowerCase() || value;
    } catch {
      return value;
    }
  }
}

function typeGroup(model: Model) {
  if (model.type === "anthropic") return { key: "anthropic", label: "Anthropic" };
  if (model.openai_endpoint === "/v1/chat/completions") return { key: "openai-chat", label: "OpenAI Chat" };
  return { key: "openai-responses", label: "OpenAI Responses" };
}
