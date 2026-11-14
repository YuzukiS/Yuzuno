// YN-114: what folds away below the reader near the end of the running
// Turn does not move what they are reading. The open tool group of the
// latest Turn closes as the next message arrives (or as the Turn ends); a
// reader just short of the end, not following, had the pane clamped to its
// new end and the text being read dropped by what folded beyond the room
// below it (main 43eb7826, after #941: +41px at 145px from the end).
//  B1. 145px from the end, a commentary arrives: the paragraph stays.
//  B2. 90px from the end, the same: the paragraph stays.
//  B3. 145px from the end, the Turn ends (a final reply, the Agent idle): it stays.
//  C.  The room taken at the end goes as the reply streams into it, and an
//      Agent followed at the end is still followed, with no room left.
// Production bundle, synthetic API and event stream; no Core, no writes, no
// model turns. Desktop width (headless Chromium does not scroll this pane by
// touch, YN-114).
//   YUZUNO_UI_DIST=<isolated build> [FOLD_OUTPUT=dir] node tools/fold-clamp-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.FOLD_OUTPUT || "../acceptance/fold-clamp");
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
const target = '[data-item-id="t21-c1"] p';
/** The reader leaves the end by wheel and stops `gap` px short of it, the
 * running Turn's first commentary in view, its open tool group below. */
async function readNearEnd(page, cdp, gap) {
  await wheel(page, cdp, -400); await settle(page);
  await pane(page).evaluate((el, gap) => { el.scrollTop = el.scrollHeight - el.clientHeight - gap; }, gap);
  await settle(page);
  return page.evaluate((target) => ({ top: window.__probe.top(target), gap: window.__probe.gap(), at: performance.now() }), target);
}
const column = (page) => page.evaluate(() => ({ room: document.querySelector(".main-panel .conversation-inner").style.paddingBottom || "",
  groupOpen: document.querySelector('[data-turn-id="t21"] details.tool-activity')?.open ?? null }));
/** Tools join the open group, then a commentary arrives after it (the group folds). */
async function toolsThenCommentary(page, state, deltas) {
  for (let k = 0; k < 3; k++) {
    const id = `t21-y${k}`;
    await addItem(page, state, cmd(id, 20 + k, "inProgress")); await sleep(250);
    live(state).items.find((i) => i.id === id).status = "completed";
    await emit(page, state, { type: "agent.item", turnId: "t21", item: structuredClone(live(state).items.find((i) => i.id === id)) });
    await sleep(250);
  }
  const output = stream(page, state, deltas);
  await output.done;
  await sleep(600); await settle(page);
}

for (const [name, gap] of [["b1-fold-145", 145], ["b2-fold-90", 90]]) {
  await run(name, async ({ page, cdp, state, entry }) => {
    const before = entry.before = await readNearEnd(page, cdp, gap);
    check(Math.abs(before.gap - gap) < 2, `${name}: the reader is ${gap}px short of the end, not following`, { gap: Math.round(before.gap) });
    await toolsThenCommentary(page, state, 3);
    const after = entry.after = { ...(await page.evaluate((target) => ({ top: window.__probe.top(target), gap: window.__probe.gap() }), target)), ...(await column(page)) };
    entry.moved = Math.round((after.top - before.top) * 10) / 10;
    check(after.groupOpen === false, `${name}: the open tool group folded when the commentary arrived`, { groupOpen: after.groupOpen });
    check(Math.abs(entry.moved) <= 2, `${name}: the paragraph being read does not move as the group folds`, { before: before.top, after: after.top, moved: entry.moved, room: after.room });
  });
}

await run("b3-turn-ends", async ({ page, cdp, state, entry }) => {
  const before = entry.before = await readNearEnd(page, cdp, 145);
  live(state).items.push({ id: "t21-r", type: "agentMessage", phase: "final_answer", text: "All checks passed." });
  live(state).status = "completed";
  state.agent.status = "idle";
  await emit(page, state, { type: "agent.changed" });
  await page.waitForFunction(() => !!document.querySelector('.main-panel [data-item-id="t21-r"]'), null, { timeout: 8000 });
  await sleep(800); await settle(page);
  const after = entry.after = { ...(await page.evaluate((target) => ({ top: window.__probe.top(target), gap: window.__probe.gap() }), target)), ...(await column(page)) };
  entry.moved = Math.round((after.top - before.top) * 10) / 10;
  check(after.groupOpen === false, "B3: the Turn's tool group folded as it ended", { groupOpen: after.groupOpen });
  check(Math.abs(entry.moved) <= 2, "B3: the paragraph being read does not move as the Turn ends", { before: before.top, after: after.top, moved: entry.moved, room: after.room });
});

await run("c-room-and-following", async ({ page, cdp, state, entry }) => {
  const before = await readNearEnd(page, cdp, 145);
  await toolsThenCommentary(page, state, 24);
  const filled = entry.filled = { ...(await column(page)), moved: Math.round(((await page.evaluate((target) => window.__probe.top(target), target)) - before.top) * 10) / 10 };
  check(filled.room === "" && Math.abs(filled.moved) <= 2, "C: the room at the end goes as the reply streams into it, nothing moving", filled);
  // Back down to the end by wheel: followed again, with no room left.
  const up = Math.round(await page.evaluate(() => window.__probe.gap()));
  await wheel(page, cdp, up + 300); await settle(page);
  const output = stream(page, state, 12);
  await output.done; await sleep(400); await settle(page);
  entry.end = { gap: Math.round(await page.evaluate(() => window.__probe.gap())), ...(await column(page)) };
  check(entry.end.gap < 2 && entry.end.room === "", "C: wheeled back to the end, the reader follows again, with no room left", entry.end);
});

await browser.close();
check(report.errors.length === 0, "no page errors", { errors: report.errors.slice(0, 3) });
check(report.writes.length === 0 && report.unexpected.length === 0, "nothing written and no unexpected reads", { writes: report.writes.slice(0, 3), unexpected: report.unexpected.slice(0, 5) });
report.status = report.failed.length ? "failed" : "passed";
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(report.failed.length ? `\n${report.failed.length} failed` : "\nall passed");
process.exit(report.failed.length ? 1 : 0);
