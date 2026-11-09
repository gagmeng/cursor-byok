//! 在隔离演示中验证 Cursor 模型页的布局、分组交互与异步测试边界。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const testUrl = process.env.CURSOR_CARD_TEST_URL;
const demoTestOptions = {
  skip: !testUrl && "需要运行隔离的产品演示并设置 CURSOR_CARD_TEST_URL",
};

async function desktopViewports() {
  // 从原生窗口定义读取逻辑尺寸，防止浏览器测试通过而实际默认窗口仍然不协调。
  const source = await readFile(new URL("../../../src-tauri/src/desktop.rs", import.meta.url), "utf8");
  const defaultSize = source.match(/\.inner_size\(([\d.]+),\s*([\d.]+)\)/);
  const minimumSize = source.match(/\.min_inner_size\(([\d.]+),\s*([\d.]+)\)/);
  assert.ok(defaultSize && minimumSize, "布局测试必须使用实际主窗口的默认尺寸和最小尺寸");
  return {
    default: { width: Number(defaultSize[1]), height: Number(defaultSize[2]) },
    minimum: { width: Number(minimumSize[1]), height: Number(minimumSize[2]) },
  };
}

async function launchLayoutBrowser() {
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

async function openDemoModelPage(browser, locale, viewport, modelCount, { plugins = [], grouped = false, groupCount = null, caReady = true, takenOver = true } = {}) {
  const context = await browser.newContext({ viewport, locale });
  const page = await context.newPage();
  // 演示未提供这些基础接口；只在测试页补充假响应，避免接触真实服务。
  await page.addInitScript(({ modelCount, plugins, grouped, groupCount, caReady, takenOver }) => {
    let currentFetch = window.fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => currentFetch,
      set: (demoFetch) => {
        currentFetch = (input, init) => {
          const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
          if (path === "/__byok-api__/api/models") {
            return Promise.resolve(demoFetch(input, init)).then(async (response) => {
              const all = await response.json();
              // 首次加载记住本页要展示的模型;删除后刷新不能从后面的模型里补位,
              // 否则刚被删空的分组会被下一个模型"复活",删除结果就不可观察。
              window.__demoModelKeys ??= all.slice(0, modelCount).map((model) => model.model_hash);
              const indexOf = (model) => window.__demoModelKeys.indexOf(model.model_hash);
              const models = window.__demoModelKeys
                .map((hash) => all.find((model) => model.model_hash === hash))
                .filter(Boolean);
              // groupCount 把模型摊到多个供应商,用于验证同组多卡片的行内排布。
              const providerOf = (index) => groupCount === null ? index : index % groupCount;
              return Response.json(grouped ? models.map((model) => {
                const index = indexOf(model);
                return {
                  ...model, base_url: `https://provider-${providerOf(index)}.example/v1`, group_name: `Provider ${providerOf(index)}`,
                  type: index === 0 ? "anthropic" : "openai",
                  openai_endpoint: index === 1 ? "/v1/chat/completions" : "/v1/responses",
                };
              }) : models);
            });
          }
          if (path === "/__byok-api__/api/plugins") return Promise.resolve(Response.json(plugins));
          if (path === "/__byok-api__/api/harness/cursor/status") {
            return Promise.resolve(demoFetch(input, init)).then(async (response) => {
              const status = await response.json();
              return Response.json({ ...status, ca: caReady ? status.ca : "missing", settings_applied: takenOver });
            });
          }
          if (path === "/__byok-api__/api/plugins/runtime") return Promise.resolve(Response.json({
            state: "uninitialized", version: "test", target: null, phase: null,
            downloaded_bytes: 0, total_bytes: null, error: null,
          }));
          if (path === "/__byok-api__/api/settings/pricing") return Promise.resolve(Response.json({
            input_per_million: 0, output_per_million: 0, cache_read_per_million: 0, cache_write_per_million: 0,
          }));
          return demoFetch(input, init);
        };
      },
    });
  }, { modelCount, plugins, grouped, groupCount, caReady, takenOver });
  const url = new URL(testUrl);
  url.searchParams.set("locale", locale);
  url.searchParams.set("theme", "default-light");
  url.hash = "/harness/cursor";
  await page.goto(url.href, { waitUntil: "networkidle" });
  const cards = page.locator("[data-model-key]");
  try {
    await (modelCount > 0 && caReady ? cards.first() : page.locator('[class*="title"]').filter({ hasText: /^Cursor$/ })).waitFor({ state: "visible" });
  } catch (error) {
    console.error(await page.locator("body").innerText());
    throw error;
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    // 演示安装完成后固定入口，后续请求包装器不能再次按位置改写分组身份。
    Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: window.fetch });
  });
  return { context, page, cards };
}

/** 卡片几何快照:卡片在网格中的位置、尺寸,以及测试状态条相对卡片的宽度。 */
async function cardBoxes(cards) {
  return cards.evaluateAll((elements) => elements.map((card) => {
    const box = card.getBoundingClientRect();
    const status = card.querySelector('[class*="modelCardTest"] > div');
    const actions = card.querySelector('[class*="modelCardActions"]');
    const statusBox = status?.getBoundingClientRect();
    const actionsBox = actions?.getBoundingClientRect();
    return {
      top: Math.round(box.top),
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      height: Math.round(box.height),
      statusWidth: statusBox ? Math.round(statusBox.width) : null,
      statusLeftInset: statusBox ? Math.round(statusBox.left - box.left) : null,
      statusRightInset: statusBox ? Math.round(box.right - statusBox.right) : null,
      actionsRight: actionsBox ? Math.round(actionsBox.right) : null,
    };
  }));
}

/** 两张卡片必须并排在同一行,不能因为卡片定宽而退化成单列。 */
function assertCardsSideBySide(left, right, locale, context) {
  assert.ok(Math.abs(left.top - right.top) <= 1,
    `${locale}：${context}必须并排显示（top ${left.top}/${right.top}）`);
  assert.ok(right.left >= left.right, `${locale}：${context}不得重叠`);
}

/** 测试状态必须横向占满卡片内宽,而不是缩成按文字宽度的小徽标。 */
function assertStatusSpansCard(box, locale, context) {
  assert.ok(box.statusWidth !== null, `${locale}：${context}——卡片必须显示测试状态`);
  assert.ok(Math.abs(box.statusLeftInset - box.statusRightInset) <= 1,
    `${locale}：${context}——状态条必须在卡片内水平居中（左右内边距 ${box.statusLeftInset}/${box.statusRightInset}）`);
  assert.ok(box.statusWidth >= box.width - 30,
    `${locale}：${context}——测试状态必须占满卡片宽度（卡片 ${box.width}px，状态 ${box.statusWidth}px）`);
}

/** 卡片网格在窗口拉伸时列数会变;这些宽度覆盖最小、默认与几个典型拉伸档位。 */
function resizableViewports({ default: defaultViewport, minimum }) {
  return [minimum, defaultViewport, { width: 1000, height: defaultViewport.height }, { width: 1280, height: defaultViewport.height }, { width: 1600, height: defaultViewport.height }];
}

async function saveScreenshot(page, name) {
  if (!process.env.CURSOR_CARD_SCREENSHOT_DIR) return;
  await page.mouse.move(0, 0);
  // 捕捉稳定卡片布局，避免临时错误提示或悬浮提示遮住被验证的内容。
  await page.locator('[role="status"][class*="message"]').waitFor({ state: "hidden" });
  await mkdir(process.env.CURSOR_CARD_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.CURSOR_CARD_SCREENSHOT_DIR, `${name}.png`) });
}

test("flat_and_grouped_views_share_one_card_grid", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, viewports.default, 3);
      const flat = await cardBoxes(cards);
      assert.equal(flat.length, 3, "平铺视图必须列出全部三个模型卡片");
      // 默认窗体内两张卡片并排:卡片网格而不是单列行列表。
      assertCardsSideBySide(flat[0], flat[1], locale, "平铺视图前两张卡片");
      assert.ok(Math.abs(flat[0].width - flat[1].width) <= 1, `${locale}：并排卡片宽度必须一致`);
      for (const [index, box] of flat.entries()) assertStatusSpansCard(box, locale, `平铺卡片 ${index}`);
      await saveScreenshot(page, `flat-cards-${locale}`);
      await context.close();

      // 三个模型同属一个供应商:分组容器内的卡片也必须并排,而不是退化成单列。
      const groupedPage = await openDemoModelPage(browser, locale, viewports.default, 3, { grouped: true, groupCount: 1 });
      await groupedPage.page.locator('[class*="groupActions"] button[aria-pressed]').nth(1).click();
      await groupedPage.page.getByRole("button", { name: locale === "en-US" ? "Expand all" : "一键展开", exact: true }).click();
      const grouped = await cardBoxes(groupedPage.page.locator('[data-model-key]'));
      assert.equal(grouped.length, 3, "分组视图必须列出全部三个模型卡片");
      for (const [index, box] of grouped.entries()) assertStatusSpansCard(box, locale, `分组卡片 ${index}`);
      assertCardsSideBySide(grouped[0], grouped[1], locale, "同组内前两张卡片");
      assert.ok(Math.abs(grouped[0].width - grouped[1].width) <= 1, `${locale}：分组内并排卡片宽度必须一致`);
      // 两种视图同构:同一张模型卡片在平铺与分组中高度一致,宽度只允许差出分组留白量。
      for (let index = 0; index < grouped.length; index += 1) {
        assert.ok(Math.abs(grouped[index].height - flat[index].height) <= 1,
          `${locale}：卡片 ${index} 在平铺与分组视图高度必须一致（平铺 ${flat[index].height} vs 分组 ${grouped[index].height}）`);
        assert.ok(flat[index].width - grouped[index].width <= 30,
          `${locale}：卡片 ${index} 在分组视图内只能收窄分组留白量（平铺 ${flat[index].width} vs 分组 ${grouped[index].width}）`);
      }
      await saveScreenshot(groupedPage.page, `grouped-cards-${locale}`);
      await groupedPage.context.close();
    }
  } finally {
    await browser.close();
  }
});

test("cards_keep_their_geometry_through_failed_and_successful_tests", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, viewports.default, 2);
      const card = cards.first();
      await holdConnectivityTests(page);
      const initial = await cardBoxes(cards);
      for (const outcome of [
        { state: "error", status: 401, body: { message: `provider error: OpenAI Responses 401 ${"authentication failed ".repeat(20)}` } },
        { state: "success", status: 200, body: { duration_ms: 1284, first_valid_response_ms: 418, output_tokens: 42, tokens_per_second: 38.6, tokens_estimated: false, output: "Mock connectivity test passed." } },
      ]) {
        await card.locator('[class*="modelCardActions"] button').first().click();
        await page.waitForFunction(() => typeof window.completeModelTest === "function");
        await card.locator('[class*="modelCardTest"] > [class*="testing"]').waitFor({ state: "visible" });
        await page.evaluate(({ body, status }) => {
          const complete = window.completeModelTest;
          delete window.completeModelTest;
          complete(Response.json(body, { status }));
        }, outcome);
        await card.locator(`[class*="modelCardTest"] > [class*="${outcome.state}"]`).waitFor({ state: "visible" });
        const settled = await cardBoxes(cards);
        for (const [index, box] of settled.entries()) {
          assertStatusSpansCard(box, locale, `${outcome.state} 卡片 ${index}`);
          // 状态文案变化不能改变卡片几何:测试中、失败、成功与未测试同尺寸。
          assert.ok(Math.abs(box.width - initial[index].width) <= 1 && Math.abs(box.height - initial[index].height) <= 1,
            `${locale}：${outcome.state} 结果不得改变卡片尺寸（初始 ${initial[index].width}x${initial[index].height}，结果后 ${box.width}x${box.height}）`);
          assert.ok(Math.abs(box.top - initial[index].top) <= 1, `${locale}：${outcome.state} 结果不得把卡片挤到下一行`);
        }
        await saveScreenshot(page, `card-${outcome.state}-${locale}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("card_actions_keep_every_label_visible", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      for (const viewport of resizableViewports(viewports)) {
        const { context, page, cards } = await openDemoModelPage(browser, locale, viewport, 1);
        const labels = await cards.first().locator('[class*="modelCardActions"] button > span').evaluateAll((elements) => elements.map((element) => ({
          text: element.textContent,
          available: element.clientWidth,
          needed: element.scrollWidth,
        })));
        assert.equal(labels.length, 5, "每个模型卡片必须保留全部五个操作");
        if (locale === "zh-CN") {
          assert.deepEqual(labels.map(({ text }) => text), ["测试", "编辑", "系统提示词", "复制", "删除"]);
          // 窗口拉伸会让列宽在 240px 与等分之间变化,五个操作必须在同一行。
          const tops = await cards.first().locator('[class*="modelCardActions"] button').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
          assert.equal(new Set(tops).size, 1, `${locale}：五个操作必须保持同一行（视口 ${viewport.width}px，tops=${JSON.stringify(tops)}）`);
          // 测试中按钮文案会切换；切换后的行宽同样不能在最小窗口里溢出到第二行。
          await holdConnectivityTests(page);
          await cards.first().locator('[class*="modelCardActions"] button').first().click();
          await cards.first().locator('[class*="testing"]').waitFor({ state: "visible" });
          const testingTops = await cards.first().locator('[class*="modelCardActions"] button').evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
          const testingLabels = await cards.first().locator('[class*="modelCardActions"] button > span').allTextContents();
          assert.equal(testingLabels[0], "停止", "测试进行中第一个操作必须变成停止");
          assert.equal(new Set(testingTops).size, 1, `${locale}：测试中五个操作也必须保持同一行（视口 ${viewport.width}px，tops=${JSON.stringify(testingTops)}）`);
          await page.evaluate(() => {
            const complete = window.completeModelTest;
            delete window.completeModelTest;
            complete(Response.json({ duration_ms: 1, first_valid_response_ms: 1, output_tokens: 1, tokens_per_second: 1, tokens_estimated: false, output: "ok" }));
          });
        }
        // 翻译较长时可以换行，但不能截断文案。
        assert.deepEqual(labels.filter(({ needed, available }) => needed > available + 1), [],
          `${locale}：卡片内按钮文字不能被省略号截断（视口 ${viewport.width}px）`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
});

async function holdConnectivityTests(page) {
  // 假请求保留异步与取消行为，但不访问真实供应商。
  await page.evaluate(() => {
    const original = window.fetch;
    window.modelTestCancellations = 0;
    window.modelTestCompletions = [];
    window.fetch = (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      if (/^\/__byok-api__\/api\/models\/[^/]+\/test\/[^/]+$/.test(path)) {
        if (init?.method === "POST") {
          return new Promise((resolve, reject) => {
            window.completeModelTest = resolve;
            window.modelTestCompletions.push(resolve);
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        if (init?.method === "DELETE") window.modelTestCancellations += 1;
      }
      return original(input, init);
    };
  });
}

const groupingLabels = {
  "zh-CN": { expand: "一键展开", collapse: "一键折叠", prompt: "系统提示词", before: "前置", after: "后置" },
  "en-US": { expand: "Expand all", collapse: "Collapse all", prompt: "System prompt", before: "Before", after: "After" },
  "pt-BR": { expand: "Expandir tudo", collapse: "Recolher tudo", prompt: "Prompt do sistema", before: "Antes", after: "Depois" },
};

function pluginFixtures() {
  return [0, 1].map((index) => ({
    id: `fixture-plugin-${index}`, name: `Plugin ${index}`, version: "test", author: null,
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", resources: [],
    providers: [{
      id: `provider-${index}`, pluginId: `fixture-plugin-${index}`, displayName: `Provider ${index}`,
      description: null, providerType: "openai", resourceType: null, hasModels: true, configured: true,
      models: [{
        id: `fixture-plugin-model-${index}`, pluginId: `fixture-plugin-${index}`, pluginName: `Plugin ${index}`,
        providerId: `provider-${index}`, modelId: `plugin-model-${index}`, displayName: `Plugin model ${index}`,
        description: null, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
        providerType: "openai", maxOutputTokens: null, images: false, enabled: true,
      }],
    }],
  }));
}

async function assertToolbarFits(page, width, locale) {
  const title = await page.locator('[class*="title"]').filter({ hasText: /^Cursor$/ }).boundingBox();
  const actions = await page.locator('[class*="takeoverActions"]').boundingBox();
  assert.ok(title.x + title.width <= actions.x, `${locale}：分组操作不得遮挡标题`);
  const buttons = await page.locator('[class*="actionRegion"] button').evaluateAll((elements) => elements.map((element) => {
    const bounds = element.getBoundingClientRect();
    const group = element.closest('[class*="groupActions"]')?.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, clipped: group && (bounds.left < group.left - 1 || bounds.right > group.right + 1) };
  }));
  assert.ok(buttons.length >= 6, "工具栏验证必须包括分组命令、刷新和添加按钮");
  assert.ok(buttons.every((button) => button.left >= 0 && button.right <= width && !button.clipped), `${locale}：整个工具栏必须可见，不能越界或被静默裁切`);
}

async function assertGroupStates(groups, expected, message) {
  assert.deepEqual(await groups.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-expanded"))), expected.map(String), message);
}

/** 平铺视图下插件模型与内置模型同为卡片,同处一个网格。 */
async function assertFlatPluginCards(page, count, message) {
  assert.equal(await page.locator('[class*="groupToggle"]').count(), 0, `${message}：平铺视图不渲染分组容器`);
  for (let index = 0; index < count; index += 1) {
    await page.getByText(`Plugin model ${index}`, { exact: true }).waitFor({ state: "visible" });
  }
}

test("group_header_shows_icon_commands_and_deletes_the_whole_group", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const [locale, labels] of Object.entries(groupingLabels)) {
      const { context, page } = await openDemoModelPage(browser, locale, viewports.default, 3, { grouped: true });
      await page.locator('[class*="groupActions"] button[aria-pressed]').nth(1).click();
      await page.getByRole("button", { name: labels.expand, exact: true }).click();
      const header = page.locator('[class*="groupHeader"]').first();
      const settingsLabel = locale === "en-US" ? "Group settings" : locale === "pt-BR" ? "Configurações do grupo" : "分组设置";
      const deleteLabel = locale === "en-US" ? "Delete group" : locale === "pt-BR" ? "Excluir grupo" : "分组删除";
      const dialogLabel = locale === "en-US" ? "Delete group" : locale === "pt-BR" ? "Excluir grupo" : "删除分组";
      // 分组头只保留图标:操作文案靠悬停提示表达,不再占宽度。
      const settings = header.getByRole("button", { name: settingsLabel });
      const remove = header.getByRole("button", { name: deleteLabel });
      assert.equal(await settings.count(), 1, `${locale}：分组头必须有设置图标命令`);
      assert.equal(await remove.count(), 1, `${locale}：分组头必须有删除图标命令`);
      assert.deepEqual(await settings.allTextContents(), [""], `${locale}：设置命令不得渲染文字`);
      assert.deepEqual(await remove.allTextContents(), [""], `${locale}：删除命令不得渲染文字`);
      await settings.hover();
      await page.getByRole("tooltip").filter({ hasText: settingsLabel }).waitFor({ state: "visible" });
      await page.mouse.move(0, 0);
      await page.getByRole("tooltip").waitFor({ state: "hidden" });
      await remove.hover();
      const deleteTip = page.getByRole("tooltip").filter({ hasText: deleteLabel });
      await deleteTip.waitFor({ state: "visible" });

      // 删除是破坏性操作:必须先确认,取消则一个模型都不少。
      const before = await page.locator("[data-model-key]").count();
      await remove.click();
      const confirm = page.getByRole("alertdialog", { name: dialogLabel });
      await confirm.waitFor({ state: "visible" });
      await confirm.getByRole("button", { name: locale === "en-US" ? "Cancel" : locale === "pt-BR" ? "Cancelar" : "取消" }).click();
      await confirm.waitFor({ state: "hidden" });
      assert.equal(await page.locator("[data-model-key]").count(), before, `${locale}：取消删除必须保留全部模型`);
      const firstGroupLabel = await page.locator('[class*="groupLabel"]').first().innerText();
      await remove.click();
      await confirm.getByRole("button", { name: locale === "en-US" ? "Delete" : locale === "pt-BR" ? "Excluir" : "删除" }).click();
      await page.waitForFunction((label) => ![...document.querySelectorAll('[class*="groupLabel"]')].some((node) => node.textContent === label), firstGroupLabel);
      assert.equal(await page.locator('[class*="groupLabel"]').count(), 2, `${locale}：确认后整个分组连同其模型一起消失`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("system_prompt_dialog_offers_replace_alongside_insert_positions", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const [locale, labels] of Object.entries(groupingLabels)) {
      const { context, page } = await openDemoModelPage(browser, locale, viewports.default, 2);
      const promptButton = page.locator("[data-model-key]").first().getByRole("button", { name: labels.prompt, exact: true });
      await promptButton.click();
      const dialog = page.getByRole("dialog", { name: labels.prompt });
      await dialog.waitFor({ state: "visible" });
      const selectLabel = locale === "en-US" ? "System prompt composition" : locale === "pt-BR" ? "Composição do prompt do sistema" : "系统提示词组合方式";
      const trigger = dialog.getByRole("button", { name: selectLabel });
      await trigger.waitFor({ state: "visible" });
      assert.equal(await trigger.innerText(), labels.after, `${locale}：默认组合方式是后置`);
      await trigger.click();
      const options = page.getByRole("option");
      const replace = locale === "en-US" ? "Replace" : locale === "pt-BR" ? "Substituir" : "替换";
      const optionTexts = await options.allTextContents();
      assert.deepEqual(optionTexts, [labels.before, labels.after, replace],
        `${locale}：组合方式必须同时提供前置、后置和替换`);
      await options.filter({ hasText: replace }).click();
      await dialog.getByRole("button", { name: locale === "en-US" ? "Save" : locale === "pt-BR" ? "Salvar" : "保存" }).click();
      await dialog.waitFor({ state: "hidden" });
      // 保存后重新打开必须读回替换方式,而不是回落到后置。
      await promptButton.click();
      const reopened = page.getByRole("dialog", { name: labels.prompt });
      await reopened.waitFor({ state: "visible" });
      const reopenedTrigger = reopened.getByRole("button", { name: selectLabel });
      await reopenedTrigger.waitFor({ state: "visible" });
      await page.waitForFunction(
        ({ name, value }) => [...document.querySelectorAll("[role=dialog] button")]
          .some((button) => button.getAttribute("aria-label") === name && button.textContent.includes(value)),
        { name: selectLabel, value: replace },
      );
      assert.match(await reopenedTrigger.innerText(), new RegExp(replace), `${locale}：替换方式必须被持久保存`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("grouped_views_share_one_bulk_button_and_follow_manual_group_state", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const [locale, labels] of Object.entries(groupingLabels)) {
      const { context, page } = await openDemoModelPage(browser, locale, viewports.default, 3, { plugins: pluginFixtures(), grouped: true });
      const modes = page.locator('[class*="groupActions"] button[aria-pressed]');
      const groups = page.locator('[class*="groupToggle"]');
      const expand = page.getByRole("button", { name: labels.expand, exact: true });
      const collapse = page.getByRole("button", { name: labels.collapse, exact: true });
      assert.equal(await expand.count(), 1, `${locale}：工具栏必须有唯一的一键展开按钮`);
      assert.equal(await expand.isDisabled(), true, "平铺时批量按钮必须禁用");
      const order = await page.locator('[class*="groupActions"] button').evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") || element.textContent.trim()));
      assert.equal(order[1], labels.expand, "批量按钮必须位于默认平铺和按供应商之间");
      await assertFlatPluginCards(page, 2, "平铺中的插件模型默认可见");
      await page.evaluate(() => {
        const original = window.fetch;
        window.groupingRequests = [];
        window.fetch = (input, init) => {
          const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
          if (path.startsWith("/__byok-api__/api/")) window.groupingRequests.push(path);
          return original(input, init);
        };
      });
      for (const mode of [1, 2]) {
        await modes.nth(mode).click();
        await assertGroupStates(groups, Array(5).fill(false), "切换分组视图后，三个内置组和两个插件组均默认折叠");
        await saveScreenshot(page, `grouped-collapsed-${locale}-${mode}`);
        const sameButton = await expand.elementHandle();
        await expand.click();
        await collapse.waitFor({ state: "visible" });
        assert.equal(await collapse.evaluate((element, previous) => element === previous, sameButton), true, "展开与折叠必须复用同一个按钮元素");
        await sameButton.dispose();
        await assertGroupStates(groups, Array(5).fill(true), "批量展开必须覆盖内置组和插件组");
        await groups.first().click();
        await expand.waitFor({ state: "visible" });
        await assertGroupStates(groups, [false, true, true, true, true], "单独折叠不应影响其他分组");
        await expand.click();
        await collapse.waitFor({ state: "visible" });
        await modes.nth(mode).click();
        await assertGroupStates(groups, Array(5).fill(true), "重复选择当前视图不得重置展开状态");
        await collapse.click();
        await expand.waitFor({ state: "visible" });
        await assertGroupStates(groups, Array(5).fill(false), "批量折叠必须覆盖所有分组");
        for (let index = 0; index < 5; index += 1) await groups.nth(index).click();
        await collapse.waitFor({ state: "visible" });
        await assertGroupStates(groups, Array(5).fill(true), "手动展开最后一个组后，批量按钮必须切换为折叠");
        await saveScreenshot(page, `grouped-expanded-${locale}-${mode}`);
        await collapse.click();
        for (const viewport of [viewports.default, viewports.minimum]) {
          await page.setViewportSize(viewport);
          await assertToolbarFits(page, viewport.width, locale);
        }
        await page.setViewportSize(viewports.default);
      }
      await modes.first().click();
      await assertFlatPluginCards(page, 2, "返回平铺后插件模型回到卡片网格");
      assert.equal(await expand.isDisabled(), true, "平铺不允许批量控制插件组");
      await expand.evaluate((element) => element.click());
      await assertFlatPluginCards(page, 2, "禁用的批量按钮不得改变分组");
      assert.deepEqual(await page.evaluate(() => window.groupingRequests), [], "展开、折叠和切换视图不得发送管理请求");
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("bulk_controls_handle_plugin_only_empty_and_blocked_views", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const options of [{ plugins: pluginFixtures() }, {}, { plugins: pluginFixtures(), caReady: false }]) {
      const { context, page } = await openDemoModelPage(browser, "zh-CN", viewports.default, 0, options);
      const expand = page.getByRole("button", { name: "一键展开", exact: true });
      assert.equal(await expand.count(), 1, "没有内置模型时仍须保留批量按钮的位置");
      for (const mode of [1, 2]) {
        await page.locator('[class*="groupActions"] button[aria-pressed]').nth(mode).click();
        if (options.plugins && options.caReady !== false) {
          await expand.click();
          await page.getByRole("button", { name: "一键折叠", exact: true }).waitFor({ state: "visible" });
          await assertGroupStates(page.locator('[class*="groupToggle"]'), [true, true], "插件-only 视图也必须支持批量展开");
        } else {
          assert.equal(await expand.isDisabled(), true, "空列表或 CA Gate 阻止显示时必须禁用批量操作");
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("folding_groups_keeps_in_flight_tests_and_their_results", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const [locale, labels] of Object.entries(groupingLabels)) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, viewports.default, 3, { plugins: pluginFixtures(), grouped: true, takenOver: false });
      await page.locator('[class*="groupActions"] button[aria-pressed]').nth(1).click();
      await page.getByRole("button", { name: labels.expand, exact: true }).click();
      await holdConnectivityTests(page);
      await cards.first().locator('[class*="modelCardActions"] button').first().click();
      await page.waitForFunction(() => typeof window.completeModelTest === "function");
      await page.getByRole("button", { name: labels.collapse, exact: true }).click();
      await assertGroupStates(page.locator('[class*="groupToggle"]'), Array(5).fill(false), "测试中也可以折叠全部分组");
      assert.equal(await page.evaluate(() => window.modelTestCancellations), 0, "折叠不能取消正在运行的测试");
      await page.evaluate(() => {
        const complete = window.completeModelTest;
        delete window.completeModelTest;
        complete(Response.json({ duration_ms: 1284, first_valid_response_ms: 418, output_tokens: 42, tokens_per_second: 38.6, tokens_estimated: false, output: "Mock connectivity test passed." }));
      });
      await page.getByRole("button", { name: labels.expand, exact: true }).click();
      await cards.locator('[class*="success"]').first().waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => window.modelTestCancellations), 0, "折叠期间完成的测试应保留成功结果");
      const batch = page.locator('[class*="groupActions"] button').last();
      const testLabel = await batch.getAttribute("aria-label");
      await batch.click();
      await page.waitForFunction(() => window.modelTestCompletions.length === 6);
      assert.notEqual(await batch.getAttribute("aria-label"), testLabel, "同一个测试按钮应切换到取消全部测试");
      await page.getByRole("button", { name: labels.collapse, exact: true }).click();
      for (const viewport of [viewports.default, viewports.minimum]) {
        await page.setViewportSize(viewport);
        await assertToolbarFits(page, viewport.width, locale);
      }
      assert.equal(await page.evaluate(() => window.modelTestCancellations), 0, "折叠不应冒充取消全部测试");
      await batch.click();
      await page.waitForFunction((label) => [...document.querySelectorAll('[class*="groupActions"] button')].at(-1)?.getAttribute("aria-label") === label, testLabel);
      assert.equal(await page.evaluate(() => window.modelTestCancellations), 5, "只有显式取消才取消三个内置模型和两个插件模型的测试");
      await assertGroupStates(page.locator('[class*="groupToggle"]'), Array(5).fill(false), "取消测试不应改变分组的展开状态");
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("refresh_keeps_live_groups_and_resets_removed_group_identities", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    const { context, page } = await openDemoModelPage(browser, "zh-CN", viewports.default, 3, { grouped: true });
    await page.locator('[class*="groupActions"] button[aria-pressed]').nth(1).click();
    await page.getByRole("button", { name: "一键展开", exact: true }).click();
    await page.evaluate(async () => {
      const original = window.fetch;
      window.fullGroupingModels = await (await original("/__byok-api__/api/models")).json();
      window.currentGroupingModels = window.fullGroupingModels.slice(1);
      window.fetch = (input, init) => {
        const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
        return path === "/__byok-api__/api/models" && (init?.method ?? "GET") === "GET"
          ? Promise.resolve(Response.json(window.currentGroupingModels)) : original(input, init);
      };
    });
    const groups = page.locator('[class*="groupToggle"]');
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[class*="groupToggle"]').length === 2);
    await assertGroupStates(groups, [true, true], "删组后仍存在的分组应保持展开");
    await page.evaluate(() => { window.currentGroupingModels = window.fullGroupingModels; });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[class*="groupToggle"]').length === 3);
    await assertGroupStates(groups, [false, true, true], "重新出现的分组应默认折叠，而不是恢复已经回收的旧选择");
    await page.evaluate(() => {
      const models = window.fullGroupingModels.map((model, index) => ({ ...model, group_name: `Renamed ${index}` }));
      window.currentGroupingModels = [...models, { ...models[1], model_hash: "new-group-member", display_name: "New member" }];
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await groups.first().getByText("Renamed 0", { exact: true }).waitFor({ state: "visible" });
    await assertGroupStates(groups, [false, true, true], "改组名和增加现有组成员不得改变展开选择");
    await context.close();
  } finally {
    await browser.close();
  }
});
