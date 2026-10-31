// The task board (T-119) in a browser.
// - Wide: tasks grouped by what they wait for, most recently changed first;
//   with no task open, cards several to a row; beside an open task, one row
//   each, long titles wrapping at two lines; no sideways scroll.
// - The detail beside the list: title and actions, then where things stand,
//   the work and Delivery; linked PRs, checks and reviews show, linking and
//   PR operations only after Manage; nothing linked is one button.
// - The detail slides in and out (frames and GIFs for the user); moving to
//   another task only fades in; with reduced motion nothing animates.
// - Narrow: rows stack, the detail replaces the list with a way back.
// - Light and dark; keyboard opens a row; reading writes nothing.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/task-board");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-tasks.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], gifs: [] };
let page;
async function step(name, run) {
  try {
    const extra = (await run()) || {};
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    const file = `fail-${report.failures.length + 1}.png`;
    report.failures.push({ name, error: error.stack || String(error), screenshot: file });
    console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
    await page?.screenshot({ path: resolve(output, file) }).catch(() => {});
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------- fixture
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const you = { kind: "user", id: "user", name: "You" };
const agents = [1, 2, 3, 4, 6].map((n) => ({
  id: `dev-${n}`, name: `Dev ${n}`, projectId: "p1", harness: n % 2 ? "codex" : "claude", cwd: "/fixture", model: "test-model",
  settings: {}, color: ["sage", "sky", "peach", "lilac", "sand"][n % 5], createdAt: "", updatedAt: "", status: "idle",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null,
}));
const projects = [{ id: "p1", name: "yuzuno-next", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const pr = (number, state, ci, title) => ({
  id: `7:pull:${number}`, repositoryId: 7, repository: "YuzukiS/Yuzuno", kind: "pull", number,
  url: `https://github.com/YuzukiS/Yuzuno/pull/${number}`, syncedAt: new Date().toISOString(), stale: false, error: null,
  snapshot: {
    title, state, headSha: String(number).padStart(40, "a"), headBranch: `feat/${number}`, baseBranch: "main",
    ci: ci && { state: ci, headSha: String(number).padStart(40, "a"), complete: ci !== "pending", observedAt: new Date().toISOString(), checks: [{ name: "Core", state: ci }, { name: "Web", state: ci }] },
  },
});
const earlier = (summary) => ({ summary, links: [], reportedAt: ago(1500), reportedBy: { kind: "agent", id: "dev-4", name: "Dev 4" } });
const task = (id, fields) => ({
  id, description: "", progress: "", blocker: "", result: null, github: [], projectId: "p1", version: 3,
  createdAt: ago(9000), createdBy: you, updatedBy: you, assigneeAgentId: null, assignee: null, ...fields,
});
const tasks = [
  task("T-88", {
    title: "公开准备：让新用户独立安装并选择本机或远程 Core", status: "todo", assigneeAgentId: "dev-1", updatedAt: ago(180),
    description: "让新用户无需开发环境即可安装，并在首次启动时选择本机或远程 Core。\n\n首版只覆盖 Linux。",
    progress: "first-use 切片已完成并合并；剩余独立主机验收。", result: earlier("**首个切片**：first-use 流程已合并（PR #116）。"),
    github: [pr(81, "merged", "success", "Tunnel-port boundary"), pr(93, "merged", "success", "macOS notes"), pr(116, "merged", "success", "First use")],
  }),
  task("T-89", {
    title: "公开准备：核查仓库历史、CI 日志与发布资产的可公开内容", status: "doing", assigneeAgentId: "dev-4", updatedAt: ago(40),
    description: "确认仓库历史、CI 日志和发布资产中没有不应公开的内容。",
    progress: "当前树与 CI 日志已扫描；正在核对旧发布资产。", result: earlier("上一轮审计结论已更正（无确认的凭据泄露）。"),
  }),
  task("T-90", {
    title: "公开准备：许可证、产品介绍与用户反馈入口", status: "review", assigneeAgentId: "dev-3", updatedAt: ago(20),
    description: "补齐许可证、第三方声明、产品介绍和反馈入口。",
    result: { summary: "Claude runtime 依赖声明已合并（PR #122）；候选评审、真实打包与 main CI 均已通过。", links: [{ label: "PR #122", url: "https://github.com/YuzukiS/Yuzuno/pull/122" }], reportedAt: ago(20), reportedBy: { kind: "agent", id: "dev-3", name: "Dev 3" } },
    github: [pr(122, "merged", "success", "Claude runtime notices"), pr(124, "open", "success", "Feedback entry")],
  }),
  task("T-108", {
    title: "研究 Jobs 第三阶段：托管 Windows 与远程 Linux 作业", status: "doing", assigneeAgentId: "dev-2", updatedAt: ago(5),
    description: "在托管 Windows 和远程 Linux 上运行 Jobs，保持资源边界与日志回传。",
    progress: "Windows 托管执行路径：作业隔离已完成，正在验证取消与日志回传。",
    github: [pr(113, "merged", "success", "Remote jobs"), pr(117, "merged", "success", "Remote jobs 2"), pr(125, "draft", "pending", "Windows managed jobs")],
  }),
  task("T-109", {
    title: "研究 Jobs 后续低优先级：保存检查点后释放显存并恢复", status: "todo", updatedAt: ago(1440),
    description: "当确实需要时，保存检查点后释放显存，之后从检查点恢复。",
  }),
  task("T-110", { title: "长期：将 OpenCode 接入 yuzuno-next 的原生 Agent 工作流", status: "todo", updatedAt: ago(2880), description: "长期目标，当前不开发。" }),
  task("T-114", {
    title: "低优先级：在回复操作栏加入 Codex / Claude Rewind", status: "doing", assigneeAgentId: "dev-1", updatedAt: ago(15),
    description: "在回复操作栏加入回退。", progress: "Codex 原生对话回退已通过隔离探针，正在验收；Claude 当前只开放文件恢复。",
  }),
  task("T-118", {
    title: "紧急：在 Yuzuno 调整 Codex 上下文窗口与压缩阈值", status: "blocked", assigneeAgentId: "dev-6", updatedAt: ago(2),
    description: "让用户在 Yuzuno 内调整 Codex 的上下文窗口和自动压缩阈值。",
    blocker: "已加载会话的 resume 不会换用新窗口，需要先确定安全重载方式。",
  }),
  task("T-120", {
    title: "一个故意写得很长很长的任务标题，用来确认紧凑行在窄宽度和分屏时会换行而不是撑开整行或者被截成看不出意思的半句话",
    status: "todo", updatedAt: ago(600), description: "",
  }),
];
const reviews = {
  "T-90": [{
    id: "r-1", requestedHarness: "claude", requestedModel: "opus", actualHarness: "claude", actualModel: "claude-opus",
    linkId: "7:pull:124", repository: "YuzukiS/Yuzuno", number: 124, status: "completed", phase: "completed",
    baseSha: "b".repeat(40), headSha: String(124).padStart(40, "a"), mergeBaseSha: "b".repeat(40), conclusion: "no_findings",
    error: null, createdAt: ago(25), outdated: false, findings: [], cursor: 1, round: 1,
  }],
};

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const reads = new Set(["task_list", "task_get", "github_links", "github_refresh", "delivery_get", "peers_list", "github_repositories"]);
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (request.method() !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    const body = JSON.parse(request.postData() || "{}");
    if (!reads.has(op) || body.action) {
      report.writes.push(`${request.method()} ${path}`);
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
      task_get: () => ({ task: own, activities: [{ seq: 1, taskId: own.id, kind: "created", actor: you, at: own.createdAt }], executions: [], hasMore: false }),
      github_links: () => ({ links: own?.github || [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: own?.github || [], repositories: [], refreshing: false }),
      github_repositories: () => ({ repositories: [], links: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "claude", model: "opus" } }),
      peers_list: () => ({ peers: agents.map((a) => ({ id: a.id, name: a.name })) }),
    }[op];
    return route.fulfill({ json: answer() });
  }
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const taskId = url.searchParams.get("taskId");
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws-tasks" }, projects, projectUsage: { p1: { agents: agents.length, tasks: tasks.length } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": () => ({ generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] }),
    "/api/machine-load": () => ({ at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null }, memory: { totalMiB: 16000, usedMiB: 4000, availableMiB: 12000, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] }),
    "/api/pr-operations": () => ({ operations: [], repositories: [{ id: 7, fullName: "YuzukiS/Yuzuno" }], hasMore: false, nextBefore: null }),
    "/api/pr-reviews": () => ({ settings: { harness: "claude", model: "opus" }, reviews: reviews[taskId] || [], hasMore: false, nextBefore: null }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/agents/")) {
    const agent = agents.find((a) => path.endsWith(`/${a.id}`));
    return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  }
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}
async function board({ theme = "light", width = 1440, motion = "reduce" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", reducedMotion: motion });
  const tab = await context.newPage();
  await tab.addInitScript(({ theme }) => {
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 50); } close() {} };
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance") || "{}");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme, fontSize: 16, palette: "garden" }));
  }, { theme });
  tab.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  tab.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await tab.route("**/*", serve);
  await tab.goto(`https://${HOST}/`);
  await tab.getByRole("button", { name: "Tasks & messages", exact: true }).click();
  await tab.locator('.collab-task-card[data-task-id="T-88"]').waitFor();
  return tab;
}
const row = (id) => page.locator(`.collab-task-card[data-task-id="${id}"]`);
const detail = () => page.locator(".collab-detail");
async function openTask(id) {
  await row(id).click();
  await page.locator(`.collab-detail .collab-task-title [data-task-id="${id}"]`).waitFor();
  await sleep(350);
}
const overflow = () => page.evaluate(() => {
  const list = document.querySelector(".collab-task-list");
  const modal = document.querySelector(".modal");
  return { list: list.scrollWidth - list.clientWidth, modal: modal.scrollWidth - modal.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
});
const noSideways = async () => {
  const o = await overflow();
  assert.ok(o.list <= 1 && o.modal <= 1 && o.page <= 1, JSON.stringify(o));
};
const headings = () => detail().locator("h4").allInnerTexts();
const before = (list, a, b) => {
  const i = list.findIndex((h) => h.startsWith(a));
  const j = list.findIndex((h) => h.startsWith(b));
  assert.ok(i >= 0 && j > i, `${a} before ${b}: ${list.join(" | ")}`);
};

/** Frames of an animation slowed down, joined into a GIF when ffmpeg is there. */
async function film(name, action, frames = 14) {
  await page.evaluate(() => {
    window.__slow = new MutationObserver(() => document.getAnimations().forEach((a) => (a.playbackRate = 0.15)));
    window.__slow.observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await action();
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => document.getAnimations().forEach((a) => (a.playbackRate = 0.15)));
    await page.locator(".modal").screenshot({ path: resolve(output, `${name}-${String(i).padStart(2, "0")}.png`), animations: "allow" });
    await sleep(90);
  }
  await page.evaluate(() => { window.__slow.disconnect(); document.getAnimations().forEach((a) => a.finish?.()); });
  try {
    await promisify(execFile)("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "8", "-i", resolve(output, `${name}-%02d.png`),
      "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", resolve(output, `${name}.gif`)]);
    report.gifs.push(`${name}.gif`);
  } catch (error) {
    report.gifs.push(`${name}: frames only (${String(error.message).split("\n")[0]})`);
  }
}

try {
  page = await board();
  await step("wide: one grid of cards, several to a row, ordered by what each task waits for, newest change first; nothing scrolls sideways", async () => {
    assert.equal(await page.locator(".collab-group-head").count(), 0, "no headings while no task is open");
    const chips = await page.locator(".collab-cards .collab-task-card .collab-status").allInnerTexts();
    assert.deepEqual(chips, ["To review", "Blocked", "In progress", "In progress", "In progress", "To do", "To do", "To do", "To do"]);
    const ids = await page.locator(".collab-task-card").evaluateAll((rows) => rows.map((r) => r.dataset.taskId));
    assert.deepEqual(ids, ["T-90", "T-118", "T-108", "T-114", "T-89", "T-88", "T-120", "T-109", "T-110"]);
    assert.equal(await row("T-118").locator(".collab-row-line").innerText(), "已加载会话的 resume 不会换用新窗口，需要先确定安全重载方式。");
    assert.equal(await row("T-88").locator(".collab-row-line").innerText(), "让新用户无需开发环境即可安装，并在首次启动时选择本机或远程 Core。");
    assert.equal(await row("T-88").locator(".collab-has-result").count(), 0, "an earlier slice's result is not this round's");
    assert.equal(await row("T-90").locator(".collab-has-result").count(), 1);
    assert.match(await row("T-88").locator(".github-summary").innerText(), /^3 merged$/);
    assert.match(await row("T-108").locator(".github-summary").innerText(), /#125.*Draft.*Checks unknown.*2 merged/s);
    // Several cards to a row: the first four share their top.
    const tops = await Promise.all(["T-90", "T-118", "T-108", "T-114"].map((id) => row(id).evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    assert.ok(tops.every((top) => top === tops[0]), JSON.stringify(tops));
    await noSideways();
    await page.locator(".modal").screenshot({ path: resolve(output, "list-light-1440.png") });
  });
  await step("the detail beside the list: title and actions, where things stand, the work, then Delivery with what is linked", async () => {
    await openTask("T-90");
    assert.equal(await page.locator(".collab-task-layout.with-detail").count(), 1);
    // Beside the detail, rows under status headings, one per task.
    const groups = await page.locator(".collab-group-head").allInnerTexts();
    assert.deepEqual(groups.map((g) => g.replace(/\s*\d+$/, "").trim()), ["To review", "Blocked", "In progress", "To do"]);
    const rowTops = await Promise.all(["T-108", "T-114"].map((id) => row(id).evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    assert.ok(rowTops[1] > rowTops[0], JSON.stringify(rowTops));
    assert.ok(await detail().locator(".collab-task-title").getByRole("button", { name: "Edit task" }).isVisible());
    assert.ok(await page.getByRole("button", { name: "Close task" }).isVisible());
    assert.ok(!(await detail().getByRole("button", { name: "All tasks" }).isVisible()), "beside the list, close rather than back");
    const h = await headings();
    before(h, "The result", "The work");
    before(h, "The work", "Delivery");
    const delivery = detail().locator(".collab-delivery");
    const text = await delivery.innerText();
    assert.match(text, /#124[\s\S]*Open[\s\S]*Checks passed/);
    assert.match(text, /No actionable findings/, "the review's conclusion shows without Manage");
    assert.doesNotMatch(text, /Create or reuse PR|Issue or pull request URL|Review PR|Notify when finished/);
    assert.equal(await delivery.locator('[aria-label^="Unlink"]').count(), 0);
    await noSideways();
    await page.locator(".modal").screenshot({ path: resolve(output, "detail-light-1440.png") });
    await delivery.getByRole("button", { name: "Manage" }).click();
    await delivery.getByText("Issue or pull request URL").waitFor();
    assert.ok(await delivery.getByRole("button", { name: "Review PR" }).first().isVisible());
    assert.ok(await delivery.getByRole("button", { name: "Create or reuse PR" }).isVisible());
    assert.ok(await delivery.getByRole("button", { name: "Set up delivery…" }).isVisible());
    assert.equal(await delivery.locator('[aria-label="Unlink YuzukiS/Yuzuno#124"]').count(), 1);
    await delivery.scrollIntoViewIfNeeded();
    await detail().screenshot({ path: resolve(output, "detail-manage-light-1440.png") });
  });
  await step("an earlier round's result is labelled so; a task with nothing linked offers one button; long titles wrap at two lines", async () => {
    await openTask("T-89");
    // Beside the detail a long title wraps to two lines, no more.
    const title = await row("T-120").locator(".collab-row-title").evaluate((el) => ({
      lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
      clamp: getComputedStyle(el).webkitLineClamp,
    }));
    assert.ok(title.lines === 2 && title.clamp === "2", JSON.stringify(title));
    const h = await headings();
    before(h, "Earlier result", "Where things stand");
    assert.ok(!h.includes("The result"));
    const delivery = detail().locator(".collab-delivery");
    assert.match(await delivery.innerText(), /No Issue or PR linked yet/);
    assert.ok(await delivery.getByRole("button", { name: "Link a PR or Issue" }).isVisible());
    assert.doesNotMatch(await delivery.innerText(), /Create or reuse PR|Set up delivery|Pull requests and issues/);
    await page.locator(".modal").screenshot({ path: resolve(output, "detail-nothing-linked-light-1440.png") });
  });
  await step("the keyboard opens a row; reduced motion closes at once", async () => {
    await page.getByRole("button", { name: "Close task" }).click();
    await page.locator(".collab-detail").waitFor({ state: "detached", timeout: 300 });
    await row("T-114").focus();
    await page.keyboard.press("Enter");
    await page.locator('.collab-detail .collab-task-title [data-task-id="T-114"]').waitFor();
    assert.equal(await row("T-114").getAttribute("aria-pressed"), "true");
    // The card it was opened from is now a row: focus is on that row.
    await page.waitForFunction(() => document.activeElement?.dataset?.taskId === "T-114", null, { timeout: 2000 });
  });
  await page.context().close();

  page = await board({ motion: "no-preference" });
  await step("the detail slides in beside the list and out again; another task only fades in", async () => {
    // Real speed: part way in, part way out.
    await row("T-108").click();
    await sleep(70);
    const midway = await page.evaluate(() => {
      const d = document.querySelector(".collab-detail");
      return { opacity: Number(getComputedStyle(d).opacity), width: d.getBoundingClientRect().width };
    });
    await sleep(400);
    const settled = await page.evaluate(() => {
      const d = document.querySelector(".collab-detail");
      return { opacity: Number(getComputedStyle(d).opacity), width: d.getBoundingClientRect().width };
    });
    assert.ok(midway.opacity < 1 && midway.width < settled.width - 20, JSON.stringify({ midway, settled }));
    assert.equal(settled.opacity, 1);
    await row("T-114").click();
    assert.equal(await page.locator(".collab-task-layout").getAttribute("data-entry"), "switch");
    await sleep(350);
    // The cards come back only once the list has its whole width again.
    await page.evaluate(() => {
      window.__cardsAt = null;
      window.__cards = new MutationObserver(() => {
        if (window.__cardsAt || !document.querySelector(".collab-cards")) return;
        const width = (selector) => document.querySelector(selector).getBoundingClientRect().width;
        window.__cardsAt = { list: width(".collab-task-list"), all: width(".collab-task-layout") };
      });
      window.__cards.observe(document.body, { subtree: true, childList: true });
    });
    await page.getByRole("button", { name: "Close task" }).click();
    await sleep(60);
    assert.equal(await page.locator(".collab-task-layout.with-detail").count(), 0, "the list widens at once");
    assert.equal(await detail().count(), 1, "the detail leaves, not vanishes");
    assert.equal(await page.locator(".collab-cards").count(), 0, "rows until the detail has gone");
    await page.locator(".collab-detail").waitFor({ state: "detached", timeout: 1000 });
    const cardsAt = await page.evaluate(() => (window.__cards.disconnect(), window.__cardsAt));
    assert.ok(cardsAt && cardsAt.list >= cardsAt.all - 1, JSON.stringify(cardsAt));
    // For the user: the motion, slowed down.
    await film("open", () => row("T-90").click());
    await film("switch", () => row("T-118").click(), 8);
    await film("close", () => page.getByRole("button", { name: "Close task" }).click());
    return { gifs: report.gifs };
  });
  await page.context().close();

  page = await board({ theme: "dark" });
  await step("dark at 1440: list and detail", async () => {
    await page.locator(".modal").screenshot({ path: resolve(output, "list-dark-1440.png") });
    await openTask("T-108");
    await noSideways();
    await page.locator(".modal").screenshot({ path: resolve(output, "detail-dark-1440.png") });
  });
  await page.context().close();

  for (const theme of ["light", "dark"]) {
    page = await board({ theme, width: 390 });
    await step(`${theme} at 390: rows stack, the detail replaces the list with a way back`, async () => {
      await noSideways();
      await page.locator(".modal").screenshot({ path: resolve(output, `list-${theme}-390.png`) });
      await openTask("T-90");
      assert.ok(!(await page.locator(".collab-task-list").isVisible()));
      assert.ok(await detail().getByRole("button", { name: "All tasks" }).isVisible());
      assert.ok(!(await page.getByRole("button", { name: "Close task" }).isVisible()));
      await noSideways();
      await page.locator(".modal").screenshot({ path: resolve(output, `detail-${theme}-390.png`) });
      await detail().getByRole("button", { name: "All tasks" }).click();
      await page.locator(".collab-task-list").waitFor();
      assert.equal(await detail().count(), 0);
    });
    await page.context().close();
  }
} finally {
  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: report.unexpected.join("\n") });
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
