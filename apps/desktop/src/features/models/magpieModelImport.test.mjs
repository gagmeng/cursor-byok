//! 验证「从 magpie 导入模型」弹窗：内容能滚动到最后一个供应商，网关地址可编辑且查询由用户触发。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const testUrl = process.env.CURSOR_CARD_TEST_URL;
const demoTestOptions = {
  skip: !testUrl && "需要运行隔离的产品演示并设置 CURSOR_CARD_TEST_URL",
};

/** 网关返回的目录必须远超一屏，才能证明滚动条是唯一的到达方式。 */
const GATEWAY_MODELS = [
  ...Array.from({ length: 13 }, (_, providerIndex) => Array.from({ length: 6 }, (_, modelIndex) => ({
    model_id: `provider-${providerIndex}/model-${modelIndex}`,
    display_name: `Model ${providerIndex}.${modelIndex}`,
    provider: `provider-${providerIndex}`,
    routing_group: false,
    endpoint: "openai-chat",
    context_window_tokens: 128_000,
    max_completion_tokens: 16_000,
    reasoning_levels: [],
    existing: false,
  }))).flat(),
  // magpie 的路由组：一条 id 在多个供应商/账号之间负载均衡，不是供应商模型。
  {
    model_id: "auto/model-0",
    display_name: "Auto model 0",
    provider: "auto",
    routing_group: true,
    endpoint: "openai-chat",
    context_window_tokens: 128_000,
    max_completion_tokens: 16_000,
    reasoning_levels: [],
    existing: false,
  },
];

async function launchBrowser() {
  const target = new URL(testUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "布局测试只能访问本机演示");
  assert.equal(target.pathname, "/product-demo/demo/index.html", "不得对真实后端运行演示布局测试");
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE_DIR || "playwright");
  return chromium.launch({
    headless: true,
    ...(process.env.CURSOR_TEST_BROWSER && { executablePath: process.env.CURSOR_TEST_BROWSER }),
  });
}

/** 记录弹窗向网关发起的每一次探测；返回的 getter 让测试断言用户触发了几次。 */
async function openImportDialog(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const page = await context.newPage();
  await page.addInitScript((models) => {
    window.__magpieProbes = [];
    let currentFetch = window.fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => currentFetch,
      set: (demoFetch) => {
        currentFetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          const path = url.pathname;
          if (path === "/__byok-api__/api/harness/cursor/status") {
            return Promise.resolve(demoFetch(input, init)).then(async (response) => Response.json({ ...(await response.json()), ca: "ready", settings_applied: true }));
          }
          if (path === "/__byok-api__/api/plugins") return Promise.resolve(Response.json([]));
          if (path === "/__byok-api__/api/plugins/runtime") return Promise.resolve(Response.json({
            state: "uninitialized", version: "test", target: null, phase: null,
            downloaded_bytes: 0, total_bytes: null, error: null,
          }));
          if (path === "/__byok-api__/api/settings/pricing") return Promise.resolve(Response.json({
            input_per_million: 0, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0,
          }));
          if (path === "/__byok-api__/api/magpie") {
            window.__magpieProbes.push(url.searchParams.get("address"));
            return Promise.resolve(Response.json({ address: url.searchParams.get("address") || "127.0.0.1:3425", version: "0.1.3359", models }));
          }
          if (path === "/__byok-api__/api/magpie/import") return Promise.resolve(Response.json({ imported: 0, skipped: 0, total: 0 }));
          return demoFetch(input, init);
        };
      },
    });
  }, GATEWAY_MODELS);
  const url = new URL(testUrl);
  url.searchParams.set("locale", "zh-CN");
  url.searchParams.set("theme", "default-light");
  url.hash = "/harness/cursor";
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "添加模型" }).click();
  await page.locator('[class*="chips"] button').filter({ hasText: "Magpie" }).click();
  const dialog = page.getByRole("alertdialog", { name: "从 magpie 导入模型" });
  await dialog.waitFor({ state: "visible" });
  return { context, page, dialog };
}

test("import_dialog_scrolls_through_every_provider_group", demoTestOptions, async () => {
  const browser = await launchBrowser();
  try {
    const { context, page, dialog } = await openImportDialog(browser, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "查询" }).click();
    const last = dialog.locator("section").last();
    await last.waitFor({ state: "visible" });

    // 内容远高于弹窗，滚轮必须真的移动滚动位置，而不是原地不动地漏给页面。
    const viewport = dialog.locator('[class*="viewport"]').first();
    const before = await viewport.evaluate((node) => ({ top: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
    assert.ok(before.scrollHeight > before.clientHeight + 1,
      `弹窗内容必须可滚动（可视 ${before.clientHeight}px / 内容 ${before.scrollHeight}px）`);
    await last.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    const box = await dialog.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    const afterWheel = await viewport.evaluate((node) => node.scrollTop);
    assert.ok(afterWheel > before.top, `滚轮必须滚动弹窗内容（${before.top} → ${afterWheel}）`);

    // 最后一个供应商分组与页脚提示都必须能滚进弹窗可视区，否则用户永远看不到。
    const reachable = await dialog.evaluate((node) => {
      const sections = [...node.querySelectorAll("section")];
      const lastSection = sections.at(-1).getBoundingClientRect();
      const dialogBox = node.getBoundingClientRect();
      const footer = node.querySelector("footer").getBoundingClientRect();
      return { lastBottom: Math.round(lastSection.bottom), dialogBottom: Math.round(dialogBox.bottom), footerTop: Math.round(footer.top) };
    });
    assert.ok(reachable.lastBottom <= reachable.footerTop + 1,
      `最后一个供应商分组必须能滚到页脚之上（分组底部 ${reachable.lastBottom}px，页脚顶部 ${reachable.footerTop}px）`);
    await context.close();
  } finally {
    await browser.close();
  }
});

test("gateway_address_is_editable_and_query_is_explicit", demoTestOptions, async () => {
  const browser = await launchBrowser();
  try {
    const { context, page, dialog } = await openImportDialog(browser, { width: 1280, height: 800 });

    // 打开弹窗不探测：网关地址是用户输入，不是打开即跑的网络请求。
    const address = dialog.getByRole("textbox", { name: "网关地址" });
    await address.waitFor({ state: "visible" });
    assert.equal(await address.inputValue(), "127.0.0.1:3425", "网关地址必须预填当前默认值");
    assert.deepEqual(await page.evaluate(() => window.__magpieProbes), [],
      "打开弹窗时不得自动探测网关");

    // 用户主动查询才发请求，且请求带着改过的地址。
    await address.fill("127.0.0.1:5001");
    await page.getByRole("button", { name: "查询" }).click();
    await dialog.locator("section").first().waitFor({ state: "visible" });
    assert.deepEqual(await page.evaluate(() => window.__magpieProbes), ["127.0.0.1:5001"],
      "查询必须只探测用户填写的地址一次");
    assert.match(await dialog.locator("code").first().innerText(), /127\.0\.0\.1:5001/,
      "查询结果必须展示实际查询到的网关地址");
    assert.equal(await dialog.locator("section").count(), 14, "目录里的每个供应商和路由组都要分组显示");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("routing_groups_stay_apart_and_are_not_selected_by_default", demoTestOptions, async () => {
  const browser = await launchBrowser();
  try {
    const { context, page, dialog } = await openImportDialog(browser, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "查询" }).click();
    const last = dialog.locator("section").last();
    await last.waitFor({ state: "visible" });

    // magpie 原样把 auto/<model> 标成路由组的 owned_by，若按供应商分组，
    // 它会混进供应商组里，看起来像同一个模型被导入了两次。
    const routing = dialog.locator("section").filter({ hasText: "路由组" });
    assert.equal(await routing.count(), 1, "所有路由组必须单独成组，而不是混进供应商分组");
    assert.match(await routing.innerText(), /auto\/model-0/, "路由组分组必须列出 auto/ 模型");
    // 路由组背后是别的模型的负载均衡，重复导入只会多一条指向同一上游的配置。
    const routingBox = routing.getByRole("checkbox").first();
    assert.equal(await routingBox.isChecked(), false, "路由组默认不勾选");
    const confirm = dialog.getByRole("button", { name: /导入选中的/ });
    assert.match(await confirm.innerText(), /78/, "默认勾选数不得包含路由组（13×6=78）");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("model_rows_sit_indented_under_their_group_header", demoTestOptions, async () => {
  const browser = await launchBrowser();
  try {
    const { context, page, dialog } = await openImportDialog(browser, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "查询" }).click();
    const first = dialog.locator("section").first();
    await first.waitFor({ state: "visible" });

    // 分组名与模型若左对齐，层级只能靠字号区分；模型勾选框必须落在分组勾选框右侧，
    // 让「这一行属于上面的分组」在版面上直接成立。
    const layout = await first.evaluate((section) => {
      const controlLeft = (label) => Math.round(label.querySelector("span").getBoundingClientRect().left);
      const group = section.querySelector("header label");
      const row = section.querySelector('[class*="models"] > [class*="model"] label');
      return { groupLeft: controlLeft(group), rowLeft: controlLeft(row) };
    });
    assert.ok(layout.rowLeft - layout.groupLeft >= 20,
      `模型勾选框必须相对分组勾选框缩进（分组 ${layout.groupLeft}px，模型 ${layout.rowLeft}px）`);
    // 缩进不得把右侧的模型 id / 协议信息挤出分组。
    const overflow = await first.evaluate((section) => {
      const bounds = section.getBoundingClientRect();
      return [...section.querySelectorAll('[class*="models"] > [class*="model"]')].some((row) => row.getBoundingClientRect().right > bounds.right + 1);
    });
    assert.equal(overflow, false, "缩进后的模型行不得溢出分组边框");
    await context.close();
  } finally {
    await browser.close();
  }
});

test("provider_groups_fold_and_unfold", demoTestOptions, async () => {
  const browser = await launchBrowser();
  try {
    const { context, page, dialog } = await openImportDialog(browser, { width: 1280, height: 800 });
    await page.getByRole("button", { name: "查询" }).click();
    const first = dialog.locator("section").first();
    await first.waitFor({ state: "visible" });

    const models = first.locator('[class*="models"]');
    assert.equal(await models.isVisible(), true, "分组默认展开，用户能直接勾选模型");
    const toggle = first.locator('[class*="groupToggle"]').first();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true", "默认展开的分组必须如实声明展开状态");
    await toggle.click();
    await models.waitFor({ state: "hidden" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false", "点击分组头必须折叠该分组");
    // 折叠只影响视图，勾选状态不能丢。
    assert.equal(await first.getByRole("checkbox").first().isChecked(), true, "折叠不得清除分组勾选");
    await toggle.click();
    await models.waitFor({ state: "visible" });
    await context.close();
  } finally {
    await browser.close();
  }
});
