// T-19, an Agent row this window adds (M9 + M4: SH:R11), in Chromium on a production build of the
// app with a synthetic Workspace and a stand-in event stream this check speaks for Core (no Core, no
// Agent).
// - On the desktop, an Agent created here, and one forked here, has its row brought into view, come
//   in over small (opacity, 4 px up) and settle once (the tint plays, then goes). Under reduced
//   motion it is there at once and the tint stands, then goes.
// - The list as it first shows, and a row a newer read of the Workspace brings (another window's
//   Agent), come in and settle not at all.
// - On a phone the list is not shown while the new conversation opens: back in the list, the new
//   row is there.
// Writes: only the create and the fork this check asks for, the fork's preview, and the app's own
// saves of where an Agent was read; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-agent-row-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-agent-row");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], creates: 0, forks: 0, previews: 0,
  readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name, extra = {}) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "codex",
  connectionState: "connected", threadId: `019a1234-5678-4321-aaaa-${id.padStart(12, "0").slice(-12)}`, ...extra });
// Enough Agents that the list scrolls.
const fillers = Array.from({ length: 24 }, (_, n) => agent(`f${n + 1}`, `Agent ${String(n + 1).padStart(2, "0")}`));
const mori = agent("mori", "Mori");
const turn = { id: "t1", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
  { id: "m1", type: "agentMessage", text: "Hello back." }] };
const preview = { sourceThreadId: mori.threadId, throughTurnId: "t1", throughCompletedAt: 1791856000, includedTurns: 1, excludedTurns: 0,
  name: "Mori", cwd: "/w", model: "m", reasoningEffort: null, permissionPreset: null, projectId: null, forkedTo: null, warnings: [] };
let state;
const fresh = () => ({ agents: [...fillers, mori] });
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const detail = (a) => ({ agent: a, pending: [], artifacts: [], messageReceipts: [], turns: a.id === "mori" ? [turn] : [],
  // Another Codex client owns Mori's session: the notice offers to continue in a fork.
  ...(a.id === "mori" ? { codexHandoff: { writerConflictAt: "2026-11-03T09:00:00Z" } } : {}) });
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: state.agents, projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/w" }] },
  "/api/models": { models: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  // Another window adds an Agent: Core has it before it says so.
  if (path === "/__check/plum") {
    state.agents = [...state.agents, agent("plum", "Plum")];
    return route.fulfill({ json: {} });
  }
  if (path.startsWith("/api/")) {
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) {
        report.readingSaves.push(path);
        return route.fulfill({ json: { accepted: true } });
      }
      // Reads that are POSTs, and change nothing.
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      if (path === "/api/agents") {
        report.creates++;
        const body = request.postDataJSON();
        const made = agent("peach", body.name, { cwd: body.cwd || "/w" });
        state.agents = [...state.agents, made];
        return route.fulfill({ json: made });
      }
      if (path === "/api/agents/mori/codex/fork/preview") {
        report.previews++;
        return route.fulfill({ json: preview });
      }
      if (path === "/api/agents/mori/codex/fork") {
        report.forks++;
        const body = request.postDataJSON();
        const forked = agent("mori-fork", body.name);
        state.agents = [...state.agents, forked];
        return route.fulfill({ json: { state: "completed", requestId: body.requestId, agent: forked, connected: true, message: null, warnings: [] } });
      }
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const known = gets()[path];
    if (known !== undefined) return route.fulfill({ json: known });
    const shown = path.match(/^\/api\/agents\/([^/]+)$/);
    const listed = shown && state.agents.find((a) => a.id === decodeURIComponent(shown[1]));
    if (listed) return route.fulfill({ json: detail(listed) });
    if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path)) return route.fulfill({ json: usage });
    if (/^\/api\/agents\/[^/]+\/codex\/mcp$/.test(path)) return route.fulfill({ json: mcp });
    if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: { handoff: null } });
    if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
    if (/^\/api\/agents\/[^/]+\/./.test(path)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: {} });
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = resolve(dist, file);
  assert.ok(full.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(full), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page, from the first script on: the event stream, spoken for Core by this check (a fresh
 * connection starts with `reset`, as events.rs does), and each frame, every Agent row: whether one
 * plays an entry of its own (not the settle's CSS tint) or is settled, and the rows asked about. */
function pageHelpers() {
  let id = 0;
  const streams = [];
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      streams.push(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  // Another window added an Agent: Core has it, then says the Workspace changed.
  window.__plum = async () => {
    await fetch("/__check/plum");
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "agents" }), lastEventId: String(++id) });
  };
  const entries = (el) => el.getAnimations().filter((a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation));
  const row = (el) => {
    if (!el) return null;
    const list = el.closest(".agent-list");
    const shownRect = el.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const plays = entries(el);
    const keys = new Set();
    for (const a of plays) for (const k of a.effect?.getKeyframes?.() ?? [])
      for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) keys.add(p);
    return { opacity: Number(getComputedStyle(el).opacity), entries: plays.length, keys: [...keys].sort().join("+"),
      duration: plays[0]?.effect?.getComputedTiming().duration ?? null, settle: el.hasAttribute("data-settle"),
      shown: shownRect.height > 0 && !!listRect && listRect.height > 0,
      inView: !!listRect && shownRect.height > 0 && shownRect.top >= listRect.top - 1 && shownRect.bottom <= listRect.bottom + 1 };
  };
  const frames = [];
  window.__frames = frames;
  window.__now = () => frames.length;
  const step = () => {
    const rows = [...document.querySelectorAll(".agent-list .agent-row")];
    frames.push({
      rows: rows.length,
      entering: rows.filter((el) => entries(el).length).map((el) => el.dataset.agentId),
      settled: rows.filter((el) => el.hasAttribute("data-settle")).map((el) => el.dataset.agentId),
      peach: row(document.querySelector('.agent-list .agent-row[data-agent-id="peach"]')),
      fork: row(document.querySelector('.agent-list .agent-row[data-agent-id="mori-fork"]')),
      plum: row(document.querySelector('.agent-list .agent-row[data-agent-id="plum"]')),
    });
    if (frames.length < 20_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** The row came in: from its first frame, a fade 4 px up over small; under reduced motion, at once. */
function cameIn(frames, reduced) {
  const shown = frames.filter(Boolean);
  if (!shown.length) return false;
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => f.opacity === 1 && f.entries === 0);
  return shown[0].opacity < 1 && shown[0].entries === 1 && shown[0].keys === "opacity+transform" && Math.abs((shown[0].duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.entries === 0;
}
/** It was brought into view and settled once: the tint showed, then went. */
const settledOnce = (frames) => {
  const shown = frames.filter(Boolean);
  const first = shown.findIndex((f) => f.settle);
  return first >= 0 && shown.slice(first).some((f) => !f.settle) && shown.at(-1).inView && !shown.at(-1).settle;
};
const quiet = (frames) => frames.length > 0 && frames.every((f) => f.entering.length === 0 && f.settled.length === 0);

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  state = fresh();
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const now = () => page.evaluate(() => window.__now());
  /** On a phone, back to the list when a conversation shows. */
  const toList = async () => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator('.agent-list .agent-row[data-agent-id="f1"]').waitFor({ timeout: 10_000 });
  };
  try {
    await page.goto("http://127.0.0.1:4322/");
    await page.locator('.agent-list .agent-row[data-agent-id="mori"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(1500);
    // The list as it first shows.
    const opening = record("as the list first shows", await framesSince(0));
    ok(`${tag}: the Agent list as it first shows: no row comes in or settles`,
      quiet(opening.filter((f) => f.rows > 0)) && opening.some((f) => f.rows > 0), { entering: opening.find((f) => f.entering.length)?.entering, settled: opening.find((f) => f.settled.length)?.settled });

    // Another window adds an Agent: a newer read of the Workspace brings its row.
    if (run.phone) await toList();
    const beforePlum = await now();
    await page.evaluate(() => window.__plum());
    await page.locator('.agent-list .agent-row[data-agent-id="plum"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(1500);
    const plum = record("a row a read brings", await framesSince(beforePlum));
    ok(`${tag}: a row a newer read of the Workspace brings (another window's Agent): it does not come in or settle`,
      quiet(plum) && plum.some((f) => f.plum), { entering: plum.find((f) => f.entering.length)?.entering, settled: plum.find((f) => f.settled.length)?.settled });

    // Created here.
    if (run.phone) await toList();
    await page.getByRole("button", { name: "Create agent", exact: true }).first().click({ timeout: 10_000 });
    const dialog = page.locator('[role="dialog"]').last();
    await dialog.getByLabel("Name", { exact: true }).fill("Peach");
    const beforeCreate = await now();
    await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
    await page.locator('.agent-list .agent-row[data-agent-id="peach"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(2600);
    const created = record("created here", (await framesSince(beforeCreate)).map((f) => f.peach));
    if (!run.phone) {
      ok(`${tag}: an Agent created here: its row comes in over small, 4 px up with a fade, from its first frame; under reduced motion it is there at once`,
        cameIn(created, reduced), { first: created.filter(Boolean).slice(0, 3), last: created.filter(Boolean).at(-1) });
      ok(`${tag}: an Agent created here: its row is brought into view and settles once (the tint shows, then goes)`,
        settledOnce(created), { settles: created.filter((f) => f?.settle).length, last: created.filter(Boolean).at(-1) });
    } else {
      await toList();
      const there = await page.evaluate(() => window.__frames.at(-1).peach);
      ok(`${tag}: an Agent created here, on a phone: its conversation opens; back in the list, its row is there (${JSON.stringify(there)})`,
        !!there?.shown && there.opacity === 1, there);
    }

    // Forked here: from Mori's conversation, whose session another Codex client owns.
    if (run.phone) await toList();
    await page.locator('.agent-row[data-agent-id="mori"] .agent-select').first().click();
    await page.getByRole("button", { name: "Continue in a fork…", exact: true }).click({ timeout: 10_000 });
    const forkDialog = page.locator('[role="dialog"]').last();
    const forkButton = forkDialog.getByRole("button", { name: "Fork and continue", exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === "Fork and continue" && !b.disabled), null, { timeout: 10_000 });
    const beforeFork = await now();
    await forkButton.click();
    await page.locator('.agent-list .agent-row[data-agent-id="mori-fork"]').waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(2600);
    const forked = record("forked here", (await framesSince(beforeFork)).map((f) => f.fork));
    if (!run.phone) {
      ok(`${tag}: an Agent forked here: its row comes in over small, 4 px up with a fade, from its first frame; under reduced motion it is there at once`,
        cameIn(forked, reduced), { first: forked.filter(Boolean).slice(0, 3), last: forked.filter(Boolean).at(-1) });
      ok(`${tag}: an Agent forked here: its row is brought into view and settles once (the tint shows, then goes)`,
        settledOnce(forked), { settles: forked.filter((f) => f?.settle).length, last: forked.filter(Boolean).at(-1) });
    } else {
      await toList();
      const there = await page.evaluate(() => window.__frames.at(-1).fork);
      ok(`${tag}: an Agent forked here, on a phone: its conversation opens; back in the list, its row is there (${JSON.stringify(there)})`,
        !!there?.shown && there.opacity === 1, there);
    }
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but the creates (POST /api/agents, ${report.creates}), the forks (${report.forks}) and their previews (${report.previews}) this check asked for, and where an Agent was read (PUT .../reading, ${report.readingSaves.length})`,
  report.writes.length === 0 && report.creates === runs.length && report.forks === runs.length, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-agent-row-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
