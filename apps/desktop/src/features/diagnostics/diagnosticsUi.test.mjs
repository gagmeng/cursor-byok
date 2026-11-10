//! Exercises onboarding, independent evidence, capability cancellation, and migration in an isolated browser.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const testUrl = process.env.CURSOR_CARD_TEST_URL;
const options = { skip: !testUrl && "由 npm run test:ui 启动隔离演示" };
async function open(route, locale = "zh-CN", configure) {
  const url = new URL(testUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/product-demo/demo/index.html");
  url.searchParams.set("locale", locale);
  url.hash = route;
  const browser = await chromium.launch({ headless: true, ...(process.env.CURSOR_TEST_BROWSER && { executablePath: process.env.CURSOR_TEST_BROWSER }) });
  const page = await browser.newPage({ viewport: { width: 780, height: 600 }, locale });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (configure) await page.addInitScript(configure);
  await page.goto(url.href, { waitUntil: "networkidle" });
  return { browser, page, errors };
}

test("local_and_ssh_challenges_remain_separate_and_do_not_claim_success_without_cursor", options, async () => {
  const { browser, page, errors } = await open("/diagnostics");
  try {
    await page.getByRole("button", {name: "验证本地连接", exact: true}).click();
    const local = page.locator('code').first();
    await local.waitFor();
    const first = await local.textContent();
    assert.match(first, /BYOK_DIAGNOSTIC_/);
    assert.equal(await page.locator('[class*="evidence"] [data-state="passed"]').count(), 0);
    await page.getByRole("button", {name: "验证 SSH 连接", exact: true}).click();
    await page.waitForFunction(() => document.querySelectorAll("code").length === 2);
    const markers = await page.locator("code").allTextContents();
    assert.equal(markers[0], first);
    assert.notEqual(markers[0], markers[1]);
    assert.equal(await page.locator('[class*="evidence"] [data-state="passed"]').count(), 0);
    const bounds = await page.locator('[class*="actionRegion"]').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 781, "最小窗口中诊断操作必须可达");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("capability_results_are_saved_and_cancelling_a_batch_stops_the_remaining_requests", options, async () => {
  const { browser, page, errors } = await open("/model-health");
  try {
    const first = page.locator('[class*="resultHeader"]').first();
    await first.getByRole("button", {name: "运行测试", exact: true}).click();
    await first.getByText("通过", {exact: true}).waitFor();
    await page.getByRole("link", {name: "连接诊断", exact: true}).click();
    await page.getByRole("link", {name: "模型健康", exact: true}).click();
    await first.getByText("通过", {exact: true}).waitFor();
    await page.evaluate(() => {
      const original = window.fetch;
      window.probeCount = 0;
      window.fetch = (input, init) => {
        const path = new URL(String(input), location.href).pathname;
        if (path.includes("/capabilities/")) {
          window.probeCount++;
          return new Promise(resolve => {window.cancelProbe = () => resolve(Response.json({model_id:"mock-claude-sonnet", capability:"streaming", status:"cancelled", tested_at_ms:Date.now(), duration_ms:1, detail:"cancelled"}));});
        }
        if (path.includes("/test/") && init?.method === "DELETE") { window.cancelProbe(); return Promise.resolve(new Response(null, {status:204})); }
        return original(input, init);
      };
    });
    await page.getByRole("button", {name: "测试全部能力", exact: true}).click();
    await first.getByRole("button", {name: "取消测试", exact: true}).click();
    await page.getByRole("button", {name: "测试全部能力", exact: true}).waitFor();
    assert.equal(await page.evaluate(() => window.probeCount), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("first_use_opens_setup_and_can_be_deferred_without_blocking_the_overview", options, async () => {
  const { browser, page, errors } = await open("/", "zh-CN", () => {
    let current = window.fetch;
    Object.defineProperty(window, "fetch", { configurable:true, get:()=>current, set:(demo)=>{current=(input,init)=>{
      const path = new URL(String(input),location.href).pathname;
      if(path.endsWith("/models")) return Promise.resolve(Response.json([]));
      if(path.endsWith("/harness/cursor/status")) return Promise.resolve(Response.json({platform:"windows",ca:"missing",configured_models:0,enabled_models:0,integration:"disabled",settings_applied:false,proxy_url:null,ca_install_command:null,startup_error:null}));
      return demo(input,init);
    };}});
  });
  try {
    await page.waitForURL(/#\/diagnostics$/);
    await page.getByRole("link",{name:"稍后完成，进入概览",exact:true}).click();
    await page.waitForURL(/#\/$/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("diagnostic_pages_fit_the_minimum_window_in_all_supported_languages", options, async () => {
  for(const [locale, route] of [["en-US","/diagnostics"],["pt-BR","/diagnostics"],["en-US","/model-health"],["pt-BR","/model-health"]]) {
    const {browser,page,errors}=await open(route,locale);
    try {
      const region=page.locator('[class*="actionRegion"]');
      await region.waitFor();
      const controls=await region.locator("button").evaluateAll(elements=>elements.map(element=>{const b=element.getBoundingClientRect(); return {left:b.left,right:b.right};}));
      assert.ok(controls.every(b=>b.left>=0 && b.right<=781), `${locale} ${route}: 页面操作不能超出窗口`);
      const title=await page.locator('[class*="pageTitle"]').boundingBox();
      assert.ok(title.x + title.width <= Math.min(...controls.map(b=>b.left)),`${locale} ${route}: 页面操作不能遮住标题`);
      assert.ok(Math.min(...controls.map(b=>b.left))>=230,`${locale} ${route}: 操作不能遮住左侧菜单`);
      if (process.env.CURSOR_CARD_SCREENSHOT_DIR) {
        await mkdir(process.env.CURSOR_CARD_SCREENSHOT_DIR, {recursive:true});
        await page.screenshot({path:join(process.env.CURSOR_CARD_SCREENSHOT_DIR, `${route.slice(1)}-${locale}.png`)});
      }
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  }
});

test("model_selection_shows_complete_names_and_stays_inside_the_window_after_resize", options, async () => {
  const { browser, page, errors } = await open("/model-health", "zh-CN", () => {
    let current = window.fetch;
    Object.defineProperty(window, "fetch", { configurable: true, get: () => current, set: demo => { current = async (input, init) => {
      const response = await demo(input, init);
      if (new URL(String(input), location.href).pathname === "/__byok-api__/api/models") {
        const models = await response.json();
        return Response.json(models.slice(0, 5).map((model, index) => ({
          ...model,
          display_name: index === 0 ? "Qwen3.8-Flash-Next 完整模型名称 / 高上下文版本" : `Claude-Opus-5-1M-${"extended-context-".repeat(12)}${index}`,
          group_name: `unittec / ${"供应商完整名称与分组".repeat(5)}`,
        })));
      }
      return response;
    }; } });
  });
  try {
    const trigger = page.getByRole("button", { name: /筛选项：选择模型/ });
    const selectedName = "Qwen3.8-Flash-Next 完整模型名称 / 高上下文版本";
    await trigger.click();
    const list = page.getByRole("listbox", { name: "选择模型", exact: true });
    await list.waitFor();
    const originalWidth = (await list.boundingBox()).width;
    assert.ok(originalWidth >= 350, "下拉列表应独立加宽，不能被紧凑选择框限制到 150px");
    const assertReadable = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('[role="listbox"] [role="option"] [class*="option"] > span:last-child')]
        .every(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1));
      const clippedGroups = await list.locator('[class*="groupLabel"]').evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).length);
      assert.equal(clippedGroups, 0, "供应商分组名称也必须完整显示");
      const bounds = await list.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(bounds.x >= 9 && bounds.x + bounds.width <= viewport.width - 9, "菜单必须在窗口左右边界内");
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, "菜单必须在窗口上下边界内");
    };
    await assertReadable();
    const names = await list.getByRole("option").allTextContents();
    assert.ok(names.includes(selectedName));
    await list.getByRole("option", { name: selectedName, exact: true }).click();
    await list.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    assert.equal(await trigger.getAttribute("title"), selectedName, "紧凑选择框应保留完整已选模型名称提示");
    await trigger.click();
    await page.setViewportSize({ width: 820, height: 558 });
    await assertReadable();
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    await page.setViewportSize({ width: 1200, height: 700 });
    await trigger.click();
    await assertReadable();
    if (process.env.CURSOR_CARD_SCREENSHOT_DIR) {
      await mkdir(process.env.CURSOR_CARD_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.CURSOR_CARD_SCREENSHOT_DIR, "model-health-model-selection-wide.png") });
    }
    await page.locator('[class*="pageTitle"]').click();
    await list.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("wider_model_menus_keep_nested_overview_filters_and_bulk_selection_usable", options, async () => {
  const { browser, page, errors } = await open("/");
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.getByRole("button", { name: "自定义", exact: true }).click();
    const filters = page.getByRole("dialog", { name: "自定义概览筛选", exact: true });
    await filters.waitFor();
    const trigger = filters.getByRole("button", { name: /筛选项：模型/ });
    await trigger.click();
    const list = page.getByRole("listbox", { name: "模型", exact: true });
    await list.waitFor();
    assert.ok((await list.boundingBox()).width >= 350, "嵌套多选菜单同样应有足够宽度");
    const menu = page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
    await menu.getByRole("button", { name: "全选", exact: true }).click();
    await page.getByRole("button", { name: /筛选项：模型，已选/ }).waitFor();
    assert.equal(await filters.isVisible(), true, "操作子菜单不能关闭父筛选框");
    assert.equal(await list.isVisible(), true, "多选操作后应保留菜单");
    await menu.getByRole("button", { name: "全不选", exact: true }).click();
    await page.getByRole("button", { name: "筛选项：模型，全部", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await list.waitFor({ state: "hidden" });
    assert.equal(await filters.isVisible(), true);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("migration_rejects_corruption_blocks_repeat_submission_and_refreshes_models", options, async () => {
  const {browser,page,errors}=await open("/settings");
  try {
    const input=page.locator('input[type="file"]');
    await input.setInputFiles({name:"broken.json",mimeType:"application/json",buffer:Buffer.from('{"format":"cursor-byok-migration"}')});
    await page.getByText("迁移文件无法读取，可能已损坏",{exact:true}).waitFor();
    assert.equal(await page.getByRole("alertdialog",{name:"导入迁移文件"}).count(),0);
    await page.evaluate(()=>{
      const original=window.fetch;
      window.importSubmissions=0;
      window.importCompleted=false;
      window.modelRefreshes=0;
      window.fetch=async(input,init)=>{
        const path=new URL(String(input),location.href).pathname;
        if(path.endsWith("/migration/import")) {
          window.importSubmissions++;
          return new Promise(resolve=>{window.completeImport=()=>{window.importCompleted=true;resolve(Response.json({models_added:1,models_total:1,resources_added:0,resources_updated:0,warnings:[]}));};});
        }
        if(path.endsWith("/models") && window.importCompleted) window.modelRefreshes++;
        return original(input,init);
      };
    });
    const bundle={format:"cursor-byok-migration",version:3,app_version:"test",exported_at_ms:0,models:[],plugin_resources:[],model_system_prompts:[]};
    await input.setInputFiles({name:"complete.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(bundle))});
    const dialog=page.getByRole("alertdialog",{name:"导入迁移文件"});
    await dialog.getByRole("button",{name:"导入",exact:true}).click();
    await dialog.getByRole("button",{name:"处理中…",exact:true}).waitFor();
    assert.equal(await dialog.getByRole("button",{name:"处理中…",exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.importSubmissions),1);
    await page.evaluate(()=>window.completeImport());
    await dialog.waitFor({state:"hidden"});
    assert.ok(await page.evaluate(()=>window.modelRefreshes)>0,"导入成功必须刷新共享模型快照");
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test("migration_export_reports_failures_and_downloads_the_file_after_session_recovery", options, async () => {
  const {browser,page,errors}=await open("/settings");
  try {
    await page.evaluate(()=>{
      const original=window.fetch;
      window.exportRequests=0;
      window.exportFailure=true;
      window.fetch=async(input,init)=>{
        const path=new URL(String(input),location.href).pathname;
        if(path.endsWith("/migration/export")) {
          window.exportRequests++;
          if(window.exportFailure) return Response.json({message:"Export failed fixture"},{status:500});
          if(window.exportRequests===2) return new Response("expired",{status:401,headers:{"x-cursor-byok-session":"required"}});
          return new Response('{"version":3}',{headers:{"content-disposition":'attachment; filename="configuration-test.json"'}});
        }
        return original(input,init);
      };
    });
    await page.getByRole("button",{name:"导出",exact:true}).click();
    await page.getByText("Export failed fixture",{exact:true}).waitFor();
    await page.evaluate(()=>window.exportFailure=false);
    const downloaded=page.waitForEvent("download");
    await page.getByRole("button",{name:"导出",exact:true}).click();
    const file=await downloaded;
    assert.equal(file.suggestedFilename(),"configuration-test.json");
    assert.equal(await readFile(await file.path(),"utf8"),'{"version":3}');
    assert.equal(await page.evaluate(()=>window.exportRequests),3);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test("plugin_exports_download_inside_the_application_without_opening_an_external_browser", options, async () => {
  const {browser,page,errors}=await open("/plugins","zh-CN",()=>{
    let current=window.fetch;
    Object.defineProperty(window,"fetch",{configurable:true,get:()=>current,set:demo=>{current=(input,init)=>{
      const path=new URL(String(input),location.href).pathname;
      if(path.endsWith("/plugins/runtime")) return Promise.resolve(Response.json({state:"ready",version:"test",target:null,phase:null,downloaded_bytes:0,total_bytes:null,error:null}));
      if(path.endsWith("/plugins")) return Promise.resolve(Response.json([{
        id:"fixture",name:"Fixture",version:"1",author:null,icon:"",providers:[],resources:[{
          type:"accounts",displayName:"Accounts",add:[],import:null,canRefresh:false,canRemove:false,actions:[],resources:[{
            id:"one",state:{status:"ready"},displayName:"One",description:null,metrics:[],createdAtMs:0,
          }],
        }],
      }]));
      if(path.endsWith("/resources/accounts/export")) return Promise.resolve(new Response('[{"id":"one"}]',{headers:{"content-disposition":'attachment; filename="fixture-accounts.json"'}}));
      if(path.endsWith("/desktop/open-external-url")) throw new Error("Export must stay in the application");
      return demo(input,init);
    };}});
  });
  try {
    await page.getByRole("button",{name:"更多",exact:true}).click();
    const downloaded=page.waitForEvent("download");
    await page.getByRole("menuitem",{name:"批量导出",exact:true}).click();
    const file=await downloaded;
    assert.equal(file.suggestedFilename(),"fixture-accounts.json");
    assert.equal(await readFile(await file.path(),"utf8"),'[{"id":"one"}]');
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
