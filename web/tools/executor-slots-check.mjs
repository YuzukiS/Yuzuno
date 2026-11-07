// T-35 S1: Executors at once, in Chromium (en-US), with every API answered
// here (no Core, no CLI, no daily configuration). Through the real Settings:
// the Workspace's limit and what holds a slot, a new limit saved against the
// version read, and a number outside 1 to 64 not offered; then the task
// board, where a card says where its executor stands (queued with its place,
// starting, running), in English and in Chinese; on a phone, both fit.
// S2: the Workspace's start time limit: 29 is not offered, 120 is saved with
// the limit; in Chinese too.
// S4: a template's own At most at once: a fraction or a negative number holds
// the save, said at the field (in Chinese too); a whole number is saved.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-slots-check.mjs
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
const report = { task: "T-35", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-slots.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
let saved = { version: 1, templates: [{ id: "reviewer", label: "Reviewer", harness: "claude" }] };
const templates = () => ({ workspace: saved, available: saved.templates.map((template) => ({ template, source: "workspace" })),
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false });
// What Core keeps and answers (executor_slots.rs `executor_slots_view`).
let slots = { version: 0, slots: 3, saved: false, startLimitSeconds: 300 };
const slotsView = () => ({ workspace: { ...slots, default: 3 }, limits: { min: 1, max: 64, startLimitSeconds: { min: 30, max: 3600, default: 300 } },
  inUse: { waiting: 2, starting: 1, running: 3 } });
const you = { kind: "user", id: "user", name: "You" };
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const task = (id, title, status, executorSlot) => ({ id, title, description: "", status, version: 2, projectId: "p1", progress: "", blocker: "",
  result: null, github: [], createdAt: ago(90), updatedAt: ago(5), createdBy: you, updatedBy: you, assigneeAgentId: null, executorSlot });
const tasks = [
  task("T-41", "Review the parser change", "doing", { agentId: "e1", state: "running", machine: "local" }),
  task("T-42", "Review the import change", "doing", { agentId: "e2", state: "starting", machine: "local", reason: "its start was not confirmed" }),
  task("T-43", "Review the export change", "doing", { agentId: "e3", state: "waiting", machine: "local", position: 1 }),
  task("T-44", "Review the docs change", "doing", { agentId: "e4", state: "waiting", machine: "local", position: 2 }),
  task("T-45", "Write the release notes", "todo", undefined),
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const reads = new Set(["task_list", "task_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list"]);

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (path === "/api/executor-slots" && method === "PUT") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    if (body.expectedVersion !== slots.version) return route.fulfill({ status: 400, json: { error: "version_conflict: these executor slots changed; reload before saving" } });
    slots = { version: slots.version + 1, slots: body.slots, saved: true, startLimitSeconds: body.startLimitSeconds ?? slots.startLimitSeconds };
    return route.fulfill({ json: slotsView() });
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
    "/api/workspace": { workspace: { id: "ws-executor-slots" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
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

async function openEditor(page) {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("executor");
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "Executor templates" }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator("#settings-editor-executor-templates");
  await box.waitFor({ timeout: 10_000 });
  return box;
}
// Whether a part, and each field in it, fits its own width.
const fits = (box) => box.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, select, textarea, button, .collab-executor-slot")]
    .filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));
const slotTexts = (page) => page.locator(".collab-task-card").evaluateAll((cards) =>
  Object.fromEntries(cards.map((c) => [c.dataset.taskId, c.querySelector(".collab-executor-slot")?.textContent ?? null])));

const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
const other = await context.newPage();
try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- The Workspace's limit, and what holds a slot; a new one saved.
  let box = await openEditor(page);
  const group = box.getByRole("group", { name: "How many executors run at once" });
  const input = group.locator('input[aria-label="Executors at once"]');
  await input.waitFor({ timeout: 10_000 });
  assert.equal(await input.inputValue(), "3");
  await group.getByText("In this Workspace now: 3 running, 1 starting, 2 waiting.").waitFor({ timeout: 10_000 });
  const save = group.getByRole("button", { name: "Save executors at once" });
  assert.equal(await save.isDisabled(), true, "nothing to save yet");
  await input.fill("0");
  await group.getByText("A whole number from 1 to 64.").waitFor({ timeout: 10_000 });
  assert.equal(await save.isDisabled(), true, "0 is not offered");
  await input.fill("5");
  await group.getByText("Unsaved change").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(output, "1-settings-unsaved.png") });
  await save.click();
  await group.getByText("Saved.").waitFor({ timeout: 10_000 });
  const put = report.writes.find((w) => w.path === "/api/executor-slots");
  assert.deepEqual(put.body, { expectedVersion: 0, slots: 5, startLimitSeconds: 300 });
  assert.equal(await save.isDisabled(), true, "what was saved is what is shown");
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "the editor fits its width");
  await group.screenshot({ path: join(output, "2-settings-saved.png") });
  check("the Workspace's limit shown with what holds a slot; 0 not offered; 5 saved against version 0", { body: put.body });

  // ---- S2: the Workspace's start time limit.
  const limitInput = group.locator('input[aria-label="Start time limit (seconds)"]');
  assert.equal(await limitInput.inputValue(), "300");
  await limitInput.fill("29");
  await group.getByText("A whole number of seconds from 30 to 3600.").waitFor({ timeout: 10_000 });
  assert.equal(await save.isDisabled(), true, "29 is not offered");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  // In Chinese the group has its Chinese name: found by its class here.
  const slotsGroup = box.locator(".executor-slots");
  await slotsGroup.getByText("30 到 3600 之间的整数秒。").waitFor({ timeout: 10_000 });
  await slotsGroup.screenshot({ path: join(output, "2c-start-limit-zh.png") });
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await group.getByText("A whole number of seconds from 30 to 3600.").waitFor({ timeout: 10_000 });
  await limitInput.fill("120");
  await save.click();
  await group.getByText("Saved.").waitFor({ timeout: 10_000 });
  const limitPut = report.writes.filter((w) => w.path === "/api/executor-slots").at(-1);
  assert.deepEqual(limitPut.body, { expectedVersion: 1, slots: 5, startLimitSeconds: 120 });
  assert.equal(await limitInput.inputValue(), "120");
  check("the start time limit: 29 not offered (said in Chinese too); 120 saved with the limit against version 1", { body: limitPut.body });

  // ---- A template's own limit (S4).
  await box.locator("details.executor-template-more > summary").first().click(); // YN-2 S2: the rest is folded
  const limitField = box.locator('input[aria-label="At most at once"]');
  const saveTemplates = box.getByRole("button", { name: "Save templates" });
  for (const bad of ["2.5", "-1"]) {
    await limitField.fill(bad);
    await box.getByText("At most at once is a whole number from 1 to 64.").waitFor({ timeout: 10_000 });
    assert.equal(await saveTemplates.isDisabled(), true, `${bad} holds the save`);
  }
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  await box.getByText("同时最多 是 1 到 64 之间的整数。").waitFor({ timeout: 10_000 });
  await box.locator('input[aria-label="同时最多"]').screenshot({ path: join(output, "2b-template-limit-zh.png") });
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await box.getByText("At most at once is a whole number from 1 to 64.").waitFor({ timeout: 10_000 });
  await limitField.fill("2");
  await box.getByText("At most this many of this template’s executors run at once, within Executors at once. Empty: no limit of its own.").waitFor({ timeout: 10_000 });
  await saveTemplates.click();
  // The templates' own actions: the limit group above says Saved. too.
  await box.locator(".executor-templates-actions:not(.executor-slots-actions)").getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
  const templatesPut = report.writes.find((w) => w.path === "/api/executor-templates");
  assert.deepEqual(templatesPut.body, { expectedVersion: 1, templates: [{ id: "reviewer", label: "Reviewer", harness: "claude", maxConcurrent: 2 }] });
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "the editor fits its width");
  check("a template's own limit: 2.5 and -1 hold the save, said at the field (in Chinese too); 2 is saved", { body: templatesPut.body });

  // ---- The board: each card says where its executor stands.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Tasks & messages", exact: true }).click({ timeout: 10_000 });
  await page.locator('.collab-task-card[data-task-id="T-43"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(await slotTexts(page), { "T-41": "Running", "T-42": "Start not finished: its start was not confirmed",
    "T-43": "Queued (number 1)", "T-44": "Queued (number 2)", "T-45": null });
  assert.equal(await page.locator('.collab-task-card[data-task-id="T-42"] .collab-executor-slot').getAttribute("title"),
    "Its executor keeps its slot, open; its start didn't finish: its start was not confirmed. Connect starts it again; Close frees its slot.");
  await page.locator(".collab-cards").screenshot({ path: join(output, "3-board-en.png") });
  check("each card says queued with its place, a start not finished with why, or running; one without an executor says nothing");

  // ---- In Chinese after a language change elsewhere.
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  await page.locator('.collab-task-card[data-task-id="T-43"] .collab-executor-slot', { hasText: "排队中（第 1 位）" }).waitFor({ timeout: 10_000 });
  assert.deepEqual(await slotTexts(page), { "T-41": "运行中", "T-42": "启动未完成：its start was not confirmed", "T-43": "排队中（第 1 位）", "T-44": "排队中（第 2 位）", "T-45": null });
  await page.locator(".collab-cards").screenshot({ path: join(output, "4-board-zh.png") });
  check("in Chinese: 排队中（第 n 位）, 启动未完成：…, 运行中");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await page.locator('.collab-task-card[data-task-id="T-43"] .collab-executor-slot', { hasText: "Queued (number 1)" }).waitFor({ timeout: 10_000 });

  // ---- On a phone: the cards and the editor fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Tasks & messages", exact: true }).click({ timeout: 10_000 });
  await page.locator('.collab-task-card[data-task-id="T-44"]').waitFor({ timeout: 10_000 });
  for (const id of ["T-41", "T-42", "T-44"]) {
    assert.deepEqual(await fits(page.locator(`.collab-task-card[data-task-id="${id}"]`)), { box: true, wider: [] }, `${id} fits on a phone`);
  }
  await page.screenshot({ path: join(output, "5-board-phone.png"), fullPage: false });
  await page.keyboard.press("Escape");
  box = await openEditor(page);
  await box.locator('input[aria-label="Executors at once"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "on a phone the editor fits its width");
  await box.getByRole("group", { name: "How many executors run at once" }).screenshot({ path: join(output, "6-settings-phone.png") });
  check("at 390 px the cards and the editor fit their width");

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), ["PUT /api/executor-slots", "PUT /api/executor-slots", "PUT /api/executor-templates"],
    "the three saves, nothing else written");
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
