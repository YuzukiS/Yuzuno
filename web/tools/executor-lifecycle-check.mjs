// T-36 S3: an executor's lifecycle in Chromium, with every API answered
// here (no Core, no CLI, no daily configuration). At 1440 and 390 wide, in
// light and dark: the sidebar lists the Project's lead, its other Agent, its
// task executors by attention (failed, delivered awaiting release, running,
// archiving, queued or starting) with each badge's state, and folds the
// archived one; Home's Needs you lists the executors you dispatched; a
// task's card and view say its executor's state; Release says what an
// archiving executor waits for. Once more in Chinese at 1440, light.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-lifecycle-check.mjs
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
const report = { task: "T-36", checks: [], screenshots: [], unexpected: [], writes: [], posts: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-lifecycle.test";

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const you = { kind: "user", id: "user", name: "You" };
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", status: "idle", harness: "codex", createdAt: "", updatedAt: ago(5),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected" };
const lead = { ...base, id: "mori", name: "Mori", kind: "lead" };
const standing = { ...base, id: "hana", name: "Hana", color: "plum" };
const byLead = { kind: "agent", id: "mori", name: "Mori" };
const executor = (n, label, state, extra = {}, lifecycle = {}) => ({
  ...base, id: `e${n}`, name: `T-${n} · ${label}`, kind: "executor",
  executor: { state, agentId: `e${n}`, dispatcher: { kind: "user" }, task: { id: `T-${n}`, title: titles[n] }, since: ago(n - 40), ...lifecycle },
  ...extra,
});
const titles = { 50: "Review the release notes", 51: "Review the parser change", 52: "Review the import change", 53: "Build the export",
  54: "Review the docs change", 55: "Build the installer", 56: "Review the settings change" };
const CLOSED = ago(20);
// In the workspace's own order; the sidebar orders them.
const agents = [
  executor(55, "Builder", "queued", {}, { position: 1, dispatcher: byLead }),
  standing,
  executor(53, "Builder", "running", { status: "working" }, { dispatcher: byLead }),
  executor(50, "Reviewer", "archived", { closedAt: CLOSED, releasedAt: CLOSED, releasedBy: "user", status: "offline" }),
  executor(52, "Reviewer", "delivering"),
  lead,
  executor(54, "Reviewer", "archiving", {}, { reason: "Waiting to close: a Job is still running: cargo test (j1).", dispatcher: byLead }),
  executor(56, "Reviewer", "starting", { status: "offline" }),
  executor(51, "Reviewer", "failed", { closedAt: CLOSED, status: "offline" }, { reason: "The runtime may still be running there: held for you" }),
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
// Core lists the executors you dispatched only: T-52's result, T-51's failed start.
const needs = [
  { kind: "executor", projectId: "p1", agentId: "e51", agentName: "T-51 · Reviewer", state: "failed", taskId: "T-51", title: titles[51],
    reason: "The runtime may still be running there: held for you", since: ago(20) },
  { kind: "executor", projectId: "p1", agentId: "e52", agentName: "T-52 · Reviewer", state: "delivering", taskId: "T-52", title: titles[52], since: ago(12) },
];
const counts = { working: 1, idle: 4, waiting: 0, error: 0, offline: 2, total: 7 };
const home = { generatedAt: ago(0), order: ["p1"], needsYou: needs,
  projects: [{ project: { id: "p1", name: "Yuzuno" }, agents: counts, errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }] };
const task = (n, status, extra = {}) => {
  const own = agents.find((a) => a.id === `e${n}`);
  return { id: `T-${n}`, title: titles[n], description: "", status, version: 2, projectId: "p1", progress: "", blocker: "", result: null, github: [],
    createdAt: ago(300), updatedAt: ago(n - 40), createdBy: you, updatedBy: you, assigneeAgentId: own.id, executor: own.executor, ...extra };
};
const tasks = [
  task(52, "review", { result: { summary: "Reviewed: two findings fixed.", links: [], reportedAt: ago(12), reportedBy: { kind: "agent", id: "e52", name: "T-52 · Reviewer" } } }),
  task(51, "blocked", { blocker: "Its executor did not start: the runtime may still be running there." }),
  task(53, "doing", { progress: "Exporting the second format" }),
  task(54, "doing", { progress: "Docs reviewed; a Job still runs" }),
  task(56, "doing", { executorSlot: { agentId: "e56", state: "starting", machine: "local" } }),
  task(55, "doing", { executorSlot: { agentId: "e55", state: "waiting", machine: "local", position: 1 } }),
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const reads = new Set(["task_list", "task_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list"]);

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function route(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
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
        const byStatus = {};
        for (const t of open) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
        return { tasks: open, counts: byStatus, hasMore: false, nextAfterSeq: null };
      },
      task_get: () => ({ task: own, activities: [], executions: [], hasMore: false }),
      github_links: () => ({ links: [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: [], repositories: [], refreshing: false }),
      github_repositories: () => ({ repositories: [], links: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "claude", model: "opus" } }),
      peers_list: () => ({ peers: agents.map((a) => ({ id: a.id, name: a.name })) }),
    }[op];
    return route.fulfill({ json: answer() });
  }
  // Opening a conversation marks it read and the like: answered, and kept
  // in the report; no task or Agent changes in this fixture.
  if (method !== "GET") {
    report.posts.push(`${method} ${path}`);
    return route.fulfill({ json: {} });
  }
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) {
    const agent = agents.find((a) => a.id === detail[1]);
    return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-lifecycle" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
}

async function shot(locator, name) {
  const path = join(output, `${name}.png`);
  await locator.screenshot({ path });
  report.screenshots.push(name);
}
const order = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((rows) => rows.map((r) => r.dataset.agentId));
const badges = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((rows) =>
  Object.fromEntries(rows.map((r) => [r.dataset.agentId, r.querySelector(".agent-kind-badge")?.textContent ?? null])));
// Nothing in the list wider than it: rows, their badges and the headings.
const fits = (box) => box.evaluate((el) => {
  const right = el.getBoundingClientRect().right + 1;
  return [...el.querySelectorAll(".agent-row, .agent-kind-badge, .rail-subgroup-head, .collab-executor-state, .home-needs-item")]
    .filter((c) => c.getBoundingClientRect().right > right).map((c) => c.textContent.trim().slice(0, 40));
});

const english = {
  badges: { mori: "Lead", hana: null, e51: "Executor · Failed", e52: "Executor · Delivered, awaiting release", e53: "Executor · Running",
    e54: "Executor · Archiving", e56: "Executor · Starting", e55: "Executor · Queued · 1 in line" },
  executors: "Task executors", archived: "Archived", delivering: "Delivered, awaiting your release", failedNeed: "Its start failed",
};
const chinese = {
  badges: { mori: "负责人", hana: null, e51: "执行者 · 失败", e52: "执行者 · 交付待放行", e53: "执行者 · 运行中",
    e54: "执行者 · 归档中", e56: "执行者 · 启动中", e55: "执行者 · 排队中 · 第 1 位" },
  executors: "任务执行者", archived: "已归档", delivering: "交付待你放行", failedNeed: "启动失败",
};

async function run({ width, height, theme, language }) {
  const phone = width < 600;
  const tag = `${width}-${theme}${language === "zh-Hans" ? "-zh" : ""}`;
  const words = language === "zh-Hans" ? chinese : english;
  const context = await browser.newContext({ viewport: { width, height }, locale: language === "zh-Hans" ? "zh-CN" : "en-US",
    timezoneId: "Asia/Shanghai", reducedMotion: "reduce", colorScheme: theme });
  await context.addInitScript(([theme, language]) => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance")) localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "attention" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, [theme, language]);
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  try {
    await page.goto(`https://${HOST}/`);
    const list = page.locator(".agent-list");
    await list.locator('article[data-agent-id="e52"]').waitFor({ timeout: 15_000 });
    // The sidebar: lead, other Agent, executors by attention; the archived one folded.
    assert.deepEqual(await order(page), ["mori", "hana", "e51", "e52", "e53", "e54", "e55", "e56"], `${tag}: the sidebar's order`);
    assert.deepEqual(await badges(page), words.badges, `${tag}: each badge`);
    assert.equal(await list.locator('[data-rail-part="executors"] .rail-subgroup-head > span').first().textContent(), words.executors);
    const fold = list.locator('[data-rail-part="archived"] .rail-archived-toggle');
    assert.equal(await fold.getAttribute("aria-expanded"), "false", `${tag}: the archived fold starts folded`);
    assert.deepEqual(await fits(list), [], `${tag}: the sidebar fits its width`);
    await shot(list, `${tag}-1-sidebar`);
    await fold.click();
    await list.locator('article[data-agent-id="e50"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(await fits(list), [], `${tag}: opened, it still fits`);
    await shot(list.locator('[data-rail-part="archived"]'), `${tag}-2-archived-open`);
    await fold.click();
    check(`${tag}: sidebar order, badges, Task executors group and archived fold`);

    // Home's Needs you: the executors you dispatched, the failed start first.
    await page.locator(".toolbar-nav button.catchup-nav").first().click();
    const needsYou = page.locator(".home-needs-you");
    await needsYou.locator('[data-needs-you="executor:e52:delivering"]').waitFor({ timeout: 10_000 });
    const rows = await needsYou.locator(".home-needs-item").evaluateAll((items) => items.map((i) => i.dataset.needsYou));
    assert.deepEqual(rows, ["executor:e51:failed", "executor:e52:delivering"], `${tag}: Needs you lists the two you dispatched`);
    assert.match(await needsYou.locator('[data-needs-you="executor:e52:delivering"]').textContent(), new RegExp(words.delivering));
    assert.match(await needsYou.locator('[data-needs-you="executor:e51:failed"]').textContent(), new RegExp(words.failedNeed));
    assert.deepEqual(await fits(needsYou), [], `${tag}: Needs you fits its width`);
    await shot(needsYou, `${tag}-3-needs-you`);
    check(`${tag}: Home's Needs you lists the failed start and the delivery awaiting release`);

    // The task board: each card's executor state; a view's beside its owner.
    await page.locator("button.collab-nav").click({ timeout: 10_000 });
    await page.locator('.collab-task-card[data-task-id="T-55"] .collab-executor-state').waitFor({ timeout: 10_000 });
    const chips = await page.locator(".collab-task-card").evaluateAll((cards) =>
      Object.fromEntries(cards.map((c) => [c.dataset.taskId, [c.querySelector(".collab-executor-state")?.textContent ?? null, !!c.querySelector(".collab-executor-slot")]])));
    const label = (id) => words.badges[`e${id.slice(2)}`];
    for (const [id, [text, slot]] of Object.entries(chips)) {
      assert.equal(text, label(id), `${tag}: ${id}'s card says its executor's state`);
      assert.equal(slot, false, `${tag}: ${id}'s lifecycle in its slot's place`);
    }
    const cards = page.locator(".collab-cards");
    assert.deepEqual(await fits(cards), [], `${tag}: the cards fit their width`);
    await shot(phone ? page : cards, `${tag}-4-board`);
    await page.locator('.collab-task-card[data-task-id="T-52"]').click();
    const owner = page.locator(".collab-detail .collab-owner-line");
    await owner.locator(".collab-executor-state").waitFor({ timeout: 10_000 });
    assert.equal(await owner.locator(".collab-executor-state").textContent(), words.badges.e52);
    await shot(phone ? page : page.locator(".collab-detail"), `${tag}-5-task-view`);
    check(`${tag}: each card and the task's view say its executor's state`, { chips });
    await page.keyboard.press("Escape");

    // Release of an archiving executor (English only: the dialog's words are its own test's).
    if (language !== "zh-Hans") {
      await page.keyboard.press("Escape");
      if (phone) await page.locator(".phone-back").click({ timeout: 10_000 }).catch(() => {});
      await page.locator('.agent-list article[data-agent-id="e54"] .agent-select').click({ timeout: 10_000 });
      await page.getByRole("button", { name: "Conversation actions" }).first().click({ timeout: 10_000 });
      const archiving = page.locator(".agent-action-card", { has: page.locator("strong", { hasText: /^Archiving$/ }) });
      await archiving.waitFor({ timeout: 10_000 });
      assert.equal(await archiving.locator("small").textContent(), "Waiting to close: a Job is still running: cargo test (j1). Releasing again tries now.");
      await shot(page.locator('[role="dialog"]').first(), `${tag}-6-release-archiving`);
      check(`${tag}: Release says what the archiving executor waits for`);
    }
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const theme of ["light", "dark"]) {
    await run({ width: 1440, height: 900, theme, language: "en" });
    await run({ width: 390, height: 844, theme, language: "en" });
  }
  await run({ width: 1440, height: 900, theme: "light", language: "zh-Hans" });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "no collaboration write: a check only reads");
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
