// T-35 S3: where executors run, in Chromium (en-US), with every API answered
// here (no Core, no CLI, no daily configuration). Through the real app:
//   1. the Machines editor: a machine's own executor limit, saved after the
//      machine against the version read;
//   2. the Core host's card: its own executor limit, through the route for local;
//   3. the template editor: Runs on offers this Core host, each machine and
//      auto, says what auto means, and a save keeps it;
//   4. the task card: the machine auto chose, and in its title how.
// Each at 1440 and 390 px, light and dark: every part fits its width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-machines-check.mjs
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
const report = { task: "T-35 S3", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-machines.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture", lab: "/srv/lab" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
let machines = [
  { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null },
  { id: "lab", name: "Lab box", kind: "ssh", target: "lab", codex: "codex", defaultCwd: "/srv/lab", lastCheck: null },
  { id: "boxed", name: "Boxed", kind: "ssh", target: "boxed", codex: "codex", defaultCwd: "/srv/boxed", contained: true, lastCheck: null },
];
// What Core keeps and answers (executor_slots.rs `executor_slots_view`).
let limits = [{ id: "local", name: "this Core host", version: 0, slots: null, executors: 1 },
  { id: "lab", name: "Lab box", version: 2, slots: 3, executors: 1 }, { id: "boxed", name: "Boxed", version: 0, slots: null, executors: 0 }];
const slotsView = () => ({ workspace: { version: 0, slots: 3, saved: false, default: 3, startLimitSeconds: 300 },
  limits: { min: 1, max: 64, startLimitSeconds: { min: 30, max: 3600, default: 300 } }, inUse: { waiting: 1, starting: 0, running: 2 }, machines: limits });
let saved = { version: 1, templates: [{ id: "reviewer", label: "Reviewer", harness: "claude" }] };
const templates = () => ({ workspace: saved, available: saved.templates.map((template) => ({ template, source: "workspace" })),
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false });
const you = { kind: "user", id: "user", name: "You" };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const task = (id, title, status, executorSlot) => ({ id, title, description: "", status, version: 2, projectId: "p1", progress: "", blocker: "",
  result: null, github: [], createdAt: ago(90), updatedAt: ago(5), createdBy: you, updatedBy: you, assigneeAgentId: null, executorSlot });
const choice = { requested: "auto", chosen: "lab", candidates: [
  { machine: "lab", name: "Lab box", freeSlot: true, executors: 0, limit: 3, budget: { cpuMillis: 4000, memoryMiB: 8192 },
    reserved: { cpuMillis: 0, memoryMiB: 1024 }, spare: { cpuMillis: 4000, memoryMiB: 7168 } },
  { machine: "local", name: "this Core host", freeSlot: true, executors: 1, limit: null, budget: { cpuMillis: 2000, memoryMiB: 4096 },
    reserved: { cpuMillis: 1000, memoryMiB: 2048 }, spare: { cpuMillis: 1000, memoryMiB: 2048 } },
  { machine: "boxed", name: "Boxed", excluded: "it keeps its Agents contained, and runs no Codex Agent there" },
] };
const tasks = [
  task("T-51", "Review the parser change", "doing", { agentId: "e1", state: "running", machine: "lab", choice }),
  task("T-52", "Review the import change", "doing", { agentId: "e2", state: "waiting", machine: "local", position: 1 }),
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const reads = new Set(["task_list", "task_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list"]);

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  const limitPut = path.match(/^\/api\/machines\/([^/]+)\/executor-slots$/);
  if (limitPut && method === "PUT") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    const id = decodeURIComponent(limitPut[1]);
    const own = limits.find((m) => m.id === id);
    if (!own || body.expectedVersion !== own.version) return route.fulfill({ status: 400, json: { error: "version_conflict: these executor slots changed; reload before saving" } });
    limits = limits.map((m) => (m.id === id ? { ...m, version: m.version + 1, slots: body.slots } : m));
    return route.fulfill({ json: slotsView() });
  }
  const machinePut = path.match(/^\/api\/machines\/([^/]+)$/);
  if (machinePut && method === "PUT") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    const id = decodeURIComponent(machinePut[1]);
    machines = machines.map((m) => (m.id === id ? { ...m, ...body } : m));
    return route.fulfill({ json: machines.find((m) => m.id === id) });
  }
  if (path === "/api/executor-templates" && method === "PUT") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    if (body.expectedVersion !== saved.version) return route.fulfill({ status: 400, json: { error: "version_conflict: these executor templates changed; reload before saving" } });
    saved = { version: saved.version + 1, templates: body.templates };
    return route.fulfill({ json: templates() });
  }
  if (method !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    const body = JSON.parse(request.postData() || "{}");
    if (!reads.has(op)) {
      report.writes.push({ method, path });
      return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
    }
    const own = tasks.find((t) => t.id === body.taskId);
    const answer = {
      task_list: () => {
        const open = body.statuses ? tasks.filter((t) => body.statuses.includes(t.status)) : tasks;
        const counts = {};
        for (const t of open) counts[t.status] = (counts[t.status] || 0) + 1;
        return { tasks: open, counts, hasMore: false, nextAfterSeq: null };
      },
      task_get: () => ({ task: own, activities: [], executions: [], hasMore: false }),
      github_links: () => ({ links: [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: [], repositories: [], refreshing: false }),
      github_repositories: () => ({ repositories: [], links: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "claude", model: "opus" } }),
      peers_list: () => ({ peers: [{ id: agent.id, name: agent.name }] }),
    }[op];
    return route.fulfill({ json: answer() });
  }
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-machines" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/executor-templates": templates(), "/api/executor-slots": slotsView(),
  }[path];
  if (json) return route.fulfill({ json });
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
});

async function openSettingsCard(page, search, title) {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill(search);
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
  await card.locator("button").last().click({ timeout: 10_000 });
}
async function openMachines(page) {
  await openSettingsCard(page, "SSH", "Execution machines & SSH");
  const dialog = page.getByRole("dialog", { name: "Machines" });
  await dialog.waitFor({ timeout: 10_000 });
  return dialog;
}
async function openTemplates(page) {
  await openSettingsCard(page, "executor", "Executor templates");
  const box = page.locator("#settings-editor-executor-templates");
  await box.waitFor({ timeout: 10_000 });
  return box;
}
async function openBoard(page) {
  await page.getByRole("button", { name: "Tasks & messages", exact: true }).click({ timeout: 10_000 });
  await page.locator('.collab-task-card[data-task-id="T-51"]').waitFor({ timeout: 10_000 });
}
// Whether a part, and each field in it, fits its own width.
const fits = (box) => box.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, select, textarea, button, .collab-executor-slot")]
    .filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));
const options = (select) => select.evaluate((el) => [...el.options].map((o) => o.value));

const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });

  // ---- 1. The Machines editor: Lab box's own limit, saved after the machine.
  let dialog = await openMachines(page);
  await dialog.getByRole("button", { name: "Edit Lab box" }).click({ timeout: 10_000 });
  const editor = dialog.locator(".remote-machine-editor");
  const field = editor.locator('input[aria-label="Executors at once"]');
  await field.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('.remote-machine-editor input[aria-label="Executors at once"]')?.value === "3", null, { timeout: 10_000 });
  await editor.getByText("Lowering it stops no running executor").waitFor({ timeout: 10_000 });
  await field.fill("5");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await editor.waitFor({ state: "detached", timeout: 10_000 });
  const lab = report.writes.filter((w) => w.path.startsWith("/api/machines/lab"));
  assert.deepEqual(lab.map((w) => w.path), ["/api/machines/lab", "/api/machines/lab/executor-slots"]);
  assert.deepEqual(lab[1].body, { expectedVersion: 2, slots: 5 });
  check("1 the Machines editor: Lab box's limit 3 read, 5 saved after the machine against version 2", { body: lab[1].body });

  // ---- 2. The Core host's card: its own limit, through the route for local.
  const host = dialog.locator('[data-machine-id="local"] .machine-executor-limit');
  await host.waitFor({ timeout: 10_000 });
  await host.getByText("1 on this machine now.").waitFor({ timeout: 10_000 });
  await host.locator("input").fill("2");
  await host.getByRole("button", { name: "Save executors at once" }).click();
  await host.getByText("Saved.").waitFor({ timeout: 10_000 });
  const local = report.writes.find((w) => w.path === "/api/machines/local/executor-slots");
  assert.deepEqual(local.body, { expectedVersion: 0, slots: 2 });
  check("2 the Core host card: its own limit 2 saved through the route for local against version 0", { body: local.body });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", timeout: 10_000 });

  // ---- 3. The template editor: Runs on, auto explained, and kept on save.
  let box = await openTemplates(page);
  await box.locator('input[aria-label="Label"]').first().waitFor({ timeout: 10_000 });
  await box.locator("details.executor-template-more > summary").first().click(); // YN-2 S2: the rest is folded
  const runsOn = box.locator('select[aria-label="Runs on"]');
  await runsOn.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector('#settings-editor-executor-templates select[aria-label="Runs on"]')?.options.length === 4, null, { timeout: 10_000 });
  assert.deepEqual(await options(runsOn), ["", "lab", "boxed", "auto"], "Claude Code: this Core host, each machine, auto");
  await runsOn.selectOption("auto");
  await box.getByText("Core chooses at each dispatch: a machine with a free executor slot first").waitFor({ timeout: 10_000 });
  await box.getByRole("button", { name: "Save templates" }).click();
  await box.locator(".executor-templates-actions:not(.executor-slots-actions)").getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
  const put = report.writes.find((w) => w.path === "/api/executor-templates");
  assert.equal(put.body.templates[0].machineId, "auto");
  assert.equal(await runsOn.inputValue(), "auto", "kept as saved");
  check("3 the template editor: Runs on offers this Core host, Lab box, Boxed and auto; auto explained and saved", { body: put.body.templates[0] });
  await page.keyboard.press("Escape");

  // ---- 4. The task card: the machine auto chose, and how.
  await openBoard(page);
  const chip = page.locator('.collab-task-card[data-task-id="T-51"] .collab-executor-slot');
  assert.equal(await chip.textContent(), "Running · Lab box (chosen automatically)");
  const title = await chip.getAttribute("title");
  assert.match(title, /Chosen automatically\. The machines in the order Core weighed them:/);
  assert.match(title, /Lab box: a free executor slot \(0 running, limit 3\); 7168 of 8192 MiB and 4 of 4 CPUs spare in its Jobs budget/);
  assert.match(title, /Boxed: left out: it keeps its Agents contained/);
  assert.equal(await page.locator('.collab-task-card[data-task-id="T-52"] .collab-executor-slot').textContent(), "Queued (number 1)", "no choice, as before");
  check("4 the task card: Lab box (chosen automatically), with every candidate's numbers in its title");

  // ---- Each part at 1440 and 390, light and dark: it fits its width.
  for (const [width, scheme] of [[1440, "light"], [1440, "dark"], [390, "light"], [390, "dark"]]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    // Appearance is this device's own setting (light by default), read at load.
    await page.evaluate((theme) => localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" })), scheme);
    await page.reload();
    await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
    const at = `${width}-${scheme}`;
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), scheme, `${at}: the page is in the ${scheme} theme`);
    dialog = await openMachines(page);
    await dialog.getByRole("button", { name: "Edit Lab box" }).click({ timeout: 10_000 });
    const shownEditor = dialog.locator(".remote-machine-editor");
    await shownEditor.locator('input[aria-label="Executors at once"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(await fits(shownEditor), { box: true, wider: [] }, `${at}: the Machines editor fits`);
    // The editor is taller than a screen: the shot is the new field, with its help.
    await shownEditor.locator("label", { has: page.locator('input[aria-label="Executors at once"]') })
      .screenshot({ path: join(output, `1-machine-editor-${at}.png`) });
    const shownHost = dialog.locator('[data-machine-id="local"] .machine-executor-limit');
    await shownHost.waitFor({ timeout: 10_000 });
    assert.deepEqual(await fits(shownHost), { box: true, wider: [] }, `${at}: the Core host control fits`);
    await shownHost.screenshot({ path: join(output, `2-core-host-limit-${at}.png`) });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    box = await openTemplates(page);
    await box.locator('input[aria-label="Label"]').first().waitFor({ timeout: 10_000 });
    await box.locator("details.executor-template-more > summary").first().click(); // YN-2 S2: the rest is folded
    await box.locator('select[aria-label="Runs on"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(await fits(box), { box: true, wider: [] }, `${at}: the template editor fits`);
    await box.locator("label.settings-row", { has: page.locator('select[aria-label="Runs on"]') }).first()
      .screenshot({ path: join(output, `3-template-runs-on-${at}.png`) });
    await page.keyboard.press("Escape");
    await openBoard(page);
    const card = page.locator('.collab-task-card[data-task-id="T-51"]');
    assert.deepEqual(await fits(card), { box: true, wider: [] }, `${at}: the task card fits`);
    await card.screenshot({ path: join(output, `4-task-card-${at}.png`) });
    check(`${at}: the Machines editor, the Core host control, the template editor and the task card fit their width`);
    await page.keyboard.press("Escape");
  }

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`),
    ["PUT /api/machines/lab", "PUT /api/machines/lab/executor-slots", "PUT /api/machines/local/executor-slots", "PUT /api/executor-templates"],
    "the four saves, nothing else written");
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
