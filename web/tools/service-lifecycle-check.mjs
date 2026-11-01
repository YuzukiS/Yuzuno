// A managed service's lifecycle in the Portal (T-14), in a real browser: the
// project's services list opens it beside the chat at its saved width (full
// screen on a phone); process, HTTP health and this browser's check are
// three facts; stopping is first "stop requested", then "stopped as you
// requested" once the run ends; a new run starts only with a chosen limit and
// is queued, not ready; an expired or unknown run shows why instead of a
// page, and closing the preview stops nothing. Each confirmation is what the
// user sees, above the Portal even when it covers the window. Desktop light
// and dark, a narrow desktop window and a 390 px phone, in Chinese. Bounded
// recovery (T-14 v3.4): a waiting retry with its earliest time, its stop and
// opt-out, a retry in launch preparation, a Core restart with the current run
// to be checked, and the Start option unticked after the retries are used.
// Production bundle with an explicit API fixture: no Core, synthetic data;
// only the service's own open, stop, start and opt-out are sent, to the
// fixture.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/service-lifecycle-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/service-lifecycle");
await mkdir(output, { recursive: true });
// The page as the Core host's own browser opens it: Core's service ports are this computer's.
const HOST = "127.0.0.1:4317";
const report = { task: "T-14", checks: [], shots: [], errors: [], writes: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shoot = async (target, name) => {
  await target.screenshot({ path: `${output}/${name}.png` });
  report.shots.push(name);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const PORT = 4381;
const SAVED_WIDTH = 760;
const base = { harness: "claude", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "iris", name: "Iris", projectId: "p1", rev: 1 }];
// The conversation beside the Portal, as in the design.
const conversation = { agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "把阅读界面跑起来，让我直接在这里看。" }] },
  { id: "r1", type: "agentMessage", phase: "final_answer", text: "预览入口在这里。运行状态、停止原因和后续操作也在同一个位置。" },
] }] };
const projects = [{ id: "p1", name: "Northstar", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];

// Synthetic records only.
const intent = (revision = 0, extra = {}) => ({ revision, desiredState: "unspecified", recoveryMode: "manual", requestedAt: null,
  requestedBy: null, appliesToJobId: null, sourceJobId: null, requestId: null, ...extra });
const run = (extra = {}) => ({ jobId: "demo-84", status: "running", owner: "verified", earlierJobIds: ["demo-71"], canStop: true,
  reason: null, resultReason: null, startedAt: iso(-2 * HOUR), finishedAt: null, timeoutSeconds: 4 * 3600, reserved: true,
  cancelRequestedAt: null, attempt: "a1", ownerCheckedAt: iso(-MIN), ...extra });
// An ended run no longer listens on the port.
const ended = (extra = {}) => run({ owner: "notListening", canStop: false, reserved: false, finishedAt: iso(-10 * MIN), ...extra });
const service = ({ job = run(), chosen = intent(), canStart = false, health, recovery, outcomeUnknown } = {}) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "Northstar · 开发预览", author: { kind: "agent", id: "iris", name: "Iris" },
  createdAt: iso(-3 * HOUR),
  connection: { state: "available", localPort: PORT, httpStatus: 200, framing: "allowed", since: iso(-MIN) },
  job,
  health: health ?? { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-MIN) },
  lifecycle: { intent: chosen, canStart, startBlockedCode: canStart ? null : "service_busy",
    startBlockedReason: canStart ? null : "service_busy: this Job has not conclusively ended without a reservation", sourceJobId: job.jobId,
    ...(recovery ? { recovery } : {}), ...(outcomeUnknown !== undefined ? { outcomeUnknown } : {}) },
});
// Bounded recovery as Core reports it (Dev 5's contract v1): the window of
// demo-84 after two crashes; retry 2 (demo-86) is the current Job.
const armed = intent(2, { desiredState: "running", recoveryMode: "bounded", requestedAt: iso(-2 * HOUR), requestedBy: { kind: "user" },
  appliesToJobId: "demo-84", sourceJobId: "demo-71", requestId: "r-armed" });
const window2 = (extra = {}) => ({ mode: "bounded", state: "waiting", launch: "queued", queueReason: "Waiting for shared machine capacity",
  retry: { scheduled: 2, started: 1, max: 3 }, schedule: [30, 120, 600], deadlineAt: iso(2 * HOUR), retryJobId: "demo-86",
  notBefore: iso(2 * MIN), lastFailure: { kind: "exit", code: 1, jobId: "demo-85", endedAt: iso(-10_000) }, haltedReason: null, haltedAt: null,
  attempts: [{ retry: 0, jobId: "demo-84", startedAt: iso(-2 * HOUR), endedAt: iso(-20 * MIN), outcome: "exit:1" },
    { retry: 1, jobId: "demo-85", startedAt: iso(-19 * MIN), endedAt: iso(-10_000), outcome: "exit:1" },
    { retry: 2, jobId: "demo-86", startedAt: null, endedAt: null, outcome: null }], observedAt: iso(0), ...extra });
const retryRun = (extra = {}) => run({ jobId: "demo-86", earlierJobIds: ["demo-84", "demo-85"], status: "queued", owner: "unknown", reserved: false,
  startedAt: null, attempt: null, ownerCheckedAt: null, ...extra });
const notChecked = { declared: true, path: "/health", state: "unknown" };
const stoppedBy = (request) => intent(request.expectedIntentRevision + 1, { desiredState: "stopped", requestedAt: iso(0),
  requestedBy: { kind: "user" }, appliesToJobId: request.expectedJobId, requestId: request.requestId });
const scenes = {
  running: () => service(),
  expired: () => service({ job: ended({ status: "failed", reason: "timeout", resultReason: "timeout", startedAt: iso(-4 * HOUR - 10 * MIN),
    finishedAt: iso(-10 * MIN) }), canStart: true, health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-11 * MIN) } }),
  unknown: () => service({ job: run({ status: "unknown", owner: "unknown", ownerCheckedAt: iso(-6 * MIN) }),
    health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-6 * MIN) } }),
  retryWaiting: () => service({ job: retryRun(), chosen: armed, health: notChecked, recovery: window2() }),
  retryStarting: () => service({ job: retryRun({ status: "starting", reserved: true }), chosen: armed, health: notChecked,
    recovery: window2({ state: "retry", launch: "starting", queueReason: null }) }),
  restartUnknown: () => service({ job: retryRun({ status: "unknown", reserved: true, startedAt: iso(-MIN) }), chosen: armed, health: notChecked, outcomeUnknown: true,
    recovery: window2({ state: "halted", launch: "unknown", queueReason: null, haltedReason: "core_restart", haltedAt: iso(-30_000) }) }),
  exhausted: () => service({ job: ended({ jobId: "demo-87", status: "failed", reason: "exit code 1", startedAt: iso(-8 * MIN), finishedAt: iso(-MIN) }), chosen: armed, canStart: true,
    health: notChecked, recovery: window2({ state: "exhausted", launch: null, queueReason: null, retry: { scheduled: 3, started: 3, max: 3 }, retryJobId: "demo-87",
      notBefore: null, lastFailure: { kind: "exit", code: 1, jobId: "demo-87", endedAt: iso(-MIN) } }) }),
};
// The service's Job, as the Jobs dialog lists it.
const jobRecord = { id: "demo-84", name: "Northstar 开发预览", requestId: "r-84", taskRef: "T-14", agentId: "iris", agent: { name: "Iris" },
  machine: { name: "Core 主机" }, resources: { cpuMillis: 500, memoryMiB: 512, swapMiB: 0 }, reservation: { cpuMillis: 600, memoryMiB: 576, swapMiB: 0 },
  createdAt: iso(-2 * HOUR), startedAt: iso(-2 * HOUR), finishedAt: null, argv: ["npm", "run", "dev"], cwd: "/fixture", env: {}, cursor: 1,
  reserved: true, status: "running", reason: "Running with verified cgroup limits", timeoutSeconds: 4 * 3600 };
const page404 = "<!doctype html><meta charset=utf-8><title>Northstar</title><body style=\"font:16px system-ui;margin:40px;color:#2c3a2e;background:#f6f1e7\"><h1>Northstar 阅读界面</h1><p>开发预览（合成示例页面）</p></body>";

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ name, width, height, touch, theme }) {
  // Not open until the user opens it from the list.
  const state = { service: scenes.running(), posts: [], opened: false };
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([theme, width]) => {
    window.EventSource = class { constructor() { this.readyState = 0; } close() {} addEventListener() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    localStorage.setItem("yuzuno.portal-width", JSON.stringify({ px: width }));
  }, [theme, SAVED_WIDTH]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // The service's own port, as this browser reaches it: the proof, and its page.
    if (url.host === `127.0.0.1:${PORT}`) {
      if (path.startsWith("/.well-known/yuzuno-service/"))
        return route.fulfill({ body: path.endsWith("/c-check") ? "a-check" : "nope", contentType: "text/plain", headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ body: page404, contentType: "text/html" });
    }
    if (request.method() !== "GET") {
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      // Reads that are POSTs, and change nothing.
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      if (path === "/api/services/s1/open") {
        state.posts.push({ path, body });
        state.opened = true;
        // As Core answers it (services.rs, open_service): the service and its
        // way, never its Job, lifecycle or health, which only the list reads.
        const { job: _job, lifecycle: _lifecycle, health: _health, ...opened } = state.service;
        return route.fulfill({ json: { ...opened, proof: { challenge: "c-check", answer: "a-check" } } });
      }
      if (path === "/api/services/s1/stop") {
        state.posts.push({ path, body });
        const chosen = stoppedBy(body);
        state.service = service({ job: run({ status: "cancelling", canStop: false, cancelRequestedAt: iso(0) }), chosen });
        return route.fulfill({ json: { serviceId: "s1", requestId: body.requestId, action: "stop", intent: chosen, jobId: body.expectedJobId, status: "cancelling" } });
      }
      if (path === "/api/services/s1/start") {
        state.posts.push({ path, body });
        const chosen = intent(body.expectedIntentRevision + 1, { desiredState: "running", requestedAt: iso(0), requestedBy: { kind: "user" },
          appliesToJobId: "demo-85", sourceJobId: body.sourceJobId, requestId: body.requestId });
        state.service = service({ job: run({ jobId: "demo-85", earlierJobIds: ["demo-71", "demo-84"], status: "queued", reserved: false, startedAt: null,
          timeoutSeconds: body.timeoutSeconds, attempt: null, ownerCheckedAt: null }), chosen, health: { declared: true, path: "/health", state: "unknown" } });
        return route.fulfill({ json: { serviceId: "s1", requestId: body.requestId, action: "start", intent: chosen, jobId: "demo-85", status: "queued" } });
      }
      if (path === "/api/services/s1/recovery") {
        // Opting out while retry 2 waits: Core cancels it; it never starts.
        state.posts.push({ path, body });
        const chosen = intent(body.expectedIntentRevision + 1, { desiredState: "running", requestedAt: iso(0), requestedBy: { kind: "user" },
          appliesToJobId: "demo-86", sourceJobId: "demo-71", requestId: body.requestId });
        state.service = service({ job: retryRun({ status: "cancelled", canStop: false, finishedAt: iso(0) }), chosen, canStart: true, health: notChecked,
          recovery: window2({ mode: "manual", state: "off", launch: null, queueReason: null, haltedReason: "opted_out", haltedAt: iso(0) }) });
        return route.fulfill({ json: { serviceId: "s1", requestId: body.requestId, action: "recovery", intent: chosen, jobId: "demo-86", status: "cancelled", cancelledRetryJobId: "demo-86" } });
      }
      report.writes.push(`${name}: ${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { error: "no writes here" } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 1 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/projects/p1/services")
      return route.fulfill({ json: { services: [state.opened ? state.service : { ...state.service, connection: { state: "closed", since: iso(-HOUR) } }] } });
    if (path === "/api/agents/iris") return route.fulfill({ json: conversation });
    if (path === "/api/machines") return route.fulfill({ json: { machines: [{ id: "local", name: "Core 主机", kind: "local", defaultCwd: "/fixture" }] } });
    if (path === "/api/projects/p1/home-editors") return route.fulfill({ json: { version: 0, editorAgentIds: null } });
    if (path.endsWith("/models")) return route.fulfill({ json: { models: [] } });
    if (path.startsWith("/api/jobs/") && path.endsWith("/logs")) {
      // A log as Core pages it (the Jobs view reads its size).
      const text = "15:30  process owner verified\n15:30  GET /health → 200\n";
      return route.fulfill({ json: { text, offset: 0, nextOffset: text.length, oldestOffset: 0, totalBytes: text.length, truncated: false } });
    }
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { ...noJobs, jobs: [jobRecord] } });
    if (path === "/api/jobs/demo-84") return route.fulfill({ json: jobRecord });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci/runs") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
  // A render error the app's boundary catches is only logged.
  page.on("console", (message) => { if (message.type() === "error") report.errors.push(`${name} console: ${message.text().slice(0, 500)}`); });
  await page.goto(`http://${HOST}/`);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, state };
}

/** From the project's services list, as the user opens it. */
async function openService(page, full) {
  await page.locator(".workspace-scope").first().click();
  await page.locator("button", { hasText: /^管理项目…$/ }).click();
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.locator("button", { hasText: "Northstar" }).first().click();
  const panel = dialog.locator('[aria-label="服务"]');
  await panel.locator("button", { hasText: /^打开$/ }).click();
  await panel.locator(".services-open").waitFor({ timeout: 10_000 });
  // Opening answers only the way: the run details stay, and the open choice
  // outlasts the list's next read (every 5 seconds).
  await page.waitForTimeout(5_500);
  assert.equal(await panel.locator(".services-open").count(), 1, "the open choice outlasts the next read");
  assert.equal(await panel.locator("button", { hasText: /^运行情况$/ }).count(), 1, "the run details stay offered");
  await panel.locator(".open-choice-split > .primary-button:not(.open-choice-more)").click();
  await page.locator(".portal-panel .portal-lifecycle").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".portal-panel").getAttribute("role"), full ? "dialog" : "complementary");
}

const lifecycle = (page) => page.locator(".portal-panel .portal-lifecycle");
const headline = (page) => lifecycle(page).locator(".service-lifecycle-heading h3").textContent();
const facts = (page) => lifecycle(page).locator(".portal-fact").evaluateAll((all) => Object.fromEntries(all.map((fact) =>
  [fact.dataset.fact, [...fact.querySelectorAll("b, em")].map((el) => el.textContent)])));
const sideways = (page) => page.evaluate(() => {
  const panel = document.querySelector(".portal-panel");
  return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panel: panel ? panel.scrollWidth - panel.clientWidth : 0,
    lifecycle: [...document.querySelectorAll(".portal-lifecycle, .portal-lifecycle *")].filter((el) => el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX !== "auto" && getComputedStyle(el).overflowX !== "hidden").map((el) => el.className).slice(0, 5) };
});
const refresh = async (page, scene, state) => {
  state.service = scene;
  await lifecycle(page).getByRole("button", { name: "刷新状态" }).click();
};
const waitHeadline = (page, text) => page.waitForFunction((text) => document.querySelector(".portal-lifecycle .service-lifecycle-heading h3")?.textContent === text, text, { timeout: 8_000 });
const writes = (state, kind) => state.posts.filter((p) => p.path === `/api/services/s1/${kind}`);
/**
 * The confirmation is what the user sees: what is painted on top at its
 * middle and at its main button is the dialog, a far corner of the window is
 * under its overlay, focus is inside it, and the page behind does not scroll.
 * While a dialog is open the page refuses pointer events outside it, and hit
 * testing skips such elements, so a covered dialog would still answer clicks
 * and elementFromPoint; for this reading only, every element takes them.
 */
const dialogShown = (page, primary, selector = ".modal.service-control-dialog") => page.evaluate(([primary, selector]) => {
  const probe = Object.assign(document.createElement("style"), { textContent: "*{pointer-events:auto!important}" });
  document.head.append(probe);
  try {
    const dialog = document.querySelector(selector);
    if (!dialog) return { dialog: false };
    const top = (rect) => document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const button = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === primary);
    // Where the user would scroll to reach it on a short screen.
    button?.scrollIntoView({ block: "nearest" });
    const middle = top(dialog.getBoundingClientRect());
    const pressed = button ? top(button.getBoundingClientRect()) : null;
    const corner = document.elementFromPoint(3, innerHeight - 3);
    return {
      dialog: true,
      middle: !!middle && dialog.contains(middle),
      button: primary === null || (!!pressed && !!button && button.contains(pressed)),
      corner: !!corner?.classList?.contains("modal-overlay"),
      focus: dialog.contains(document.activeElement),
      locked: document.body.hasAttribute("data-scroll-locked"),
    };
  } finally {
    probe.remove();
  }
}, [primary, selector]);
/** What is painted on top at an element's middle (pointer events on for the reading only, as above). */
const onTop = (page, selector) => page.evaluate((selector) => {
  const probe = Object.assign(document.createElement("style"), { textContent: "*{pointer-events:auto!important}" });
  document.head.append(probe);
  try {
    const el = document.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && el.contains(top);
  } finally {
    probe.remove();
  }
}, selector);
const shown = { dialog: true, middle: true, button: true, corner: true, focus: true, locked: true };
/** The layers as the page's styles stack them now: the full Portal, a
 * dialog's overlay and box, the handoff strip that must stay above a
 * dialog's overlay while a handoff is dragged out of it, and the Agent
 * actions menu. Read from elements of those classes added for the reading. */
const layers = (page) => page.evaluate(() => {
  const z = (className) => {
    const el = Object.assign(document.createElement("div"), { className });
    el.style.display = "none";
    document.body.append(el);
    try { return Number(getComputedStyle(el).zIndex); } finally { el.remove(); }
  };
  return { portal: Number(getComputedStyle(document.querySelector(".portal-panel")).zIndex),
    overlay: z("modal-overlay"), dialog: z("modal"), strip: z("handoff-strip"), menu: z("agent-actions-menu") };
});

try {
  for (const view of [
    { name: "desktop", width: 1440, height: 900, touch: false, theme: "light" },
    { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark" },
    // Too narrow to leave the chat its width: the Portal covers the window.
    { name: "desktop-narrow", width: 640, height: 900, touch: false, theme: "light", full: true },
    { name: "phone", width: 390, height: 844, touch: true, theme: "light", full: true },
  ].filter((view) => !process.env.YUZUNO_CHECK_VIEWS || process.env.YUZUNO_CHECK_VIEWS.split(",").includes(view.name))) {
    const { context, page, state } = await open(view);
    try {
      await openService(page, !!view.full);
      // Running: the page, and three facts each with its own check.
      await page.locator(".portal-panel iframe").waitFor();
      await waitHeadline(page, "正在运行，预览连接已确认");
      // The Portal's next read (every 5 seconds) keeps the page and the proof.
      await page.waitForTimeout(5_500);
      assert.equal(await page.locator(".portal-panel iframe").count(), 1, "the page outlasts the Portal's next read");
      assert.equal(await headline(page), "正在运行，预览连接已确认");
      const running = await facts(page);
      assert.deepEqual(running.process.slice(0, 2), ["运行中", "端口归属已确认"], JSON.stringify(running));
      assert.match(running.health.join(" "), /^检查通过 \/health · HTTP 200 · \S/);
      assert.match(running.browser.join(" "), /^连接已确认 检查于 \S/);
      if (!view.full) {
        const width = await page.locator(".portal-panel").evaluate((el) => Math.round(el.getBoundingClientRect().width));
        assert.equal(width, SAVED_WIDTH, "the Portal keeps the width saved on this device");
      }
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: running; process, health and this browser apart, each with its own time; the saved width and layout kept`, { running });
      if (view.full) {
        // Over a full Portal: a dialog's overlay, then its box, then the handoff strip above them, the actions menu above all.
        const stack = await layers(page);
        assert.ok(stack.overlay > stack.portal && stack.dialog > stack.overlay, `a dialog shows above the full Portal: ${JSON.stringify(stack)}`);
        assert.ok(stack.strip > stack.overlay, `the handoff strip stays above a dialog's overlay: ${JSON.stringify(stack)}`);
        assert.ok(stack.menu > stack.dialog, `the actions menu stays above a dialog: ${JSON.stringify(stack)}`);
        record(`${view.name}: over the full Portal, a dialog's overlay and box, the handoff strip above its overlay, the actions menu above all`, { stack });

        // Jobs from the full Portal: its dialog is what is seen.
        await lifecycle(page).getByRole("button", { name: "在 Jobs 中查看" }).click();
        const jobs = page.locator(".modal.jobs-dialog");
        await jobs.waitFor();
        const row = jobs.locator("button.job-row[draggable=true]").first();
        await row.waitFor();
        assert.deepEqual(await dialogShown(page, null, ".modal.jobs-dialog"), shown, "the Jobs dialog is seen, above the full Portal");
        await shoot(page, `${view.name}-jobs`);
        if (!view.touch) {
          // The Job dragged out of the dialog: the strip and its Agent are seen
          // on top, and the Agent takes the drag. Let go over the dialog, not
          // the Agent, so nothing is added to a draft.
          const from = await row.boundingBox();
          const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x + 24, start.y + 24, { steps: 6 });
          const chip = page.locator('.handoff-strip .handoff-chip[data-agent-id="iris"]');
          await chip.waitFor({ timeout: 5_000 });
          const to = await chip.boundingBox();
          await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
          await page.waitForFunction(() => document.querySelector('.handoff-chip[data-agent-id="iris"]')?.classList.contains("handoff-accept"), null, { timeout: 5_000 })
            .catch(() => assert.fail("the Agent in the strip never takes the drag (no handoff-accept)"));
          assert.ok(await onTop(page, ".handoff-strip"), "the handoff strip is seen, above the Jobs dialog and the Portal");
          assert.ok(await onTop(page, '.handoff-chip[data-agent-id="iris"]'), "the Agent to drop on is seen");
          await shoot(page, `${view.name}-handoff-strip`);
          const before = report.writes.length;
          await page.mouse.move(start.x, start.y, { steps: 10 });
          await page.mouse.up();
          await page.locator(".handoff-strip").waitFor({ state: "detached", timeout: 5_000 });
          // Nothing was handed off: a sent handoff closes Jobs and opens the Agent; nothing reached the fixture.
          await page.waitForTimeout(300);
          assert.equal(await jobs.count(), 1, "Jobs stays open: no handoff was sent");
          assert.equal(report.writes.length, before, "no request was sent for the drag");
          record(`${view.name}: a Job dragged out of Jobs over the full Portal: the strip and its Agent are seen on top and take the drag`);
        }
        await page.keyboard.press("Escape");
        await jobs.waitFor({ state: "detached" });
        assert.equal(await page.locator(".portal-panel").count(), 1, "closing Jobs leaves the Portal");
        record(`${view.name}: Jobs opened from the full Portal is seen above it, and closing it leaves the Portal`);
      }
      await shoot(page, `${view.name}-running`);

      // Stopping: the confirmation, then "stop requested", not stopped.
      await lifecycle(page).getByRole("button", { name: "停止服务…" }).click();
      const confirm = page.locator(".service-control-dialog");
      await confirm.waitFor();
      assert.match(await confirm.textContent(), /demo-84/);
      assert.deepEqual(await dialogShown(page, "停止服务"), shown, "the stop confirmation is seen, above the Portal");
      await shoot(page, `${view.name}-stop-confirm`);
      if (view.full) {
        // Escape closes the confirmation only; the Portal stays, and nothing is sent.
        await page.keyboard.press("Escape");
        await confirm.waitFor({ state: "detached" });
        assert.equal(await page.locator(".portal-panel").count(), 1);
        assert.equal(writes(state, "stop").length, 0);
        await lifecycle(page).getByRole("button", { name: "停止服务…" }).click();
        await confirm.waitFor();
      }
      record(`${view.name}: the stop confirmation is what is seen, above the Portal, with focus in it and the page behind still`);
      await confirm.getByRole("button", { name: "停止服务", exact: true }).click();
      await waitHeadline(page, "已请求停止，等待退出确认");
      assert.equal(await page.locator(".portal-panel iframe").count(), 0, "no page while it stops");
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^正在停止服务/);
      const [stop] = writes(state, "stop");
      assert.deepEqual([stop.body.expectedJobId, stop.body.expectedIntentRevision, Object.keys(stop.body).length], ["demo-84", 0, 3]);
      record(`${view.name}: a stop names the run it was confirmed for and shows as requested, not done`, { stop: stop.body.expectedJobId });
      if (!view.touch) await shoot(page, `${view.name}-stopping`);

      // The run ended: stopped as you requested, with a manual start.
      await refresh(page, service({ job: ended({ status: "cancelled", cancelRequestedAt: iso(-MIN) }), chosen: state.service.lifecycle.intent, canStart: true }), state);
      await waitHeadline(page, "已按你的选择停止");
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^服务已停止/);
      assert.deepEqual((await facts(page)).browser, ["当前未连接预览", "新运行启动后重新检查"]);
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: stopped as you requested once the run ended; the start is manual`);
      await shoot(page, `${view.name}-user-stopped`);

      // Starting again: a chosen limit, then queued, not ready.
      await lifecycle(page).getByRole("button", { name: "再启动一次…" }).click();
      const start = page.locator(".service-control-dialog");
      await start.waitFor();
      const options = await start.locator(".service-lifetime-options label").allTextContents();
      assert.deepEqual(options, ["1 小时", "4 小时", "24 小时"]);
      await start.getByText("1 小时", { exact: true }).click();
      assert.deepEqual(await dialogShown(page, "启动一次"), shown, "the start confirmation is seen, above the Portal");
      record(`${view.name}: the start confirmation is what is seen, above the Portal`);
      await shoot(page, `${view.name}-start-choice`);
      await start.getByRole("button", { name: "启动一次" }).click();
      await waitHeadline(page, "等待这次运行开始");
      const [started] = writes(state, "start");
      assert.deepEqual({ ...started.body, requestId: typeof started.body.requestId },
        { requestId: "string", expectedJobId: "demo-84", expectedIntentRevision: 1, sourceJobId: "demo-84", timeoutSeconds: 3600 });
      assert.equal(await page.locator(".portal-panel iframe").count(), 0, "a queued run shows no page");
      assert.equal(await lifecycle(page).locator(".service-lifecycle-deadline strong").textContent(), "1 小时，从实际启动时计时");
      record(`${view.name}: a new run starts only from the confirmation, with its limit, and is queued, not ready`, { started: started.body.timeoutSeconds });
      if (!view.touch) await shoot(page, `${view.name}-queued`);

      // Expired: the run's own end, not the clock; then unknown: no second run.
      await refresh(page, scenes.expired(), state);
      await waitHeadline(page, "这次运行已到期");
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^运行期限到了/);
      await shoot(page, `${view.name}-expired`);
      await refresh(page, scenes.unknown(), state);
      await waitHeadline(page, "运行情况还在核对");
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^先确认原来的运行/);
      assert.equal(await lifecycle(page).getByRole("button", { name: "再启动一次…" }).count(), 0, "no start while the run is unknown");
      assert.equal(await lifecycle(page).getByRole("button", { name: "停止服务…" }).count(), 1, "a stop may be asked of an unknown run");
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: expired and unknown each say why there is no page; unknown offers a stop request, no start`);
      await shoot(page, `${view.name}-unknown`);

      // Bounded recovery: retry 2 waits for its earliest time.
      const recoveryLines = () => lifecycle(page).locator(".service-recovery-intent p span").allTextContents();
      await refresh(page, scenes.retryWaiting(), state);
      await waitHeadline(page, "服务已停止，稍后自动再试");
      const waitingLines = await recoveryLines();
      assert.match(waitingLines[0] ?? "", /^第 2 次自动再试（共 3 次）· 等待中 · 最早 .+ 后尝试 · 约 2 分钟后$/, JSON.stringify(waitingLines));
      assert.doesNotMatch(await lifecycle(page).textContent(), /即将开始|将在/);
      assert.deepEqual((await facts(page)).process, ["本轮尚未启动", "等待重试"]);
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^等待自动再试/);
      assert.match(await lifecycle(page).locator(".service-recovery-off").textContent(), /^关闭自动再试会取消等待中的那次再试，服务保持停止$/);
      assert.match(await lifecycle(page).locator(".service-lifecycle-deadline").textContent(), /共用本次截止时间；到期停止，不另开新的运行窗口$/);
      assert.equal(await lifecycle(page).getByRole("button", { name: "再启动一次…" }).count(), 0, "no start while a retry waits");
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: a waiting retry says this round hasn't started, its earliest time and what opt-out cancels`, { lines: waitingLines });
      await shoot(page, `${view.name}-recovery-waiting`);
      if (view.name === "desktop") {
        await lifecycle(page).locator(".service-recovery-details summary").click();
        assert.match(await lifecycle(page).locator(".service-recovery-details").textContent(), /已安排 2 次 · 已启动 1 次 · 上限 3 次/);
        await shoot(page, `${view.name}-recovery-details`);
        await lifecycle(page).locator(".service-recovery-details summary").click();
      }
      // Its stop: no process runs; the waiting retry is cancelled with it.
      await lifecycle(page).getByRole("button", { name: "停止服务…" }).click();
      const retryStop = page.locator(".modal.service-control-dialog");
      await retryStop.waitFor();
      assert.match(await retryStop.textContent(), /现在没有进程在运行；停止只改变接下来会发生的事。/);
      assert.match(await retryStop.textContent(), /也会取消那次等待中的自动再试（最早 .+ 后尝试），之后不会再自动启动。/);
      assert.deepEqual(await dialogShown(page, "停止服务"), shown, "the stop confirmation is seen, above the Portal");
      record(`${view.name}: a waiting retry's stop says no process runs and the retry is cancelled with it`);
      await shoot(page, `${view.name}-recovery-stop`);
      await retryStop.getByRole("button", { name: "继续运行" }).click();
      await retryStop.waitFor({ state: "detached" });

      // In launch preparation: it may run briefly; opting out keeps this round.
      await refresh(page, scenes.retryStarting(), state);
      await waitHeadline(page, "第 2 次自动再试正在准备启动");
      assert.deepEqual(await recoveryLines(), ["第 2 次自动再试（共 3 次）正在准备启动"]);
      assert.match(await lifecycle(page).locator(".service-recovery-off").textContent(), /当前这一轮不受影响，之后不再自动再试$/);
      record(`${view.name}: a retry in launch preparation; opting out keeps this round`);
      if (!view.full || view.touch) await shoot(page, `${view.name}-recovery-starting`);

      // After a Core restart the current run is to be checked: a stop may be asked, no start.
      await refresh(page, scenes.restartUnknown(), state);
      await waitHeadline(page, "运行情况还在核对");
      assert.deepEqual(await recoveryLines(), ["自动再试已关闭（Core 已重启）", "当前这次运行：待核对"]);
      assert.equal(await lifecycle(page).getByRole("button", { name: "停止服务…" }).count(), 1);
      assert.equal(await lifecycle(page).getByRole("button", { name: "再启动一次…" }).count(), 0);
      assert.equal(await lifecycle(page).getByRole("button", { name: "关闭自动再试" }).count(), 0);
      record(`${view.name}: after a Core restart, recovery is off and the current run is to be checked; stop offered, no start`);
      if (!view.full || view.touch) await shoot(page, `${view.name}-recovery-restart-unknown`);

      // All retries used: Start offers the option again, unticked.
      await refresh(page, scenes.exhausted(), state);
      await page.waitForFunction(() => document.querySelector(".service-recovery-intent")?.textContent?.includes("3 次自动再试都已用完"), null, { timeout: 8_000 });
      await lifecycle(page).getByRole("button", { name: "再启动一次…" }).click();
      const restart = page.locator(".modal.service-control-dialog");
      await restart.waitFor();
      const option = restart.locator(".service-recovery-option");
      assert.equal(await option.locator("input").isChecked(), false, "unticked on every start");
      assert.equal(await option.textContent(), "失败后自动再试最多 3 次，分别在 30 秒、2 分钟、10 分钟后；共用本次截止时间；停止、到期或 Core 重启后不会再试");
      assert.deepEqual(await dialogShown(page, "启动一次"), shown, "the start confirmation is seen, above the Portal");
      record(`${view.name}: after the retries are used, Start offers the option unticked, with Core's delays`);
      await shoot(page, `${view.name}-recovery-start`);
      await restart.getByRole("button", { name: "取消" }).click();
      await restart.waitFor({ state: "detached" });

      // Opting out while a retry waits: sent at once, the retry cancelled.
      if (view.name === "desktop" || view.name === "phone") {
        await refresh(page, scenes.retryWaiting(), state);
        await waitHeadline(page, "服务已停止，稍后自动再试");
        await lifecycle(page).getByRole("button", { name: "关闭自动再试" }).click();
        await page.waitForFunction(() => document.querySelector(".service-recovery-intent")?.textContent === "你已关闭自动再试", null, { timeout: 8_000 });
        const [optedOut] = writes(state, "recovery");
        assert.deepEqual({ ...optedOut.body, requestId: typeof optedOut.body.requestId },
          { requestId: "string", expectedJobId: "demo-86", expectedIntentRevision: 2, mode: "manual" });
        assert.deepEqual((await facts(page)).process.slice(0, 1), ["本轮没有启动"]);
        assert.equal(await lifecycle(page).getByRole("button", { name: "再启动一次…" }).count(), 1, "manual from here");
        record(`${view.name}: opting out while a retry waits cancels it; manual from here`);
        await shoot(page, `${view.name}-recovery-opted-out`);
      }

      // Closing the preview stops nothing.
      const before = state.posts.length;
      await page.getByRole("button", { name: view.full ? "返回会话" : "关闭预览" }).first().click();
      await page.locator(".portal-panel").waitFor({ state: "detached" });
      assert.equal(state.posts.length, before, "closing the preview sends nothing");
      assert.deepEqual([writes(state, "stop").length, writes(state, "start").length], [1, 1]);
      record(`${view.name}: closing the preview sends nothing`);
    } catch (error) {
      await page.screenshot({ path: `${output}/failed-${view.name}.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.deepEqual(report.writes, [], "nothing else is written");
  record("no page errors, and nothing else written");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.checks.length} checks, ${report.shots.length} screenshots in ${output}`);
