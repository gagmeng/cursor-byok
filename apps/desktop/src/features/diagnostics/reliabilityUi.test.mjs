//! Verifies model keyboard selection, failed range queries, and Magpie group resynchronization.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const testUrl=process.env.CURSOR_CARD_TEST_URL;
const options={skip:!testUrl && "由隔离产品演示启动"};
async function open(route, configure) {
  const browser=await chromium.launch({headless:true,...(process.env.CURSOR_TEST_BROWSER && {executablePath:process.env.CURSOR_TEST_BROWSER})});
  const page=await browser.newPage({viewport:{width:1400,height:900},locale:"zh-CN"});
  const url=new URL(testUrl);assert.equal(url.hostname,"127.0.0.1");url.searchParams.set("locale","zh-CN");url.hash=route;
  if(configure) await page.addInitScript(configure);
  await page.goto(url.href,{waitUntil:"networkidle"});
  return {browser,page};
}
test("keyboard_can_select_the_second_and_last_model_and_restore_focus",options,async()=>{
  const {browser,page}=await open("/model-health");
  try {
    const trigger=page.getByRole("button",{name:/筛选项：选择模型/});
    await trigger.click();
    const list=page.getByRole("listbox",{name:"选择模型",exact:true});
    const names=await list.getByRole("option").allTextContents();
    await page.keyboard.press("ArrowDown");await page.keyboard.press("Enter");
    await page.waitForFunction(name=>document.querySelector('button[aria-label^="筛选项：选择模型"]')?.title===name,names[1]);
    assert.equal(await trigger.getAttribute("title"),names[1]);
    assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
    await trigger.click();await page.keyboard.press("End");await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector('button[aria-label^="筛选项：选择模型"]')?.title==="Mistral Small");
    assert.equal(await trigger.getAttribute("title"),"Mistral Small");
    await trigger.click();await page.keyboard.press("Home");await page.keyboard.press("Enter");
    await page.waitForFunction(name=>document.querySelector('button[aria-label^="筛选项：选择模型"]')?.title===name,names[0]);
    assert.equal(await trigger.getAttribute("title"),names[0]);
  } finally {await browser.close();}
});
test("a_failed_range_query_displays_an_error_and_does_not_label_old_data_as_current",options,async()=>{
  const {browser,page}=await open("/");
  try {
    await page.getByRole("region",{name:"调用统计"}).waitFor();
    await page.evaluate(()=>{
      const original=window.fetch;
      window.fetch=(input,init)=>new URL(String(input),location.href).pathname.endsWith("/api/overview")
        ? Promise.resolve(Response.json({message:"audit range unavailable"},{status:503})) : original(input,init);
    });
    await page.getByRole("button",{name:"近1小时",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"audit range unavailable"}).waitFor();
    assert.equal(await page.getByRole("region",{name:"调用统计"}).count(),0);
  } finally {await browser.close();}
});
test("magpie_group_settings_can_reload_its_gateway_and_import_only_selected_new_models",options,async()=>{
  const {browser,page}=await open("/harness/cursor",()=>{
    let current=window.fetch;
    window.auditImports=[];window.auditMagpieQueries=[];
    Object.defineProperty(window,"fetch",{configurable:true,get:()=>current,set:demo=>{current=async(input,init)=>{
      const url=new URL(String(input),location.href);
      if(url.pathname==="/__byok-api__/api/models") {
        const models=await (await demo(input,init)).json();
        return Response.json(models.slice(0,1).map(model=>({...model,group_name:"Magpie test",base_url:"http://127.0.0.1:4521/v1"})));
      }
      if(/\/api\/models\/mock-claude-sonnet$/.test(url.pathname)) {
        const model=await (await demo(input,init)).json();
        return Response.json({...model,base_url:"http://127.0.0.1:4521/v1",api_key:"magpie-cursor-byok"});
      }
      if(url.pathname.endsWith("/api/magpie")) {
        window.auditMagpieQueries.push(url.searchParams.get("address"));
        return Response.json({address:"127.0.0.1:4521",version:"test",models:[
          {model_id:"provider/existing",display_name:"Existing",provider:"provider",routing_group:false,endpoint:"openai-chat",existing:true,reasoning_levels:[]},
          {model_id:"provider/new-a",display_name:"New A",provider:"provider",routing_group:false,endpoint:"openai-chat",existing:false,reasoning_levels:[]},
          {model_id:"provider/new-b",display_name:"New B",provider:"provider",routing_group:false,endpoint:"openai-chat",existing:false,reasoning_levels:[]},
        ]});
      }
      if(url.pathname.endsWith("/api/magpie/import")) {window.auditImports.push(JSON.parse(init.body));return Response.json({imported:1,skipped:0,total:1});}
      return demo(input,init);
    };}});
  });
  try {
    await page.getByRole("button",{name:"按供应商",exact:true}).click();
    await page.getByRole("button",{name:"分组设置",exact:true}).first().click();
    await page.getByRole("button",{name:"同步模型",exact:true}).click();
    const dialog=page.getByRole("alertdialog",{name:"从 magpie 导入模型",exact:true});
    await dialog.getByText("New A",{exact:true}).waitFor();
    assert.equal(await dialog.getByRole("textbox",{name:"网关地址"}).inputValue(),"127.0.0.1:4521");
    assert.equal(await dialog.getByRole("checkbox",{name:"Existing",exact:true}).isDisabled(),true);
    await dialog.getByText("New B",{exact:true}).click();
    await dialog.getByRole("button",{name:"导入选中的 1 个模型",exact:true}).click();
    await dialog.waitFor({state:"hidden"});
    assert.deepEqual(await page.evaluate(()=>window.auditImports),[{model_ids:["provider/new-a"],address:"127.0.0.1:4521"}]);
    assert.deepEqual(await page.evaluate(()=>window.auditMagpieQueries),["127.0.0.1:4521"]);
  } finally {await browser.close();}
});

test("magpie_ignores_old_queries_and_requires_retry_after_a_gateway_failure",options,async()=>{
  const {browser,page}=await open("/harness/cursor",()=>{
    let current=window.fetch;
    window.pendingMagpie={};
    Object.defineProperty(window,"fetch",{configurable:true,get:()=>current,set:demo=>{current=(input,init)=>{
      const url=new URL(String(input),location.href);
      if(url.pathname.endsWith("/api/magpie")) return new Promise(resolve=>{window.pendingMagpie[url.searchParams.get("address")]=resolve;});
      return demo(input,init);
    };}});
  });
  try {
    await page.getByRole("button",{name:"添加模型",exact:true}).click();
    await page.locator('[class*="chips"] button').filter({hasText:"Magpie"}).click();
    const dialog=page.getByRole("alertdialog",{name:"从 magpie 导入模型",exact:true});
    const address=dialog.getByRole("textbox",{name:"网关地址"});
    await address.fill("127.0.0.1:4001");await dialog.getByRole("button",{name:"查询",exact:true}).click();
    await address.fill("127.0.0.1:4002");await dialog.getByRole("button",{name:"查询",exact:true}).click();
    await page.evaluate(()=>window.pendingMagpie["127.0.0.1:4002"](Response.json({message:"gateway unavailable"},{status:503})));
    await page.getByText("gateway unavailable",{exact:false}).first().waitFor();
    await page.evaluate(()=>window.pendingMagpie["127.0.0.1:4001"](Response.json({address:"127.0.0.1:4001",version:"old",models:[{model_id:"old",display_name:"Old result",provider:"provider",routing_group:false,endpoint:"openai-chat",existing:false,reasoning_levels:[]}]})));
    assert.equal(await address.inputValue(),"127.0.0.1:4002");
    assert.equal(await dialog.getByText("Old result",{exact:true}).count(),0);
    assert.equal(await dialog.getByRole("button",{name:"导入选中的 0 个模型",exact:true}).isDisabled(),true);
    await dialog.getByRole("button",{name:"查询",exact:true}).click();
    await page.evaluate(()=>window.pendingMagpie["127.0.0.1:4002"](Response.json({address:"127.0.0.1:4002",version:"new",models:[{model_id:"new",display_name:"Fresh result",provider:"provider",routing_group:false,endpoint:"openai-chat",existing:false,reasoning_levels:[]}]})));
    await dialog.getByText("Fresh result",{exact:true}).waitFor();
    assert.equal(await dialog.getByRole("button",{name:"导入选中的 1 个模型",exact:true}).isEnabled(),true);
  } finally {await browser.close();}
});
