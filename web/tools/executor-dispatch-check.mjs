// T-34 S2, YN-2 S1/S2: giving a task to a new executor, in Chromium, with
// every API answered here (no Core, no CLI, no daily configuration). Through
// the real Tasks & messages window: the task's dispatch form offers a
// general executor, then its Project's templates, then the Workspace's; one is chosen and sent as
// `executor`, never as an Agent; afterwards the rail marks the executor Core
// made. In Chinese on a phone, the form fits its width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-dispatch-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-34", checks: [], reads: [], writes: [], unexpected: [], errors: [], console: [], unmodelled: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-dispatch.test";

const you = { kind: "user", id: "user", name: "You" };
const base = { status: "idle", harness: "codex", cwd: "/fixture/app", model: "gpt-6", projectId: "p1", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected", closedAt: null };
const mori = { ...base, id: "a", name: "Mori", color: "sage" };
const executor = { ...base, id: "x", name: "T-7 · Reviewer", harness: "claude", model: "", color: "sky", kind: "executor", status: "offline", connectionState: "connecting" };
let agents = [mori];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, archivedAt: null, createdAt: "", updatedAt: "" }];
let current = { id: "T-7", title: "Review the preview fix", description: "Read the change and say what is missing.", status: "todo",
  progress: "", blocker: "", result: null, github: [], projectId: "p1", version: 1, assigneeAgentId: null, assignee: null,
  createdAt: "", createdBy: you, updatedAt: "", updatedBy: you };
// What Core answers for the task's Project (executor_templates::view).
const view = { workspace: { version: 2, templates: [] }, presets: [],
  available: [
    { template: { id: "reviewer", label: "Reviewer", harness: "claude", instructions: "Read the acceptance first." }, source: "workspace" },
    { template: { id: "builder", label: "Builder", harness: "codex" }, source: "workspace" },
  ],
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false,
  general: { label: "Executor", harness: "claude", harnessSource: "project" } };
// Well-formed answers for what the selected Agent's panels read: `{}` there
// sends the app to its error boundary with no page error (browser pitfalls).
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const reads = new Set(["task_list", "task_get", "github_links", "github_refresh", "delivery_get", "peers_list", "github_repositories", "peer_read"]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}${url.search}`);
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) {
    return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  }
  if (method === "POST" && path === "/api/collaboration/task_dispatch") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    current = { ...current, status: "doing", version: current.version + 1, assigneeAgentId: "x", assignee: { kind: "agent", id: "x", name: executor.name } };
    agents = [mori, executor];
    return route.fulfill({ json: { task: current, agentId: "x", message: { id: "m-1" } } });
  }
  if (method !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    const body = JSON.parse(request.postData() || "{}");
    if (!reads.has(op)) {
      report.writes.push({ method, path, body });
      return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
    }
    const answer = {
      task_list: () => ({ tasks: [current], counts: { [current.status]: 1 }, hasMore: false, nextAfterSeq: null }),
      task_get: () => ({ task: current, activities: [{ seq: 1, taskId: "T-7", kind: "created", actor: you, at: "" }], executions: [], hasMore: false }),
      github_links: () => ({ links: [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: [], repositories: [], refreshing: false }),
      github_repositories: () => ({ repositories: [], links: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "claude", model: "opus" } }),
      peers_list: () => ({ peers: agents.map((a) => ({ id: a.id, name: a.name })) }),
      peer_read: () => ({ messages: [], hasMore: false }),
    }[op];
    return route.fulfill({ json: answer() });
  }
  if (method !== "GET" && path.startsWith("/api/")) {
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/executor-templates") {
    assert.equal(url.searchParams.get("projectId"), "p1", "the templates read are the task's Project's");
    return route.fulfill({ json: view });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws-executor-dispatch" }, projects, projectUsage: { p1: { agents: agents.length, tasks: 1 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": () => ({ generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] }),
    "/api/pr-operations": () => ({ operations: [], repositories: [], hasMore: false, nextBefore: null }),
    "/api/pr-reviews": () => ({ settings: { harness: "claude", model: "opus" }, reviews: [], hasMore: false, nextBefore: null }),
    "/api/updates": () => unmanagedUpdates, "/api/jobs/budget": () => idleJobsBudget, "/api/jobs": () => noJobs, "/api/jobs/live": () => noLiveJobs,
    "/api/ci": () => noCiRuns, "/api/reviews": () => noReviews, "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/agents/")) {
    const agent = agents.find((a) => path.split("/")[3] === a.id);
    if (agent && path === `/api/agents/${agent.id}`) return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    if (path.endsWith("/codex/usage")) return route.fulfill({ json: usage });
    if (path.endsWith("/codex/mcp")) return route.fulfill({ json: mcp });
  }
  if (path.startsWith("/api/")) {
    report.unmodelled[path] = (report.unmodelled[path] || 0) + 1;
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open({ width, locale, language }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.addInitScript((language) => {
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 50); } close() {} };
    if (language) localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, language);
  await context.route("**/*", serve);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  // Kept for reading a failure; not counted.
  page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
  await page.goto(`https://${HOST}/`);
  return page;
}
async function dispatchForm(page, names) {
  await page.getByRole("button", { name: names.tasks, exact: true }).click({ timeout: 10_000 });
  await page.locator('.collab-task-card[data-task-id="T-7"]').click({ timeout: 10_000 });
  await page.getByRole("button", { name: names.give }).click({ timeout: 10_000 });
  const form = page.locator(".collab-detail .collab-inset").filter({ has: page.locator(".collab-dispatch-from") });
  await form.waitFor({ timeout: 10_000 });
  return form;
}
const fits = (box) => box.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, select, textarea, button")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));

try {
  // ---- Wide, in English: the templates offered, one chosen and sent.
  let page = await open({ width: 1280, locale: "en-US" });
  let form = await dispatchForm(page, { tasks: "Tasks & messages", give: "Give to agent" });
  assert.equal(await form.getByLabel("An existing agent").isChecked(), true, "an existing agent comes first");
  await form.getByLabel("A new executor").check();
  const picker = form.locator("select").last();
  await page.waitForFunction((el) => el.options.length === 3, await picker.elementHandle(), { timeout: 10_000 });
  assert.deepEqual(await picker.locator("option").allTextContents(),
    ["General executor · Claude Code (this project’s default)", "Reviewer", "Builder"]);
  assert.equal(await form.getByRole("button", { name: "Create and send" }).isDisabled(), false, "a general executor needs no template");
  await picker.selectOption("reviewer");
  await form.getByText("Core creates an agent for this task, a general one or from the template you choose").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(output, "1-form.png") });
  await form.getByRole("button", { name: "Create and send" }).click();
  await page.getByText("Task sent.").waitFor({ timeout: 10_000 });
  const sent = report.writes.find((w) => w.path === "/api/collaboration/task_dispatch");
  assert.ok(sent, "a dispatch was sent");
  const { requestId, ...body } = sent.body;
  assert.equal(typeof requestId, "string");
  assert.deepEqual(body, { taskId: "T-7", expectedVersion: 1, executor: { templateId: "reviewer" }, priority: "normal" });
  await page.screenshot({ path: join(output, "2-sent.png") });
  check("a general executor, then the Workspace's templates, offered; the chosen one sent as executor, with no Agent", { body });

  // ---- The rail marks the executor Core made.
  await page.reload();
  const row = page.locator('.agent-row[data-agent-id="x"]');
  await row.waitFor({ timeout: 10_000 });
  assert.equal(await row.locator(".agent-kind-badge").innerText(), "Executor");
  assert.match(await row.locator(".agent-select").getAttribute("aria-description"), /^Executor · /);
  assert.equal(await page.locator('.agent-row[data-agent-id="a"] .agent-kind-badge').count(), 0, "a standing Agent has no label");
  await row.screenshot({ path: join(output, "3-rail.png") });
  check("the rail labels the executor Executor, and a standing Agent nothing");
  await page.context().close();

  // ---- In Chinese on a phone: the form fits.
  current = { ...current, status: "todo", version: 1, assigneeAgentId: null, assignee: null };
  page = await open({ width: 390, locale: "zh-CN", language: "zh-Hans" });
  form = await dispatchForm(page, { tasks: "任务与消息", give: "交给 Agent" });
  await form.getByLabel("新建执行者").check();
  await page.waitForFunction((el) => el.options.length === 3, await form.locator("select").last().elementHandle(), { timeout: 10_000 });
  await form.getByText("Core 为这个任务创建一个 Agent（通用的，或按你选的模板）").waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(form), { box: true, wider: [] }, "on a phone the form fits its width");
  await page.screenshot({ path: join(output, "4-phone-zh.png") });
  check("in Chinese at 390 px the dispatch form and each field fit their width");
  await page.context().close();

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), ["POST /api/collaboration/task_dispatch"], "one dispatch, nothing else written");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
