//! 验证系统提示词管理接口和演示环境的按模型保存行为。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { installDemoApi } from "../../demo/api.ts";

const collectionUrl = "/__byok-api__/api/model-system-prompts";
const defaultSettings = { enabled: false, content: "", position: "after" };
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let api;

before(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {},
      location: new URL("http://127.0.0.1:54321/__byok-api__/"),
      fetch: globalThis.fetch,
    },
  });
  api = (await import("../../shared/api.ts")).api;
});

after(() => {
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

test("built_in_and_plugin_model_ids_load_settings_over_the_management_http_boundary", async (context) => {
  const requested = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    return Response.json(defaultSettings);
  });
  for (const modelId of ["builtin-hash", "plugin/provider/模型 ?#🙂"]) {
    assert.deepEqual(await api.modelSystemPrompt(modelId), defaultSettings);
  }
  assert.deepEqual(requested, [
    `${collectionUrl}?model_id=builtin-hash`,
    `${collectionUrl}?model_id=${encodeURIComponent("plugin/provider/模型 ?#🙂")}`,
  ]);
});

test("saving_sends_the_model_id_and_complete_disabled_content_to_the_collection_url", async (context) => {
  const modelId = "plugin/provider/model";
  const settings = {
    enabled: false, content: "  中文🙂\n第二行\r\n\t ", position: "before",
  };
  context.mock.method(globalThis, "fetch", async (input, init) => {
    assert.equal(String(input), collectionUrl);
    assert.equal(init?.method, "PUT");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), { model_id: modelId, ...settings });
    return Response.json(settings);
  });
  assert.deepEqual(await api.setModelSystemPrompt(modelId, settings), settings);
});

test("failed_http_saves_report_the_management_service_error", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "model system prompt write failed" }, { status: 500 }));
  await assert.rejects(api.setModelSystemPrompt("builtin-hash", defaultSettings), /model system prompt write failed/);
});

test("demo_defaults_and_saved_prompts_remain_independent_for_each_model", async (context) => {
  context.mock.method(window, "fetch", async () => { throw new Error("demo management requests must not reach the network"); });
  installDemoApi();
  for (const modelId of ["demo-builtin", "demo/plugin/模型 ?#🙂"]) {
    const response = await window.fetch(`${collectionUrl}?model_id=${encodeURIComponent(modelId)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), defaultSettings);
  }
  const builtinSettings = { enabled: true, content: "内置提示词", position: "after" };
  const pluginSettings = { enabled: false, content: "  插件🙂\n原样保留  ", position: "before" };
  for (const [modelId, settings] of [["demo-builtin", builtinSettings], ["demo/plugin/模型 ?#🙂", pluginSettings]]) {
    const response = await window.fetch(collectionUrl, {
      method: "PUT", body: JSON.stringify({ model_id: modelId, ...settings }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), settings);
  }
  for (const [modelId, settings] of [["demo-builtin", builtinSettings], ["demo/plugin/模型 ?#🙂", pluginSettings]]) {
    const response = await window.fetch(`${collectionUrl}?model_id=${encodeURIComponent(modelId)}`);
    assert.deepEqual(await response.json(), settings);
  }
});
