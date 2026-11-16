// YN-114: a newer saved page, read as the reader scrolls down an older
// window (YN-19), keeps a screen of room above the window while it loads
// (App.tsx changeHistoryPage). That room must not move what is being read:
//  1. The stroke that starts the read moves the message being read only as
//     far as the reader scrolled it (main c3085169: +595px, a screen, so a
//     600px stroke moved the text 5px).
//  2. When the page is in, the message stays where the reader left it.
// The first newer page after Turn 1 keeps no room (nothing is before that
// window), so the reader goes on to the next one.
// Production bundle, synthetic API; no Core, no writes, no model turns. Desktop
// width: headless Chromium does not scroll this pane by touch (YN-114).
//   YUZUNO_UI_DIST=<isolated build> [NEWER_OUTPUT=dir] node tools/newer-page-hold-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.NEWER_OUTPUT || "../acceptance/newer-page-hold");
await mkdir(output, { recursive: true });
// A newer page answers slowly enough for its room to be seen.
const NEWER_MS = Number(process.env.NEWER_MS || 1500);

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "fixture",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const sentence = (n, p) => `Turn ${n}, part ${p + 1}: the check notes are written out at length so the reply wraps over several lines and every reply has a different height.`;
const TURNS = 100;
const turns = Array.from({ length: TURNS }, (_, i) => ({ id: `t${i + 1}`, status: "completed", items: [
  { id: `t${i + 1}-u`, type: "userMessage", content: [{ type: "text", text: `Question ${i + 1}: please look at this part.` }] },
  { id: `t${i + 1}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: 1 + ((i * 7) % 4) }, (_, p) => sentence(i + 1, p)).join("\n\n") },
] }));
const all = turns.flatMap((turn) => turn.items.map((item) => JSON.stringify([turn.id, item.id])));
// Core's window rules (conversation_window.rs): `after` and `turnId` start at their Item.
const SIZE = 40;
const windowOf = (from, to) => {
  from = Math.max(0, from); to = Math.min(all.length - 1, to);
  const shown = new Set(all.slice(from, to + 1));
  return {
    agent, pending: [], messageReceipts: [], artifacts: [],
    turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => shown.has(JSON.stringify([turn.id, item.id]))) })).filter((turn) => turn.items.length),
    conversation: {
      index: turns.map((turn, i) => ({ id: turn.id, status: turn.status, number: i + 1, _yuzunoIndex: true, _yuzunoRequestCount: 1, itemCount: turn.items.length, items: [turn.items[0]] })),
      questions: [], nativeClientIds: [], start: all[from], end: all[to], hasBefore: from > 0, hasAfter: to < all.length - 1, totalItems: all.length,
    },
  };
};
const detailFor = (query) => {
  if (query.has("before")) { const end = all.indexOf(query.get("before")); return windowOf(end - SIZE + 1, end); }
  if (query.has("after")) { const from = all.indexOf(query.get("after")); return windowOf(from, from + SIZE - 1); }
  if (query.has("turnId")) {
    const from = query.has("itemId") ? all.indexOf(JSON.stringify([query.get("turnId"), query.get("itemId")])) : all.findIndex((key) => JSON.parse(key)[0] === query.get("turnId"));
    return windowOf(from, from + SIZE - 1);
  }
  return windowOf(all.length - SIZE, all.length - 1);
};

const report = { checks: [], failed: [], errors: [], console: [], unexpected: [], writes: [], reads: [], steps: [] };
const check = (ok, name, extra = {}) => {
  report.checks.push({ name, ok, ...extra });
  if (!ok) report.failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(extra)}`);
  return ok;
};
const usage = { revision: 1, status: "unknown", account: null, accountId: null, source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
await page.addInitScript(() => {
  window.EventSource = class { close() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected.ws", JSON.stringify("a"));
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== "localhost") return route.abort();
  if (request.method() !== "GET") { report.writes.push(`${request.method()} ${url.pathname}`); return route.fulfill({ json: { ok: true } }); }
  if (url.pathname === "/api/agents/a") {
    const query = url.searchParams;
    const direction = query.has("after") ? "after" : query.has("before") ? "before" : query.has("turnId") ? "turn" : "latest";
    report.reads.push(direction);
    if (direction === "after") await new Promise((done) => setTimeout(done, NEWER_MS));
    else if (report.reads.length > 1) await new Promise((done) => setTimeout(done, 200));
    return route.fulfill({ json: detailFor(query) });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs,
    "/api/ci": noCiRuns, "/api/ci/live": noLiveCi, "/api/home": emptyHome, "/api/agents/a/conversation/inputs": noConversationInputs,
    "/api/reviews": noReviews, "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
    "/api/backlog": { observedAt: "2026-11-14T00:00:00Z", agents: {} }, "/api/pr-reviews/settings": { harness: "codex", model: "fixture" },
    "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
    "/api/waits/live": { agents: {} },
  }[url.pathname];
  if (json) return route.fulfill({ json });
  if (url.pathname.startsWith("/api/")) { report.unexpected.push(url.pathname); return route.fulfill({ status: 404, json: { error: "not in the fixture" } }); }
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  if (!file.startsWith(dist + "/")) return route.fulfill({ status: 404, body: "" });
  try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
  catch { return route.fulfill({ status: 404, body: "" }); }
});
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") report.console.push(message.text().slice(0, 240)); });

const pane = () => page.locator(".main-panel .conversation-scroll");
async function settle() {
  await page.waitForFunction(() => {
    const el = document.querySelector(".main-panel .conversation-scroll");
    const value = `${Math.round(el.scrollTop)}/${el.scrollHeight}`;
    window.__stable = { value, n: window.__stable?.value === value ? window.__stable.n + 1 : 0 };
    return window.__stable.n >= 6;
  }, null, { timeout: 6000, polling: "raf" }).catch(() => {});
}
/** The message a third down the pane, where it is, the pane's scrollTop, how
 * far the app itself has scrolled it, and the room kept above the window. */
const place = (id) => pane().evaluate((el, id) => {
  const box = el.getBoundingClientRect();
  let item = id ? el.querySelector(`[data-item-id="${id}"]`) : null;
  if (!id) item = [...el.querySelectorAll("[data-item-id]")].find((m) => { const r = m.getBoundingClientRect(); return r.height > 0 && r.top >= box.top + box.height / 3; }) || null;
  const inner = el.querySelector(".conversation-inner");
  const room = [...inner.children].filter((c) => c.tagName === "DIV" && c.getAttribute("aria-hidden") === "true" && c.style.height && c.offsetTop < (inner.querySelector(".conversation-window")?.offsetTop ?? 0))
    .reduce((n, c) => n + c.offsetHeight, 0);
  return { id: item?.dataset.itemId ?? null, top: item ? Math.round((item.getBoundingClientRect().top - box.top) * 10) / 10 : null, scrollTop: el.scrollTop, app: window.appScrolled, room };
}, id);

let shotTaken = false;
try {
  await page.goto("http://localhost/");
  await page.locator(".agent-row .agent-select").first().waitFor();
  await page.waitForTimeout(500);
  if (!(await page.locator(".main-panel .conversation-scroll [data-item-id]").count())) await page.locator(".agent-row .agent-select").first().click();
  await page.locator('.main-panel [data-item-id="t100-r"]').waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  await pane().evaluate((el) => {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    window.appScrolled = 0;
    const note = (fn) => { const was = d.get.call(el); const r = fn(); window.appScrolled += d.get.call(el) - was; return r; };
    Object.defineProperty(el, "scrollTop", { configurable: true, get() { return d.get.call(this); }, set(v) { note(() => d.set.call(this, v)); } });
    for (const name of ["scrollTo", "scrollBy"]) { const orig = el[name]; el[name] = function (...a) { return note(() => orig.apply(this, a)); }; }
  });
  const cdp = await context.newCDPSession(page);
  // Turn 1 from the turn dock: an older window, read toward its end.
  await page.locator(".turn-dock .turn-dock-stop").first().focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.locator('.main-panel [data-item-id="t1-u"]').waitFor({ state: "attached" });
  await page.waitForTimeout(900); await settle();
  const box = await pane().boundingBox();
  let roomLoad = null;
  for (let g = 0; g < 40 && !roomLoad; g++) {
    // As a scrollbar drag would: on toward the end of what is loaded.
    if (g % 4 === 2) { await pane().evaluate((el) => { el.scrollTop = Math.max(el.scrollTop, el.scrollHeight - el.clientHeight * 3.2); }); await settle(); }
    const reads = report.reads.length;
    const before = await place();
    if (!before.id) continue;
    await cdp.send("Input.synthesizeScrollGesture", { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height * 0.6),
      yDistance: -600, speed: 1600, gestureSourceType: "mouse", preventFling: true });
    const during = await place(before.id);
    const read = report.reads.slice(reads);
    const step = { g, before, during, read };
    report.steps.push(step);
    if (!read.includes("after")) continue;
    // The reader's scroll is what scrollTop moved less what the app moved it.
    step.reader = Math.round((during.scrollTop - before.scrollTop) - (during.app - before.app));
    step.jump = during.top === null ? null : Math.round(((during.top - before.top) + step.reader) * 10) / 10;
    if (during.room > 0) {
      roomLoad = step;
      await page.screenshot({ path: resolve(output, "loading.png") });
      await page.waitForTimeout(NEWER_MS + 900); await settle();
      step.landed = await place(before.id);
      await page.screenshot({ path: resolve(output, "landed.png") });
      shotTaken = true;
    } else {
      await page.waitForTimeout(NEWER_MS + 900); await settle();
    }
  }
  check(!!roomLoad, "a newer page was read with room kept above the window", { reads: report.reads });
  if (roomLoad) {
    check(roomLoad.jump !== null && Math.abs(roomLoad.jump) <= 2,
      "1. the stroke that starts the read moves the message being read only as far as the reader scrolled it",
      { message: roomLoad.before.id, room: roomLoad.during.room, readerScrolled: roomLoad.reader, moved: roomLoad.during.top === null ? null : Math.round((roomLoad.during.top - roomLoad.before.top) * 10) / 10, jump: roomLoad.jump });
    check(roomLoad.landed?.top != null && Math.abs(roomLoad.landed.top - roomLoad.during.top) <= 2,
      "2. when the page is in, the message stays where the reader left it", { during: roomLoad.during.top, landed: roomLoad.landed?.top ?? null });
  }
} catch (error) {
  check(false, "the run finished", { error: String(error?.message || error).slice(0, 400) });
} finally {
  if (!shotTaken) await page.screenshot({ path: resolve(output, "final.png") }).catch(() => {});
  await browser.close();
}
check(report.errors.length === 0, "no page errors", { errors: report.errors.slice(0, 3) });
check(report.writes.length === 0 && report.unexpected.length === 0, "nothing written and no unexpected reads", { writes: report.writes.slice(0, 3), unexpected: report.unexpected.slice(0, 5) });
report.status = report.failed.length ? "failed" : "passed";
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(report.failed.length ? `\n${report.failed.length} failed` : "\nall passed");
process.exit(report.failed.length ? 1 : 0);
