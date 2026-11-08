//! 验证分组身份、批量展开与单组操作共享状态，并正确处理视图与列表生命周期。
import assert from "node:assert/strict";
import test from "node:test";
import { createCursorGroupingState, cursorGroupingReducer, cursorGroupIsOpen, cursorAllGroupsExpanded, cursorGroupId, cursorModelGroups, cursorPluginGroups } from "./cursorModelGrouping.ts";

const ids = [cursorGroupId("provider", "builtin", "same"), cursorGroupId("provider", "plugin", "same")];
const view = (grouping) => cursorGroupingReducer(createCursorGroupingState(), { type: "change-view", grouping });
const all = (state, groupIds = ids) => cursorGroupingReducer(state, { type: "toggle-all", grouping: state.grouping, ids: groupIds });
const one = (state, id = ids[0]) => cursorGroupingReducer(state, { type: "toggle-one", grouping: state.grouping, id });

test("bulk_toggle_expands_and_collapses_every_builtin_and_plugin_group", () => {
  for (const grouping of ["provider", "type"]) {
    const groupIds = [cursorGroupId(grouping, "builtin", "same"), cursorGroupId(grouping, "plugin", "same")];
    let state = view(grouping);
    assert.deepEqual(groupIds.map((id) => cursorGroupIsOpen(state, id)), [false, false]);
    state = all(state, groupIds);
    assert.deepEqual(groupIds.map((id) => cursorGroupIsOpen(state, id)), [true, true]);
    assert.equal(cursorAllGroupsExpanded(state, groupIds), true);
    state = all(state, groupIds);
    assert.deepEqual(groupIds.map((id) => cursorGroupIsOpen(state, id)), [false, false]);
  }
});

test("mixed_groups_expand_all_and_manual_last_group_updates_the_bulk_action", () => {
  let state = one(view("provider"));
  assert.equal(cursorAllGroupsExpanded(state, ids), false);
  state = all(state);
  state = one(state);
  assert.deepEqual(ids.map((id) => cursorGroupIsOpen(state, id)), [false, true]);
  state = one(state);
  assert.equal(cursorAllGroupsExpanded(state, ids), true);
});

test("queued_bulk_clicks_use_the_latest_group_state", () => {
  const action = { type: "toggle-all", grouping: "provider", ids };
  let state = view("provider");
  state = cursorGroupingReducer(state, action);
  state = cursorGroupingReducer(state, action);
  assert.deepEqual(ids.map((id) => cursorGroupIsOpen(state, id)), [false, false]);
  state = one(state);
  state = cursorGroupingReducer(state, action);
  assert.deepEqual(ids.map((id) => cursorGroupIsOpen(state, id)), [true, true]);
});

test("flat_plugin_manual_choices_survive_disabled_bulk_operations", () => {
  const id = cursorGroupId("flat", "plugin", "same");
  let state = createCursorGroupingState();
  assert.equal(cursorGroupIsOpen(state, id), true);
  state = one(state, id);
  state = all(state, [id]);
  assert.equal(cursorGroupIsOpen(state, id), false);
  assert.equal(cursorAllGroupsExpanded(state, [id]), false);
});

test("empty_groups_never_report_all_expanded_or_change_existing_choices", () => {
  const state = one(view("provider"));
  assert.equal(cursorAllGroupsExpanded(state, []), false);
  assert.deepEqual([...all(state, []).openById], [...state.openById]);
});

test("same_view_keeps_choices_and_new_view_restores_its_defaults", () => {
  let state = all(view("provider"));
  state = cursorGroupingReducer(state, { type: "change-view", grouping: "provider" });
  assert.equal(cursorAllGroupsExpanded(state, ids), true);
  state = cursorGroupingReducer(state, { type: "change-view", grouping: "type" });
  assert.equal(state.grouping, "type");
  assert.deepEqual([...state.openById], []);
  const previous = state;
  state = cursorGroupingReducer(state, { type: "toggle-all", grouping: "provider", ids });
  assert.deepEqual(state, previous, "旧视图的延迟事件不得改变新视图");
});

test("removed_groups_are_reclaimed_and_reappearing_groups_start_closed", () => {
  let state = all(view("provider"));
  const added = cursorGroupId("provider", "builtin", "new");
  assert.equal(cursorGroupIsOpen(state, added), false);
  assert.equal(cursorAllGroupsExpanded(state, [...ids, added]), false);
  state = cursorGroupingReducer(state, { type: "retain-groups", grouping: "provider", ids: [ids[1], added] });
  assert.equal(state.openById.has(ids[0]), false);
  assert.equal(cursorGroupIsOpen(state, ids[1]), true);
  assert.equal(cursorGroupIsOpen(state, ids[0]), false, "删除后重新出现的分组应按新组初始化");
  state = cursorGroupingReducer(state, { type: "retain-groups", grouping: "provider", ids: [] });
  assert.equal(state.openById.size, 0);
});

test("view_and_group_kind_isolate_identical_group_names", () => {
  assert.notEqual(ids[0], ids[1]);
  assert.notEqual(ids[0], cursorGroupId("type", "builtin", "same"));
  const state = one(view("provider"));
  assert.deepEqual(ids.map((id) => cursorGroupIsOpen(state, id)), [true, false]);
});

test("supplier_identity_and_order_ignore_labels_paths_ports_and_credentials", () => {
  const models = [
    { model_hash: "a", base_url: "https://same.example:444/v1", group_name: "First" },
    { model_hash: "b", base_url: "http://other.example/v2", group_name: "First" },
    { model_hash: "c", base_url: "https://same.example/other", group_name: "Renamed", api_key: "fixture" },
  ];
  const groups = cursorModelGroups(models, "provider");
  assert.deepEqual(groups.map((group) => [group.key, group.label, group.models.map((model) => model.model_hash)]), [
    ["same.example", "First", ["a", "c"]], ["other.example", "First", ["b"]],
  ]);
  const changed = cursorModelGroups([{ ...models[0], group_name: "Another" }], "provider");
  assert.equal(changed[0].id, groups[0].id);
});

test("type_and_plugin_groups_keep_their_existing_model_boundaries", () => {
  const models = [
    { type: "anthropic", model_hash: "a" },
    { type: "openai", openai_endpoint: "/v1/chat/completions", model_hash: "b" },
    { type: "openai", openai_endpoint: "/v1/responses", model_hash: "c" },
  ];
  assert.deepEqual(cursorModelGroups(models, "type").map((group) => group.key), ["anthropic", "openai-chat", "openai-responses"]);
  const plugins = [{ pluginId: "same", pluginName: "Plugin", providerId: "a", icon: "", id: "a" }, { pluginId: "same", pluginName: "Plugin", providerId: "b", icon: "", id: "b" }];
  const groups = cursorPluginGroups(plugins, "type");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].models.map((model) => model.id), ["a", "b"]);
});
