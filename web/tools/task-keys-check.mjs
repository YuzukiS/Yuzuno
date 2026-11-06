// T-56 PR 2: a Project's task key prefix changed in its window, in a real
// browser. The user types a new prefix for yuzuno-next (YN) in the Projects
// window; the window says the new numbers, and then the task board and a live
// task reference on a Home report show the task by its new key, while a task in
// no project keeps T-2. A prefix another project had is refused in Core's
// words. Desktop and a 393 px phone. Production bundle with an explicit API
// fixture standing in for Core: synthetic data, and the only writes are the
// key changes this check makes.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_CHECK_OUTPUT=<dir> node tools/task-keys-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/task-keys");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-task-keys.test";
const report = { task: "T-56", checks: [], shots: [], errors: [], writes: [], reads: [] };
const record = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shoot = async (target, name) => {
  await target.screenshot({ path: `${output}/${name}.png` });
  report.shots.push(name);
};

const base = { harness: "claude", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "dev5", name: "Dev 5", projectId: "p1" }];
const user = { kind: "user", id: "user", name: "You" };
const owner = { agentId: "dev5", name: "Dev 5", state: "active" };
const at = "2026-11-06T09:00:00Z";

/** One Core: the Project's key now, and what everything reads from it. */
function core() {
  const state = { key: "YN" };
  // A key another project had (a deleted one's): reserved forever, so refused.
  const retired = { OLD: "p-gone" };
  const projects = () => [{ id: "p1", name: "yuzuno-next", key: state.key, defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
  const task = (seq, title, status, inProject) => ({ id: inProject ? `${state.key}-1` : `T-${seq}`, seq, title, description: "", status,
    projectId: inProject ? "p1" : null, assigneeAgentId: "dev5", assignee: { kind: "agent", id: "dev5", name: "Dev 5" }, progress: "",
    blocker: "", result: null, version: 1, createdBy: user, updatedBy: user, createdAt: at, updatedAt: at });
  const tasks = () => [task(1, "Key editor in the Projects window", "doing", true), task(2, "A task in no project", "todo", false)];
  // The report names the task by the key the Agent wrote (YN-1); Core shows the key it has now.
  const body = { root: "body", elements: {
    body: { type: "BriefBody", props: {}, children: ["refs"] },
    refs: { type: "LiveRefs", props: { layout: "list", items: [{ kind: "task", id: "YN-1", note: "written as YN-1" }, { kind: "task", id: "T-2" }] } },
  } };
  const refs = () => {
    const [inProject, outside] = tasks();
    const shown = (named, t) => ({ kind: "task", id: named, found: true, key: t.id, title: t.title, state: t.status, tone: "active",
      assignee: t.assignee, updatedAt: at });
    return { "task:YN-1": shown("YN-1", inProject), "task:T-2": shown("T-2", outside) };
  };
  const home = () => ({
    generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
    projects: [{
      project: { id: "p1", name: "yuzuno-next" },
      agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 }, errors: [], pending: [], jobs: [],
      brief: { version: 3, history: [], sections: [{ key: "keys", kind: "report", title: "Task keys", version: 2, owner, updatedAt: at,
        updatedTurnId: null, attachments: [], refs: refs(), seen: null, history: false, body }] },
      unseen: 0, missing: [],
    }],
  });
  const reads = {
    task_list: () => ({ tasks: tasks(), hasMore: false, counts: { doing: 1, todo: 1 } }),
    task_get: (input) => ({ task: tasks().find((t) => t.id === input.taskId) ?? tasks()[0], activities: [], executions: [], hasMore: false }),
    peer_read: () => ({ messages: [], hasMore: false }),
    peers_list: () => ({ peers: [] }),
    github_repositories: () => ({ repositories: [] }),
    github_links: () => ({ links: [], repositories: [] }),
  };
  /** A key change, as Core's PATCH /api/projects/<id> answers it (task_keys::set). */
  const patch = (input) => {
    const error = (message) => ({ status: 400, json: { error: message } });
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(input.key))
      return error("invalid_input: a Project key is an uppercase letter followed by 1–9 uppercase letters or digits, for example YN");
    if (retired[input.key]) return error(`project_key_taken: ${input.key} is or was another Project's key, and keys are never reused`);
    state.key = input.key;
    return { json: projects()[0] };
  };
  return { state, projects, home, reads, patch };
}

// What changes something in Core; nothing here asks for any of it.
const WRITES = /^(task_(create|update|comment|dispatch|submit_result|claim|result_ack|research_add)|peer_send|github_pr_submit|github_links_link|review_start|delivery_(enable|continue|stop)|ci_subscribe|job_)/;

const browser = await launchBrowser();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

async function open({ name, width, height, touch }) {
  const fixture = core();
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce", locale: "en-US" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    // No event stream: the app reads what it shows after the user's own actions.
    window.EventSource = class { addEventListener() {} close() {} };
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (path.startsWith("/api/collaboration/") && request.method() === "POST") {
      const operation = path.slice("/api/collaboration/".length);
      if (WRITES.test(operation)) {
        report.writes.push(`${name}: POST ${path}`);
        return route.fulfill({ status: 405, json: { error: "not in this check's fixture" } });
      }
      report.reads.push(`${name}: ${operation}`);
      return route.fulfill({ json: fixture.reads[operation]?.(body) ?? {} });
    }
    if (path === "/api/projects/p1" && request.method() === "PATCH") {
      report.writes.push(`${name}: PATCH ${path} ${JSON.stringify(body)}`);
      return route.fulfill(fixture.patch(body));
    }
    if (request.method() !== "GET") {
      report.writes.push(`${name}: ${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { error: "no other writes here" } });
    }
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: fixture.projects(), projectUsage: { p1: { agents: 1, tasks: 1 } }, agents,
        runtime: { connected: true }, defaultCwd: "/fixture" } });
    if (path === "/api/home") return route.fulfill({ json: fixture.home() });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci/runs") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/machines") return route.fulfill({ json: { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] } });
    if (path === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ body: await readFile(resolve(dist, "index.html")), contentType: "text/html" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
  await page.goto(`https://${HOST}/`);
  await page.locator(".workspace-scope").first().waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, fixture };
}

const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function projectsWindow(page) {
  await page.locator(".workspace-scope").first().click();
  await page.locator("button", { hasText: /^Manage projects…$/ }).click({ timeout: 10_000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.locator("button", { hasText: "yuzuno-next" }).first().click({ timeout: 10_000 });
  const field = dialog.locator("label", { hasText: "Task key prefix" }).locator("input");
  await field.waitFor({ timeout: 10_000 });
  return { dialog, field, change: dialog.locator("button", { hasText: /^Change prefix$/ }),
    note: dialog.locator(".project-note", { hasText: /^Tasks in this project are numbered/ }) };
}

try {
  for (const view of [
    { name: "desktop", width: 1440, height: 1000, touch: false },
    { name: "phone", width: 393, height: 852, touch: true },
  ]) {
    const { context, page, fixture } = await open(view);
    try {
      // 1. The Projects window: the prefix now, typed anew, saved by Core.
      const win = await projectsWindow(page);
      assert.equal(await win.field.inputValue(), "YN");
      assert.match(await win.note.textContent(), /numbered YN-1, YN-2 and so on/);
      await win.field.scrollIntoViewIfNeeded();
      await shoot(win.dialog, `${view.name}-1-prefix-before`);
      // A prefix another project had is refused, in Core's own words.
      await win.field.fill("OLD");
      await win.change.click();
      const refusal = win.dialog.locator(".project-key ~ .inline-error[role=alert]");
      await refusal.waitFor({ timeout: 10_000 });
      assert.equal(await refusal.textContent(), "project_key_taken: OLD is or was another Project's key, and keys are never reused");
      assert.equal(fixture.state.key, "YN", "a refused prefix changes nothing");
      record(`${view.name}: a prefix another project had is refused in Core's words`);
      await shoot(win.dialog, `${view.name}-2-prefix-refused`);
      await win.field.fill("ynx");
      assert.equal(await win.field.inputValue(), "YNX", "typed in capitals");
      await win.change.click();
      await win.note.filter({ hasText: "numbered YNX-1, YNX-2" }).waitFor({ timeout: 10_000 });
      assert.equal(fixture.state.key, "YNX");
      assert.ok((await sideways(page)) <= 0, `${view.name}: nothing sideways in the Projects window`);
      const fits = await win.dialog.evaluate((el) => {
        const form = el.querySelector(".project-key");
        const right = form.getBoundingClientRect().right;
        return [...form.querySelectorAll("input, button")].every((c) => c.getBoundingClientRect().right <= right + 1) && right <= innerWidth;
      });
      assert.ok(fits, `${view.name}: the prefix field and its button fit the window`);
      record(`${view.name}: the new prefix is saved by Core and the window says the new numbers`);
      await shoot(win.dialog, `${view.name}-3-prefix-after`);
      await page.keyboard.press("Escape");
      await win.dialog.waitFor({ state: "hidden", timeout: 10_000 });

      // 2. The task board: the task in the project by its new key; the other keeps T-2.
      await page.locator(".collab-nav").first().click();
      await page.locator(".collab-task-card").first().waitFor({ timeout: 10_000 });
      await page.locator(".collab-task-card .collab-task-id", { hasText: "YNX-1" }).first().waitFor({ timeout: 10_000 });
      const ids = await page.locator(".collab-task-card .collab-task-id").allTextContents();
      assert.deepEqual(ids.map((id) => id.trim()).sort(), ["T-2", "YNX-1"], `${view.name}: ${JSON.stringify(ids)}`);
      assert.ok((await sideways(page)) <= 0, `${view.name}: nothing sideways on the board`);
      record(`${view.name}: the task board shows the task by its new key, and T-2 as it was`, { ids });
      await shoot(page, `${view.name}-4-board`);

      // 3. Home: the report's live reference, written as YN-1, shows YNX-1.
      await page.locator(".toolbar-nav .catchup-nav:not(.collab-nav):not(.jobs-nav)").first().click();
      const card = page.locator('.home-view [data-section-key="keys"]').first();
      await card.waitFor({ timeout: 10_000 });
      const opener = card.locator(".home-report-open");
      await opener.scrollIntoViewIfNeeded();
      await opener.click();
      const article = page.locator(".home-report .report-article");
      await article.locator(".brief-ref-row").first().waitFor({ timeout: 10_000 });
      const rows = await article.locator(".brief-ref-row").evaluateAll((all) => all.map((row) => ({
        id: row.querySelector(".brief-ref-row-open small")?.textContent,
        title: row.querySelector(".brief-ref-row-title")?.textContent,
      })));
      assert.deepEqual(rows, [{ id: "YNX-1", title: "Key editor in the Projects window" }, { id: "T-2", title: "A task in no project" }],
        `${view.name}: ${JSON.stringify(rows)}`);
      assert.ok((await sideways(page)) <= 0, `${view.name}: nothing sideways on the report`);
      record(`${view.name}: a live reference written as YN-1 shows the task's new key, YNX-1`, { rows });
      await shoot(article, `${view.name}-5-live-reference`);
    } catch (error) {
      await page.screenshot({ path: `${output}/failed-${view.name}.png` }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.deepEqual(report.writes, [
    'desktop: PATCH /api/projects/p1 {"key":"OLD"}', 'desktop: PATCH /api/projects/p1 {"key":"YNX"}',
    'phone: PATCH /api/projects/p1 {"key":"OLD"}', 'phone: PATCH /api/projects/p1 {"key":"YNX"}',
  ], "the only writes are the key changes made here");
  record("no page errors; the only writes are the key changes");
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
