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
const report = { task: "T-77", phase: "bounded data and DOM windows", coreMeasurements: apiFixture.measurements, checks: [], samples: [], errors: [], mutations: [], requests: [] };
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
  await page.waitForTimeout(500);
  assert.deepEqual(report.errors, [], "Fixture preflight");
  await sample("157 turns / 6197 items");
  assert.ok((await counts()).turns < 40, "Historical turn DOM is removed");
  const draft = page.getByRole("textbox", { name: "Message T77 Long" });
  await draft.fill("T77 draft stays local");
  await page.locator(".inspector-work-source").click();
  await page.waitForFunction(id => document.activeElement?.id === `item-${id}`, firstTool.id);
  assert.ok(await page.locator(`[id="item-${firstTool.id}"]`).evaluate(el => el.closest(".tool-activity").open));
  assert.equal(await composerDraft(draft), "T77 draft stays local");
  assert.ok(await page.getByRole("button", {name:"Continue to newer messages",exact:true}).count(), "Source jump holds an earlier data window");
  assert.ok(report.requests.some(r => r.path.includes("itemId=")), "Direct source jump loads its destination");
  report.checks.push("Unloaded turn and nested tool source loaded and mounted before focus; draft retained");
  await page.locator(`[id="item-${firstTool.id}"] > summary`).click();
  await page.waitForFunction(id => document.getElementById(`item-${id}`)?.open, firstTool.id);
  const groupIndex = await page.locator(`[id="item-${firstTool.id}"]`).evaluate(el =>
    [...el.closest(".turn").querySelectorAll(".tool-activity")].indexOf(el.closest(".tool-activity")));
  const sourceGroup = page.locator(`[data-turn-id="${firstToolTurn.id}"] .tool-activity`).nth(groupIndex);
  await sourceGroup.locator(":scope > summary").click();
  await page.waitForFunction(id => !document.getElementById(`item-${id}`), firstTool.id);
  await sourceGroup.locator(":scope > summary").click();
  await page.waitForFunction(id => document.getElementById(`item-${id}`)?.open, firstTool.id);
  report.checks.push("Closed tool group removes its rows; nested disclosure choice survives remount");
  await page.locator(`[data-turn-id="${firstToolTurn.id}"]`).getByRole("button",{name:"Copy turn",exact:true}).click();
  await page.waitForFunction(() => typeof window.t77Copied === "string");
  const originalTurn = apiFixture.replies[`/api/agents/a/turns/${firstToolTurn.id}/original`];
  const copied = await page.evaluate(()=>window.t77Copied);
  const sourceUrl = `/api/agents/a?${new URLSearchParams({turnId:firstToolTurn.id,itemId:firstTool.id})}`;
  const loadedIds = new Set(apiFixture.replies[sourceUrl].turns.flatMap(t=>t.items.map(i=>i.id)));
  const missingText = originalTurn.items.filter(i=>!loadedIds.has(i.id))
    .map(i=>i._yuzunoInputText || i.text || i.content?.filter(p=>p.type==="text").map(p=>p.text).join("\n"))
    .find(text=>text?.trim());
  assert.ok(missingText,"Copy fixture must contain text outside the loaded page");
  assert.ok(copied.includes(missingText),"Copy includes the original text outside this body's page");
  report.checks.push({check:"Copy turn loads full original",items:apiFixture.copiedItems,chars:copied.length});
  await latest();
  await page.getByRole("button",{name:"Search conversation",exact:true}).click();
  await page.getByRole("searchbox",{name:"Search saved messages",exact:true}).fill(apiFixture.searchQuery);
  await page.locator(".conversation-search-result").first().waitFor();
  const searchUrl = `/api/agents/a/conversation/search?${new URLSearchParams({q:apiFixture.searchQuery})}`;
  const searchHit = apiFixture.replies[searchUrl][0];
  await page.locator(".conversation-search-result").first().click();
  await page.waitForFunction(id=>document.activeElement?.getAttribute("data-item-id") === id || document.activeElement?.id === `item-${id}`,searchHit.itemId);
  report.checks.push("Saved search loads and focuses a message outside the initial data window");
  await latest();
  const initial = apiFixture.replies["/api/agents/a"];
  const boundary = initial.turns.flatMap(t=>t.items.filter(i=>i.type === "reasoning"
    ? i.summary?.some(s=>s.trim()) : i.type !== "agentMessage" || i.text?.trim() || i.questions?.length)
    .map(i=>({turnId:t.id,itemId:i.id})))[0];
  const {turnId:anchorTurn,itemId:anchorItem} = boundary;
  await page.getByRole("button", {name:"Load earlier messages",exact:true}).scrollIntoViewIfNeeded();
  await settle();
  const anchorTop = () => page.evaluate(({anchorTurn,anchorItem}) => {
    const turn=document.getElementById(`turn-${anchorTurn}`);
    const elements=[...turn?.querySelectorAll("[data-item-id], [id], [data-window-key]") || []];
    const element=elements.find(el=>el.dataset.itemId===anchorItem || el.id===`item-${anchorItem}`)
      || elements.find(el=>el.dataset.windowKey===anchorItem);
    if(!element) throw new Error(`Missing rendered page anchor ${anchorItem}`);
    return element.getBoundingClientRect().top;
  },{anchorTurn,anchorItem});
  const beforeTop = await anchorTop();
  await page.getByRole("button", {name:"Load earlier messages",exact:true}).click();
  await page.waitForFunction(() => !document.querySelector(".conversation-history-window button:disabled"));
  await settle();
  assert.ok(report.requests.some(r=>r.path.includes("?before=")), "Earlier data page was requested");
  const afterTop = await anchorTop();
  report.checks.push({check:"page overlap reading anchor",anchorTurn,anchorItem,beforeTop,afterTop});
  assert.ok(Math.abs(afterTop-beforeTop)<8, `Page anchor moved ${afterTop-beforeTop}px`);
  await page.getByRole("button",{name:"Continue to newer messages",exact:true}).click();
  await page.waitForFunction(() => !document.querySelector(".conversation-history-window button:disabled"));
  await latest();
  await page.locator('.agent-row[data-agent-id="b"] .agent-select').click();
  await page.getByRole("textbox", { name: "Message T77 Giant" }).waitFor();
  await page.waitForTimeout(300);
  await sample("1 giant turn / 6198 items including one 900KB message");
  assert.equal((await counts()).turns, 1);
  report.checks.push("One oversized turn does not bypass message-block windowing");
  await page.getByRole("button",{name:"View full original",exact:true}).last().click();
  await page.waitForFunction(() => document.querySelector(".history-original-dialog > pre")?.textContent.length > 800000);
  assert.equal(await page.locator(".history-original-dialog pre").count(),1);
  assert.ok((await counts()).nodes < 6000,"Full plain original does not create huge Markdown DOM");
  await page.getByRole("button",{name:"Close original",exact:true}).click();
  assert.equal(await page.locator(".history-original-dialog").count(),0);
  report.checks.push("Huge single-item preview opens complete plain original and releases it on close");
  for(const id of ["a","b"]) assert.ok(report.requests.find(r=>r.path===`/api/agents/${id}`).bytes < 1024*1024,"Initial body transfer is bounded");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mutations, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  report.failureCounts = await counts().catch(() => null);
  report.navigationFailure = await page.evaluate(({turnId,itemId}) => {
    const item=document.getElementById(`item-${itemId}`), turn=document.getElementById(`turn-${turnId}`);
    return {active:document.activeElement?.outerHTML.slice(0,600),exists:!!item,turnExists:!!turn,
      item:item?.outerHTML.slice(0,600),parent:item?.closest(".tool-activity")?.outerHTML.slice(0,300),rect:item?.getBoundingClientRect().toJSON()};
  }, {turnId:firstToolTurn.id,itemId:firstTool.id}).catch(()=>null);
  await page.screenshot({ path: resolve(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
