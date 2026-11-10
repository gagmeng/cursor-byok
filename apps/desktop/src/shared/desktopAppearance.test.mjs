//! Verifies readable desktop themes, diagnostic states, keyboard focus, and compact-window navigation.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const testUrl = process.env.CURSOR_CARD_TEST_URL;
const options = { skip: !testUrl && "由 npm run test:ui 启动隔离演示" };
const themes = ["default-light", "default-dark"];

async function open(browser, route, { theme = "default-light", locale = "zh-CN", width = 820, reducedMotion = "no-preference" } = {}) {
  const url = new URL(testUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/product-demo/demo/index.html");
  url.searchParams.set("theme", theme);
  url.searchParams.set("locale", locale);
  url.hash = route;
  const context = await browser.newContext({ viewport: { width, height: 558 }, locale, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url.href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

async function launch() {
  return chromium.launch({ headless: true, ...(process.env.CURSOR_TEST_BROWSER && { executablePath: process.env.CURSOR_TEST_BROWSER }) });
}

async function contrast(locator) {
  return locator.evaluate(element => {
    const rgb = color => color.match(/[\d.]+/g).map(Number);
    const composite = (front, back) => {
      const alpha = front[3] ?? 1;
      return front.slice(0, 3).map((value, index) => value * alpha + back[index] * (1 - alpha));
    };
    const layers = [];
    for (let parent = element; parent; parent = parent.parentElement) layers.push(rgb(getComputedStyle(parent).backgroundColor));
    const background = layers.reverse().reduce((back, front) => composite(front, back), [255, 255, 255]);
    const foreground = composite(rgb(getComputedStyle(element).color), background);
    const luminance = color => color.map(value => value / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const light = luminance(foreground), dark = luminance(background);
    return (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05);
  });
}

test("secondary_text_and_primary_actions_are_readable_in_both_themes", options, async () => {
  const browser = await launch();
  try {
    for (const theme of themes) {
      const { context, page, errors } = await open(browser, "/diagnostics", { theme });
      const explanation = page.locator("main small").first();
      assert.ok(await contrast(explanation) >= 4.5, `${theme}: 配置说明文字与卡片的对比度必须至少为 4.5:1`);
      await page.getByRole("link", { name: "插件配置", exact: true }).click();
      const action = page.getByRole("button", { name: "初始化插件", exact: true });
      await action.waitFor();
      assert.ok(await contrast(action) >= 4.5, `${theme}: 主按钮文字必须达到 4.5:1`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("verified_and_waiting_connection_states_have_distinct_readable_indicators", options, async () => {
  const browser = await launch();
  try {
    for (const theme of themes) {
      const { context, page } = await open(browser, "/diagnostics", { theme });
      const ready = page.locator('main ol [data-state="passed"]').first();
      const waiting = page.locator('main ol [data-state="waiting"]').first();
      assert.equal(await ready.innerText(), "已就绪");
      assert.equal(await waiting.innerText(), "未验证");
      const readyStyle = await ready.evaluate(element => {
        const style = getComputedStyle(element);
        const dot = getComputedStyle(element, "::before");
        return { color: style.color, parentColor: getComputedStyle(element.parentElement).color, marker: dot.content, markerWidth: parseFloat(dot.width) };
      });
      assert.notEqual(readyStyle.color, readyStyle.parentColor, "已验证状态必须有明确的语义颜色");
      assert.notEqual(readyStyle.color, await waiting.evaluate(element => getComputedStyle(element).color));
      assert.ok(readyStyle.marker !== "none" && readyStyle.markerWidth > 0, "状态点应与文字同时可见");
      assert.ok(await contrast(ready) >= 4.5, `${theme}: 已验证状态必须可读`);
      assert.ok(await contrast(waiting) >= 4.5, `${theme}: 等待状态必须可读`);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("navigation_icons_are_quiet_and_keyboard_focus_remains_visible", options, async () => {
  const browser = await launch();
  try {
    const { context, page } = await open(browser, "/diagnostics");
    const coloredGlyphs = await page.locator("nav svg [fill], nav svg [stroke]").evaluateAll(elements => elements
      .flatMap(element => [element.getAttribute("fill"), element.getAttribute("stroke")])
      .filter(value => value && value !== "none" && value !== "currentColor"));
    assert.deepEqual(coloredGlyphs, [], "导航图标应使用文字颜色，供应商品牌图标仍可保留自身标识");
    const overview = page.getByRole("link", { name: "数据概览", exact: true });
    await overview.focus();
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    assert.equal(await focused.innerText(), "调用详细");
    const outline = await focused.evaluate(element => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.ok(outline.style !== "none" && outline.width >= 2, "键盘用户必须看得到当前导航焦点");
    await context.close();
  } finally { await browser.close(); }
});

test("page_actions_and_navigation_remain_reachable_in_every_language_at_the_minimum_window", options, async () => {
  const browser = await launch();
  try {
    for (const locale of ["zh-CN", "en-US", "pt-BR"]) {
      const { context, page, errors } = await open(browser, "/", { locale });
      for (const route of ["/", "/harness/cursor", "/diagnostics", "/model-health", "/calls", "/plugins", "/settings"]) {
        await page.locator(`nav a[href="#${route}"]`).click();
        const region = page.locator('main > [class*="actionRegion"]');
        await region.waitFor();
        const geometry = await page.evaluate(() => {
          const box = element => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          };
          const main = document.querySelector("main");
          const action = main.querySelector('[class*="actionRegion"]');
          const title = main.querySelector('[class*="title"]');
          return { nav: box(document.querySelector("nav")), action: box(action), title: box(title), controls: [...action.querySelectorAll("button")].filter(element => element.getClientRects().length).map(box), overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(geometry.action.left >= geometry.nav.right && geometry.action.right <= 821, `${locale} ${route}: 页面操作必须完整位于内容区域内`);
        assert.ok(geometry.title.right <= geometry.action.left, `${locale} ${route}: 操作不能遮住页面标题`);
        assert.ok(geometry.controls.every(box => box.top >= 30 && box.bottom <= 558), `${locale} ${route}: 操作不能进入原生窗口控制区域`);
        assert.equal(geometry.overflow, false, `${locale} ${route}: 页面不能横向溢出`);
      }
      const chrome = () => page.evaluate(() => [document.querySelector("nav"), document.querySelector("header"), document.querySelector('main > [class*="actionRegion"]')]
        .map(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; }));
      const before = await chrome();
      await page.mouse.move(600, 400);
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(150);
      assert.deepEqual(await chrome(), before, `${locale}: 滚动设置内容不能移动窗口栏、导航和页面操作`);
      assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0);
      const settingsLink = page.locator('nav a[href="#/settings"]');
      assert.ok(await settingsLink.isVisible(), `${locale}: 设置入口始终可达`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test("reduced_motion_keeps_controls_usable_without_animated_transitions", options, async () => {
  const browser = await launch();
  try {
    const { context, page } = await open(browser, "/harness/cursor", { reducedMotion: "reduce" });
    const toggle = page.getByRole("switch").first();
    await toggle.waitFor();
    const duration = await toggle.evaluate(element => getComputedStyle(element).transitionDuration);
    assert.ok(duration.split(",").every(value => parseFloat(value) <= .001), "系统选择减少动态效果时，开关不应继续播放过渡");
    await toggle.focus();
    assert.equal(await toggle.evaluate(element => document.activeElement === element), true);
    await context.close();
  } finally { await browser.close(); }
});

test("compact_overview_filters_keep_every_range_and_custom_model_filter_available", options, async () => {
  const browser = await launch();
  try {
    for (const locale of ["zh-CN", "en-US", "pt-BR"]) {
      const { context, page } = await open(browser, "/", { locale });
      const trigger = page.locator('[class*="compactPreset"] > button');
      await trigger.waitFor();
      await trigger.click();
      const list = page.getByRole("listbox");
      assert.equal(await list.getByRole("option").count(), 6, "窄窗口中仍应提供五个预设和自定义范围");
      await list.getByRole("option").nth(1).click();
      await list.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
      await trigger.click();
      await page.getByRole("listbox").getByRole("option").last().click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, "打开自定义范围后键盘焦点应进入筛选面板");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
      await trigger.click();
      await page.getByRole("listbox").getByRole("option").last().click();
      await dialog.waitFor();
      await page.setViewportSize({ width: 1280, height: 558 });
      await page.waitForFunction(() => {
        const panel = document.querySelector('[role="dialog"]');
        const button = document.querySelector('[class*="presets"] > button:last-child');
        return Math.abs(panel.getBoundingClientRect().right - button.getBoundingClientRect().right) < 1;
      });
      await page.setViewportSize({ width: 820, height: 558 });
      await page.waitForFunction(() => {
        const panel = document.querySelector('[role="dialog"]');
        const button = document.querySelector('[class*="compactPreset"] > button');
        return Math.abs(panel.getBoundingClientRect().right - button.getBoundingClientRect().right) < 1;
      });
      await dialog.locator('[class*="modelSelect"], [class*="target"]').getByRole("button").first().click();
      await page.getByRole("listbox").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), true, "关闭模型菜单应保留自定义筛选面板");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await trigger.evaluate(element => document.activeElement === element), true, "关闭窄窗口筛选面板后应返回范围选择器");
      await context.close();
    }
  } finally { await browser.close(); }
});

test("cached_overview_charts_repaint_when_the_desktop_theme_changes", options, async () => {
  const browser = await launch();
  try {
    const { context, page } = await open(browser, "/", { reducedMotion: "reduce", width: 1280 });
    const image = page.getByRole("img", { name: "Token 消耗", exact: true });
    await image.waitFor();
    const pixels = () => image.locator("canvas").evaluate(canvas => {
      const bytes = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (let index = 0; index < bytes.length; index += 4) hash = (Math.imul(hash, 31) + bytes[index] + bytes[index + 1] + bytes[index + 2]) | 0;
      return hash;
    });
    const light = await pixels();
    await page.evaluate(() => { document.documentElement.dataset.theme = "default-dark"; });
    await page.waitForTimeout(100);
    assert.notEqual(await pixels(), light, "主题切换后保留在缓存中的图表必须重新绘制为对应配色");
    await context.close();
  } finally { await browser.close(); }
});
