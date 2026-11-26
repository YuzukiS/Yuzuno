// R-38 S4 in Chromium, every API answered here (no Core, no daily configuration), through the production build:
// a Project's page by request, each request's first look by outcome (YN-227 design v5 §2.2, §3).
//  - R-38 itself: its design delivered, kept as evidence, the same task implementing: Team on it, its bar of six
//    outcomes (one merged with its install not verified, one usable, one in progress), its one next step;
//  - R-31: its only card an answered Ask naming the Plan; a task waiting for a condition: its next step is that;
//  - R-14: an investigation with no Plan: the first sentence of its task's progress;
//  - R-36: every outcome done and its task ended: for the user to accept, Confirm done and Follow up;
//  - R-40: an open Ask of its own, answered in its first look;
//  - R-41: a progress written before a PR merged and a follow-up: said so, above it;
//  - R-42 (R-43): a task with no card and no progress yet: the front desk's reply in its first look, not folded;
//  - a segment opens its outcome under the bar by click and by keyboard (Tab to it, its focus shown, Enter, Enter
//    again hides it), one at a time; Evidence opens the PRs by whether the release has them;
//  - at 1180 px and on a 390 px phone, and in Chinese at 1180; nothing wider than the window; nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-progress-check.mjs
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
const report = { task: "YN-227", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47394";
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
const agents = [
  { ...base, id: "l", name: "Dev Lead", kind: "lead" },
  { ...base, id: "x", name: "YN-227 · 按批准的设计实现", kind: "executor", status: "working",
    executor: { state: "running", task: { id: "YN-227", title: "R-38 · 请求进度条", shortName: "请求进度与待办" } } },
];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "Dev Lead", state: "active" };
const leadWho = { agentId: "l", name: "Dev Lead", kind: "lead", state: "active" };
const executor = { agentId: "x", name: "YN-227 · 按批准的设计实现", kind: "executor", state: "running" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
let id = 300;
const bind = (task, responsible, shortName = null) => ({ task: { id: task, title: task, shortName, status: "doing", archived: false }, responsible });
/** A card bound to `task` whose summary names its Plan of `steps` as the task's progress. */
const planned = (key, kind, title, task, steps, minutes, extra = {}) => ({
  id: id++, key, kind, title, version: 3, owner: lead, author: { agentId: "x", name: executor.name }, updatedAt: at(minutes), updatedTurnId: "t1",
  body: { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", progress: "plan", size: "wide" } }, ["lead", "plan"]),
    lead: md("In progress."), plan: node("Plan", { title: "Outcomes", steps }),
  } },
  attachments: [], refs: {}, seen: null, history: false, card: bind(task, task === "YN-221" ? leadWho : executor), ...extra,
});
const status = (minutes) => ({ status: { asOf: at(minutes), validFor: 86_400, stale: false } });
const pull = (number, state, installed, minutes = 40) => ({ number, title: `[YN-227] #${number}`, url: `https://github.com/o/atlas/pull/${number}`,
  repository: "o/atlas", state, mergedAt: state === "merged" ? at(minutes) : null, installed });

const r38Card = planned("yn-227", "status", "R-38 · 实施中", "YN-227", [
  { id: "s1", text: "S1 契约 — summary.progress 与步骤 prs", state: "done", prs: [1121] },
  { id: "s2", text: "S2 Core — 进度与安装核实", state: "done", prs: [1122, 1123] },
  { id: "s3", text: "S3 网页模型", state: "doing", prs: [1124] },
  { id: "s4", text: "S4 分段成果条", state: "todo" },
  { id: "s5", text: "S5 项目近况", state: "todo" },
  { id: "s6", text: "S6 写法规则", state: "todo" },
], 3, status(3));
const r31Ask = planned("yn-221", "ask", "这轮做哪些运行改进？", "YN-221", [
  { id: "a", text: "静态资源缓存与压缩", state: "done", prs: [1105] },
  { id: "b", text: "减少重复刷新", state: "done", prs: [1107] },
  { id: "c", text: "运行诊断 — 桌面诊断已合入", state: "done", prs: [1116] },
  { id: "d", text: "定位 Core CPU — 等含分步计量的版本安装", state: "blocked" },
], 90, { ask: { question: "这轮做哪些运行改进？", state: "replied", reply: { freeText: true }, repliedAt: at(95), replyText: "都做" } });
const r14Card = { ...planned("yn-197", "status", "Core CPU 调查", "YN-197", [{ id: "x", text: "x", state: "todo" }], 300, status(300)),
  body: { root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: md("Core CPU 调查：阶段对照完成。") } } };
const r36Card = planned("yn-225", "report", "R-36 · 工具栏", "YN-225", [
  { id: "a", text: "四个入口同排", state: "done", prs: [1119] }, { id: "b", text: "滚动时固定", state: "done", prs: [1119] },
], 120);
r36Card.card.task.status = "done";
const r40Ask = { id: id++, key: "yn-230/pick", kind: "ask", title: "选哪种读数？", version: 1, owner: lead, updatedAt: at(8), updatedTurnId: "t1",
  body: { root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: md("两种读数，选一种。") } }, attachments: [], refs: {}, seen: null, history: false,
  ask: { question: "选哪种读数？", state: "open", reply: { options: [{ id: "a", label: "完成 n/m" }, { id: "b", label: "可用 n/m" }], freeText: true } },
  card: bind("YN-230", executor) };
const r41Card = planned("yn-231", "status", "导出", "YN-231", [{ id: "a", text: "导出 CSV", state: "doing", prs: [1130] }], 60, status(60));
// The lead's status, bound to no task (the page leads with it, R-27): its common item is YN-221's condition (R-38 S5).
const devCard = { id: id++, key: "development", kind: "status", title: "开发状态", version: 4, owner: lead, updatedAt: at(15), updatedTurnId: "t1",
  status: { asOf: at(15), validFor: 86_400, stale: false },
  body: { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", size: "wide" } }, ["lead", "refs"]),
    lead: md("**等含分步计量的版本发布并安装。** 发布后请安装。"),
    refs: node("LiveRefs", { items: [{ kind: "task", id: "YN-221", label: "YN-221" }] }),
  } }, attachments: [], refs: {}, seen: null, history: false };
const sections = [r38Card, r31Ask, r14Card, r36Card, r40Ask, r41Card, devCard];
// The design's report, delivered and marked seen: in Home's History, opened from R-38's evidence at its version.
const designReport = { id: 619, key: "yn-227-design", kind: "report", title: "R-38 · 请求卡定稿", version: 6, owner: lead, updatedAt: at(200),
  updatedTurnId: "t0", body: { root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: md("① 分段成果条定稿。") } },
  attachments: [], refs: {}, seen: { version: 6, at: at(150) }, history: true, historyReason: "seen" };

const card = (s, task, taskStatus, responsible, extra = {}) => ({
  sectionId: s.id, key: s.key, title: s.title, live: true, responsible,
  task: { id: task, status: taskStatus, archived: false, progress: null, blocker: null, ...(extra.task ?? {}) },
  result: extra.result ?? null, deliverables: extra.deliverables ?? null, prs: { items: extra.prs ?? [] },
});
const request = (n, title, minutes, state, cards, extra = {}) => ({
  id: `req-${n}`, n, text: `R-${n} 的原话`, textBlocks: null, images: [], files: [], title, createdAt: at(minutes), frontAgentId: "l",
  messageId: `m${n}`, delivery: "accepted", replies: [], notes: [{ note: "好，交给执行者。", by: { agentId: "l", name: "Dev Lead" }, at: at(minutes - 1) }],
  routes: [], cards, state, confirmedAt: null, progress: { cards: cards.length, ended: cards.filter((c) => c.task.status === "done").length }, lines: [], ...extra,
});
const design = { kind: "report", title: "R-38 · 请求卡定稿", note: "定稿 v5", key: "yn-227-design", version: 6, sectionId: 619, state: "history", currentVersion: 6 };
const said42 = "我会把规则写进 Agent 提交 Job 时看到的说明，并核实主线是否允许直接快进。";
const requests = [
  request(42, "在 Job 提交说明写清 GPU 暂停时的处理", 4, "doing", [{
    sectionId: null, key: null, title: null, live: false, responsible: leadWho, result: null, deliverables: null, prs: { items: [] },
    task: { id: "YN-232", status: "doing", archived: false, progress: null, blocker: null },
  }], { notes: [{ note: said42, by: { agentId: "l", name: "Dev Lead" }, at: at(3) }] }),
  request(41, "导出设置", 200, "doing", [card(r41Card, "YN-231", "doing", executor, { prs: [pull(1130, "merged", null, 10)] })], {
    replies: [{ n: 1, text: "还要 JSON", textBlocks: null, images: [], files: [], at: at(5), messageId: "m41-1", deliveredTo: [] }],
  }),
  request(40, "读数选型", 30, "doing", [card(r40Ask, "YN-230", "doing", executor)], {
    lines: [{ kind: "ask", sectionId: r40Ask.id, key: r40Ask.key, title: r40Ask.title, state: "open", at: at(8), task: "YN-230", cardSectionId: null }],
  }),
  request(38, "让请求卡一眼看清进度", 240, "doing", [card(r38Card, "YN-227", "doing", executor, {
    result: { id: "res-design", status: "review", reportedAt: at(200) },
    deliverables: { resultId: "res-design", reportedAt: at(200), items: [design] },
    prs: [pull(1121, "merged", false), pull(1122, "merged", true), pull(1123, "merged", true), pull(1124, "open", null)],
  })]),
  request(36, "项目页一行工具栏", 600, "ended", [card(r36Card, "YN-225", "done", null, { prs: [pull(1119, "merged", false)] })], {
    lines: [{ kind: "done", task: "YN-225", status: "done", at: at(110), cardSectionId: r36Card.id, title: r36Card.title }],
  }),
  request(31, "这轮的运行改进", 2000, "doing", [card(r31Ask, "YN-221", "doing", leadWho, {
    task: { blocker: "等含分步计量的版本发布并安装" },
    prs: [pull(1105, "merged", true), pull(1107, "merged", true), pull(1116, "merged", false)],
  })]),
  request(14, "Core CPU 为什么高", 3000, "doing", [card(r14Card, "YN-197", "doing", executor, {
    task: { progress: "查明了两个原因：轮询和重复读取。第三个还在查。" },
  })]),
];
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" }, agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 9, history: [designReport], sections },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: {
    states: { 42: "Team on it", 41: "Team on it", 40: "Your decision", 38: "Team on it", 36: "For you to accept", 31: "Waiting on a condition", 14: "Team on it" },
    r38: "Done 2/6 · usable 1 · 1 merged · install not verified",
    r31: "Done 3/4 · usable 2 · 1 merged · install not verified",
    s1: "S1 契约 — merged · install not verified: summary.progress 与步骤 prs; #1121 merged · install not verified",
    next38: "NextYN-227 · 按批准的设计实现: S3 网页模型", next31: "Next等含分步计量的版本发布并安装depends on a project-wide item ↗",
    installed: ["Installed 0.39.0", "3 merged PRs linked to this project are not in this version"],
    r14: "Progress查明了两个原因：轮询和重复读取。", stale: /^Summary written .+; since then #1130 merged, you followed up once: what follows may be out of date$/,
    evidence: "Evidence: PRs 4 · delivered 1",
    replied: "Dev Lead replied",
  },
  "zh-Hans": {
    states: { 42: "团队在办", 41: "团队在办", 40: "等你决定", 38: "团队在办", 36: "等你验收", 31: "等条件", 14: "团队在办" },
    r38: "完成 2/6 · 可用 1 · 1 项已合入 · 安装待核实",
    r31: "完成 3/4 · 可用 2 · 1 项已合入 · 安装待核实",
    s1: "S1 契约 — 已合入 · 安装待核实：summary.progress 与步骤 prs；#1121 已合入 · 安装待核实",
    next38: "下一步YN-227 · 按批准的设计实现：S3 网页模型", next31: "下一步等含分步计量的版本发布并安装依赖共同事项 ↗",
    installed: ["已装 0.39.0", "当前版本未包含本项目关联的 3 个已合并 PR"],
    r14: "进度查明了两个原因：轮询和重复读取。", stale: /^摘要写于 .+；之后#1130 合入、你追问了 1 次，下面可能已不准$/,
    evidence: "依据：PR 4 · 交付 1",
    replied: "Dev Lead 回复",
  },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "1180", viewport: { width: 1180, height: 1400 }, phone: false, language: "en" },
  { name: "phone-390", viewport: { width: 390, height: 844 }, phone: true, language: "en" },
  { name: "zh-1180", viewport: { width: 1180, height: 1400 }, phone: false, language: "zh-Hans" },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "request-progress-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`request-progress-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC",
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-r38" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/projects\/[^/]+\/brief\/opened$/.test(path)) {
      const body = JSON.parse(request.postData() || "{}");
      return route.fulfill({ json: { projectId: "p-dev", sectionId: body.sectionId, key: body.key, version: body.version, at: at(0), recorded: true } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    if (/^\/api\/projects\/[^/]+\/requests$/.test(path))
      return route.fulfill({ json: { requests, hasMore: false,
        installedRelease: { releaseId: "core-20261123-713606f", version: "0.39.0", gitSha: "713606f".padEnd(40, "0") }, mergedAfterInstalled: 3 } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] }, "/api/collaboration/github_repositories": { repositories: [], links: [] },
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
  const block = (n) => page.locator(`[data-request-block="${n}"]`);
  const text = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, " ").trim());
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-r38`);
    const open = page.locator('[data-glance-project="p-dev"] .project-glance-open');
    await open.waitFor({ timeout: 15_000 });
    if (run.phone) await open.tap();
    else await open.click();
    await block(38).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);

    for (const [n, state] of Object.entries(w.states)) assert.equal(await text(block(n).locator(".request-state")), state, `R-${n}`);
    pass("each request's status label, the first that holds");

    const r38 = block(38);
    assert.equal(await text(r38.locator(".request-bar-label")), w.r38);
    assert.deepEqual(await r38.locator(".request-bar-seg").evaluateAll((els) => els.map((el) => el.dataset.state)),
      ["merged", "available", "doing", "todo", "todo", "todo"]);
    assert.equal(await r38.locator(".request-block-delivered").count(), 0, "the design's report is evidence, folded");
    assert.equal(await text(r38.locator(".request-next")), w.next38);
    assert.equal(await text(block(31).locator(".request-bar-label")), w.r31);
    assert.equal(await text(block(31).locator(".request-next")), w.next31, "a task waiting for a condition: its next step is that");
    assert.equal(await text(block(14).locator(".request-progress")), w.r14, "no Plan: the first sentence of its task's progress");
    assert.equal(await block(14).locator(".request-bar").count(), 0);
    assert.equal(await block(36).locator('.request-block-action[data-action="confirm"]').count(), 1);
    assert.equal(await block(40).locator(".request-block-asks [data-section-key]").count(), 1, "its own Ask, answered in its first look");
    assert.match(await text(block(41).locator(".request-stale")), w.stale);
    // R-43: no card and no progress yet: the front desk's newest reply is in R-42's first look, its fold still closed.
    const reply42 = block(42).locator(".request-block-now .request-reply");
    assert.ok(await reply42.isVisible(), "R-42's reply is in its first look");
    assert.equal(await text(reply42.locator(".request-bar-label")), w.replied);
    assert.equal(await text(reply42.locator(".request-reply-text")), said42);
    assert.equal(await block(42).locator(".request-block-more").first().getAttribute("aria-expanded"), "false");
    pass("R-38 in progress by outcome; R-31's Ask names the Plan; an investigation, a settled one, an Ask, a stale summary and a reply with no progress yet each read as they are");
    // Each part of a first look below the one before, never over it (a phone's grid once put them in one cell).
    for (const n of [42, 38, 31, 36, 41]) {
      const rows = await block(n).evaluate((el) => [".request-block-head", ".request-block-fact", ".request-block-now", ".request-block-foot"]
        .map((selector) => el.querySelector(selector)).filter(Boolean).map((part) => {
          const box = part.getBoundingClientRect();
          return { part: part.className, top: Math.round(box.top), bottom: Math.round(box.bottom) };
        }));
      for (let i = 1; i < rows.length; i++) assert.ok(rows[i].top >= rows[i - 1].bottom - 1, `R-${n}: ${JSON.stringify(rows)}`);
    }
    pass("each first look's parts stack, none over another");
    // The user's to-do is the solid mark: its words readable on it (WCAG AA, 4.5:1).
    const contrast = await block(40).locator(".request-state").evaluate((el) => {
      const rgb = (value) => {
        const probe = document.createElement("canvas").getContext("2d");
        probe.fillStyle = value;
        probe.fillRect(0, 0, 1, 1);
        return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const lum = ([r, g, b]) => [r, g, b].map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const style = getComputedStyle(el);
      const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    assert.ok(contrast >= 4.5, `Your decision's words on its mark: ${contrast.toFixed(2)}:1`);
    pass("the user's to-do mark is readable", { contrast: Number(contrast.toFixed(2)) });
    // S5: Core's line about the release; the lead's common item names YN-221, so R-31 is a related request and its
    // condition points to that card; Needs you holds R-40's Ask and R-36, so it says no "none".
    assert.deepEqual(await page.locator(".project-installed span").allTextContents(), w.installed);
    assert.deepEqual(await page.locator(".now-hero .now-related-chip").allTextContents(), ["R-31"]);
    assert.equal(await block(31).locator(".request-next-common").count(), 1);
    assert.equal(await block(38).locator(".request-next-common").count(), 0, "not a common item: no pointer");
    assert.equal(await page.locator(".request-group-none").count(), 0);
    pass("the release Core runs and what merged after it; the lead's common item points to its request and back");
    await shot("page", page);
    await shot("r38", r38);
    await shot("r42", block(42));

    // A segment by click: its outcome under the bar; another replaces it; pressed again, nothing.
    const segs = r38.locator(".request-bar-seg");
    if (run.phone) await segs.nth(0).tap();
    else await segs.nth(0).click();
    assert.equal(await text(r38.locator(".request-bar-detail")), w.s1);
    await shot("r38-segment", r38);
    if (run.phone) await segs.nth(1).tap();
    else await segs.nth(1).click();
    assert.deepEqual(await segs.evaluateAll((els) => els.map((el) => el.getAttribute("aria-pressed"))), ["false", "true", "false", "false", "false", "false"]);
    if (run.phone) await segs.nth(1).tap();
    else await segs.nth(1).click();
    assert.equal(await text(r38.locator(".request-bar-detail")), "");
    pass("a segment opens its outcome under the bar, one at a time, and closes again");

    if (!run.phone) {
      // By keyboard: Tab from the request's title reaches the first segment, its focus shown; Enter opens and closes it.
      await r38.locator(".request-block-title").focus();
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.classList.contains("request-bar-seg") ?? false);
      }
      assert.ok(reached, "Tab reaches the bar's first segment");
      const ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), label: document.activeElement.getAttribute("aria-label") };
      });
      assert.ok(ring.style !== "none" && ring.width >= 2, JSON.stringify(ring));
      await shot("r38-keyboard-focus", r38);
      await page.keyboard.press("Enter");
      assert.equal(await text(r38.locator(".request-bar-detail")), w.s1);
      await page.keyboard.press("Enter");
      assert.equal(await text(r38.locator(".request-bar-detail")), "");
      pass("by keyboard: Tab reaches a segment with its focus shown; Enter opens its outcome and closes it", ring);
    }

    // Evidence: the PRs by whether the release has them, and the design's report.
    const evidence = r38.locator(".request-block-more[data-evidence]");
    assert.equal(await text(evidence), w.evidence);
    if (run.phone) await evidence.tap();
    else await evidence.click();
    assert.deepEqual(await r38.locator(".request-evidence section").evaluateAll((els) => els.map((el) => el.dataset.evidence)), ["installed", "pending", "open"]);
    assert.equal(await r38.locator(".request-block-delivered .request-deliverable").count(), 1);
    await shot("r38-evidence", r38);
    // What was delivered opens at the version its result named, from History, from the evidence opened.
    const deliverable = r38.locator(".request-block-delivered .request-deliverable");
    if (run.phone) await deliverable.tap();
    else await deliverable.click();
    await page.locator(".home-report .report-head h1").waitFor({ timeout: 15_000 });
    assert.equal(await text(page.locator(".home-report .report-head h1")), "R-38 · 请求卡定稿");
    await shot("r38-report", page);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".home-report"), null, { timeout: 10_000 });
    pass("Evidence opens the PRs by install, then what was delivered, which opens its report");

    const widths = await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      const edge = view.getBoundingClientRect().right;
      const over = [...document.querySelectorAll(".request-block, .request-bar, .request-bar-cells, .request-block-foot, .request-next")]
        .filter((el) => el.getBoundingClientRect().right > edge + 1).map((el) => el.className);
      return { page: document.scrollingElement.scrollWidth, window: innerWidth, over };
    });
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    assert.deepEqual(widths.over, []);
    pass("nothing wider than the window", widths);
  } catch (error) {
    await shot("failure").catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}
