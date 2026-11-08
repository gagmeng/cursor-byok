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

async function openDemoModelPage(browser, locale, viewport, modelCount, { plugins = [], grouped = false, caReady = true, takenOver = true } = {}) {
  const context = await browser.newContext({ viewport, locale });
  const page = await context.newPage();
  // 演示未提供这些基础接口；只在测试页补充假响应，避免接触真实服务。
  await page.addInitScript(({ modelCount, plugins, grouped, caReady, takenOver }) => {
    let currentFetch = window.fetch;
    Object.defineProperty(window, "fetch", {
      configurable: true,
      get: () => currentFetch,
      set: (demoFetch) => {
        currentFetch = (input, init) => {
          const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
          if (path === "/__byok-api__/api/models") {
            return Promise.resolve(demoFetch(input, init)).then(async (response) => {
              const models = (await response.json()).slice(0, modelCount);
              return Response.json(grouped ? models.map((model, index) => ({
                ...model, base_url: `https://provider-${index}.example/v1`, group_name: `Provider ${index}`,
                type: index === 0 ? "anthropic" : "openai",
                openai_endpoint: index === 1 ? "/v1/chat/completions" : "/v1/responses",
              })) : models);
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
  }, { modelCount, plugins, grouped, caReady, takenOver });
  const url = new URL(testUrl);
  url.searchParams.set("locale", locale);
  url.searchParams.set("theme", "default-light");
  url.hash = "/harness/cursor";
  await page.goto(url.href, { waitUntil: "networkidle" });
  const cards = page.locator("[data-model-hash]");
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

async function cardRow(cards) {
  return cards.evaluateAll(async (elements) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      right: elements[0].parentElement.getBoundingClientRect().right,
      cards: elements.map((element) => {
        const { top, left, right, width } = element.getBoundingClientRect();
        return { top, left, right, width };
      }),
    };
  });
}

async function saveScreenshot(page, name) {
  if (!process.env.CURSOR_CARD_SCREENSHOT_DIR) return;
  await page.mouse.move(0, 0);
  // 捕捉稳定卡片布局，避免临时错误提示或悬浮提示遮住被验证的内容。
  await page.locator('[role="status"][class*="message"]').waitFor({ state: "hidden" });
  await mkdir(process.env.CURSOR_CARD_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(process.env.CURSOR_CARD_SCREENSHOT_DIR, `${name}.png`) });
}

test("default_window_fits_two_idle_cards_without_unused_row_space", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, viewports.default, 2);
      assert.equal(await cards.count(), 2, "双列验证必须包含两张真实模型卡片");
      const initial = await cardRow(cards);
      assert.ok(Math.abs(initial.cards[0].top - initial.cards[1].top) <= 1, `${locale}：默认窗体必须让两张未测试卡片并排显示`);
      assert.ok(Math.abs(initial.cards[0].width - initial.cards[1].width) <= 1, `${locale}：两张卡片的宽度必须一致`);
      assert.ok(initial.cards[1].left >= initial.cards[0].right, `${locale}：并排卡片不得重叠`);
      assert.ok(Math.abs(initial.right - initial.cards[1].right) <= 1, `${locale}：第二张卡片右侧只能保留正常页边距，内容区不得留出多余空白`);
      const title = await page.locator('[class*="title"]').filter({ hasText: /^Cursor$/ }).boundingBox();
      const actions = await page.locator('[class*="takeoverActions"]').boundingBox();
      assert.ok(title.x + title.width <= actions.x, `${locale}：收紧默认窗体后，工具栏不得遮挡页面标题`);
      await saveScreenshot(page, `two-fixed-cards-${locale}`);
      for (const viewport of [{ width: 1280, height: viewports.default.height }, viewports.minimum]) {
        await page.setViewportSize(viewport);
        const resized = await cardRow(cards);
        for (let index = 0; index < resized.cards.length; index += 1) {
          assert.ok(Math.abs(resized.cards[index].width - initial.cards[index].width) <= 1, `${locale}：缩放窗体不得拉伸或压缩卡片`);
          assert.ok(resized.cards[index].left >= 0 && resized.cards[index].right <= viewport.width, `${locale}：缩放窗体时卡片仍须完整可见`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("model_cards_keep_idle_width_during_failed_tests_and_successful_retries", demoTestOptions, async () => {
  const viewports = await desktopViewports();
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, viewports.default, 2);
      const initial = await cardRow(cards);
      const card = cards.first();
      await holdConnectivityTests(page);
      for (const outcome of [
        { state: "error", status: 401, body: { message: `provider error: OpenAI Responses 401 ${"authentication failed ".repeat(20)}` } },
        { state: "success", status: 200, body: { duration_ms: 1284, first_valid_response_ms: 418, output_tokens: 42, tokens_per_second: 38.6, tokens_estimated: false, output: "Mock connectivity test passed." } },
      ]) {
        await card.locator('[class*="modelCardActions"] button').first().click();
        await page.waitForFunction(() => typeof window.completeModelTest === "function");
        await card.locator('[class*="modelCardTest"] > [class*="testing"]').waitFor({ state: "visible" });
        const during = await cardRow(cards);
        assert.ok(during.cards.every((box, index) => Math.abs(box.width - initial.cards[index].width) <= 1), `${locale}：测试中必须保持未测试时的卡片宽度`);
        await page.evaluate(({ body, status }) => {
          const complete = window.completeModelTest;
          delete window.completeModelTest;
          complete(Response.json(body, { status }));
        }, outcome);
        await card.locator(`[class*="modelCardTest"] > [class*="${outcome.state}"]`).waitFor({ state: "visible" });
        const settled = await cardRow(cards);
        assert.ok(settled.cards.every((box, index) => Math.abs(box.width - initial.cards[index].width) <= 1), `${locale}：${outcome.state} 状态必须保持未测试时的卡片宽度`);
        assert.ok(Math.abs(settled.cards[0].top - settled.cards[1].top) <= 1, `${locale}：测试结果不得把第二张卡片挤到下一行`);
        const detailBounds = await card.locator('[class*="modelCardTest"] button').boundingBox();
        assert.ok(detailBounds.x + detailBounds.width <= settled.cards[0].right, `${locale}：长错误或测试结果的详情按钮不得超出卡片`);
        await saveScreenshot(page, `fixed-cards-${outcome.state}-${locale}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("fixed_model_cards_keep_every_action_label_visible", demoTestOptions, async () => {
  const browser = await launchLayoutBrowser();
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const { context, page, cards } = await openDemoModelPage(browser, locale, { width: 1280, height: 900 }, 1);
      const card = cards.first();
      const bounds = await card.boundingBox();
      assert.ok(bounds.width <= 400, `${locale}：单模型卡片不能拉满宽容器（实际 ${bounds.width}px）`);
      const status = await card.locator('[class*="modelCardTest"] > div').boundingBox();
      assert.ok(status.width <= 150, "未测试状态应显示为紧凑标记，而不是横向空白面板");
      const labels = await card.locator('[class*="modelCardActions"] button > span').evaluateAll((elements) => elements.map((element) => ({
        text: element.textContent,
        available: element.clientWidth,
        needed: element.scrollWidth,
        top: element.parentElement.getBoundingClientRect().top,
      })));
      assert.equal(labels.length, 5, "每张模型卡片必须保留全部五个操作");
      if (locale === "zh-CN") {
        assert.deepEqual(labels.map(({ text }) => text), ["测试", "编辑", "系统提示词", "复制", "删除"]);
        assert.equal(new Set(labels.map(({ top }) => Math.round(top))).size, 1, "中文未测试卡片的五个操作应保持同一行");
      }
      // 翻译较长时可以换行，不能为了单行显示而改变固定卡片宽度或截断文案。
      assert.deepEqual(labels.filter(({ needed, available }) => needed > available + 1), [], `${locale}：固定卡片内的按钮文字不能被省略号截断`);
      await context.close();
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
  "zh-CN": { expand: "一键展开", collapse: "一键折叠" },
  "en-US": { expand: "Expand all", collapse: "Collapse all" },
  "pt-BR": { expand: "Expandir tudo", collapse: "Recolher tudo" },
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

/** 平铺视图下插件模型以卡片呈现:无分组容器,每个插件模型可见。 */
async function assertFlatPluginCards(page, count, message) {
  assert.equal(await page.locator('[class*="groupToggle"]').count(), 0, `${message}：平铺视图不渲染分组容器`);
  for (let index = 0; index < count; index += 1) {
    await page.getByText(`Plugin model ${index}`, { exact: true }).waitFor({ state: "visible" });
  }
}

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
      const { context, page } = await openDemoModelPage(browser, locale, viewports.default, 3, { plugins: pluginFixtures(), grouped: true, takenOver: false });
      await page.locator('[class*="groupActions"] button[aria-pressed]').nth(1).click();
      await page.getByRole("button", { name: labels.expand, exact: true }).click();
      await holdConnectivityTests(page);
      await page.locator('[class*="modelRow"]').first().locator('[class*="modelCardActions"] button').first().click();
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
      await page.locator('[class*="modelRow"] [class*="success"]').first().waitFor({ state: "visible" });
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
