// Production-router responses exported from isolated temporary SQLite, with
// browser transfer/parse/mount measured separately from the debug Core reads.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import { noJobs, noCiRuns, idleJobsBudget, unmanagedUpdates, composerDraft } from "../../web/tools/browser-fixtures.mjs";

const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.T77_OUT);
const apiFixture = JSON.parse(await readFile(process.env.T77_API_OUTPUT, "utf8"));
await mkdir(output, { recursive: true });
const bytes = await readFile("target/t77/fixture.json");
assert.equal(createHash("sha256").update(bytes).digest("hex"), "b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d");
const original = JSON.parse(bytes).details.a;
const firstToolTurn = original.turns.find(turn => turn.items.some(item => item.type === "commandExecution"));
const firstTool = firstToolTurn.items.find(item => item.type === "commandExecution");
const long = { ...original, agent: { ...original.agent, name: "T77 Long", workSummary: {
  text: "Earlier tool source", source: "agent", kind: "result", turnId: firstToolTurn.id, itemId: firstTool.id,
} } };
const giant = { ...original, agent: { ...original.agent, id: "b", name: "T77 Giant", workSummary: undefined },
  turns: [{ id: "giant", status: "completed", items: original.turns.flatMap((turn, index) =>
    turn.items.map(item => ({ ...item, id: `giant-${index}-${item.id}` }))) }] };
const report = { task: "T-77", phase: "stream reading and native-page compatibility", coreMeasurements: apiFixture.measurements, checks: [], samples: [], errors: [], mutations: [], requests: [] };
let growthPhase = false, nativePhase = false;
const nativeText = "T77 native original with full copy text";
const nativeTurns = [
  {id:"native-old-one",status:"completed",startedAt:1,items:[{id:"native-one-user",type:"userMessage",content:[{type:"text",text:"First imported request"}]},{id:"native-one-reply",type:"agentMessage",text:"First native reply"}]},
  {id:"native-old-two",status:"completed",startedAt:2,items:[{id:"native-two-user",type:"userMessage",content:[{type:"text",text:"Second imported request"}]},{id:"native-two-reply",type:"agentMessage",text:nativeText}]},
];
const browser = await chromium.launch({ headless: true, executablePath: "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
await context.addInitScript(() => {
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }));
  window.EventSource = class {
    constructor() {
      this.readyState = 0; window.windowTestEvents = this;
      setTimeout(() => { this.readyState = 1; this.onopen?.({});
        this.onmessage?.({data:'{"type":"resumed"}',lastEventId:"fixture-0"}); },20);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  Object.defineProperty(navigator,"clipboard",{value:{writeText:async text=>{window.t77Copied=text;}}});
});
await context.route("**/*", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== "http://t77-window.test") {
    report.errors.push(`Blocked external request ${url.origin}`);
    return route.abort();
  }
  if (request.method() !== "GET") {
    report.mutations.push({ path: url.pathname, method: request.method() });
    return route.fulfill({ status: 403, json: {} });
  }
  let data;
  if (url.pathname === "/api/workspace") data = { agents: [long.agent, giant.agent], runtime: { connected: true }, projects: [], defaultCwd: "/fixture" };
  else if (nativePhase && url.pathname === "/api/agents/a/history")
    data = {turns:[...nativeTurns,original.turns[0]],hasMore:false,nextCursor:null};
  else if (nativePhase && url.pathname === "/api/agents/a/conversation/search" && url.searchParams.get("q") === "T77 native original") data = [];
  else if (growthPhase && apiFixture.growth[url.pathname + url.search]) {
    data = apiFixture.growth[url.pathname + url.search];
    data = {...data,agent:{...data.agent,rev:3}};
  }
  else if (apiFixture.replies[url.pathname + url.search]) {
    data = apiFixture.replies[url.pathname + url.search];
    if (data.agent?.id === "a") data = { ...data, agent: { ...data.agent, workSummary: long.agent.workSummary } };
  }
  else if (url.pathname === "/api/updates") data = unmanagedUpdates;
  else if (url.pathname === "/api/jobs") data = noJobs;
  else if (url.pathname === "/api/jobs/live") data = { agents: {} };
  else if (url.pathname === "/api/jobs/budget") data = idleJobsBudget;
  else if (url.pathname === "/api/ci") data = noCiRuns;
  else if (url.pathname === "/api/backlog") data = { observedAt: "2026-10-15T00:00:00Z", agents: {} };
  else if (url.pathname === "/api/pr-reviews/settings") data = { harness: "codex", model: "gpt-6.1-sol" };
  else if (/^\/api\/agents\/[ab]\/results\//.test(url.pathname)) data = { id: url.pathname.split("/").at(-1), spec: {
    root: "result", elements: {
      result: { type: "Result", props: { title: "Fixture result" }, children: ["text"] },
      text: { type: "Text", props: { text: "Synthetic result body" } },
    },
  } };
  if (data !== undefined) {
    if (nativePhase && data.agent?.id === "a") data = {...data, history:{hasMore:true,nextCursor:"native-page-1",loadedCount:data.turns.length}};
    const body = JSON.stringify(data);
    report.requests.push({ path: url.pathname + url.search, bytes: Buffer.byteLength(body) });
    return route.fulfill({ contentType: "application/json", body });
  }
  if (url.pathname.startsWith("/api/")) {
    report.errors.push(`Unexpected fixture GET ${url.pathname}`);
    return route.fulfill({ status: 404, json: {} });
  }
  const file = resolve(dist, url.pathname === "/" ? "index.html" : "." + url.pathname);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({ body: await readFile(file), contentType: {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2",
  }[extname(file)] });
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", error => report.errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const counts = () => page.evaluate(() => {
  const pane = document.querySelector(".conversation-scroll");
  return { nodes: document.getElementsByTagName("*").length, turns: document.querySelectorAll(".turn").length,
    blocks: document.querySelectorAll('[data-window^="blocks:"] > .conversation-window-row').length,
    toolRows: document.querySelectorAll(".tool-item").length, bottomGap: pane.scrollHeight - pane.clientHeight - pane.scrollTop };
});
async function latest() {
  const button = page.locator(".jump-latest");
  if (await button.count()) await button.click();
  else await page.locator(".conversation-scroll").evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  await settle();
}

const emit = event => page.evaluate(event => window.windowTestEvents.onmessage?.({data:JSON.stringify(event),lastEventId:`fixture-${event.rev || 3}`}),event);
const itemLocation = id => page.evaluate(id => {
  const element=[...document.querySelectorAll("[data-item-id]")].find(el=>el.dataset.itemId===id);
  if(!element) throw new Error(`Missing reading anchor ${id}`);
  return element.getBoundingClientRect().top;
},id);
async function switchAgent(id) {
  await page.locator(`.agent-row[data-agent-id="${id}"] .agent-select`).click();
  await page.getByRole("textbox",{name:id==="a"?"Message T77 Long":"Message T77 Giant"}).waitFor();
  await page.locator(".turn").first().waitFor();
  await settle();
}
async function checkGrowth() {
  await page.goto("http://t77-window.test/");
  await page.locator(".turn").first().waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await latest();
  const initial = apiFixture.replies["/api/agents/a"];
  const latestMessage = initial.turns.flatMap(t=>t.items.filter(i=>i.type==="agentMessage" && i.text).map(i=>({turnId:t.id,itemId:i.id}))).at(-1);
  await emit({type:"agent.delta",agentId:"a",rev:2,...latestMessage,op:"append",field:"text",text:"\n\nT77 streamed tail marker"});
  await page.waitForFunction(()=>document.querySelector(".conversation-scroll")?.textContent.includes("T77 streamed tail marker"));
  await settle();
  assert.ok((await counts()).bottomGap < 2,"Streaming follows the bottom while reading latest");
  report.checks.push("Visible streamed text keeps following the latest content");
  await page.locator(".conversation-scroll").evaluate(pane=>{pane.scrollTop=Math.max(0,pane.scrollTop-400);});
  await settle();
  const anchor = await page.locator(".conversation-scroll").evaluate(pane=>{
    const box=pane.getBoundingClientRect();
    const element=[...pane.querySelectorAll("[data-item-id]")].find(el=>{
      const r=el.getBoundingClientRect(); return r.height>8 && r.top>box.top && r.top<box.bottom-30;
    });
    if(!element) throw new Error("No visible reading anchor");
    return {id:element.dataset.itemId,top:element.getBoundingClientRect().top,scrollTop:pane.scrollTop,
      scrollHeight:pane.scrollHeight,paneTop:box.top,paneHeight:box.height};
  });
  growthPhase=true;
  await emit({type:"agent.changed",agentId:"a",rev:3});
  await page.getByRole("button",{name:"Continue to newer messages",exact:true}).waitFor();
  await settle();
  const afterTop=await itemLocation(anchor.id);
  report.readingAnchor={...anchor,afterTop,afterCounts:await counts(),
    afterPane:await page.locator(".conversation-scroll").evaluate(pane=>({scrollTop:pane.scrollTop,
      scrollHeight:pane.scrollHeight,paneTop:pane.getBoundingClientRect().top,paneHeight:pane.clientHeight}))};
  assert.ok(Math.abs(afterTop-anchor.top)<8,`Growth moved reading anchor ${afterTop-anchor.top}px`);
  assert.ok(report.requests.some(r=>r.path.includes("?turnId=")),"Reading refetch uses pinned IDs");
  report.checks.push({check:"150 new messages keep the prior reading window and anchor",...anchor,afterTop});
  const selectedText=await page.evaluate(id=>{
    const element=[...document.querySelectorAll("[data-item-id]")].find(el=>el.dataset.itemId===id);
    const range=document.createRange(); range.selectNodeContents(element);
    const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return selection.toString();
  },anchor.id);
  assert.ok(selectedText.length>0,"Selection covers rendered content");
  await page.locator(".conversation-scroll").evaluate(pane=>{pane.scrollTop+=700;});
  await settle();
  assert.equal(await page.evaluate(()=>window.getSelection().toString()),selectedText,"Scrolling preserves a visible native selection's DOM");
  await page.evaluate(()=>window.getSelection().removeAllRanges());
  report.checks.push("A visible native text selection survives scrolling until released");
  await latest();
  await page.locator('[data-item-id="t77-grown-149"]').waitFor();
  assert.ok((await counts()).nodes<6000);
  report.checks.push({check:"Back to latest loads new bounded tail",counts:await counts()});
}
async function checkNative() {
  growthPhase=false; nativePhase=true;
  await page.evaluate(()=>window.getSelection().removeAllRanges());
  await switchAgent("b"); await switchAgent("a");
  const nativeRequestStart=report.requests.length;
  await page.getByRole("button",{name:"Load earlier turns",exact:true}).click();
  await page.getByText("All earlier native history pages are loaded.",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Search conversation",exact:true}).click();
  await page.getByRole("searchbox",{name:"Search saved messages",exact:true}).fill("T77 native original");
  await page.locator(".conversation-search-result").first().click();
  await page.waitForFunction(()=>document.activeElement?.dataset.itemId==="native-two-reply");
  const nativeOrder=await page.locator(".turn").evaluateAll(turns=>turns.map(t=>t.dataset.turnId).filter(id=>id.startsWith("native-old-")));
  assert.deepEqual(nativeOrder,["native-old-one","native-old-two"]);
  assert.equal(await page.locator('[data-turn-id="native-old-two"]').count(),1);
  await page.evaluate(()=>{window.t77Copied=null;});
  await page.locator('[data-turn-id="native-old-two"]').getByRole("button",{name:"Copy turn",exact:true}).click();
  await page.waitForFunction(()=>typeof window.t77Copied==="string");
  assert.ok((await page.evaluate(()=>window.t77Copied)).includes(nativeText));
  assert.ok(!report.requests.slice(nativeRequestStart).some(r=>/native-(old|two|one)/.test(r.path)),"Native source/copy did not request saved-only originals");
  await page.getByRole("button",{name:"Load earlier messages",exact:true}).click();
  await page.getByRole("button",{name:"Continue to newer messages",exact:true}).waitFor();
  await settle();
  assert.ok(!report.requests.some(r=>r.path.includes("before=") && decodeURIComponent(r.path).includes("native-old")),"Saved-body page cursor excludes native-only IDs");
  await latest();
  assert.ok((await counts()).bottomGap<2);
  await switchAgent("b"); await switchAgent("a");
  assert.ok(await page.getByRole("button",{name:"Load earlier turns",exact:true}).count(),"Switching releases native pages");
  assert.equal(await page.locator('[data-turn-id="native-old-two"]').count(),0);
  report.checks.push("Native old page source, copy, ordered merge, saved-body paging, latest and switch/reset remain reachable without saved-only native requests");
 }
report.failures=[];
try {
  for (const [name,check] of [["growth",checkGrowth],["native",checkNative]]) {
    try { await check(); }
    catch(error) {
      report.failures.push({scenario:name,error:String(error.stack||error),counts:await counts().catch(()=>null)});
      await page.screenshot({path:resolve(output,`${name}-failure.png`)});
    }
  }
  assert.deepEqual(report.errors,[]); assert.deepEqual(report.mutations,[]);
  assert.deepEqual(report.failures,[],"Reading and native scenarios must both pass");
  report.passed=true;
} finally {
  await browser.close(); await writeFile(resolve(output,"report.json"),JSON.stringify(report,null,2)+"\n");
}
