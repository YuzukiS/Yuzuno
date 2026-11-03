// T-19, a proposed task status decided here (M14 + F2: HM:T3), in Chromium on a production build of the
// app with a synthetic Workspace and every API answered here (no Core, no Agent).
// - Confirm, and Decline, pressed on a published TaskStatus proposal in a conversation: once Core has
//   the decision, its outcome takes the edit area's place, fades in over small and, focus having
//   gone with the buttons, takes it.
// - A proposal already decided when the conversation opens shows its outcome as it is: no fade from
//   its first frame, read from the document's start, and no focus.
// - Under reduced motion nothing fades; focus moves the same.
// Writes: only the two decisions sent on purpose in each run (POST /api/results/…/task-status) and
// the app's own saves of where an Agent was read; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-task-status-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-task-status");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], decisions: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const spec = (taskId, status, reason) => ({
  root: "result",
  elements: {
    result: { type: "Result", props: { title: `Status of ${taskId}`, summary: "The work is merged; acceptance is still open." }, children: ["status"] },
    status: { type: "TaskStatus", props: { taskId, status, reason } },
  },
});
const results = {
  r1: { id: "r1", spec: spec("T-88", "review", "Merged, but cross-host acceptance is still open") },
  r2: { id: "r2", spec: spec("T-89", "done", "Every slice is merged") },
};
const tasks = {
  r1: { id: "T-88", title: "Independent Core", status: "doing", version: 4, blocker: "", assignee: "Dev 3", archived: false },
  r2: { id: "T-89", title: "Shared presets", status: "doing", version: 7, blocker: "", assignee: "Dev 7", archived: false },
};
// What Core has recorded for each proposal; each run starts undecided.
let attempts;
const view = (id) => ({ resultId: id, agentId: "a", proposal: results[id].spec.elements.status.props, task: tasks[id], blocked: null, attempts: attempts[id] });
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Where do T-88 and T-89 stand?" }] },
  { id: "m1", type: "agentMessage", text: "Both are ready for your call." },
], _yuzunoResults: [
  { id: "r1", chainId: "c1", version: 1, createdAt: "2026-11-03T09:00:00Z" },
  { id: "r2", chainId: "c2", version: 1, createdAt: "2026-11-03T09:00:01Z" },
] }];
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns, messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/agents/a/results/r1": results.r1,
  "/api/agents/a/results/r2": results.r2,
  "/api/results/r1/task-status": view("r1"),
  "/api/results/r2/task-status": view("r2"),
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) {
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true } });
    }
    const decided = url.pathname.match(/^\/api\/results\/(r[12])\/task-status$/);
    if (request.method() === "POST" && decided) {
      const id = decided[1];
      const sent = JSON.parse(request.postData() || "{}");
      report.decisions.push({ id, action: sent.action });
      // Core answers a moment later, as a real decision would.
      await new Promise((done) => setTimeout(done, 120));
      attempts[id] = [{ requestId: sent.requestId, action: sent.action, status: sent.status ?? null, reason: sent.reason ?? "",
        expectedVersion: sent.expectedVersion ?? null, state: sent.action === "confirm" ? "applied" : "declined", error: null,
        taskVersion: sent.action === "confirm" ? tasks[id].version + 1 : null, by: { name: "You" }, at: new Date().toISOString() }];
      return route.fulfill({ json: view(id) });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/(agents|results)\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

// In the page: press a button as a pointer does (focus, then click), then read what comes each frame;
// and, from a reload's start, what `__watch` names.
function pageHelpers() {
  const frame = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const animations = el.getAnimations();
    return { opacity: Number(getComputedStyle(el).opacity), animations: animations.length,
      duration: animations[0]?.effect?.getComputedTiming().duration ?? null };
  };
  window.__focused = () => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, className: typeof el.className === "string" ? el.className : "", text: el.textContent.trim().slice(0, 80),
      card: el.closest(".task-status-card")?.getAttribute("aria-label") ?? null } : null;
  };
  window.__press = (button, target, frames = 60) => new Promise((done) => {
    const b = document.querySelector(button);
    if (!b) return done(null);
    b.focus();
    b.click();
    const out = [];
    const step = () => {
      out.push(frame(target));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const watch = sessionStorage.getItem("__watch");
  if (watch) {
    window.__watched = [];
    let ticks = 0;
    const step = () => {
      const f = frame(watch);
      if (f || window.__watched.length) window.__watched.push(f);
      if (window.__watched.length < 30 && ++ticks < 1800) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/** What came in, from its first frame: a fade over small under normal motion, at once under reduced. */
function came(frames, reduced) {
  const shown = (frames ?? []).filter(Boolean);
  if (!shown.length) return false;
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => f.opacity === 1 && f.animations === 0);
  return shown[0].opacity < 1 && shown[0].animations === 1 && Math.abs((shown[0].duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.animations === 0;
}
const still = (frames) => (frames ?? []).filter(Boolean).length > 0 && frames.filter(Boolean).every((f) => f.opacity === 1 && f.animations === 0);

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const CARD = (taskId) => `.task-status-card[aria-label="Proposed status change for ${taskId}"]`;
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  attempts = { r1: [], r2: [] };
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.addInitScript(pageHelpers);
  const press = (button, target) => page.evaluate(([button, target]) => window.__press(button, target), [button, target]);
  const focused = () => page.evaluate(() => window.__focused());
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  /** The conversation open, with both proposals read. */
  const openConversation = async () => {
    await page.locator(".agent-row").first().waitFor({ timeout: 10_000 });
    if (!(await page.locator(CARD("T-88")).count())) {
      if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
      await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    }
    await page.locator(`${CARD("T-88")} .task-status-actions, ${CARD("T-88")} .task-status-outcome`).first().waitFor({ timeout: 10_000 });
    await page.locator(`${CARD("T-89")} .task-status-actions`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
  };
  try {
    await page.goto("http://127.0.0.1:4319/");
    await openConversation();

    // Confirm on T-88.
    const confirmed = record("confirm pressed", await press(`${CARD("T-88")} .task-status-actions .result-primary`, `${CARD("T-88")} .task-status-outcome`));
    await page.locator(`${CARD("T-88")} .task-status-outcome`).waitFor({ timeout: 5000 });
    const onConfirmed = await focused();
    ok(`${tag}: Confirm pressed: once Core has it, the outcome takes the edit area's place, fades in over small (at once under reduced motion) and takes focus (${onConfirmed?.className})`,
      came(confirmed, reduced) && onConfirmed?.className.includes("task-status-outcome") && onConfirmed.card === "Proposed status change for T-88" &&
        !(await page.locator(`${CARD("T-88")} .task-status-actions`).count()),
      { first: confirmed?.filter(Boolean).slice(0, 3), focus: onConfirmed });

    // Decline on T-89.
    const declined = record("decline pressed", await press(`${CARD("T-89")} .task-status-actions .secondary-button`, `${CARD("T-89")} .task-status-outcome`));
    await page.locator(`${CARD("T-89")} .task-status-outcome`).waitFor({ timeout: 5000 });
    const onDeclined = await focused();
    ok(`${tag}: Decline pressed: once Core has it, the outcome takes the edit area's place, fades in over small (at once under reduced motion) and takes focus (${onDeclined?.className})`,
      came(declined, reduced) && onDeclined?.className.includes("task-status-outcome") && onDeclined.card === "Proposed status change for T-89" &&
        !(await page.locator(`${CARD("T-89")} .task-status-actions`).count()),
      { first: declined?.filter(Boolean).slice(0, 3), focus: onDeclined });

    // The conversation opened again with T-88 decided in Core's record.
    await page.evaluate((selector) => sessionStorage.setItem("__watch", selector), `${CARD("T-88")} .task-status-outcome`);
    await page.reload();
    await page.locator(".agent-row").first().waitFor({ timeout: 10_000 });
    if (!(await page.locator(CARD("T-88")).count())) {
      if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
      await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    }
    await page.locator(`${CARD("T-88")} .task-status-outcome`).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => (window.__watched?.length ?? 0) >= 30, null, { timeout: 10_000 });
    const loaded = record("decided on opening", await page.evaluate(() => window.__watched));
    const loadedFocus = await focused();
    ok(`${tag}: a proposal already decided when the conversation opens shows its outcome as it is: no fade from its first frame, and it takes no focus (${loadedFocus?.className || loadedFocus?.tag})`,
      still(loaded) && !loadedFocus?.className.includes("task-status-outcome"), { loaded: loaded?.slice(0, 3), focus: loadedFocus });
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but the two decisions sent in each run (POST /api/results/…/task-status, ${report.decisions.length}) and where an Agent was read (PUT .../reading, ${report.readingSaves.length})`,
  report.writes.length === 0 && report.decisions.length === runs.length * 2, { writes: report.writes, decisions: report.decisions });
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-task-status-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
