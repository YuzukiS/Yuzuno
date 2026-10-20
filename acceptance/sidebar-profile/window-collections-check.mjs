// Structural checkpoint: real DOM windows, using the same private fixture.
// Full detail responses are deliberately retained here to isolate mounting.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import { noJobs, noCiRuns, idleJobsBudget, unmanagedUpdates, composerDraft } from "../../web/tools/browser-fixtures.mjs";

const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.T77_OUT);
await mkdir(output, { recursive: true });
const bytes = await readFile("target/t77/fixture.json");
assert.equal(createHash("sha256").update(bytes).digest("hex"), "b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d");
const original = JSON.parse(bytes).details.a;
const activities = Array.from({length:4000},(_,index)=>({
  id:`activity-${index}`,type:"subAgentActivity",kind:index < 2000 ? "started" : "interacted",
  agentThreadId:`child-${index < 2000 ? index : 0}`,agentPath:`/root/child-${index < 2000 ? index : 0}`,
}));
const plan = Array.from({length:2000},(_,index)=>({step:`Recorded plan step ${index + 1}`,status:index === 1000 ? "inProgress" : "pending"}));
const long = {...original, history:undefined, agent:{...original.agent,name:"T77 Long",rev:1,workSummary:{
  text:"Recorded plan",source:"agent",kind:"result",turnId:"collections",itemId:"yuzuno-plan-collections",
}},turns:[{id:"collections",status:"completed",_yuzunoPlan:plan,items:activities}]};
const giant = {...long,agent:{...long.agent,id:"b",name:"T77 Giant"}};
const report = { task: "T-77", phase: "plan and subagent collections; synthetic full native-compatible body", checks: [], samples: [], errors: [], mutations: [], requests: [] };
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
  else if (url.pathname === "/api/agents/a") data = long;
  else if (url.pathname === "/api/agents/b") data = giant;
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
    const body = JSON.stringify(data);
    report.requests.push({ path: url.pathname, bytes: Buffer.byteLength(body) });
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
async function sample(label) {
  await latest();
  const before = await counts();
  assert.ok(before.nodes < 6000, `Bounded visible nodes: ${JSON.stringify(before)}`);
  assert.ok(before.blocks < 80, `Bounded visible message blocks: ${JSON.stringify(before)}`);
  const timing = [];
  for (const name of ["Hide agent sidebar", "Show agent sidebar", "Toggle context panel", "Toggle context panel"]) {
    const at = performance.now();
    await page.getByRole("button", { name, exact: true }).click();
    await settle();
    timing.push({ action: name, driverAndTwoRafMs: performance.now() - at });
  }
  const after = await counts();
  assert.ok(after.nodes < 6000);
  report.samples.push({ label, before, after, timing });
}
try {
  await page.goto("http://t77-window.test/");
  await page.locator(".turn").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await latest();
  assert.equal(await page.locator("[data-plan-status]").count(),0,"closed plan has no step DOM");
  assert.ok(await page.locator(".subagent").count() < 80,"2000 child rows have a viewport window");
  assert.ok(await page.locator(".subagent-anchor").count() < 160,"4000 activities do not create 4000 hidden anchors");
  await page.locator(".inspector-work-source").click();
  await page.waitForFunction(() => document.activeElement?.id === "item-yuzuno-plan-collections");
  const planSummary = page.locator("summary").filter({hasText:"Agent plan"});
  const steps = await page.locator("[data-plan-status]").count();
  assert.ok(steps > 0 && steps < 100,`only visible plan rows: ${steps}`);
  await planSummary.click();
  await page.waitForFunction(() => !document.querySelector("[data-plan-status]"));
  await planSummary.click();
  await page.waitForFunction(() => !!document.querySelector("[data-plan-status]"));
  assert.ok(await page.locator("[data-plan-status]").count() < 100);
  report.checks.push("2000-step plan loads its source, mounts a visible window and releases all steps on collapse");
  long.agent.rev = 2;
  long.agent.workSummary = {text:"Repeated child source",source:"agent",kind:"result",turnId:"collections",itemId:"activity-3999"};
  await page.evaluate(() => window.windowTestEvents.onmessage({data:JSON.stringify({type:"agent.changed",agentId:"a",rev:2}),lastEventId:"fixture-2"}));
  await page.locator(".inspector-work-source").filter({hasText:"Repeated child source"}).waitFor();
  await page.locator(".inspector-work-source").click();
  await page.waitForFunction(() => document.activeElement?.id === "item-activity-3999");
  await settle();
  assert.ok(await page.locator(".subagent").count() < 80);
  assert.ok(await page.locator(".subagent-anchor").count() < 160);
  assert.ok((await counts()).nodes < 3000);
  report.checks.push("An arbitrary repeated child activity is mounted before source focus without retaining every anchor");
  report.samples.push(await counts());
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.mutations,[]);
  report.passed=true;
} catch (error) {
  report.failure=String(error.stack || error);
  report.failureCounts=await counts().catch(()=>null);
  await page.screenshot({path:resolve(output,"failure.png")});
  throw error;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
