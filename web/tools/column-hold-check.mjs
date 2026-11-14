// YN-114: on a wide pane the Jobs, CI and sub-agent dock coming or going
// narrows or widens the conversation's column (work-dock.css: 156px from
// 760px wide), and the text rewraps. What is being read stays where it was:
//  1. A Job of the Agent's appears (Core says the Jobs changed, the dock gets
//     its first entry): the column narrows, and the paragraph a quarter down
//     the pane, inside a long reply that runs across the top of the view,
//     does not move (main c3085169: +486px at 1440 wide, +729px at 1100).
//  2. The Job goes again (no Jobs, the dock empties): the column widens, and
//     the paragraph still does not move.
// Before and after screenshots of each width are kept. Production bundle,
// synthetic API and event stream; no Core, no writes, no model turns.
//   YUZUNO_UI_DIST=<isolated build> [COLUMN_OUTPUT=dir] [COLUMN_VIEWPORTS=1440x900,1100x760] node tools/column-hold-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveCi, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.COLUMN_OUTPUT || "../acceptance/column-hold");
await mkdir(output, { recursive: true });
const VIEWPORTS = (process.env.COLUMN_VIEWPORTS || "1440x900,1100x760").split(",").map((v) => {
  const [width, height] = v.split("x").map(Number);
  return { name: v, width, height };
});

const agent = { id: "a", name: "Mori", status: "idle", connectionState: "connected", harness: "codex", cwd: "/fixture", model: "fixture",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const sentence = (n, p) => `Turn ${n}, part ${p + 1}: the check notes are written out at length so the reply wraps over several lines and every reply has a different height.`;
// Turn 18's reply is long: fourteen paragraphs of five sentences.
const turns = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1, long = n === 18;
  const paragraph = (p) => long ? Array.from({ length: 5 }, () => sentence(n, p)).join(" ") : sentence(n, p);
  return { id: `t${n}`, status: "completed", items: [
    { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `Question ${n}: please look at this part.` }] },
    { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: long ? 14 : 1 + ((n * 7) % 4) }, (_, p) => paragraph(p)).join("\n\n") },
  ] };
});
// A Job of Mori's, as Core lists it (conversation-strips-check.mjs).
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
const job = { id: "j1", requestId: "j1", name: "unit tests", taskRef: "T-51", agentId: "a", agent: { name: "Mori" }, machine: { name: "Core host" },
  status: "running", reserved: true, reason: null, resources, reservation: resources, cursor: 1, createdAt: "2026-11-14T01:00:00Z",
  startedAt: "2026-11-14T01:00:01Z", finishedAt: null, argv: ["/usr/bin/true"], cwd: "/fixture", env: {}, outputs: [] };
const usage = { revision: 1, status: "unknown", account: null, accountId: null, source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const report = { checks: [], failed: [], errors: [], console: [], unexpected: [], writes: [], runs: [] };
const check = (ok, name, extra = {}) => {
  report.checks.push({ name, ok, ...extra });
  if (!ok) report.failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(extra)}`);
  return ok;
};
const browser = await launchBrowser();

for (const viewport of VIEWPORTS) {
  const tag = viewport.name;
  const run = { tag };
  report.runs.push(run);
  const state = { jobs: [] };
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce" });
  try {
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
        "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
        "/api/workspace": { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/jobs": { ...noJobs, jobs: state.jobs },
        "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs,
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
    if (!(await page.locator('.main-panel [data-item-id="t20-r"]').count())) await page.locator(".agent-row .agent-select").first().click();
    await page.locator('.main-panel [data-item-id="t18-r"]').waitFor({ state: "attached" });
    await page.evaluate(() => document.fonts.ready);
    const pane = page.locator(".main-panel .conversation-scroll");
    const settle = () => page.waitForFunction(() => {
      const el = document.querySelector(".main-panel .conversation-scroll");
      const value = `${Math.round(el.scrollTop)}/${el.scrollHeight}/${Math.round(el.querySelector(".conversation-inner").getBoundingClientRect().width)}`;
      window.__stable = { value, n: window.__stable?.value === value ? window.__stable.n + 1 : 0 };
      return window.__stable.n >= 8;
    }, null, { timeout: 6000, polling: "raf" }).catch(() => {});
    // The reader leaves the end by wheel, then reads Turn 18's ninth paragraph: its first line a quarter down the pane.
    const box = await pane.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await settle();
    const target = '[data-item-id="t18-r"] p:nth-of-type(9)';
    for (let i = 0; i < 5; i++) {
      await pane.evaluate((el, target) => { const r = el.querySelector(target).getBoundingClientRect(); el.scrollTop += r.top - (el.getBoundingClientRect().top + el.clientHeight / 4) + 8; }, target);
      await settle();
    }
    // The paragraph a quarter down the pane, and the column's width.
    const look = () => pane.evaluate((el) => {
      const box = el.getBoundingClientRect(), y = box.top + box.height / 4;
      const all = [...el.querySelectorAll('[data-item-id="t18-r"] p')];
      const p = all.find((p) => { const r = p.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
      return { paragraph: p ? all.indexOf(p) + 1 : null, top: p ? Math.round((p.getBoundingClientRect().top - box.top) * 10) / 10 : null,
        column: Math.round(el.querySelector(".conversation-inner").getBoundingClientRect().width), dock: !!document.querySelector(".main-panel .work-dock-scroll .work-dock-item, .main-panel .work-dock-scroll > *") };
    });
    const topOf = (paragraph) => pane.evaluate((el, n) => {
      const p = el.querySelectorAll('[data-item-id="t18-r"] p')[n - 1];
      return p ? Math.round((p.getBoundingClientRect().top - el.getBoundingClientRect().top) * 10) / 10 : null;
    }, paragraph);
    const jobsChanged = () => page.evaluate(() => { for (const es of window.__ess) if (es.readyState === 1) es.onmessage?.({ data: '{"type":"workspace.changed","scope":"jobs"}', lastEventId: "fx-jobs" }); });
    const before = run.before = await look();
    check(before.paragraph !== null && !before.dock, `${tag}: a paragraph of the long reply is a quarter down the pane, no dock yet`, before);
    await page.screenshot({ path: resolve(output, `${tag}-1-no-dock.png`) });
    // 1. A Job appears.
    state.jobs = [job];
    await jobsChanged();
    await page.waitForFunction(() => !!document.querySelector(".main-panel .work-dock-scroll > *"), null, { timeout: 8000 });
    await settle();
    const docked = run.docked = { ...(await look()), held: await topOf(before.paragraph) };
    await page.screenshot({ path: resolve(output, `${tag}-2-dock.png`) });
    check(docked.column !== before.column, `${tag}: the dock's first entry changes the column's width`, { before: before.column, after: docked.column });
    check(docked.held !== null && Math.abs(docked.held - before.top) <= 2,
      `${tag}: 1. as the Job appears, the paragraph being read does not move`, { paragraph: before.paragraph, before: before.top, after: docked.held });
    // 2. The Job goes again.
    state.jobs = [];
    await jobsChanged();
    await page.waitForFunction(() => !document.querySelector(".main-panel .work-dock-scroll > *"), null, { timeout: 8000 });
    await settle();
    const undocked = run.undocked = { ...(await look()), held: await topOf(before.paragraph) };
    await page.screenshot({ path: resolve(output, `${tag}-3-dock-gone.png`) });
    check(undocked.held !== null && Math.abs(undocked.held - before.top) <= 2,
      `${tag}: 2. as the dock empties, the paragraph being read does not move`, { paragraph: before.paragraph, before: before.top, after: undocked.held, column: undocked.column });
  } catch (error) {
    run.failure = String(error?.stack || error).slice(0, 1500);
    check(false, `${tag}: the run finished`, { error: String(error?.message || error).slice(0, 300) });
  } finally {
    await context.close().catch(() => {});
  }
}
await browser.close();
check(report.errors.length === 0, "no page errors", { errors: report.errors.slice(0, 3) });
check(report.writes.length === 0 && report.unexpected.length === 0, "nothing written and no unexpected reads", { writes: report.writes.slice(0, 3), unexpected: report.unexpected.slice(0, 5) });
report.status = report.failed.length ? "failed" : "passed";
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(report.failed.length ? `\n${report.failed.length} failed` : "\nall passed");
process.exit(report.failed.length ? 1 : 0);
