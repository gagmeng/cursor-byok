//! Verifies that configuration downloads use authenticated same-origin HTTP and preserve server errors.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

const descriptors = Object.fromEntries(["window", "document", "t"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let api;
let downloads;
let blobs;
before(async () => {
  downloads = [];
  blobs = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://127.0.0.1:54321/__byok-api__/"),
    setTimeout: (callback) => callback(),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { appendChild() {} },
    createElement: () => ({ click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} }),
  } });
  Object.defineProperty(globalThis, "t", { configurable: true, value: value => value });
  api = (await import("./api.ts")).api;
});
after(() => {
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function captureFiles(context) {
  context.mock.method(URL, "createObjectURL", blob => { blobs.push(blob); return "blob:download"; });
  context.mock.method(URL, "revokeObjectURL", () => {});
}

test("plugin_exports_download_the_authenticated_response_on_the_current_management_origin", async context => {
  captureFiles(context);
  const requested = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    requested.push(String(input));
    assert.equal(init.credentials, "same-origin");
    if (String(input).endsWith("/session")) {
      assert.equal(new Headers(init.headers).get("x-cursor-byok-session"), "1");
      return new Response(null, { status: 204 });
    }
    return new Response('[{"credential":"kept"}]', { headers: {
      "content-type": "application/json", "content-disposition": 'attachment; filename="provider-accounts.json"',
    } });
  });
  await api.exportPluginResources("plugin ?#", "accounts/primary");
  assert.deepEqual(requested, ["/__byok-api__/api/session", "/__byok-api__/api/plugins/plugin%20%3F%23/resources/accounts%2Fprimary/export"]);
  assert.deepEqual(downloads, [{ href: "blob:download", filename: "provider-accounts.json" }]);
  assert.equal(await blobs.at(-1).text(), '[{"credential":"kept"}]');
});

test("migration_downloads_reestablish_expired_sessions_before_saving_the_file", async context => {
  captureFiles(context);
  const requested = [];
  context.mock.method(globalThis, "fetch", async input => {
    requested.push(String(input));
    if (requested.length === 1) return new Response("session expired", { status: 401, headers: { "x-cursor-byok-session": "required" } });
    if (String(input).endsWith("/session")) return new Response(null, { status: 204 });
    return new Response('{"version":3}', { headers: { "content-disposition": 'attachment; filename="cursor-byok-migration-20261110.json"' } });
  });
  await api.exportMigration();
  assert.deepEqual(requested, ["/__byok-api__/api/migration/export", "/__byok-api__/api/session", "/__byok-api__/api/migration/export"]);
  assert.equal(downloads.at(-1).filename, "cursor-byok-migration-20261110.json");
  assert.equal(await blobs.at(-1).text(), '{"version":3}');
});

test("failed_exports_surface_the_server_error_without_downloading_an_error_document", async context => {
  captureFiles(context);
  const count = downloads.length;
  context.mock.method(globalThis, "fetch", async () => Response.json({ message: "plugin credentials unavailable" }, { status: 500 }));
  await assert.rejects(api.exportPluginResources("provider", "accounts"), /plugin credentials unavailable/);
  assert.equal(downloads.length, count);
});
