// YN-114: following the end of a conversation is the reader's to start and
// stop. In a real browser layout, with a reply streaming:
//  A1. Six wheel steps of 40px up, each within 72px of the end, leave the end
//      (main 5dc0d0c0: the next output took the reader back down every step).
//  A2. One slow 300px stroke up (a trackpad's speed) leaves the end too.
//  B.  A reader just short of the end of the running Turn, not following:
//      a commentary arrives, the open tool group above it folds and the
//      browser clamps the pane to the end. That clamp does not start
//      following, so the output after it does not carry the text being read
//      off the screen (main: -368px in 2.5s).
//  C.  Controls: at the end, output keeps the end in view; a reader who
//      scrolled up and wheels back down to the end follows again.
// Production bundle, synthetic API and event stream; no Core, no writes, no
// model turns. Desktop width: headless Chromium does not scroll this pane by
// touch (YN-114 c3-c5), so a phone's finger is a known limit of this check.
//   YUZUNO_UI_DIST=<isolated build> [FOLLOW_OUTPUT=dir] node tools/follow-intent-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.FOLLOW_OUTPUT || "../acceptance/follow-intent");
await mkdir(output, { recursive: true });

// Twenty finished Turns and a running one: its first commentary, then eight
// tool calls after it, open as the latest Turn's tools after its last message are.
const sentence = (n, p) => `Turn ${n}, part ${p + 1}: the check notes are written out at length so the reply wraps over several lines and every reply has a different height.`;
const cmd = (id, k, status = "completed") => ({ id, type: "commandExecution", command: `npm test -- --grep case-${k}`, cwd: "/fixture", status,
  exitCode: status === "completed" ? 0 : null, aggregatedOutput: Array.from({ length: 3 + (k % 4) }, (_, l) => `case-${k} line ${l}: ok`).join("\n") });
function fixture() {
  const turns = Array.from({ length: 20 }, (_, i) => ({ id: `t${i + 1}`, status: "completed", items: [
    { id: `t${i + 1}-u`, type: "userMessage", content: [{ type: "text", text: `Question ${i + 1}: please look at this part.` }] },
    { id: `t${i + 1}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: 1 + ((i * 7) % 4) }, (_, p) => sentence(i + 1, p)).join("\n\n") },
  ] }));
  turns.push({ id: "t21", status: "inProgress", items: [
    { id: "t21-u", type: "userMessage", content: [{ type: "text", text: "Run the checks and tell me what failed." }] },
    { id: "t21-c1", type: "agentMessage", phase: "commentary", text: [0, 1, 2].map((p) => sentence(21, p)).join("\n\n") },
    ...Array.from({ length: 8 }, (_, k) => cmd(`t21-x${k + 1}`, k + 1)),
  ] });
  const agent = { id: "a", name: "Mori", status: "working", connectionState: "connected", harness: "codex", cwd: "/fixture", model: "fixture",
    settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
  return { rev: 10, extra: 0, agent, turns };
}
const detail = (state) => ({ agent: { ...state.agent, rev: state.rev }, pending: [], messageReceipts: [], artifacts: [], turns: structuredClone(state.turns) });

const report = { checks: [], failed: [], errors: [], console: [], unexpected: [], writes: [], runs: [] };
const check = (ok, name, extra = {}) => {
  report.checks.push({ name, ok, ...extra });
  if (!ok) report.failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(extra)}`);
  return ok;
};
const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const usage = { revision: 1, status: "unknown", account: null, accountId: null, source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };

// The app's own scroll writes, told apart from the reader's scroll.
const PROBE = `
window.drawn = (look) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = look; c.port2.postMessage(null); });
window.__probe = (() => {
  const pane = document.querySelector(".main-panel .conversation-scroll");
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const writes = [];
  const note = (fn) => { const before = d.get.call(pane); const r = fn(); const delta = d.get.call(pane) - before; if (Math.abs(delta) > 0.01) writes.push({ t: performance.now(), delta }); return r; };
  Object.defineProperty(pane, "scrollTop", { configurable: true, get() { return d.get.call(this); }, set(v) { note(() => d.set.call(this, v)); } });
  for (const name of ["scrollTo", "scrollBy"]) { const orig = pane[name]; pane[name] = function (...a) { return note(() => orig.apply(this, a)); }; }
  const gap = () => pane.scrollHeight - d.get.call(pane) - pane.clientHeight;
  const top = (sel) => { const el = pane.querySelector(sel); return el ? el.getBoundingClientRect().top - pane.getBoundingClientRect().top : null; };
  return { pane, writes, gap, top, toEnd: (since) => writes.filter((w) => w.t >= since && w.delta > 0).length };
})();`;

async function open(state, tag) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.addInitScript(() => {
    window.__ess = [];
    window.EventSource = class {
      constructor() {
        this.readyState = 0; window.__ess.push(this);
        setTimeout(() => { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: '{"type":"resumed"}', lastEventId: "fx-0" }); }, 20);
      }
      addEventListener() {}
      close() { this.readyState = 2; }
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected.ws", JSON.stringify("a"));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "localhost") return route.abort();
    if (request.method() !== "GET") { report.writes.push(`${tag} ${request.method()} ${url.pathname}`); return route.fulfill({ json: { ok: true } }); }
    const json = {
      "/api/agents/a": detail(state),
      "/api/workspace": { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [{ ...state.agent, rev: state.rev }], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns, "/api/ci/live": noLiveCi, "/api/home": emptyHome, "/api/agents/a/conversation/inputs": noConversationInputs,
      "/api/reviews": noReviews, "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      "/api/backlog": { observedAt: "2026-11-14T00:00:00Z", agents: {} }, "/api/pr-reviews/settings": { harness: "codex", model: "fixture" },
      "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
      "/api/waits/live": { agents: {} },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) { report.unexpected.push(`${tag} ${url.pathname}`); return route.fulfill({ status: 404, json: { error: "not in the fixture" } }); }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(dist + "/")) return route.fulfill({ status: 404, body: "" });
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (error) => report.errors.push(`${tag} ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") report.console.push(`${tag} ${message.text().slice(0, 240)}`); });
  await page.goto("http://localhost/");
  await page.locator(".agent-row .agent-select").first().waitFor();
  await page.waitForTimeout(500);
  // Opened on Home: choose the Agent in the rail.
  if (!(await page.locator('.main-panel [data-item-id="t21-c1"]').count())) await page.locator(".agent-row .agent-select").first().click();
  await page.locator('.main-panel [data-item-id="t21-c1"]').waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ content: PROBE });
  const cdp = await context.newCDPSession(page);
  await settle(page);
  return { context, page, cdp };
}
const pane = (page) => page.locator(".main-panel .conversation-scroll");
async function settle(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector(".main-panel .conversation-scroll");
    const value = `${Math.round(el.scrollTop)}/${el.scrollHeight}/${el.clientHeight}`;
    window.__stable = { value, n: window.__stable?.value === value ? window.__stable.n + 1 : 0 };
    return window.__stable.n >= 6;
  }, null, { timeout: 6000, polling: "raf" }).catch(() => {});
}
/** A wheel scroll of the reader's: dy < 0 goes up, over `ms`. */
async function wheel(page, cdp, dy, ms = 0) {
  const box = await pane(page).boundingBox();
  const speed = ms ? Math.max(100, Math.round(Math.abs(dy) * 1000 / ms)) : 1600;
  await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height * 0.5),
    yDistance: -dy, speed, gestureSourceType: "mouse", preventFling: true });
}
async function emit(page, state, event) {
  state.rev += 1;
  Object.assign(event, { agentId: "a", rev: state.rev });
  await page.evaluate(([event, id]) => { for (const es of window.__ess) if (es.readyState === 1) es.onmessage?.({ data: JSON.stringify(event), lastEventId: id }); }, [event, `fx-${state.rev}`]);
}
const live = (state) => state.turns.at(-1);
async function addItem(page, state, item) { live(state).items.push(item); await emit(page, state, { type: "agent.item", turnId: "t21", item: structuredClone(item) }); }
async function append(page, state, id, text) {
  live(state).items.find((i) => i.id === id).text += text;
  await emit(page, state, { type: "agent.delta", turnId: "t21", itemId: id, op: "append", field: "text", text });
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** A commentary that keeps streaming, about a line every 300ms. */
function stream(page, state, count = 40) {
  const id = `t21-c${++state.extra + 1}`;
  let go = true;
  const done = (async () => {
    await addItem(page, state, { id, type: "agentMessage", phase: "commentary", text: "Streaming while the reader reads." });
    for (let k = 0; k < count && go; k++) { await sleep(100); await append(page, state, id, ` words ${k} keep arriving so the reply grows by a line now and then.`); }
  })();
  return { stop: () => { go = false; return done; }, done };
}
const toEnd = (page) => pane(page).evaluate((el) => { el.scrollTop = el.scrollHeight; });

async function run(name, body) {
  const state = fixture();
  const entry = { name };
  report.runs.push(entry);
  let opened;
  try {
    opened = await open(state, name);
    await body({ ...opened, state, entry });
  } catch (error) {
    entry.failure = String(error?.stack || error).slice(0, 1500);
    check(false, `${name}: the run finished`, { error: String(error?.message || error).slice(0, 300) });
  } finally {
    if (opened) await opened.page.screenshot({ path: resolve(output, `${name}.png`) }).catch(() => {});
    await opened?.context.close().catch(() => {});
  }
}

await run("a1-small-steps-up", async ({ page, cdp, state, entry }) => {
  await toEnd(page); await settle(page);
  const output = stream(page, state);
  await sleep(400);
  const since = await page.evaluate(() => performance.now());
  entry.gaps = [];
  for (let k = 0; k < 6; k++) {
    await wheel(page, cdp, -40);
    await sleep(150);
    entry.gaps.push(Math.round(await page.evaluate(() => window.__probe.gap())));
  }
  await sleep(600);
  entry.finalGap = Math.round(await page.evaluate(() => window.__probe.gap()));
  entry.toEnd = await page.evaluate((since) => window.__probe.toEnd(since), since);
  await output.stop();
  check(entry.finalGap >= 200, "A1: six 40px wheel steps up while a reply streams leave the end", { gaps: entry.gaps, finalGap: entry.finalGap, scrollsToEnd: entry.toEnd });
});

await run("a2-slow-stroke-up", async ({ page, cdp, state, entry }) => {
  await toEnd(page); await settle(page);
  const output = stream(page, state);
  await sleep(400);
  const since = await page.evaluate(() => performance.now());
  await wheel(page, cdp, -300, 1200);
  await sleep(600);
  entry.finalGap = Math.round(await page.evaluate(() => window.__probe.gap()));
  entry.toEnd = await page.evaluate((since) => window.__probe.toEnd(since), since);
  await output.stop();
  check(entry.finalGap >= 250, "A2: one slow 300px stroke up while a reply streams leaves the end", { finalGap: entry.finalGap, scrollsToEnd: entry.toEnd });
});

await run("b-fold-near-end", async ({ page, cdp, state, entry }) => {
  // The reader leaves the end by wheel, then reads the running Turn's first
  // commentary a quarter down the pane: its open tool group is below.
  await wheel(page, cdp, -400); await settle(page);
  const target = '[data-item-id="t21-c1"] p';
  for (let i = 0; i < 4; i++) {
    await pane(page).evaluate((el, target) => { const r = el.querySelector(target).getBoundingClientRect(); el.scrollTop += r.top - (el.getBoundingClientRect().top + 0.25 * el.clientHeight); }, target);
    await settle(page);
  }
  const before = await page.evaluate((target) => ({ top: window.__probe.top(target), gap: window.__probe.gap(), at: performance.now() }), target);
  entry.before = before;
  check(before.gap >= 72 && before.gap < 400, "B: the reader is just short of the end, not following", { gap: Math.round(before.gap) });
  // Tools join the open group, then a commentary arrives after it (the group folds) and streams.
  for (let k = 0; k < 5; k++) {
    const id = `t21-y${k}`;
    await addItem(page, state, cmd(id, 20 + k, "inProgress")); await sleep(250);
    live(state).items.find((i) => i.id === id).status = "completed";
    await emit(page, state, { type: "agent.item", turnId: "t21", item: structuredClone(live(state).items.find((i) => i.id === id)) });
    await sleep(300);
  }
  const folded = await page.evaluate(() => performance.now());
  const output = stream(page, state, 22);
  await output.done;
  await sleep(500); await settle(page);
  const after = await page.evaluate(([target, folded]) => ({ top: window.__probe.top(target), gap: window.__probe.gap(), toEnd: window.__probe.toEnd(folded),
    groupOpen: document.querySelector('[data-turn-id="t21"] details.tool-activity')?.open ?? null }), [target, folded]);
  entry.after = after;
  entry.moved = Math.round((after.top - before.top) * 10) / 10;
  check(after.groupOpen === false, "B: the open tool group folded when the commentary arrived", { groupOpen: after.groupOpen });
  // A clamp may move it down by what folded beyond the room below; nothing may carry it up after that.
  check(entry.moved >= -2 && after.toEnd === 0, "B: the clamp does not start following: the text being read is not carried off", { moved: entry.moved, scrollsToEnd: after.toEnd, gapAfter: Math.round(after.gap) });
});

await run("c-controls", async ({ page, cdp, state, entry }) => {
  await toEnd(page); await settle(page);
  let output = stream(page, state, 20);
  await output.done; await sleep(300); await settle(page);
  entry.followingGap = Math.round(await page.evaluate(() => window.__probe.gap()));
  check(entry.followingGap < 2, "C: at the end, output keeps the end in view", { gap: entry.followingGap });
  await wheel(page, cdp, -500); await settle(page);
  const up = Math.round(await page.evaluate(() => window.__probe.gap()));
  await wheel(page, cdp, up + 200); await settle(page);
  output = stream(page, state, 20);
  await output.done; await sleep(300); await settle(page);
  entry.backGap = Math.round(await page.evaluate(() => window.__probe.gap()));
  check(up >= 400 && entry.backGap < 2, "C: wheeled back down to the end, the reader follows again", { up, gap: entry.backGap });
});

await browser.close();
check(report.errors.length === 0, "no page errors", { errors: report.errors.slice(0, 3) });
check(report.writes.length === 0 && report.unexpected.length === 0, "nothing written and no unexpected reads", { writes: report.writes.slice(0, 3), unexpected: report.unexpected.slice(0, 5) });
report.status = report.failed.length ? "failed" : "passed";
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(report.failed.length ? `\n${report.failed.length} failed` : "\nall passed");
process.exit(report.failed.length ? 1 : 0);
