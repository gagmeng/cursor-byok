//! Verifies partial refreshes and response ordering using the actual store.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

async function store(api) {
  const source = await fs.readFile(new URL("./appStore.ts", import.meta.url), "utf8");
  const stripped = source.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
  const js = stripTypeScriptTypes(stripped);
  return new Function("api", "localStorage", "window", "applyTheme", "isThemeId", `${js}; return appStore;`)(api, { getItem: () => null }, { matchMedia: () => ({ addEventListener() {} }) }, () => {}, () => false);
}
const base = () => ({models: async () => [], calls: async () => ({ calls: [], next: null }), overview: async () => ({}), observability: async () => ({ detailed: false }), ports: async () => ({}), pricingSettings: async () => ({}), cursorHarness: async () => ({}), pluginRuntime: async () => ({}), plugins: async () => []});
test("a_failed_cursor_status_does_not_hide_successful_model_data", async () => {
  const api = base();
  api.models = async () => [{model_hash: "usable"}];
  api.cursorHarness = async () => {throw new Error("status unavailable");};
  const app = await store(api);
  await app.refresh();
  assert.equal(app.getSnapshot().models[0]?.model_hash, "usable");
  assert.match(app.getSnapshot().error, /status unavailable/);
});
test("a_late_old_refresh_cannot_replace_a_newer_snapshot", async () => {
  const api = base();
  let resolveOld;
  let count = 0;
  api.models = () => ++count === 1 ? new Promise(resolve => {resolveOld = resolve;}) : Promise.resolve([{model_hash: "new"}]);
  const app = await store(api);
  const old = app.refresh();
  await app.refresh();
  resolveOld([{model_hash: "old"}]);
  await old;
  assert.equal(app.getSnapshot().models[0].model_hash, "new");
});
