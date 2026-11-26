// YN-223 and YN-230 in Chromium, through the production build, every API answered here (no Core, no daily
// configuration): an answered Ask on a Project's page drawn as R-41's approved design (YN-230, over R-29's) has it:
//  - closed: the question as the user answered it, its note whole, then "Your reply" and one line of what was
//    decided: the option chosen, a form's choices without its title, labels or the fields left empty; the user's
//    other words counted; words alone at most two lines; an earlier reply (no snapshot) said so, nothing read back
//    from its text as chosen;
//  - one toggle, only where its record holds more than that line, opens the record: the answer field by field as
//    given (a field left empty said so), the user's words whole, the options not chosen as the reply kept them, Copy
//    answer; then, apart, the Ask's explanation as answered, or as its owner changed it since, said so; a one-line
//    reply to an Ask with nothing to explain has no toggle, Copy answer and Reply again instead;
//  - opened from its request's line (a way to that answer), its record is open; the request seen as usual, closed;
//  - R-40's form (yn-229/ask, the design's own sample) on the real page, closed and open, measured beside the design;
//  - a long question and a long unbroken word are never cut, and nothing is wider than the window, at desktop
//    (1440), 390 and 320 px, in Chinese and English;
//  - from the keyboard, the toggle opens and closes the record and Reply again the reply's controls on the card;
//  - beside R-27's banner (#1104): the Project cards group holds the answered Asks with the lead's status;
//  - the path the Dev Lead named (YN-223 seq 12138): R-29's Ask answered in its request's first look becomes its
//    answer card there; reloaded (the request entered a second time), the request's task row has it as one compact
//    line, which opens in place to the same card, drawn once; and again after leaving for Home and coming back;
//  - Home's history as an index (YN-221, #1115; YN-223 seq 12234): an Ask resolved in History, opened from its
//    request's line, is read whole first (saying so), then its answer card shows the question, the options then and
//    the reply as kept; one in the History list shows the same when opened; the index never carries the reply kept.
// Nothing is sent but reads and that one reply.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/answered-ask-check.mjs
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
const report = { task: "YN-223", runs: [], posts: [], unexpected: [], errors: [], homeReads: [], entryReads: [] };
const HOST = "localhost:47394";
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/next", projectId: "p-next",
};
const agents = [{ ...base, id: "l", name: "Dev Lead", kind: "lead" }];
const projects = [{ id: "p-next", name: "yuzuno-next", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "Dev Lead", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
let id = 300;
const section = (key, kind, title, body, extra = {}) => ({
  id: id++, key, kind, title, version: 10, owner: lead, updatedAt: at(40), updatedTurnId: "t1", body,
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
/** As Core keeps a reply with the version it answers (YN-223, home.rs `snapshot`). */
const kept = (title, question, options, answer) => ({
  format: 1, projectName: "yuzuno-next", sectionKind: "ask", title, question, options, choice: null, text: null, form: null, ...answer,
});

// R-29 itself (yn-220 version 10), as the design shows it.
const r29Title = "R-29 · 会话里的回复，放到首页这样看吗？";
const r29Question = "参照会话的回复样式，你想在首页采用哪一种排法？选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。";
const r29Options = ["会话同款（推荐）", "嵌入原请求", "我的补充在前", "默认折叠回执", "在回复下接上新进展", "还要改，我来指出位置"]
  .map((label, n) => ({ id: n === 5 ? "revise" : String(n), label }));
const r29Words = "需要加上问题本身啊，过两分钟再看都忘了问题是什么了";
// R-31's form (yn-221), six choices.
const r31Title = "R-31 · 这轮做哪些运行改进？";
const r31Question = "R-26 的七项建议，这一轮你想推进哪些？";
const r31Picks = ["首页历史按需加载（首选）", "精简已释放执行者列表（推荐）", "减少重复刷新，恢复窗口时补齐（推荐）",
  "定位 Agent 活动期间的 Core CPU 开销", "缓存、压缩静态资源", "补运行诊断，区分接口、线程和桌面状态"];
const r31Form = { id: "r31", title: "选择开发范围", fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", required: true,
  options: r31Picks.map((label, n) => ({ id: `p${n}`, label })) }] };
const longQuestion = "这是一条特意写长的问题，用来确认首页卡片不会裁切长问题：它没有问号，也很少停顿，" +
  "会在桌面和手机上都折成好几行，其中还夹着一个很长的路径 /w/yuzuno/results/yn-223/answered-ask-check/very-long-file-name-without-breaks.json，" +
  "以及更多的说明文字，直到它比一张小卡片能放下的宽度长得多为止";
const longWords = Array.from({ length: 9 }, (_, n) => `第 ${n + 1} 行：补充的说明写得很长，让它超过六行后折起来。`).join("\n\n");
// R-40's form (yn-229/ask v2), the sample R-41's design was drawn from: one choice, the optional words left empty.
const r40Title = "R-40 · 采样 Job 起不来，改用哪种方式补实测？";
const r40Question = "你同意的只读采样 Job 起不来（WSL 的 Windows 互操作现在没有登记）。改用哪种方式补这条实测？";
const r40Options = ["我在 Windows 运行一条命令（推荐）", "先恢复互操作，再由你跑 Job", "我自己截图，附在这里", "先不测"];
const r40Form = { id: "sample2", title: "Windows 客户端实测（第 2 轮）", fields: [
  { id: "how", type: "single", label: "补样本的方式", required: true, options: r40Options.map((label, n) => ({ id: `o${n}`, label })) },
  { id: "doing", type: "text", label: "开着 Yuzuno 时你一般在做什么？（可选）", required: false }] };
const simpleWords = "Windows 桌面版 0.7.0。";

/** Each run starts from the same page: R-29's Ask open in its request, the Project's own answered Asks. */
function fixture() {
  id = 300;
  const task = { id: "YN-220", title: "重新设计已回复的 Ask 卡", status: "doing", archived: false };
  const responsible = { agentId: "l", name: "Dev Lead", kind: "lead", state: "active" };
  const bound = { task, responsible };
  const taskCard = section("yn-220", "status", "已回复卡设计 · 第 10 版", spec(["a"], { a: md("五种排法见附图，等你选。") }), {
    card: bound, status: { asOf: at(45), validFor: 86_400, stale: false }, updatedAt: at(45), seen: { version: 10, at: at(44) },
  });
  const r29 = section("yn-220/ask", "ask", r29Title, spec(["a"], { a: md("五种排法见附图；选择只定设计。") }), {
    card: bound, updatedAt: at(41),
    ask: { question: r29Question, state: "open", reply: { options: r29Options, freeText: true } },
  });
  const sections = [
    // The lead's status: R-27's banner (#1104) leads the page with it; the Project cards group holds it with the Asks.
    section("development", "status", "开发状态", {
      root: "body",
      elements: { body: node("BriefBody", { summary: { lead: "s", size: "wide" } }, ["s"]), s: md("**core.38 已安装。** 已回复卡按 R-29 定稿实现中。") },
    }, { status: { asOf: at(10), validFor: 86_400, stale: false }, updatedAt: at(10) }),
    taskCard,
    r29,
    section("yn-221/ask", "ask", r31Title, spec(["a"], { a: md("七项建议的成本见下表。") }), {
      updatedAt: at(61),
      ask: { question: r31Question, state: "replied", repliedAt: at(55), replyText: "Answers to “选择开发范围”: …", reply: { form: r31Form },
        replySnapshot: kept(r31Title, r31Question, [], { form: { id: "r31", title: "选择开发范围",
          fields: [{ id: "picks", type: "multi", label: "这轮要做哪些？可多选", answer: r31Picks }] } }) },
    }),
    section("words", "ask", "R-33 · 命名", spec(["a"], { a: md("想听你的想法。") }), {
      updatedAt: at(81),
      ask: { question: "这个功能叫什么好？写下你的想法即可。", state: "replied", repliedAt: at(70), replyText: longWords, reply: { freeText: true },
        replySnapshot: kept("R-33 · 命名", "这个功能叫什么好？写下你的想法即可。", [], { text: longWords }) },
    }),
    // A reply from before Core kept the question with it: its text as sent.
    section("earlier", "ask", "R-12 · 预算方案", spec(["a"], { a: md("A 更便宜，B 更稳。") }), {
      updatedAt: at(400),
      ask: { question: "选 A 还是 B？", state: "replied", repliedAt: at(300), replyText: "Plan B: 先按 B 做",
        reply: { options: [{ id: "a", label: "Plan A" }, { id: "b", label: "Plan B" }], freeText: true } },
    }),
    // Its owner updated it after the reply.
    section("updated", "ask", "R-30 · 发布时间", spec(["a"], { a: md("已排进周五的发布，CI 跑完就合入。") }), {
      updatedAt: at(5),
      ask: { question: "这周五发布可以吗？", state: "replied", repliedAt: at(20), replyText: "可以",
        reply: { options: [{ id: "yes", label: "可以" }, { id: "no", label: "下周再说" }] },
        replySnapshot: kept("R-30 · 发布时间", "这周五发布可以吗？", [{ id: "yes", label: "可以" }, { id: "no", label: "下周再说" }],
          { choice: { id: "yes", label: "可以" } }) },
    }),
    section("long", "ask", "R-34 · 很长的问题", spec(["a"], { a: md("说明。") }), {
      updatedAt: at(91),
      ask: { question: longQuestion, state: "replied", repliedAt: at(90), replyText: "收到。", reply: { freeText: true },
        replySnapshot: kept("R-34 · 很长的问题", longQuestion, [], { text: "收到。" }) },
    }),
    section("yn-229/ask", "ask", r40Title, spec(["a"], { a: md("**为什么又问**：Core 拒绝了 Windows Job。") }), {
      updatedAt: at(16),
      ask: { question: r40Question, state: "replied", repliedAt: at(6), replyText: "Answers to “Windows 客户端实测（第 2 轮）”: …", reply: { form: r40Form },
        replySnapshot: kept(r40Title, r40Question, [], { form: { id: "sample2", title: r40Form.title, fields: [
          { id: "how", type: "single", label: "补样本的方式", answer: r40Options[1], options: r40Options },
          { id: "doing", type: "text", label: "开着 Yuzuno 时你一般在做什么？（可选）", answer: "" }] } }) },
    }),
    // Nothing to explain beside its question: its body is empty.
    section("simple", "ask", "简答示例", spec([], {}), {
      updatedAt: at(4),
      ask: { question: "你用的是哪个桌面版本？", state: "replied", repliedAt: at(2), replyText: simpleWords, reply: { freeText: true },
        replySnapshot: kept("简答示例", "你用的是哪个桌面版本？", [], { text: simpleWords }) },
    }),
  ];
  // Answered before, and resolved since: in History, kept with their reply as given.
  const firstQuestion = "第一轮先看哪种排法？三种都在附图里。";
  const firstOptions = [{ id: "a", label: "会话同款" }, { id: "b", label: "嵌入请求" }, { id: "c", label: "折叠回执" }];
  const first = section("yn-220/first", "ask", "R-29 · 第一轮的排法", spec(["a"], { a: md("第一轮的三种排法。") }), {
    card: bound, version: 4, updatedAt: at(200), history: true, historyReason: "resolved",
    ask: { question: firstQuestion, state: "resolved", repliedAt: at(210), replyText: "会话同款: 再加上问题本身", reply: { options: firstOptions, freeText: true },
      replySnapshot: kept("R-29 · 第一轮的排法", firstQuestion, firstOptions, { choice: firstOptions[0], text: "再加上问题本身" }) },
  });
  const r26Question = "R-26 的运行改进，先做哪一项？";
  const r26Options = [{ id: "history", label: "首页历史按需加载" }, { id: "cpu", label: "定位 Core CPU 开销" }];
  const r26 = section("r26-ask", "ask", "R-26 · 先做哪项运行改进", spec(["a"], { a: md("七项建议的成本对比。") }), {
    version: 3, updatedAt: at(500), history: true, historyReason: "resolved",
    ask: { question: r26Question, state: "resolved", repliedAt: at(520), replyText: "首页历史按需加载: 这个最影响日常", reply: { options: r26Options, freeText: true },
      replySnapshot: kept("R-26 · 先做哪项运行改进", r26Question, r26Options, { choice: r26Options[0], text: "这个最影响日常" }) },
  });
  const request = {
    id: "req-29", n: 29, text: "重新设计已回复的 Ask 卡", textBlocks: null, images: [], files: [], title: "重新设计已回复的 Ask 卡",
    createdAt: at(300), frontAgentId: "l", messageId: "m29", delivery: "accepted", replies: [], notes: [], routes: [],
    cards: [{ sectionId: taskCard.id, key: taskCard.key, title: taskCard.title, live: true, task: { id: task.id, status: "doing", archived: false }, responsible }],
    state: "doing", progress: { cards: 1, ended: 0 },
    lines: [{ kind: "ask", sectionId: r29.id, key: r29.key, title: r29.title, state: "open", at: at(41), task: task.id, cardSectionId: taskCard.id }],
  };
  return { sections, history: [first, r26], requests: [request], r29, line: request.lines[0], first, r26, firstQuestion, r26Question, firstOptions, r26Options };
}
let state = fixture();
/** As Core's index row of a History entry (home.rs Shown::section, index): no body, attachments, refs or kept reply. */
const indexRow = (entry) => {
  const { body: _body, attachments: _attachments, refs: _refs, ...rest } = structuredClone(entry);
  if (rest.ask) delete rest.ask.replySnapshot;
  return { ...rest, bodyOmitted: true, attachmentCount: 0 };
};
const home = (index) => ({
  generatedAt: at(0), order: ["p-next"], needsYou: [],
  projects: [{
    project: { id: "p-next", name: "yuzuno-next" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 20, history: index ? state.history.map(indexRow) : state.history, sections: state.sections, ...(index ? { historyIndex: true } : {}) },
  }],
});
/** As Core takes a reply to an ask (home.rs ask_reply): marked on that version, with the reply as the user gave it. */
function answer(body) {
  const ask = state.sections.find((s) => s.key === body.key);
  assert.equal(body.askVersion, ask.version, "the version on screen answered");
  const choice = ask.ask.reply.options.find((option) => option.id === body.choice) ?? null;
  const words = body.text?.trim() || null;
  ask.ask = { ...ask.ask, state: "replied", repliedAt: at(0), replyText: choice && words ? `${choice.label}: ${words}` : choice?.label ?? words,
    replySnapshot: kept(ask.title, ask.ask.question, ask.ask.reply.options, { choice, text: words }) };
  state.line.state = "replied";
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const PROJECT_ANSWERS = ["yn-221/ask", "words", "earlier", "updated", "long", "yn-229/ask", "simple"];

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "zh-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "zh-Hans" },
  { name: "zh-390", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans" },
  { name: "zh-320", viewport: { width: 320, height: 700 }, phone: true, language: "zh-Hans" },
  { name: "en-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "en" },
  // The settled design's own theme (question-first.html: dark, yuzu), to set the two side by side.
  { name: "zh-dark-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "zh-Hans", appearance: { theme: "dark", palette: "yuzu" } },
  { name: "zh-dark-390", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans", appearance: { theme: "dark", palette: "yuzu" } },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "answered-ask-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts.map((post) => post.path), runs.map(() => "/api/projects/p-next/brief/reply"), "nothing but reads and one reply a run");
console.log(`answered-ask-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);
console.log(`R-40 closed/open (CSS px): ${report.runs.map((run) => `${run.run} ${run.r40?.closed.width}×${run.r40?.closed.height}/${run.r40?.open.height}`).join(", ")}`);

async function check(run) {
  const zh = run.language !== "en";
  const words = zh
    ? { then: "当时的问题", now: "问题", label: "你的回复", wait: "等 Dev Lead 跟进", updated: "Dev Lead 已更新", show: "查看回答记录", hide: "收起记录",
      record: "回答记录", choice: "你的选择", note: "你的补充", skipped: "已跳过", others: "当时的其他选项", oneNote: "另有 1 条补充",
      thisVersion: "这版 Ask 的说明", sinceReply: "回复后的说明",
      again: "补充回复", copy: "复制回答", copied: "已复制" }
    : { then: "The question as you answered it", now: "Question", label: "Your reply", wait: "Waiting for Dev Lead", updated: "Dev Lead updated it",
      show: "Show answer record", hide: "Hide record", record: "Answer record", choice: "Your choice", note: "Your note", skipped: "Skipped",
      others: "The other options then", oneNote: "1 more note", thisVersion: "This version of the Ask", sinceReply: "The Ask since your reply",
      again: "Reply again", copy: "Copy answer", copied: "Copied" };
  state = fixture();
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const context = await browser.newContext({
    viewport: run.viewport, locale: zh ? "zh-CN" : "en-US", timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://${HOST}` });
  await context.addInitScript(({ language, appearance }) => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    if (appearance) localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  }, { language: run.language, appearance: run.appearance ?? null });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-next" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") {
      const index = (request.headers()["x-yuzuno-history"] ?? "") === "index";
      report.homeReads.push({ run: run.name, index });
      return route.fulfill({ json: home(index) });
    }
    // History's entries read whole (YN-221 S1), a moment later, so that their reading shows.
    if (method === "GET" && path === "/api/projects/p-next/brief/history") {
      const wanted = (url.searchParams.get("entries") ?? "").split(",").filter(Boolean).map((pair) => pair.split(":").map(Number));
      report.entryReads.push({ run: run.name, wanted });
      const entries = state.history.filter((entry) => wanted.some(([id, version]) => entry.id === id && entry.version === version));
      const missing = wanted.filter(([id, version]) => !entries.some((entry) => entry.id === id && entry.version === version)).map(([id, version]) => ({ id, version }));
      await new Promise((done) => setTimeout(done, 700));
      return route.fulfill({ json: { entries, missing } });
    }
    if (method === "POST" && path === "/api/projects/p-next/brief/reply") {
      const body = JSON.parse(request.postData() || "{}");
      report.posts.push({ run: run.name, method, path, body: { key: body.key, choice: body.choice, text: body.text, askVersion: body.askVersion } });
      answer(body);
      return route.fulfill({ json: { input: { ...body, expectedTurnId: null, question: null }, status: "accepted", turnId: "t30", error: null } });
    }
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-live": { machines: [] }, "/api/collaboration/github_repositories": { repositories: [], links: [] },
    }[path];
    if (json) return route.fulfill({ json });
    if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) return route.fulfill({ json: { requests: state.requests, hasMore: false } });
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
  // The card itself, never the copy of it that fades out while it changes (surface.ts dissolveFrom).
  const card = (key) => page.locator(`.home-section[data-section-key="${key}"]`);
  const inCard = (key, selector) => card(key).locator(`:scope > ${selector}`);
  const settled = () => page.waitForFunction(() => !document.querySelector(".card-ghost, [data-ghosting], [data-resizing]"), null, { timeout: 10_000 });
  const shot = async (name, locator) => {
    await settled();
    const file = `${run.name}-${name}.png`;
    await (locator ?? page).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  /** Nothing wider than the window, nothing cut: the page, Home's scroller, each answer card and what it holds. */
  const nothingCut = async () => {
    await settled();
    const found = await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      const edge = view.getBoundingClientRect().right;
      const boxes = [...document.querySelectorAll(".home-section.is-answer, .home-section.is-answer > .home-answer :is(.home-answer-question, .home-answer-ask, .home-answer-hint, .home-answer-line, .home-answer-value, .home-answer-record, .home-answer-others, .home-answer-bar, dl, dd), .request-task-answered")];
      const over = boxes.filter((el) => el.getBoundingClientRect().right > edge + 1 || el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.className || el.tagName}: ${Math.round(el.getBoundingClientRect().right)} > ${Math.round(edge)} / ${el.scrollWidth} > ${el.clientWidth}`);
      // The question's heading and note show whole: as tall as their lines, inside their card.
      const cut = [...document.querySelectorAll(".home-section > .home-answer :is(.home-answer-ask, .home-answer-hint)")].filter((el) => {
        const box = el.getBoundingClientRect(), cardBox = el.closest(".home-section").getBoundingClientRect();
        return el.scrollHeight > el.clientHeight + 1 || box.bottom > cardBox.bottom + 1 || box.right > cardBox.right + 1;
      }).map((el) => el.textContent.slice(0, 20));
      return { page: document.scrollingElement.scrollWidth, window: innerWidth, view: view.scrollWidth, viewBox: view.clientWidth, over, cut };
    });
    assert.ok(found.page <= found.window + 1, JSON.stringify(found));
    assert.ok(found.view <= found.viewBox + 1, JSON.stringify(found));
    assert.deepEqual(found.over, [], JSON.stringify(found));
    assert.deepEqual(found.cut, [], JSON.stringify(found));
    return found;
  };
  // An answer card read as the user reads it: the question as answered, its note, then one line of the reply; its
  // record when open; the actions under it.
  const read = (key) => card(key).evaluate((el) => {
    const answer = el.querySelector(":scope > .home-answer");
    const one = (selector) => answer?.querySelector(selector) ?? null;
    const top = (selector) => one(selector)?.getBoundingClientRect().top ?? null;
    const record = one(".home-answer-record");
    return {
      then: el.querySelector(":scope > .home-answer-byline .home-answer-then")?.textContent ?? null,
      kind: el.querySelector(":scope > .home-answer-byline .home-kind")?.textContent.trim() ?? null,
      ask: one(".home-answer-ask")?.textContent ?? null,
      hint: one(".home-answer-hint")?.textContent ?? null,
      unkept: !!one(".home-answer-unkept"),
      label: one(".home-answer-label")?.textContent ?? null,
      line: (one(".home-answer-line .home-answer-picks") ?? one(".home-answer-line .home-reply-words"))?.textContent.trim() ?? null,
      notes: one(".home-answer-notes")?.textContent ?? null,
      record: record && {
        label: record.getAttribute("aria-label"),
        head: record.querySelector(".home-answer-record-head")?.textContent ?? null,
        fields: [...record.querySelectorAll(".home-answer-fields > div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent.trim()]),
        words: record.querySelector(":scope > .home-reply-words")?.textContent.trim() ?? null,
        others: [...record.querySelectorAll(".home-answer-others li")].map((li) => li.lastElementChild.textContent),
        showAll: record.querySelectorAll(".home-reply-action.more").length,
      },
      update: one(".home-answer-update")?.textContent ?? null,
      body: one(".home-answer-body") && {
        head: one(".home-answer-body-head strong")?.textContent ?? null,
        text: one(".home-answer-body .home-section-body")?.textContent.trim() ?? null,
        afterRecord: !!one(".home-answer-body")?.previousElementSibling?.querySelector(".home-answer-record"),
      },
      // The question's box, then its line's ("Your reply" and the answer share a baseline, not a top).
      order: [top(".home-answer-ask"), top(".home-answer-line")],
      actions: [...(answer?.querySelectorAll(".home-answer-bar > button") ?? [])].map((b) => b.textContent.trim()),
    };
  });
  const toggle = (key) => inCard(key, ".home-answer .home-answer-toggle");
  /** Its record opened or closed by its one toggle; read once settled. */
  const setRecord = async (key, open) => {
    if ((await toggle(key).getAttribute("aria-expanded")) !== String(open)) await toggle(key).click();
    await settled();
    return read(key);
  };
  const box = (key) => card(key).evaluate((el) => {
    const { width, height } = el.getBoundingClientRect();
    return { width: Math.round(width), height: Math.round(height) };
  });
  const projectPage = `http://${HOST}/#/home?w=ws-next&p=p-next`;
  const block = () => page.locator('[data-request-block="29"]');
  try {
    // 1. R-29's Ask, open in its request's first look: the user picks an option, adds words and sends it.
    await page.goto(projectPage);
    await page.locator('[data-project-home="p-next"]').waitFor({ timeout: 15_000 });
    await block().locator('.home-section[data-section-key="yn-220/ask"] .home-ask-decision').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".now-hero").count(), 1, "R-27's banner leads the page");
    const ask = card("yn-220/ask");
    await ask.locator(".home-ask-decision fieldset label", { hasText: "还要改，我来指出位置" }).click();
    const field = ask.locator(".home-text-reply [data-composer-input]");
    await field.click();
    await page.keyboard.insertText(r29Words);
    await ask.locator(".home-ask-decision .home-ask-actions .primary-button, .home-ask-decision .clarification footer .primary-button").first().click();
    await page.waitForFunction(() => document.querySelector('[data-request-block="29"] .home-section[data-section-key="yn-220/ask"]')?.classList.contains("is-answer"), null, { timeout: 15_000 });
    const now = await read("yn-220/ask");
    assert.equal(now.ask, "参照会话的回复样式，你想在首页采用哪一种排法？");
    assert.equal(now.hint, "选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。");
    assert.equal(now.line, "还要改，我来指出位置", "one line: the option chosen");
    assert.equal(now.notes, words.oneNote, "the words counted, in its record");
    assert.equal(now.record, null, "its record closed");
    assert.equal(now.kind, words.wait);
    assert.ok(now.order[0] < now.order[1], `the question, then the reply: ${now.order}`);
    assert.deepEqual(now.actions, [words.show, words.again]);
    await nothingCut();
    await shot("request-answered", card("yn-220/ask"));
    pass("answered in the request's first look, it is its answer card there: the question, then one line of what was chosen", { now });

    // 2. The request entered a second time (reloaded): one compact line in its task's row, opened in place to the same card.
    const secondEntry = async (tag) => {
      await block().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector('[data-request-block="29"] .request-block-more'), null, { timeout: 15_000 });
      assert.equal(await page.locator('.home-section[data-section-key="yn-220/ask"]').count(), 0, `${tag}: not in the first look any more`);
      const more = block().locator(".request-block-more");
      if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
      const line = block().locator('[data-answered="yn-220/ask"] .request-task-answered');
      await line.waitFor({ timeout: 10_000 });
      assert.equal(await line.getAttribute("aria-expanded"), "false", `${tag}: compact at first`);
      assert.match(await line.innerText(), /参照会话的回复样式/);
      await nothingCut();
      await shot(`${tag}-line`, block());
      // From the keyboard: the line takes the focus and Enter opens it.
      await line.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-request-block="29"] .request-task-answered-card .home-section[data-section-key="yn-220/ask"]'), null, { timeout: 10_000 });
      assert.equal(await line.getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator('.home-section[data-section-key="yn-220/ask"]').count(), 1, `${tag}: drawn once`);
      // What the line leads to is that answer: its record open, then the Ask's explanation as answered.
      await settled();
      const opened = await read("yn-220/ask");
      assert.deepEqual(opened.record?.fields, [[words.choice, "还要改，我来指出位置"], [words.note, r29Words]], `${tag}: its record open`);
      assert.deepEqual(opened.body, { head: words.thisVersion, text: "五种排法见附图；选择只定设计。", afterRecord: true });
      await nothingCut();
      await shot(tag, block().locator(".request-task-answered-card"));
      const again = await setRecord("yn-220/ask", false);
      assert.deepEqual({ ...again, order: null }, { ...now, order: null }, `${tag}: closed, the same card as when it was answered`);
      return again;
    };
    await page.reload();
    const reloaded = await secondEntry("request-second-entry");
    pass("reloaded, the request's line opens in place to the same card, its record open: the option and the words, then the Ask's explanation; drawn once", { reloaded });
    // Leaving for the whole of Home and coming back: the same.
    await page.goto(`http://${HOST}/#/home?w=ws-next`);
    await page.locator('[data-glance-project="p-next"]').waitFor({ timeout: 15_000 });
    await page.goto(projectPage);
    await secondEntry("request-back-again");
    pass("after leaving for Home and coming back, the same line and the same card");

    // 2b. Home reads its history as an index (#1115): no entry carries the reply kept with it.
    assert.ok(report.homeReads.some((read) => read.run === run.name && read.index), "Home read its history as an index");
    // An Ask resolved in History, from its request's line: read whole first, saying so; then its card, as answered.
    const firstLine = block().locator('[data-answered="yn-220/first"] .request-task-answered');
    await firstLine.focus();
    await page.keyboard.press("Enter");
    const reading = block().locator('[data-answered="yn-220/first"] [data-history-body]');
    await reading.waitFor({ timeout: 5000 });
    const readingText = (await reading.innerText()).trim();
    await shot("history-request-reading", block().locator('[data-answered="yn-220/first"]'));
    await page.waitForFunction(() => document.querySelector('[data-answered="yn-220/first"] .home-section[data-section-key="yn-220/first"]'), null, { timeout: 10_000 });
    await settled();
    const first = await read("yn-220/first");
    assert.equal(first.ask, "第一轮先看哪种排法？");
    assert.equal(first.hint, "三种都在附图里。");
    assert.equal(first.kind, zh ? "已由 Dev Lead 解决" : "Resolved by Dev Lead");
    assert.notEqual(await card("yn-220/first").evaluate((el) => el.querySelector(".home-changed")?.textContent ?? null), zh ? "新" : "New",
      "answered and resolved: never New");
    // Opened from its line: its record, then the Ask's explanation, read here though nothing more is sent from it.
    assert.deepEqual(first.actions, [words.hide], "resolved: nothing more is sent from it");
    assert.deepEqual(first.record.fields, [[words.choice, "会话同款"], [words.note, "再加上问题本身"]]);
    const firstOptions = first.record.others;
    assert.deepEqual(firstOptions, state.firstOptions.filter((option) => option.id !== "a").map((option) => option.label), "the options not chosen");
    assert.deepEqual(first.body, { head: words.thisVersion, text: "第一轮的三种排法。", afterRecord: true });
    const firstClosed = await setRecord("yn-220/first", false);
    assert.equal(firstClosed.line, "会话同款");
    assert.equal(firstClosed.notes, words.oneNote);
    await setRecord("yn-220/first", true);
    assert.ok(report.entryReads.some((read) => read.run === run.name && read.wanted.some(([id]) => id === state.first.id)), "its entry read whole");
    await nothingCut();
    await shot("history-request", block().locator('[data-answered="yn-220/first"]'));
    pass("an Ask resolved in History opens from its request's line: read whole first (saying so), then the question and the reply as kept; its record, the options not chosen",
      { readingText, first, firstOptions });
    // The same from the History list (Done, History 30 days): the question, the reply and the options then.
    const done = page.locator('details[data-group="done"]');
    if (!(await done.evaluate((el) => el.open))) await done.locator(":scope > summary").click();
    const list = done.locator(".home-history");
    if (!(await list.evaluate((el) => el.open))) await list.locator(":scope > summary").click();
    const entry = list.locator("li details").filter({ hasText: "R-26 · 先做哪项运行改进" });
    await entry.locator(":scope > summary").click();
    await entry.locator(".home-history-answer").waitFor({ timeout: 10_000 });
    const listed = await entry.evaluate((el) => ({
      question: el.querySelector(".home-question")?.textContent ?? null,
      choice: el.querySelector(".home-history-answer .home-reply-choice")?.textContent ?? null,
      words: el.querySelector(".home-history-answer .home-reply-words")?.textContent.trim() ?? null,
      options: [...el.querySelectorAll(".home-answer-options li")].map((li) => [li.querySelector("span").textContent, !!li.getAttribute("aria-current")]),
      asSent: !!el.querySelector(".home-history-reply"),
    }));
    assert.deepEqual(listed, { question: state.r26Question, choice: "首页历史按需加载", words: "这个最影响日常",
      options: state.r26Options.map((option) => [option.label, option.id === "history"]), asSent: false });
    await nothingCut();
    await entry.scrollIntoViewIfNeeded();
    await shot("history-list", entry);
    pass("in the History list, an answered Ask opened shows the question, the reply as kept and the options then", listed);

    // 3. The Project's own answered Asks, in the Project cards group beside R-27's banner.
    const group = page.locator("details[data-project-block]");
    if (!(await group.evaluate((el) => el.open))) await group.locator("summary").click();
    await page.waitForFunction((n) => document.querySelectorAll("details[data-project-block] .home-section.is-answer").length === n, PROJECT_ANSWERS.length, { timeout: 15_000 });
    const keys = await group.locator(".home-section[data-section-key]").evaluateAll((els) => els.map((el) => el.dataset.sectionKey));
    assert.deepEqual([...keys].sort(), [...PROJECT_ANSWERS, "development"].sort());
    const r31 = await read("yn-221/ask");
    assert.equal(r31.ask, r31Question);
    assert.equal(r31.line, r31Picks.join(zh ? "、" : ", "), "the form's six choices on one line, without its title or label");
    assert.deepEqual((await setRecord("yn-221/ask", true)).record.fields, [["这轮要做哪些？可多选", r31Picks.join(zh ? "、" : ", ")]]);
    await setRecord("yn-221/ask", false);
    const alone = await read("words");
    assert.match(alone.line, /^第 1 行/);
    assert.deepEqual(alone.actions, [words.show, words.again], "words longer than two lines: the rest in its record");
    assert.equal(await inCard("words", ".home-answer .home-reply-action.more").count(), 0, "no Show all of its own: one toggle");
    const aloneRecord = (await setRecord("words", true)).record;
    for (let n = 1; n <= 9; n++) assert.ok(aloneRecord.words.includes(`第 ${n} 行`), `the words whole in its record: line ${n}`);
    assert.equal(aloneRecord.showAll, 0);
    await setRecord("words", false);
    const earlier = await read("earlier");
    assert.equal(earlier.then, words.now);
    assert.ok(earlier.unkept, "an earlier reply says its question was not kept");
    assert.equal(earlier.line, "Plan B: 先按 B 做", "as sent: nothing read back from its text as chosen");
    assert.equal(await inCard("earlier", ".home-answer .home-answer-picks").count(), 0);
    const updated = await read("updated");
    assert.equal(updated.kind, words.updated);
    assert.equal(updated.line, "可以");
    assert.equal(updated.update, null, "its owner's update is in its record");
    const updatedOpen = await setRecord("updated", true);
    assert.deepEqual(updatedOpen.record.fields, [[words.choice, "可以"]]);
    assert.deepEqual(updatedOpen.record.others, ["下周再说"], "the Ask's own options are the snapshot's, whatever changed since");
    assert.match(updatedOpen.update, /已排进周五的发布/);
    assert.equal(updatedOpen.body.head, words.sinceReply, "changed by its owner since the reply: said so");
    await setRecord("updated", false);
    const long = await read("long");
    assert.equal(long.ask, longQuestion, "the long question whole, word for word");
    // A one-line reply: nothing more to record, so no toggle.
    const simple = await read("simple");
    assert.equal(simple.line, simpleWords);
    assert.deepEqual(simple.actions, [words.copy, words.again], "its words whole: Copy answer and Reply again, no toggle");
    const widths = await nothingCut();
    pass("the Project's answered Asks: a form's choices on one line and by field in its record, long words folded to two lines, an earlier reply said so, an update in the record, a long question whole, a one-line reply with no toggle; nothing cut",
      { r31: r31.line, earlier, updated: updated.kind, simple: simple.actions, widths });
    for (const [key, name] of [["yn-221/ask", "r31-form"], ["words", "words"], ["earlier", "earlier"], ["updated", "updated"], ["long", "long"], ["simple", "simple"]]) {
      await card(key).scrollIntoViewIfNeeded();
      await shot(name, card(key));
    }
    // R-40, the design's own sample (results/YN-230/ask.html), closed and open on the real page.
    const r40 = "yn-229/ask";
    await card(r40).scrollIntoViewIfNeeded();
    const r40Closed = await read(r40);
    assert.equal(r40Closed.ask, r40Question, "the question whole");
    assert.equal(r40Closed.line, r40Options[1], "one line: what was chosen, not the optional field left empty");
    assert.equal(r40Closed.notes, null);
    assert.deepEqual(r40Closed.actions, [words.show, words.again]);
    const closedBox = await box(r40);
    await shot("r40", card(r40));
    const r40Open = await setRecord(r40, true);
    assert.equal(r40Open.line, null, "the line gives way to the record");
    assert.equal(r40Open.record.head, `${words.record}${r40Form.title}`);
    assert.deepEqual(r40Open.record.fields, [["补样本的方式", r40Options[1]], ["开着 Yuzuno 时你一般在做什么？（可选）", words.skipped]]);
    assert.deepEqual(r40Open.record.others, [r40Options[0], r40Options[2], r40Options[3]], "the field's other options, as the form answered offered them");
    assert.deepEqual(r40Open.actions, [words.hide, words.again]);
    assert.deepEqual(r40Open.body, { head: words.thisVersion, text: "为什么又问：Core 拒绝了 Windows Job。", afterRecord: true },
      "then the Ask's explanation, as answered");
    const openBox = await box(r40);
    await nothingCut();
    await shot("r40-record", card(r40));
    result.r40 = { closed: closedBox, open: openBox };
    await setRecord(r40, false);
    pass("R-40's form, the design's sample: closed, the question whole and the choice; open, the answers by field, the empty one skipped, the other three options",
      { closed: closedBox, open: openBox });

    // 4. On R-29's card, opened again in its request, from the keyboard: its record, Copy answer, Reply again.
    const r29 = "yn-220/ask";
    await card(r29).scrollIntoViewIfNeeded();
    await shot("r29", card(r29));
    await toggle(r29).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.home-section[data-section-key="yn-220/ask"] .home-answer-record'));
    await settled();
    assert.equal(await toggle(r29).getAttribute("aria-expanded"), "true");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("home-answer-toggle")), true, "focus stays on the toggle");
    const opened = await read(r29);
    assert.deepEqual(opened.record.fields, [[words.choice, "还要改，我来指出位置"], [words.note, r29Words]]);
    assert.deepEqual(opened.record.others, r29Options.filter((option) => option.id !== "revise").map((option) => option.label));
    assert.deepEqual(opened.actions, [words.hide, words.again]);
    await nothingCut();
    await shot("r29-record", card(r29));
    pass("from the keyboard, the toggle opens its record: the option and the words by field, the five options not chosen", { record: opened.record });
    await inCard(r29, ".home-answer .home-answer-tools button").click();
    await page.waitForFunction((copied) => [...document.querySelectorAll('.home-section[data-section-key="yn-220/ask"] > .home-answer .home-answer-tools button')].some((b) => b.textContent.trim() === copied), words.copied);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, `还要改，我来指出位置\n\n${r29Words}`);
    pass("Copy answer copies the option chosen and the words", { clip });
    await toggle(r29).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('.home-section[data-section-key="yn-220/ask"] .home-answer-record'));
    assert.deepEqual({ ...(await read(r29)), order: null }, { ...now, order: null }, "closed again: as it was");
    await toggle(r29).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), words.again);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.home-section[data-section-key="yn-220/ask"] > .home-card-body:not([hidden]) .home-ask-reply'), null, { timeout: 10_000 });
    assert.equal(await inCard(r29, ".home-answer .home-answer-again").getAttribute("aria-expanded"), "true");
    await nothingCut();
    await shot("r29-reply-again", card(r29));
    await inCard(r29, ".home-answer .home-answer-again").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.home-section[data-section-key="yn-220/ask"] > .home-card-body')?.hidden);
    pass("from the keyboard: the toggle closes its record; Reply again opens the reply's controls on the card and closes them again");

    await page.locator('[data-project-home="p-next"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot("page");
  } finally {
    await context.close();
  }
}
