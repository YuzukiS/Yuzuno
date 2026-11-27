// YN-237 (R-50): a Project's page as the approved design (yn-237 v3) lays it out, in Chromium with the real page,
// entered from Home, every API answered here (no Core, no daily data). Synthetic data in yuzuno-next's shape on 11-26:
// R-60 (R-31's shape) going on, its status as of a time, a delivered report, follow-up #3 answered while the work goes
// on, its bar from its Plan and PRs, and a lead's proposal of a new request; R-62 (R-47's) with its result, a report
// the lead wrote and bound to no task; R-14, older than the page, going on, kept by Core on the first page (`kept`);
// the lead's status across requests and one maintenance card of no request. At 1280 px with the mouse and the keyboard,
// and on a 390 px phone by touch, in Chinese and once in English:
//  - the head: the release, the counts, what changed per request, the lead's one line, Other folded; R-62's report and
//    the lead's card each once; R-14 in In progress with its card, not under Other;
//  - R-60 folded: now with its time, Needs you, the result and the follow-up said apart from its delivery; nothing
//    wider than the window;
//  - one step each: the result's Full text opens its report (Escape closes it, focus back), Conversation lands on
//    follow-up #3 with the focus, Decide (Enter, by keyboard on the desktop) unfolds it at the proposal;
//  - unfolded: the bar by evidence, what "new" opens, the proposal's three options; choosing "new" posts that choice
//    alone, and Core's next read shows R-71 opened from it, each request one step from the other;
//  - an older Core (no kept, from, proposals or proposal): the page draws, R-14 then under Other, with no error;
//  - one step into Details (review 4324938d): from the lead's conversation, Open on Home (Enter on the desktop, touch on
//    the phone, then the mouse) lands on what R-60 keeps under Details, found by its section's key: an answered Ask,
//    its second task's card, an earlier card. Home is drawn anew each time (closed while the conversation shows), so
//    each lands from Details folded; each in view with the focus, Details opened for it and no other fold. Details
//    stays folded when the block is only unfolded.
// Screenshots and a JSON report go to YUZUNO_BROWSER_OUTPUT.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-home-check.mjs
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
const report = { task: "YN-237", fixture: "synthetic, yuzuno-next's shape on 11-26", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47397";
let now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
const EXEC = "YN-221 · 按批准的设计实现";
const agents = [
  { ...base, id: "l", name: "Dev Lead", kind: "lead" },
  { ...base, id: "e221", name: EXEC, kind: "executor", status: "working",
    executor: { state: "running", task: { id: "YN-221", title: "运行改进选择", shortName: "运行改进" } } },
];
const projects = [{ id: "p-dev", name: "yuzuno-next", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const lead = { agentId: "l", name: "Dev Lead", state: "active" };
const exec = { agentId: "e221", name: EXEC, state: "active" };
const responsible = { agentId: "e221", name: EXEC, kind: "executor", state: "running" };
const bind = (task, title, status = "doing", who = responsible) => ({ task: { id: task, title, shortName: title, status, archived: false }, responsible: who });
let ids = 700;
const section = (key, kind, title, minutes, owner, body, extra = {}) => ({
  id: ids++, key, kind, title, version: 2, owner, author: { agentId: owner.agentId, name: owner.name }, updatedAt: at(minutes), updatedTurnId: "t",
  body, attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const summary = (lead, children = [], extra = {}) => ({ root: "body", elements: {
  body: node("BriefBody", { summary: { lead: "lead", size: "wide", ...extra } }, ["lead", ...children.map(([id]) => id)]),
  lead: node("Markdown", { text: lead }), ...Object.fromEntries(children) } });

const NOW_TEXT = "同轮去重 #1144 审查通过、等入队；待回复清单开发中。";
const RESULT = "已随 core.39 安装的 4 项：首页每次响应减少 82%。";
const REPLY3 = "我来实现。新请求按 R 编号、追问按各自序号进入待回复清单，答复写回原请求后逐条清除。";
const PROPOSAL = "阶段 Job 只读一遍";
/** The page's sections and requests; `opened`: R-71 was opened from the proposal (after the user chose "new"). */
function data({ opened = false, older = false } = {}) {
  ids = 700;
  const plan = node("Plan", { steps: [
    { id: "s1", text: "范围已选", state: "done" },
    { id: "s2", text: "前 10 项 — 随 core.39", state: "done", prs: [1108, 1112] },
    { id: "s3", text: "同轮去重 #1144", state: "doing", prs: [1144] },
    { id: "s4", text: "Windows 窗口实测", state: "todo" }] });
  const status60 = section("yn-221", "status", "R-31 · 运行改进进展", 30, exec, summary(NOW_TEXT, [["plan", plan]], { progress: "plan" }), {
    status: { asOf: at(30), validFor: 14_400, stale: false }, card: bind("YN-221", "运行改进"),
  });
  const metrics = node("Metrics", { items: [{ label: "首页每次响应", value: "20.1", unit: "kB", previous: "111.6" }] });
  const report60 = section("yn-221/core39", "report", "已随 core.39 安装的 4 项", 600, exec, summary(`**${RESULT}** 条件：Chromium 测试，30 篇历史报告。`, [["m", metrics]], { visual: "m" }), {
    card: bind("YN-221", "运行改进"),
  });
  const proposal = section("r60/split", "ask", "拆出一项新请求？", 12, lead, summary("执行中发现：推进一个运行时，阶段 Job 被整体读了四遍。"), {
    ask: { question: "执行中发现：阶段 Job 被读了四遍，要不要单独做？", state: opened ? "replied" : "open",
      ...(opened ? { repliedAt: at(1), replyText: "新建请求并关联" } : {}),
      reply: { options: [{ id: "new", label: "新建请求并关联" }, { id: "merge", label: "并入 R-60" }, { id: "later", label: "先记下" }], freeText: true },
      ...(older ? {} : { proposal: { request: 60, title: PROPOSAL, text: "每次访问只读一遍阶段 Job，按同一负载测前后。" } }) },
  });
  // Under R-60's Details: an Ask of its task answered before this visit, its second task's card, an earlier card.
  const scope = [{ id: "core", label: "先做 Core 那批" }, { id: "desk", label: "先做桌面端" }];
  const answered60 = section("yn-221/scope", "ask", "先做哪一批？", 1500, exec, summary("两批运行改进里先做哪一批？"), {
    ask: { question: "两批里先做哪一批？", state: "replied", repliedAt: at(1490), replyText: "先做 Core 那批", reply: { options: scope } },
    card: bind("YN-221", "运行改进"),
  });
  const second60 = section("yn-238", "status", "R-31 · Windows 窗口实测", 200, exec, summary("Windows 下窗口实测排在 #1144 之后。"), {
    status: { asOf: at(200), validFor: 31_536_000, stale: false }, card: bind("YN-238", "窗口实测"),
  });
  const earlier60 = section("yn-221/notes", "status", "R-31 · 早先的范围说明", 2000, exec, summary("先选范围，再分两批做。"), {
    status: { asOf: at(2000), validFor: 31_536_000, stale: false }, card: bind("YN-221", "运行改进"),
  });
  const report62 = section("yn-235", "report", "R-47 · 先试行合 PR 规则", 120, lead, summary("**主线 macOS Cargo 构建 33′48″ → 12′46″（2 次观测）。** 满两周复盘。"));
  const status14 = section("yn-197", "status", "Core CPU 调查", 300, lead, summary("现场 74% 的 CPU 用于推进 Jobs；修复在 R-60。"), {
    status: { asOf: at(300), validFor: 31_536_000, stale: false }, card: bind("YN-197", "CPU 调查", "doing", { agentId: "l", name: "Dev Lead", kind: "lead", state: "active" }),
  });
  const development = section("development", "status", "项目进度 · core.40 已安装", 25, lead, summary("**本周收尾 R-60，R-62 的 PR 规则试行满两周后复盘。**"), {
    status: { asOf: at(25), validFor: 14_400, stale: false },
  });
  const upkeep = section("upkeep", "report", "清理旧工作树的计划", 400, lead, summary("**三棵旧工作树可清理。** 等你下次清理时一起批准。"));
  const pull = (number, state, installed, minutes = 600) => ({ number, title: `[YN-221] 第 ${number} 号`, url: `https://example.test/pull/${number}`,
    repository: "o/r", state, mergedAt: state === "merged" ? at(minutes) : null, installed });
  const reportItem = (s) => ({ kind: "report", title: s.title, note: null, key: s.key, version: s.version, sectionId: s.id, state: "live", currentVersion: s.version });
  const desk = { agentId: "l", name: "Dev Lead" };
  const request = (n, minutes, title, cards, extra = {}) => ({
    id: `req-${n}`, n, text: `R-${n} 的原话`, textBlocks: null, images: [], files: [], title, createdAt: at(minutes), frontAgentId: "l",
    messageId: `m${n}`, delivery: "accepted", replies: [], notes: [{ n: 1, note: "好，交给执行者。", by: desk, at: at(minutes - 1), replyTo: null }],
    routes: [], cards, state: "doing", confirmedAt: null, progress: { cards: cards.length, ended: 0 }, lines: [], ...extra,
    ...(older ? {} : { from: extra.from ?? null, proposals: extra.proposals ?? [] }),
  });
  const card = (s, task, extra = {}) => ({ sectionId: s.id, key: s.key, title: s.title, live: true, responsible: s.card.responsible,
    task: { id: task, status: "doing", archived: false, progress: null, progressAt: null, blocker: null }, prs: { items: [] }, ...extra });
  const link = (n) => ({ n, key: "r60/split", sectionId: proposal.id, version: 2, at: at(1) });
  const r60 = request(60, 2900, "选择下一批 Core 与桌面端运行改进", [card(status60, "YN-221", {
    result: { id: "res-221", status: "doing", reportedAt: at(600) },
    deliverables: { resultId: "res-221", reportedAt: at(600), items: [reportItem(report60)] },
    prs: { items: [pull(1108, "merged", true), pull(1112, "merged", true), pull(1144, "open", null)] } }), card(second60, "YN-238")], {
    replies: [{ n: 3, text: "统一按编号保留待回复清单，实现吧", textBlocks: null, images: [], files: [], at: at(90), messageId: "m60-3",
      deliveredTo: [{ agentId: "l", name: "Dev Lead", delivery: "accepted" }] }],
    notes: [{ n: 1, note: "好，交给执行者。", by: desk, at: at(2899), replyTo: null }, { n: 2, note: REPLY3, by: desk, at: at(80), replyTo: [3] }],
    proposals: opened ? [link(71)] : [] });
  const r62 = request(62, 1200, "找出 PR 拆分与 CI 等待的主要成本", [{ sectionId: null, key: null, title: null, live: false,
    responsible: { agentId: "l", name: "Dev Lead", kind: "lead", state: "active" },
    task: { id: "YN-235", status: "doing", archived: false, progress: "按成果组织 PR 试行中，满两周复盘。", progressAt: at(120), blocker: null },
    result: { id: "res-235", status: "doing", reportedAt: at(120) },
    deliverables: { resultId: "res-235", reportedAt: at(120), items: [reportItem(report62)] }, prs: { items: [] } }]);
  const r14 = request(14, 20_000, "检查当前 Core CPU 与在做优化的覆盖", [card(status14, "YN-197")]);
  const filler = Array.from({ length: 18 }, (_, i) => request(43 + i, 3000 + i, `较早完成的请求 ${43 + i}`, [], { state: "done", confirmedAt: at(2000) }))
    .filter((r) => r.n !== 60 && r.n !== 62);
  const r71 = request(71, 1, PROPOSAL, [], { state: "waiting", text: "每次访问只读一遍阶段 Job，按同一负载测前后。", notes: [], from: link(60) });
  const page = [...(opened ? [r71] : []), r62, r60, ...filler].sort((a, b) => b.n - a.n).slice(0, 20);
  return {
    sections: [development, upkeep, status60, report60, proposal, answered60, second60, earlier60, report62, status14],
    requests: { requests: page, hasMore: true, ...(older ? {} : { kept: [r14] }),
      installedRelease: { releaseId: "core-20261126-abcdef0", version: "core.40", gitSha: "a".repeat(40) }, mergedAfterInstalled: 1 },
  };
}
/** The lead's conversation: the user's replies from Home to what R-60 keeps under Details, each with Open on Home. */
const fromHome = (id, key, kind, title, extra) => ({ id, type: "userMessage", clientId: `c-${id}`, _yuzunoInput: "home",
  _yuzunoHome: { projectId: "p-dev", key, version: 2, workspaceId: "ws-237", snapshot: { format: 1, projectName: "yuzuno-next", sectionKind: kind,
    title, question: null, options: null, choice: null, text: null, form: null, ...extra } },
  content: [{ type: "text", text: `Reply from the user on Home: ${title}` }] });
const said = (id, text) => ({ id, type: "agentMessage", phase: "final_answer", text });
const leadTurns = () => [{ id: "t-l1", status: "completed", items: [
  fromHome("home-ask", "yn-221/scope", "ask", "先做哪一批？", { question: "两批里先做哪一批？",
    options: [{ id: "core", label: "先做 Core 那批" }, { id: "desk", label: "先做桌面端" }], choice: { id: "core", label: "先做 Core 那批" } }),
  said("a1", "好，先做 Core 那批。"),
  fromHome("home-card", "yn-238", "status", "R-31 · Windows 窗口实测", { text: "窗口实测放在 #1144 之后可以。" }),
  said("a2", "收到。"),
  fromHome("home-earlier", "yn-221/notes", "status", "R-31 · 早先的范围说明", { text: "这份范围说明还对吗？" }),
  said("a3", "还对。"),
] }];
const home = (sections) => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "yuzuno-next" }, agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] }, errors: [], pending: [], jobs: [], unseen: 3, missing: [],
    brief: { version: 9, history: [], sections },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "zh-1280", viewport: { width: 1280, height: 900 }, phone: false, language: "zh-Hans" },
  { name: "zh-phone-390", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans" },
  { name: "en-1280", viewport: { width: 1280, height: 900 }, phone: false, language: "en" },
  { name: "zh-1280-older-core", viewport: { width: 1280, height: 900 }, phone: false, language: "zh-Hans", older: true },
];
let passed = 0;
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "request-home-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`request-home-check: ${report.runs.length} runs, ${passed} checks`);

function pass(run, what, facts) {
  passed += 1;
  console.log(`PASS [${run.name}] ${what}${facts ? ` ${JSON.stringify(facts)}` : ""}`);
}

async function check(run) {
  now = Date.now();
  const zh = run.language === "zh-Hans";
  const w = (en, cn) => (zh ? cn : en);
  const state = { opened: false, replies: [] };
  const result = { run: run.name, viewport: run.viewport, facts: {}, shots: [] };
  report.runs.push(result);
  const context = await browser.newContext({
    viewport: run.viewport, locale: zh ? "zh-CN" : "en-US", timezoneId: "UTC", deviceScaleFactor: run.phone ? 2 : 1,
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript((language) => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    const now = data({ opened: state.opened, older: run.older });
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-237" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home(now.sections) });
    if (method === "POST" && path === "/api/projects/p-dev/brief/reply") {
      const body = JSON.parse(request.postData() || "{}");
      state.replies.push(body);
      report.posts.push({ run: run.name, path, key: body.key, choice: body.choice ?? null, askVersion: body.askVersion ?? null });
      // Core opens R-71 on "new" and marks the Ask replied; the page reads both next.
      if (body.choice === "new") state.opened = true;
      return route.fulfill({ json: { input: { clientMessageId: body.clientMessageId, text: "reply", textBlocks: null, images: [] }, status: "accepted",
        turnId: "t1", error: null } });
    }
    if (method === "POST" && /^\/api\/projects\/[^/]+\/brief\/opened$/.test(path)) {
      const body = JSON.parse(request.postData() || "{}");
      return route.fulfill({ json: { projectId: "p-dev", sectionId: body.sectionId, key: body.key, version: body.version, at: at(0), recorded: true } });
    }
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w+\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      // Where an Agent's conversation was read, saved by the app as it is shown.
      if (method === "PUT" && /^\/api\/agents\/\w+\/reading$/.test(path)) return route.fulfill({ json: { accepted: true } });
      report.posts.push({ run: run.name, method, path, unexpected: true });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [],
      turns: detail[1] === "l" ? leadTurns() : [] } });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: "l", effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests") {
      if (url.searchParams.get("before")) return route.fulfill({ json: { requests: [], hasMore: false } });
      return route.fulfill({ json: now.requests });
    }
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] }, "/api/collaboration/github_repositories": { repositories: [], links: [] },
      "/api/catchup": { items: [], generatedAt: at(0), source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
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
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const shot = async (name, target = page) => {
    const file = `${run.name}-${name}.png`;
    await target.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const tap = async (locator) => (run.phone ? locator.tap() : locator.click());
  const text = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, " ").trim());
  const block = (n) => page.locator(`[data-request-block="${n}"]`);
  const wider = () => page.evaluate(() => {
    const view = document.querySelector(".home-view").getBoundingClientRect();
    return [...document.querySelectorAll(".project-head, .project-head *, .request-block, .request-block *")]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > view.right + 1 || r.left < view.left - 1); })
      .map((el) => el.className || el.tagName).slice(0, 10);
  });
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-237`);
    const enter = page.locator('[data-glance-project="p-dev"] .project-glance-open');
    await enter.waitFor({ timeout: 15_000 });
    await tap(enter);
    await block(60).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400);

    if (run.older) {
      // An older Core: no kept, no proposal, no links. R-14 is not read, so its card is the Project's, under Other.
      const groups = await page.evaluate(() => [...document.querySelectorAll(".request-group")].map((g) => g.dataset.group));
      assert.equal(await block(14).count(), 0, "an older Core keeps nothing beside the page");
      assert.ok(await page.locator('.project-head-others summary').count(), "R-14's card stands under Other");
      assert.equal(await block(60).locator(".request-proposal").count(), 0, "no proposal from an older Core");
      result.facts.older = { groups };
      await shot("older-core");
      pass(run, "an older Core's page draws, its cards where they were, with no error", result.facts.older);
      return;
    }

    // The head: across requests only, each fact once.
    const head = page.locator(".project-head");
    const facts = {
      release: await text(head.locator(".project-head-release")),
      pending: await text(head.locator(".project-head-pending")),
      counts: await head.locator(".project-head-counts button").evaluateAll((all) => all.map((b) => b.textContent.trim())),
      changes: await head.locator(".project-head-change").evaluateAll((all) => all.map((b) => b.textContent.replace(/\s+/g, " ").trim())),
      lead: await text(head.locator(".project-head-said")),
      other: await text(head.locator(".project-head-others summary")),
      leadCardTimes: await page.locator('[data-section-key="development"], [data-now-key="development"]').count(),
      report62Times: await page.locator('[data-section-key="yn-235"]').count(),
      r14Group: await block(14).getAttribute("data-group"),
      r14InOther: await page.locator('.project-head-others [data-section-key="yn-197"]').count(),
      wider: await wider(),
    };
    result.facts.head = facts;
    assert.equal(facts.release, w("Running core.40", "运行 core.40"));
    assert.match(facts.pending, w(/1 merged PR waits/, /1 个已合入 PR 等下一版/));
    assert.ok(facts.changes.some((line) => line.startsWith("R-60")), JSON.stringify(facts.changes));
    assert.equal(facts.lead, "本周收尾 R-60，R-62 的 PR 规则试行满两周后复盘。");
    assert.match(facts.other, w(/^Other 1/, /^其他 1/), "the maintenance card alone: R-62's report is R-62's");
    assert.equal(facts.leadCardTimes, 1, "the lead's card once");
    assert.equal(facts.report62Times, 0, "R-62's report is not drawn folded, nor under Other");
    assert.equal(facts.r14Group, "doing", "R-14, older than the page, in its group");
    assert.equal(facts.r14InOther, 0);
    assert.deepEqual(facts.wider, [], "nothing wider than the window");
    await shot("head", head);
    pass(run, "the head says what is across requests, each once; R-14 is in its group", { changes: facts.changes.length });

    // R-60 folded: four lines, each with its one step; zero clicks to its newest result.
    const r60 = block(60);
    await r60.scrollIntoViewIfNeeded();
    const line = (kind) => r60.locator(`.request-look-line[data-look="${kind}"]`);
    const first = {
      now: await text(line("now").locator(".request-look-said")),
      nowMeta: await text(line("now").locator(".request-look-meta")),
      ask: await text(line("ask").locator(".request-look-said")),
      result: await text(line("result").locator(".request-look-said")),
      follow: await text(line("follow")),
      tags: await line("follow").locator(".request-look-tag").evaluateAll((all) => all.map((t) => t.textContent.trim())),
      group: await r60.getAttribute("data-group"),
      wider: await wider(),
    };
    result.facts.firstLook = first;
    assert.equal(first.now, NOW_TEXT);
    assert.match(first.nowMeta, w(/^as of 30 min ago/, /^截至 30 分钟前/));
    assert.equal(first.ask, "执行中发现：阶段 Job 被读了四遍，要不要单独做？");
    assert.equal(first.result, RESULT, "the result in the first look: zero clicks to it");
    assert.deepEqual(first.tags, [w("Replied", "已回复"), w("Work still going on, not delivered", "工作仍在进行，未交付")]);
    assert.equal(first.group, "needs");
    assert.deepEqual(first.wider, []);
    await shot("r60-folded", r60);
    pass(run, "R-60 folded: now, needs you, its result and its follow-up apart from delivery", { tags: first.tags });

    // Full text: its report page, in one step; Escape closes it, the focus back on its step.
    const whole = line("result").locator('[data-step="report"]');
    await tap(whole);
    const reportPage = page.locator(".home-report");
    await reportPage.waitFor({ timeout: 5000 });
    const heading = await text(reportPage.locator(".report-head h1"));
    assert.equal(heading, "已随 core.39 安装的 4 项");
    await shot("report");
    await page.keyboard.press("Escape");
    await reportPage.waitFor({ state: "detached", timeout: 5000 });
    const back = await page.evaluate(() => document.activeElement?.dataset?.step ?? document.activeElement?.className ?? null);
    result.facts.report = { heading, back };
    assert.equal(back, "report", "the focus returns to Full text");
    pass(run, "Full text opens the report in one step; Escape closes it", result.facts.report);

    // Conversation: the follow-up #3 in view with the focus, it and its reply marked.
    await tap(line("follow").locator('[data-step="talk"]'));
    const reply = r60.locator('.request-thread > li[data-reply="3"]');
    await reply.waitFor({ timeout: 5000 });
    await page.waitForTimeout(700);
    const landed = await page.evaluate(() => {
      const view = document.querySelector(".home-view").getBoundingClientRect();
      const block = document.querySelector('[data-request-block="60"]');
      const target = block.querySelector('.request-thread > li[data-reply="3"]').getBoundingClientRect();
      return {
        focused: document.activeElement?.matches?.('[data-request-block="60"] .request-thread > li[data-reply="3"]') ?? false,
        marked: [...block.querySelectorAll(".request-thread > li[data-focus]")].map((li) => li.dataset.threadItem),
        inView: target.top >= view.top - 1 && target.bottom <= view.bottom + 1,
      };
    });
    result.facts.conversation = landed;
    assert.deepEqual(landed, { focused: true, marked: ["reply:3", "note:2"], inView: true });
    await shot("conversation", r60);
    pass(run, "Conversation lands on follow-up #3 and its reply, with the focus", landed);
    // Fold it again, by its foot.
    await tap(r60.locator('.request-block-foot > .request-block-more[data-view="thread"]'));
    await r60.locator(".request-look").waitFor({ timeout: 5000 });

    // Decide: by keyboard on the desktop (focus, Enter), by touch on the phone: it unfolds at the proposal.
    const decide = line("ask").locator('[data-step="decide"]');
    if (run.phone) await decide.tap();
    else {
      await decide.focus();
      await page.keyboard.press("Enter");
    }
    const proposal = r60.locator('.request-proposal[data-proposal="r60/split"]');
    await proposal.waitFor({ timeout: 5000 });
    await page.waitForTimeout(600);
    const unfolded = {
      preview: await text(proposal.locator(".request-proposal-preview")),
      options: await proposal.locator(".home-ask-pick input").evaluateAll((all) => all.map((input) => [input.value, input.closest("label").textContent.trim()])),
      bar: await r60.locator(".request-bar-seg").evaluateAll((all) => all.map((s) => s.dataset.state)),
      detailsHidden: await r60.locator(".request-block-details").evaluate((el) => el.hidden),
      inView: await proposal.evaluate((el) => {
        const view = document.querySelector(".home-view").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.top < view.bottom && r.bottom > view.top;
      }),
      wider: await wider(),
    };
    result.facts.unfolded = unfolded;
    assert.equal(unfolded.preview, `${w("On “new”, Core opens this request:", "选「新建」时，Core 会新建这个请求：")}${PROPOSAL}每次访问只读一遍阶段 Job，按同一负载测前后。`);
    assert.deepEqual(unfolded.options, [["new", "新建请求并关联"], ["merge", "并入 R-60"], ["later", "先记下"]]);
    assert.deepEqual(unfolded.bar, ["done", "available", "doing", "todo"], "S2's PRs are in the release: usable, by evidence");
    assert.equal(unfolded.inView, true);
    assert.equal(unfolded.detailsHidden, true, "unfolding the block leaves Details folded");
    assert.deepEqual(unfolded.wider, []);
    await shot("r60-unfolded-proposal", r60);
    pass(run, "Decide unfolds R-60 at its proposal: what new opens, three options, the bar by evidence", { bar: unfolded.bar });

    // "New": that choice alone is posted; Core's next read shows R-71 opened from it, both linked.
    await tap(proposal.locator(".home-ask-pick", { hasText: "新建请求并关联" }));
    await tap(proposal.locator("button.primary-button"));
    await page.waitForFunction(() => document.querySelector('[data-request-block="71"]'), null, { timeout: 15_000 });
    await page.waitForTimeout(500);
    const sent = state.replies.at(-1);
    const linked = {
      posted: { key: sent.key, choice: sent.choice, askVersion: sent.askVersion },
      here: await text(block(60).locator(".request-proposal-opened")).catch(() => null),
      there: await text(block(71).locator('.request-look-line[data-look="related"]')),
    };
    result.facts.opened = linked;
    assert.deepEqual(linked.posted, { key: "r60/split", choice: "new", askVersion: 2 });
    assert.equal(linked.there, `${w("Related", "相关")}${w("Opened from a proposal in R-60", "从 R-60 的提议拆出")}`);
    await tap(block(71).locator('.request-look-line[data-look="related"] button'));
    await page.waitForTimeout(500);
    const r60Top = await block(60).evaluate((el) => el.getBoundingClientRect().top);
    await shot("opened-r71");
    pass(run, "choosing new posts it alone; R-71 opened from it, one step back to R-60", { ...linked, r60Top });
    assert.deepEqual(await wider(), []);

    // One step into Details (review 4324938d): from the lead's conversation, Open on Home on a reply lands on the
    // section it answered, found by its key, wherever R-60 keeps it under Details.
    await page.goto(`http://${HOST}/#/agent?w=ws-237&a=l`);
    const openOnHome = async (item, how) => {
      const reply = page.locator(`[data-item-id="${item}"]`);
      await page.locator(`[data-item-id="${item}"], .app.phone-list .agent-row`).first().waitFor({ timeout: 15_000 });
      if (!(await reply.count())) await tap(page.locator(".app.phone-list .agent-row", { hasText: "Dev Lead" }).first());
      await reply.waitFor({ timeout: 15_000 });
      // Home is closed while the conversation shows: R-60 is drawn anew, its Details folded, on Open on Home.
      assert.equal(await page.locator("[data-request-block]").count(), 0, "Home is not drawn behind the conversation");
      const button = reply.locator(".home-reply-action.home");
      await button.scrollIntoViewIfNeeded();
      if (how === "keyboard") {
        await button.focus();
        await page.keyboard.press("Enter");
      } else await tap(button);
    };
    const landedOn = async (key) => {
      const id = `home-section-p-dev-${key}`;
      await page.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 15_000 });
      await page.waitForTimeout(800);
      return page.evaluate((id) => {
        const target = document.getElementById(id);
        const view = document.querySelector(".home-view").getBoundingClientRect();
        const r = target.getBoundingClientRect();
        const details = target.closest(".request-block-details");
        // In view: at least half of it, or half of the view where it is taller.
        const seen = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top);
        return {
          focused: document.activeElement === target,
          visible: target.checkVisibility() && r.width > 0 && r.height > 0,
          inView: seen >= Math.min(r.height, view.height) / 2,
          request: target.closest("[data-request-block]")?.dataset.requestBlock ?? null,
          detailsOpen: details ? !details.hidden : null,
          earlierOpen: document.querySelector('[data-request-block="60"] .request-task[data-task="YN-221"] > .request-task-earlier')?.open ?? null,
          // Its earlier cards, counted as the fold holds them: the result drawn above Details is not one of them.
          earlier: document.querySelector('[data-request-block="60"] .request-task[data-task="YN-221"] > .request-task-earlier > summary')
            ?.textContent.trim() ?? null,
        };
      }, id);
    };
    // Back to the lead's conversation by its link: each reply answered the version Home shows, so no arrival note
    // (with its way back) is drawn; the jump itself is Open on Home, clicked.
    const toConversation = () => page.goto(`http://${HOST}/#/agent?w=ws-237&a=l`);
    // An answered Ask: Enter on the desktop (touch on the phone); Details and its line open, no other fold.
    await openOnHome("home-ask", run.phone ? "touch" : "keyboard");
    const toAsk = await landedOn("yn-221/scope");
    assert.deepEqual(toAsk, { focused: true, visible: true, inView: true, request: "60", detailsOpen: true, earlierOpen: false,
      earlier: w("Earlier card 1", "更早的卡 1") }, JSON.stringify(toAsk));
    await shot("details-answered-ask");
    // Back in the conversation, Open on Home on another reply lands on R-60's second task's card (the mouse).
    await toConversation();
    await openOnHome("home-card", run.phone ? "touch" : "mouse");
    const toCard = await landedOn("yn-238");
    assert.deepEqual(toCard, { focused: true, visible: true, inView: true, request: "60", detailsOpen: true, earlierOpen: false,
      earlier: w("Earlier card 1", "更早的卡 1") }, JSON.stringify(toCard));
    await shot("details-second-task");
    // And an earlier card of its first task: its fold opens with it.
    await toConversation();
    await openOnHome("home-earlier", run.phone ? "touch" : "keyboard");
    const toEarlier = await landedOn("yn-221/notes");
    assert.deepEqual(toEarlier, { focused: true, visible: true, inView: true, request: "60", detailsOpen: true, earlierOpen: true,
      earlier: w("Earlier card 1", "更早的卡 1") }, JSON.stringify(toEarlier));
    await shot("details-earlier-card");
    result.facts.details = { toAsk, toCard, toEarlier };
    pass(run, "Open on Home lands under R-60's Details by key: an answered Ask, its second task's card, an earlier card", { landed: 3 });
    assert.deepEqual(await wider(), []);
  } catch (error) {
    await page.screenshot({ path: join(output, `${run.name}-failed.png`), fullPage: true }).catch(() => {});
    result.error = String(error?.stack || error);
    throw error;
  } finally {
    await context.close();
  }
}
