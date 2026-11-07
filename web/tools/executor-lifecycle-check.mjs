// T-36 S3: an executor's lifecycle in Chromium, with every API answered
// here (no Core, no CLI, no daily configuration); the lifecycles themselves
// are Core's own answer (tools/fixtures/executor-lifecycle.json). At 1440
// and 390 wide, in light and dark: the sidebar lists the Project's lead, its
// other Agent, its task executors by attention (failed, delivered awaiting
// release, running, archiving, queued or starting), each row's island saying
// its one state (T-43 v4-2) and its PR chip as /api/executors/live gives it, and folds the
// archived one, a closed one in Closed only; Home's Needs you
// lists the executors you dispatched and no lead's; a task's card and view
// say its executor's state; Release says what an archiving executor waits
// for. Once more in Chinese at 1440, light; and once with the compact Agent
// list, which keeps each row's island and hides the rest.
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
const report = { task: "T-36, T-43 S2", checks: [], screenshots: [], unexpected: [], writes: [], posts: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-lifecycle.test";

// What Core answers, verbatim (Lead 2 mail 6191): the Agent listing's
// `executor`, the task list's `task.executor` and Home's executor items, as
// core/src/project_brief/executor_needs_tests.rs emits them and keeps them
// equal. The rest of each record is this check's own.
const fixture = JSON.parse(await readFile(new URL("./fixtures/executor-lifecycle.json", import.meta.url), "utf8"));
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const you = { kind: "user", id: "user", name: "You" };
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "codex", createdAt: "", updatedAt: ago(5),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected" };
// One at work right now; the closed ones offline.
const statusOf = (a) => (a.closedAt ? "offline" : a.executor?.state === "running" && !a.executor.blocked ? "working" : "idle");
const agents = fixture.agents.map((a) => ({ ...base, ...a, status: statusOf(a) }));
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const needs = fixture.needsYou;
const counts = { working: 1, idle: 8, waiting: 0, error: 0, offline: 2, total: 11 };
const home = { generatedAt: ago(0), order: ["p1"], needsYou: needs,
  projects: [{ project: { id: "p1", name: "Yuzuno" }, agents: counts, errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }] };
const tasks = fixture.tasks.map((t) => ({
  id: t.id, title: t.title, description: "", status: t.status, version: 2, projectId: "p1", progress: "", github: [],
  blocker: t.status === "blocked" ? "Waiting for the signing keys" : "",
  result: t.status === "review" ? { summary: "Reviewed: two findings fixed.", links: [], reportedAt: ago(12), reportedBy: { kind: "agent", id: t.executor?.agentId, name: "" } } : null,
  createdAt: ago(300), updatedAt: ago(10), createdBy: you, updatedBy: you, assigneeAgentId: t.executor?.agentId ?? null, executor: t.executor,
  // T-35's slot, which the lifecycle replaces on the card.
  ...(t.executor?.state === "queued" ? { executorSlot: { agentId: t.executor.agentId, state: "waiting", machine: "local", position: t.executor.position } } : {}),
}));
const byId = (id) => agents.find((a) => a.id === id);
const archivingOne = agents.find((a) => a.executor?.state === "archiving");
const deliveredTask = tasks.find((t) => t.executor?.state === "delivering" && t.executor.dispatcher.kind === "user");
// Each open executor's PR (GET /api/executors/live, T-43 S2): the delivered
// one's in review, one round approved; the one at work on a draft.
const delivered = deliveredTask.executor.agentId;
const atWork = agents.find((a) => a.executor?.state === "running" && !a.executor.blocked).id;
const live = { executors: {
  [delivered]: { pr: { number: 688, url: "https://github.com/owner/repo/pull/688", state: "open", headSha: "b".repeat(40), ci: "success",
    reviews: { approved: 1, changesRequested: false, running: false } } },
  [atWork]: { pr: { number: 690, url: "https://github.com/owner/repo/pull/690", state: "draft", headSha: "c".repeat(40), ci: "pending",
    reviews: { approved: 0, changesRequested: false, running: false } } },
} };
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
    "/api/executors/live": live,
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
// Each row's state: an executor's ring (T-43 v10.1) and what its line one
// says; a lead's badge.
const states = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((rows, executors) =>
  Object.fromEntries(rows.map((r) => {
    const island = r.querySelector(".agent-island");
    return [r.dataset.agentId, executors.includes(r.dataset.agentId)
      ? [island?.dataset.state ?? null, r.querySelector(".agent-line-one")?.textContent ?? null]
      : r.querySelector(".agent-kind-badge")?.textContent ?? null];
  })), agents.filter((a) => a.executor).map((a) => a.id));
// Nothing in the list wider than it: rows, their badges and the headings.
const fits = (box) => box.evaluate((el) => {
  const right = el.getBoundingClientRect().right + 1;
  return [...el.querySelectorAll(".agent-row, .agent-kind-badge, .agent-island, .executor-row-facts, .rail-subgroup-head, .collab-executor-state, .home-needs-item")]
    .filter((c) => c.getBoundingClientRect().right > right).map((c) => c.textContent.trim().slice(0, 40));
});

// Needs you is one row that scrolls sideways (NeedsYou.tsx): each item fits
// the row's width, however many there are.
const fitsRow = (row) => row.evaluate((el) => [...el.querySelectorAll(".home-needs-item")]
  .filter((item) => item.getBoundingClientRect().width > el.clientWidth + 1).map((item) => item.textContent.trim().slice(0, 40)));

const english = {
  states: { queued: "Queued", starting: "Starting", running: "Running", delivering: "Handed in", archiving: "Archiving",
    archived: "Archived", failed: "Failed", closed: "Closed" },
  queued: (n) => `Queued · ${n} in line`, executor: "Executor", lead: "Lead",
  executors: "Task executors", delivering: "Awaiting your release", failed: "Its start failed", blocked: "Its task is blocked",
  // The row's words (AgentIsland.tsx, T-43 v10.1): its state's word, then what it is doing.
  word: { queued: "Queued", working: "Working", handed: "Handed in", failed: "Failed", archived: "Archived" }, colon: ": ", gap: " · ",
  handedIn: (pr) => (pr ? `Handed in #${pr}` : "Handed in"),
  position: (n) => `${n} in line`, starting: "Starting", leadsTurn: "waiting for the lead", closing: "Closing",
  taskBlocked: (text) => `Task blocked: ${text}`, rounds: "Review 1/2", draft: "Draft", closed: "Closed",
};
const chinese = {
  states: { queued: "排队中", starting: "启动中", running: "运行中", delivering: "已交", archiving: "归档中", archived: "已归档", failed: "失败", closed: "已关闭" },
  queued: (n) => `排队中 · 第 ${n} 位`, executor: "执行者", lead: "负责人",
  executors: "任务执行者", delivering: "交付待你放行", failed: "启动失败", blocked: "任务受阻",
  word: { queued: "排队", working: "在做", handed: "已交", failed: "出错", archived: "已归档" }, colon: "：", gap: " · ",
  handedIn: (pr) => (pr ? `已交 #${pr}` : "已交"),
  position: (n) => `第 ${n} 位`, starting: "启动中", leadsTurn: "等负责人", closing: "收尾中",
  taskBlocked: (text) => `任务受阻：${text}`, rounds: "审查 1/2", draft: "草稿", closed: "已关闭",
};
// What an executor's badge and chip say (executor-lifecycle.ts), from its state.
const says = (words, lifecycle) =>
  `${words.executor} · ${lifecycle.state === "queued" && lifecycle.position ? words.queued(lifecycle.position) : words.states[lifecycle.state]}`;
// What an executor's row says (agent-island.ts over executor-display.ts's
// rules), from Core's lifecycle in the fixture and this check's runtime
// status and PRs: its ring's state, and line one as "word: what it is
// doing" (working has no word; handed in names its PR; nothing said yet, its
// task's title). Its PR's review is its card's, not the row's.
const rowSays = (words, a) => {
  const l = a.executor;
  const pr = live.executors[a.id]?.pr?.number ?? null;
  const line = (state, text) => [state,
    state === "working" ? text : state === "handed" ? `${words.handedIn(pr)}${words.gap}${text}` : text ? `${words.word[state]}${words.colon}${text}` : words.word[state]];
  switch (l.state) {
    case "archived": return line("archived", l.task.title);
    case "archiving": return line("archived", `${words.closing} · ${l.reason}`);
    case "failed": return line("failed", l.reason ?? l.task.title);
    case "closed": return line("archived", words.closed);
    case "queued": return line("queued", l.position ? words.position(l.position) : l.task.title);
    case "starting": return line("queued", words.starting);
    case "delivering": return line("handed", words.leadsTurn);
    default: return line("working", l.blocked ? words.taskBlocked(l.blocked) : l.task.title);
  }
};
// The sidebar's order with Attention order: the lead, the other Agent, then
// failed; delivered (two, as listed); running (the one at work first);
// archiving; queued; starting. The closed one is in Closed only.
const SIDEBAR = ["mori", "hana", "e51", "e52", "e58", "e53", "e57", "e54", "e55", "e56"];

async function run({ width, height, theme, language, density = "detailed" }) {
  const phone = width < 600;
  const tag = `${width}-${theme}${language === "zh-Hans" ? "-zh" : ""}${density === "compact" ? "-compact" : ""}`;
  const words = language === "zh-Hans" ? chinese : english;
  const context = await browser.newContext({ viewport: { width, height }, locale: language === "zh-Hans" ? "zh-CN" : "en-US",
    timezoneId: "Asia/Shanghai", reducedMotion: "reduce", colorScheme: theme });
  await context.addInitScript(([theme, language, density]) => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance")) localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "attention", agentList: density }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, [theme, language, density]);
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  try {
    await page.goto(`https://${HOST}/`);
    const list = page.locator(".agent-list");
    await list.locator(`article[data-agent-id="${SIDEBAR.at(-1)}"]`).waitFor({ timeout: 15_000 });
    // The sidebar: lead, other Agent, executors by attention; the archived one folded.
    assert.deepEqual(await order(page), SIDEBAR, `${tag}: the sidebar's order`);
    const expected = Object.fromEntries(SIDEBAR.map((id) => {
      const a = byId(id);
      return [id, a.kind === "lead" ? words.lead : a.executor ? rowSays(words, a) : null];
    }));
    // Its PRs come from their own read, after the list.
    // Attached, not visible: the compact list hides it, as its own assertion below says.
    await page.waitForFunction((id) => /#\d/.test(document.querySelector(`.agent-list article[data-agent-id="${id}"] .agent-line-one`)?.textContent ?? ""), delivered, { timeout: 10_000 });
    assert.deepEqual(await states(page), expected, `${tag}: each executor's row says its one state, and its PR`);
    // No avatar on any row; each row has one ring of its own, and no chips
    // (its template and PR are its ring's title and its card's).
    const marks = await list.locator("article[data-agent-id]").evaluateAll((rows) => rows.map((r) => [
      r.dataset.agentId, !!r.querySelector(".agent-rail-avatar, .agent-avatar"),
      r.querySelectorAll(":scope > .agent-island").length === 1 && !r.querySelector(".executor-row-facts")]));
    assert.deepEqual(marks.filter(([, avatar, own]) => avatar || !own), [], `${tag}: no avatar, one ring per row, no chips`);
    if (density === "compact") {
      // The compact list keeps line one and the ring, and hides line two.
      const shownParts = await list.locator(`article[data-agent-id="${delivered}"]`).evaluate((row) =>
        Object.fromEntries([".agent-island", ".agent-row-meta"].map((part) => {
          const el = row.querySelector(part);
          return [part, el ? getComputedStyle(el).display !== "none" : null];
        })));
      assert.ok(shownParts[".agent-island"] && shownParts[".agent-row-meta"] === false,
        `${tag}: compact, line one and the ring: ${JSON.stringify(shownParts)}`);
    }
    assert.equal(await list.locator('[data-rail-part="executors"] .rail-subgroup-head > span').first().textContent(), words.executors);
    // Its words keep one line beside how many run and wait (T-43 S2).
    const headLines = await list.locator('[data-rail-part="executors"] .rail-subgroup-head > span').first().evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
    });
    assert.equal(headLines, 1, `${tag}: the Task executors heading is one line`);
    const fold = list.locator('[data-rail-part="archived"] .rail-archived-toggle');
    assert.equal(await fold.getAttribute("aria-expanded"), "false", `${tag}: the archived fold starts folded`);
    assert.deepEqual(await fits(list), [], `${tag}: the sidebar fits its width`);
    await shot(list, `${tag}-1-sidebar`);
    await fold.click();
    const archived = agents.find((a) => a.executor?.state === "archived");
    await list.locator(`article[data-agent-id="${archived.id}"]`).waitFor({ timeout: 10_000 });
    assert.ok(!(await list.locator('article[data-agent-id="e59"]').count()), `${tag}: a closed executor is in Closed only`);
    assert.deepEqual(await fits(list), [], `${tag}: opened, it still fits`);
    await shot(list.locator('[data-rail-part="archived"]'), `${tag}-2-archived-open`);
    await fold.click();
    check(`${tag}: sidebar order, each executor's island and PR, Task executors group and archived fold`);
    if (density === "compact") return;

    // Home's Needs you: the executors you dispatched, the failed start first.
    await page.locator(".toolbar-nav button.catchup-nav").first().click();
    const needsYou = page.locator(".home-needs-you");
    const keys = needs.map((i) => `executor:${i.agentId}:${i.state}`);
    await needsYou.locator(`[data-needs-you="${keys[0]}"]`).waitFor({ timeout: 10_000 });
    const rows = await needsYou.locator(".home-needs-item").evaluateAll((items) => items.map((i) => i.dataset.needsYou));
    assert.deepEqual(rows, keys, `${tag}: Needs you lists the executors you dispatched, in Core's order`);
    assert.deepEqual(needs.map((i) => i.state).sort(), ["blocked", "delivering", "failed"], "Core lists a failed start, a delivery and a blocked task");
    for (const item of needs) {
      assert.match(await needsYou.locator(`[data-needs-you="executor:${item.agentId}:${item.state}"]`).textContent(), new RegExp(words[item.state]));
    }
    // In the same render: the lead's executor, its result in too, is not listed.
    assert.ok(!rows.some((r) => r.startsWith("executor:e58:")), `${tag}: a lead's executor is never in Needs you`);
    assert.deepEqual(await fitsRow(needsYou.locator(".home-needs-list")), [], `${tag}: each Needs you item fits its row`);
    await shot(needsYou, `${tag}-3-needs-you`);
    check(`${tag}: Home's Needs you lists the failed start and the delivery awaiting release`);

    // The task board: each card's executor state; a view's beside its owner.
    await page.locator("button.collab-nav").click({ timeout: 10_000 });
    await page.locator(`.collab-task-card[data-task-id="${deliveredTask.id}"] .collab-executor-state`).waitFor({ timeout: 10_000 });
    const chips = await page.locator(".collab-task-card").evaluateAll((cards) =>
      Object.fromEntries(cards.map((c) => [c.dataset.taskId, [c.querySelector(".collab-executor-state")?.textContent ?? null, !!c.querySelector(".collab-executor-slot")]])));
    for (const [id, [text, slot]] of Object.entries(chips)) {
      assert.equal(text, says(words, tasks.find((t) => t.id === id).executor), `${tag}: ${id}'s card says its executor's state`);
      assert.equal(slot, false, `${tag}: ${id}'s lifecycle in its slot's place`);
    }
    const cards = page.locator(".collab-cards");
    assert.deepEqual(await fits(cards), [], `${tag}: the cards fit their width`);
    await shot(phone ? page : cards, `${tag}-4-board`);
    await page.locator(`.collab-task-card[data-task-id="${deliveredTask.id}"]`).click();
    const owner = page.locator(".collab-detail .collab-owner-line");
    await owner.locator(".collab-executor-state").waitFor({ timeout: 10_000 });
    assert.equal(await owner.locator(".collab-executor-state").textContent(), says(words, deliveredTask.executor));
    await shot(phone ? page : page.locator(".collab-detail"), `${tag}-5-task-view`);
    check(`${tag}: each card and the task's view say its executor's state`, { chips });
    await page.keyboard.press("Escape");

    // Release of an archiving executor (English only: the dialog's words are its own test's).
    if (language !== "zh-Hans") {
      await page.keyboard.press("Escape");
      if (phone) await page.locator(".phone-back").click({ timeout: 10_000 }).catch(() => {});
      await page.locator(`.agent-list article[data-agent-id="${archivingOne.id}"] .agent-select`).click({ timeout: 10_000 });
      // The conversation's actions menu (T-184), then Manage… for Agent management.
      await page.getByRole("button", { name: "Conversation actions" }).first().click({ timeout: 10_000 });
      await page.getByRole("menuitem", { name: "Manage…" }).click({ timeout: 10_000 });
      const archiving = page.locator(".agent-action-card", { has: page.locator("strong", { hasText: /^Archiving$/ }) });
      await archiving.waitFor({ timeout: 10_000 });
      assert.equal(await archiving.locator("small").textContent(), `${archivingOne.executor.reason} Releasing again tries now.`);
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
  await run({ width: 1440, height: 900, theme: "light", language: "en", density: "compact" });
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
