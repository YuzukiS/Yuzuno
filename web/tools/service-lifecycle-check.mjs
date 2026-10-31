// A managed service's lifecycle in the Portal (T-14), in a real browser: the
// project's services list opens it beside the chat at its saved width (full
// screen on a phone); process, HTTP health and this browser's check are
// three facts; stopping is first "stop requested", then "stopped as you
// requested" once the run ends; a new run starts only with a chosen limit and
// is queued, not ready; an expired or unknown run shows why instead of a
// page, and closing the preview stops nothing. Desktop light and dark and a
// 390 px phone, in Chinese. Production bundle with an explicit API fixture:
// no Core, synthetic data; only the service's own open, stop and start are
// sent, to the fixture.
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
const service = ({ job = run(), chosen = intent(), canStart = false, health } = {}) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "Northstar · 开发预览", author: { kind: "agent", id: "iris", name: "Iris" },
  createdAt: iso(-3 * HOUR),
  connection: { state: "available", localPort: PORT, httpStatus: 200, framing: "allowed", since: iso(-MIN) },
  job,
  health: health ?? { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-MIN) },
  lifecycle: { intent: chosen, canStart, startBlockedCode: canStart ? null : "service_busy",
    startBlockedReason: canStart ? null : "service_busy: this Job has not conclusively ended without a reservation", sourceJobId: job.jobId },
});
const stoppedBy = (request) => intent(request.expectedIntentRevision + 1, { desiredState: "stopped", requestedAt: iso(0),
  requestedBy: { kind: "user" }, appliesToJobId: request.expectedJobId, requestId: request.requestId });
const scenes = {
  running: () => service(),
  expired: () => service({ job: ended({ status: "failed", reason: "timeout", resultReason: "timeout", startedAt: iso(-4 * HOUR - 10 * MIN),
    finishedAt: iso(-10 * MIN) }), canStart: true, health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-11 * MIN) } }),
  unknown: () => service({ job: run({ status: "unknown", owner: "unknown", ownerCheckedAt: iso(-6 * MIN) }),
    health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-6 * MIN) } }),
};
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
    if (path.startsWith("/api/jobs/") && path.endsWith("/logs")) return route.fulfill({ json: { text: "15:30  process owner verified\n15:30  GET /health → 200" } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
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
async function openService(page, touch) {
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
  assert.equal(await page.locator(".portal-panel").getAttribute("role"), touch ? "dialog" : "complementary");
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

try {
  for (const view of [
    { name: "desktop", width: 1440, height: 900, touch: false, theme: "light" },
    { name: "desktop-dark", width: 1440, height: 900, touch: false, theme: "dark" },
    { name: "phone", width: 390, height: 844, touch: true, theme: "light" },
  ].filter((view) => !process.env.YUZUNO_CHECK_VIEWS || process.env.YUZUNO_CHECK_VIEWS.split(",").includes(view.name))) {
    const { context, page, state } = await open(view);
    try {
      await openService(page, view.touch);
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
      if (!view.touch) {
        const width = await page.locator(".portal-panel").evaluate((el) => Math.round(el.getBoundingClientRect().width));
        assert.equal(width, SAVED_WIDTH, "the Portal keeps the width saved on this device");
      }
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: running; process, health and this browser apart, each with its own time; the saved width and layout kept`, { running });
      await shoot(page, `${view.name}-running`);

      // Stopping: the confirmation, then "stop requested", not stopped.
      await lifecycle(page).getByRole("button", { name: "停止服务…" }).click();
      const confirm = page.locator(".service-control-dialog");
      await confirm.waitFor();
      assert.match(await confirm.textContent(), /demo-84/);
      if (!view.touch) await shoot(page, `${view.name}-stop-confirm`);
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
      await waitHeadline(page, "运行情况还待核实");
      assert.match(await page.locator(".portal-panel .portal-idle").textContent(), /^先确认原来的运行/);
      assert.equal(await lifecycle(page).getByRole("button", { name: "再启动一次…" }).count(), 0, "no start while the run is unknown");
      assert.deepEqual(await sideways(page), { page: 0, panel: 0, lifecycle: [] });
      record(`${view.name}: expired and unknown each say why there is no page; unknown offers no start`);
      await shoot(page, `${view.name}-unknown`);

      // Closing the preview stops nothing.
      const before = state.posts.length;
      await page.getByRole("button", { name: view.touch ? "返回会话" : "关闭预览" }).first().click();
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
