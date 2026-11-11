//! Builds and serves an isolated demo before running browser behavior tests.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "../../target/review-ui-demo");
function run(args, env = process.env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? done() : reject(new Error(`Browser verification exited ${code ?? signal}`)));
  });
}
await run(["node_modules/vite/bin/vite.js", "build", "--config", "vite.demo.config.ts", "--outDir", output]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (!pathname.startsWith("/product-demo/")) { res.writeHead(404).end(); return; }
    const path = resolve(output, pathname.slice("/product-demo/".length));
    if (!path.startsWith(output + sep)) { res.writeHead(403).end(); return; }
    const bytes = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
  await run(["--test", "--test-concurrency=1", ...process.argv.slice(2), "src/features/models/cursorModelCardLayout.test.mjs", "src/features/models/magpieModelImport.test.mjs", "src/features/diagnostics/diagnosticsUi.test.mjs", "src/features/diagnostics/reliabilityUi.test.mjs", "src/shared/desktopAppearance.test.mjs"], {
    ...process.env,
    CURSOR_CARD_TEST_URL: `http://127.0.0.1:${server.address().port}/product-demo/demo/index.html`,
  });
} finally { await new Promise((done) => server.close(done)); }
