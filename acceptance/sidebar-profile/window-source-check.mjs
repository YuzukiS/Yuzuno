// R1 regression: source controls must load and mount their destination before
// focusing it. Synthetic data only; all writes and external requests rejected.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import { noJobs, noCiRuns, idleJobsBudget, unmanagedUpdates, composerDraft } from "../../web/tools/browser-fixtures.mjs";

const dist = resolve(process.env.YUZUNO_UI_DIST), output = resolve(process.env.T77_OUT);
await mkdir(output, { recursive: true });
const agents = ["a", "b"].map(id => ({
  id, name: `Source ${id}`, cwd: "/fixture", model: "test-model", color: "green",
  harness: "codex", status: "waiting", createdAt: "2026-10-16", updatedAt: "2026-10-16",
  unreadCount: 1, pendingCount: 1, lastSeq: 12, reviewedSeq: 5, rev: 1,
}));
const copyCases = process.env.T77_MAILBOX_OUTPUT
  ? JSON.parse(await readFile(process.env.T77_MAILBOX_OUTPUT,"utf8")) : [];
for (const sample of copyCases) {
  sample.page.agent = {...sample.page.agent,id:`copy-${sample.mode}`,name:`Copy ${sample.mode}`};
  agents.push(sample.page.agent);
}
const edits = (prefix, count) => ({ id: `${prefix}-tools`, status: "completed", items:
  Array.from({length:count}, (_,i) => ({id:`${prefix}-edit-${i}`, type:"fileChange", status:"completed",
    changes:[{path:`src/${prefix}-${i}.ts`,diff:`+proposed ${prefix} ${i}`}]})) });
const savedTools = edits("saved",96), nativeTools = edits("native",500);
const question = {id:"old-question",type:"agentMessage",delivery:"async",questions:[{title:"Choose a color",options:["Green","Yellow"]}]};
const questionTurn = {id:"question-turn",status:"completed",items:[question]};
const tail = {id:"tail",status:"completed",items:[{id:"tail-reply",type:"agentMessage",text:"Waiting for approval."}]};
const pending = (id,turnId,itemId) => [{id:`approval-${id}`,agentId:id,method:"item/fileChange/requestApproval",
  createdAt:"2026-10-16",params:{turnId,itemId}}];
const savedPending = pending("a",savedTools.id,"saved-edit-48");
const nativePending = pending("b",nativeTools.id,"native-edit-250");
const savedTurns = [questionTurn,savedTools,tail];
function savedDetail(turn) {
  return {agent:agents[0],turns:[turn],pending:savedPending,artifacts:[],messageReceipts:[],conversation:{
    index:savedTurns.map((t,i)=>({...t,items:[],number:i+1,itemCount:t.items.length,_yuzunoIndex:true})),
    questions:[questionTurn],nativeClientIds:[],totalItems:98,
    start:JSON.stringify([turn.id,turn.items[0].id]),end:JSON.stringify([turn.id,turn.items.at(-1).id]),
    hasBefore:turn !== questionTurn,hasAfter:turn !== tail,
  }};
}
const report = {task:"T-77",phase:"R1 approval and question source regression",checks:[],errors:[],requests:[],mutations:[]};
const browser = await chromium.launch({headless:true,executablePath:"/usr/sbin/chromium"});
const context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:"reduce"});
await context.addInitScript(() => {
  localStorage.setItem("yuzuno.selected",JSON.stringify("a"));
  window.EventSource = class {
    constructor() { this.readyState=0; setTimeout(()=>{this.readyState=1;this.onopen?.({});
      this.onmessage?.({data:'{"type":"resumed"}',lastEventId:"fixture-0"});},20); }
    addEventListener() {} close() { this.readyState=2; }
  };
  Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.t77Copied=text;}}});
});
await context.route("**/*", async route => {
  const request=route.request(),url=new URL(request.url());
  if(url.origin !== "http://t77-source.test") {report.errors.push(`External request ${url.origin}`);return route.abort();}
  if(request.method() !== "GET") {report.mutations.push({path:url.pathname,method:request.method()});return route.fulfill({status:403,json:{}});}
  let data;
  if(url.pathname === "/api/workspace") data={agents,runtime:{connected:true},projects:[],defaultCwd:"/fixture"};
  else if(url.pathname === "/api/agents/a") {
    const turnId=url.searchParams.get("turnId"), itemId=url.searchParams.get("itemId");
    const turn=turnId ? savedTurns.find(t=>t.id===turnId && t.items.some(i=>i.id===itemId)) : tail;
    assert.ok(turn,`Unexpected source ${url.search}`);
    data=savedDetail(turn);
  }
  else if(url.pathname === "/api/agents/b") data={agent:agents[1],turns:[nativeTools,tail],pending:nativePending,artifacts:[],messageReceipts:[]};
  else if(copyCases.some(sample=>url.pathname === `/api/agents/copy-${sample.mode}`))
    data=copyCases.find(sample=>url.pathname === `/api/agents/copy-${sample.mode}`).page;
  else if(copyCases.some(sample=>url.pathname === `/api/agents/copy-${sample.mode}/turns/t/original`))
    data=copyCases.find(sample=>url.pathname === `/api/agents/copy-${sample.mode}/turns/t/original`).original;
  else if(url.pathname === "/api/updates") data=unmanagedUpdates;
  else if(url.pathname === "/api/jobs") data=noJobs;
  else if(url.pathname === "/api/jobs/live") data={agents:{}};
  else if(url.pathname === "/api/jobs/budget") data=idleJobsBudget;
  else if(url.pathname === "/api/ci") data=noCiRuns;
  else if(url.pathname === "/api/backlog") data={observedAt:"2026-10-16T00:00:00Z",agents:{}};
  else if(url.pathname === "/api/pr-reviews/settings") data={harness:"codex",model:"gpt-6.1-sol"};
  if(data !== undefined) {report.requests.push(url.pathname+url.search);return route.fulfill({json:data});}
  if(url.pathname.startsWith("/api/")) {report.errors.push(`Unexpected GET ${url.pathname}`);return route.fulfill({status:404,json:{}});}
  const file=resolve(dist,url.pathname === "/" ? "index.html" : "."+url.pathname);
  assert.ok(file.startsWith(dist+"/"));
  return route.fulfill({body:await readFile(file),contentType:{".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".woff2":"font/woff2"}[extname(file)]});
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror",error=>report.errors.push(error.message));
async function proposed(id) {
  await page.getByRole("button",{name:"View proposed changes",exact:true}).click();
  await page.waitForFunction(id=>{
    const item=document.getElementById(`item-${id}`);
    return item?.open && item.closest(".tool-activity")?.open && document.activeElement===item;
  },id);
  const target=page.locator(`[id="item-${id}"]`);
  assert.match(await target.locator("pre").textContent(),/proposed/);
  const visible=await target.evaluate(item=>{const r=item.getBoundingClientRect(),p=item.closest(".conversation-scroll").getBoundingClientRect();return r.bottom>p.top && r.top<p.bottom;});
  assert.ok(visible,"Focused diff is visible in the conversation");
  assert.ok(await page.locator(".tool-item").count()<80,"Source navigation keeps tool rows bounded");
}
try {
  await page.goto("http://t77-source.test/");
  const draft=page.getByRole("textbox",{name:"Message Source a",exact:true});
  await draft.fill("Draft survives source navigation");
  assert.equal(await page.locator('[id="turn-saved-tools"]').count(),0,"Approval turn is outside initial data window");
  await proposed("saved-edit-48");
  assert.ok(report.requests.includes("/api/agents/a?turnId=saved-tools&itemId=saved-edit-48"));
  assert.equal(await composerDraft(draft),"Draft survives source navigation");
  assert.equal(await page.locator('[id="request-approval-a"]').count(),1);
  report.checks.push("Unloaded approval turn loads by turn/item IDs, mounts, opens diff and focuses; draft and pending request retained");
  assert.equal(await page.locator('[id="turn-question-turn"]').count(),0);
  await page.locator(".question-dock-open").click();
  await page.getByRole("button",{name:"Original question",exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.dataset.itemId === "old-question");
  assert.ok(report.requests.includes("/api/agents/a?turnId=question-turn&itemId=old-question"));
  assert.equal(await composerDraft(draft),"Draft survives source navigation");
  assert.equal(await page.locator(".question-dock-open").count(),1);
  report.checks.push("Question dock loads and focuses an original outside the current body window without answering or dismissing it");
  await page.locator('.agent-row[data-agent-id="b"] .agent-select').click();
  await page.getByRole("textbox",{name:"Message Source b",exact:true}).waitFor();
  await page.getByRole("button",{name:"View proposed changes",exact:true}).waitFor();
  assert.equal(await page.locator('[id="item-native-edit-250"]').count(),0,"Pending target in 500-tool group is initially unmounted");
  const requestsBefore=report.requests.length;
  await proposed("native-edit-250");
  assert.ok(!report.requests.slice(requestsBefore).some(path=>path.startsWith("/api/agents/b?")),"Loaded original requires no history fetch");
  assert.equal(await page.locator('[id="request-approval-b"]').count(),1);
  report.checks.push("Pending approval targets an unmounted middle row in a loaded 500-tool group without mounting the full group");
  for (const sample of copyCases) {
    await page.locator(`.agent-row[data-agent-id="copy-${sample.mode}"] .agent-select`).click();
    await page.getByRole("textbox",{name:`Message Copy ${sample.mode}`,exact:true}).waitFor();
    await page.evaluate(()=>{window.t77Copied=null;});
    assert.equal(await page.locator('[data-item-id="mail"]').count(),0,"Mailbox input is outside the loaded page");
    await page.getByRole("button",{name:"Copy turn",exact:true}).click();
    await page.waitForFunction(()=>typeof window.t77Copied === "string");
    const copied=await page.evaluate(()=>window.t77Copied);
    assert.ok(copied.includes("Workspace mailbox\nMailbox delivery"));
    assert.ok(!copied.includes("You\nMailbox delivery"));
    assert.ok(copied.includes("You\nHuman follow-up"));
    if(sample.mode === "steer") assert.ok(copied.includes("You\nHuman request"));
    assert.ok(copied.includes("saved message 399"),"Full turn includes its tail");
    assert.ok(report.requests.includes(`/api/agents/copy-${sample.mode}/turns/t/original`));
    report.checks.push(`Production original response preserves ${sample.mode} mailbox attribution and human authors in full-turn clipboard text`);
  }
  assert.deepEqual(report.mutations,[]);
  assert.deepEqual(report.errors,[]);
  report.passed=true;
} catch(error) {
  report.failure=String(error.stack||error);
  report.focus=await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,1000)).catch(()=>null);
  await page.screenshot({path:resolve(output,"failure.png")});
  throw error;
} finally {
  await browser.close();
  await writeFile(resolve(output,"report.json"),JSON.stringify(report,null,2)+"\n");
}
