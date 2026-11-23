// YN-223 in Chromium, through the production build, every API answered here (no Core, no daily configuration):
// an answered Ask on a Project's page drawn as R-29's settled design (question-first) has it:
//  - the question as the user answered it, its note whole, then "Your reply": the option chosen and the user's
//    words; a multi-select form's answers by field; words alone; an earlier reply (no snapshot) said so, nothing
//    read back from its text as chosen; its owner's update after the reply apart from the reply;
//  - a long question and a long unbroken word are never cut, and nothing is wider than the window, at desktop
//    (1440), 390 and 320 px, in Chinese and English;
//  - Options then lists the options with the chosen one marked; Copy answer copies the answer as shown;
//  - folded by the card's own fold, the question and what was chosen stay, the rest one unfold away;
//  - from the keyboard, Reply again opens the reply's controls on the card, and Details its body;
//  - beside R-27's banner (#1104): the Project cards group holds the answered Asks with the lead's status.
// Nothing is sent but reads.
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
const report = { task: "YN-223", runs: [], posts: [], unexpected: [], errors: [] };
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

const sections = [
  // The lead's status: R-27's banner (#1104) leads the page with it; the Project cards group holds it with the Asks.
  section("development", "status", "开发状态", {
    root: "body",
    elements: { body: node("BriefBody", { summary: { lead: "s", size: "wide" } }, ["s"]), s: md("**core.38 已安装。** 已回复卡按 R-29 定稿实现中。") },
  }, { status: { asOf: at(10), validFor: 86_400, stale: false }, updatedAt: at(10) }),
  section("yn-220/ask", "ask", r29Title, spec(["a"], { a: md("五种排法见附图；选择只定设计。") }), {
    updatedAt: at(41),
    ask: { question: r29Question, state: "replied", repliedAt: at(30), replyText: `还要改，我来指出位置: ${r29Words}`,
      reply: { options: r29Options, freeText: true },
      replySnapshot: kept(r29Title, r29Question, r29Options, { choice: { id: "revise", label: "还要改，我来指出位置" }, text: r29Words }) },
  }),
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
];
const home = () => ({
  generatedAt: at(0), order: ["p-next"], needsYou: [],
  projects: [{
    project: { id: "p-next", name: "yuzuno-next" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 20, history: [], sections },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const ANSWERS = ["yn-220/ask", "yn-221/ask", "words", "earlier", "updated", "long"];

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "zh-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "zh-Hans" },
  { name: "zh-390", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans" },
  { name: "zh-320", viewport: { width: 320, height: 700 }, phone: true, language: "zh-Hans" },
  { name: "en-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "en" },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "answered-ask-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`answered-ask-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const zh = run.language !== "en";
  const words = zh
    ? { then: "当时的问题", now: "问题", label: "你的回复", wait: "等 Dev Lead 跟进", updated: "Dev Lead 已更新", options: "当时的选项", chosen: "已选",
      again: "补充回复", details: "详情", whole: "查看完整回复", copy: "复制回答", copied: "已复制" }
    : { then: "The question as you answered it", now: "Question", label: "Your reply", wait: "Waiting for Dev Lead", updated: "Dev Lead updated it",
      options: "Options then", chosen: "chosen", again: "Reply again", details: "Details", whole: "Show the whole reply", copy: "Copy answer", copied: "Copied" };
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-next" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
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
    if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) return route.fulfill({ json: { requests: [], hasMore: false } });
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
  const card = (key) => page.locator(`.home-section[data-section-key="${key}"]`);
  const shot = async (name, locator) => {
    const file = `${run.name}-${name}.png`;
    await (locator ?? page).screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  /** Nothing wider than the window, nothing cut: the page, Home's scroller, each answer card and what it holds. */
  const nothingCut = async () => {
    const found = await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      const edge = view.getBoundingClientRect().right;
      const boxes = [...document.querySelectorAll(".home-section.is-answer, .home-section.is-answer :is(.home-answer, .home-answer-question, .home-answer-ask, .home-answer-hint, .home-answer-given, .home-reply-answer, footer, dl, dd)")];
      const over = boxes.filter((el) => el.getBoundingClientRect().right > edge + 1 || el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.className || el.tagName}: ${Math.round(el.getBoundingClientRect().right)} > ${Math.round(edge)} / ${el.scrollWidth} > ${el.clientWidth}`);
      // The question's heading and note show whole: as tall as their lines, inside their card.
      const cut = [...document.querySelectorAll(".home-answer-ask, .home-answer-hint")].filter((el) => {
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
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-next&p=p-next`);
    await page.locator('[data-project-home="p-next"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction((n) => document.querySelectorAll(".home-section.is-answer").length === n, ANSWERS.length, { timeout: 15_000 });
    // R-27's banner leads the page; the Project cards group, open with no request on the page, holds the Asks and the status.
    assert.equal(await page.locator(".now-hero").count(), 1, "the banner");
    const group = await page.locator("details[data-project-block] [data-section-key]").evaluateAll((els) => els.map((el) => el.dataset.sectionKey));
    assert.deepEqual([...group].sort(), [...ANSWERS, "development"].sort());
    pass("beside R-27's banner, the Project cards group holds the answered Asks as answer cards", { group });

    // Each card: its question as answered, its note, then the reply as given; in that order.
    const read = (key) => card(key).evaluate((el) => {
      const top = (selector) => el.querySelector(selector)?.getBoundingClientRect().top ?? null;
      return {
        then: el.querySelector(".home-answer-then")?.textContent ?? null,
        kind: el.querySelector(".home-kind")?.textContent.trim() ?? null,
        ask: el.querySelector(".home-answer-ask")?.textContent ?? null,
        hint: el.querySelector(".home-answer-hint")?.textContent ?? null,
        unkept: !!el.querySelector(".home-answer-unkept"),
        label: el.querySelector(".home-answer-label")?.textContent ?? null,
        choice: el.querySelector(".home-reply-choice")?.textContent ?? null,
        words: el.querySelector(".home-reply-words")?.textContent.trim() ?? null,
        form: [...el.querySelectorAll("dd li")].map((li) => li.textContent),
        update: el.querySelector(".home-answer-update")?.textContent ?? null,
        order: [top(".home-answer-ask"), top(".home-answer-label"), top(".home-reply-answer")],
        actions: [...el.querySelectorAll(".home-answer-given footer button")].map((b) => b.textContent.trim()),
      };
    });
    const r29 = await read("yn-220/ask");
    assert.equal(r29.then, words.then);
    assert.equal(r29.kind, words.wait);
    assert.equal(r29.ask, "参照会话的回复样式，你想在首页采用哪一种排法？");
    assert.equal(r29.hint, "选择只定设计；如果希望直接开发，可在补充里写「按这版实现」。");
    assert.equal(r29.label, words.label);
    assert.equal(r29.choice, "还要改，我来指出位置");
    assert.equal(r29.words, r29Words);
    assert.ok(r29.order[0] < r29.order[1] && r29.order[1] < r29.order[2], `the question, then the reply: ${r29.order}`);
    assert.deepEqual(r29.actions, [words.copy, words.options, words.details, words.again]);
    const r31 = await read("yn-221/ask");
    assert.equal(r31.ask, r31Question);
    assert.deepEqual(r31.form, r31Picks, "the form's six choices");
    const alone = await read("words");
    assert.equal(alone.choice, null);
    assert.match(alone.words, /^第 1 行/);
    assert.equal(await card("words").locator(".home-reply-action.more").count(), 1, "long words fold behind Show all");
    const earlier = await read("earlier");
    assert.equal(earlier.then, words.now);
    assert.ok(earlier.unkept, "an earlier reply says its question was not kept");
    assert.equal(earlier.choice, null, "nothing read back from its text as chosen");
    assert.equal(earlier.words, "Plan B: 先按 B 做");
    const updated = await read("updated");
    assert.equal(updated.kind, words.updated);
    assert.equal(updated.choice, "可以");
    assert.match(updated.update, /已排进周五的发布/);
    const long = await read("long");
    assert.equal(long.ask, longQuestion, "the long question whole, as its heading");
    const widths = await nothingCut();
    pass("each answered Ask reads the question as answered, then the reply as given; nothing cut, nothing wider than the window",
      { r29, r31: r31.form.length, earlier, updated: updated.kind, widths });
    await card("yn-220/ask").scrollIntoViewIfNeeded();
    await shot("r29", card("yn-220/ask"));
    await shot("r31-form", card("yn-221/ask"));
    await shot("words", card("words"));
    await shot("earlier", card("earlier"));
    await shot("updated", card("updated"));
    await shot("long", card("long"));

    // Options then: the options as the user saw them, the chosen one marked.
    const r29Card = card("yn-220/ask");
    await r29Card.locator(".home-answer-options-toggle").click();
    const options = await r29Card.locator(".home-answer-options li").evaluateAll((els) => els.map((li) => [li.querySelector("span").textContent, !!li.getAttribute("aria-current")]));
    assert.deepEqual(options, r29Options.map((option) => [option.label, option.id === "revise"]));
    assert.equal(await r29Card.locator(".home-answer-options li[aria-current] small").innerText(), words.chosen);
    await nothingCut();
    await shot("r29-options", r29Card);
    await r29Card.locator(".home-answer-options-toggle").click();
    pass("Options then: the six options as seen, the chosen one marked", { options });

    // Copy answer: the answer as shown, the option then the words.
    await r29Card.locator(".home-answer-given footer button", { hasText: words.copy }).click();
    await page.waitForFunction((copied) => [...document.querySelectorAll(".home-answer-given footer button")].some((b) => b.textContent.trim() === copied), words.copied);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, `还要改，我来指出位置\n\n${r29Words}`);
    pass("Copy answer copies the option chosen and the words", { clip });

    // Folded by the card's own fold: the question and what was chosen stay.
    await r29Card.locator(".home-answer-byline .home-fold").click();
    await page.waitForFunction(() => document.querySelector('[data-section-key="yn-220/ask"]').classList.contains("is-folded"));
    const folded = await read("yn-220/ask");
    assert.equal(folded.ask, r29.ask);
    assert.equal(folded.hint, r29.hint);
    assert.equal(folded.choice, "还要改，我来指出位置");
    assert.equal(folded.words, null, "the words one unfold away");
    assert.deepEqual(folded.actions, []);
    assert.equal((await r29Card.locator(".home-answer-unfold").innerText()).trim(), words.whole);
    await nothingCut();
    await shot("r29-fold", r29Card);
    await r29Card.locator(".home-answer-unfold").click();
    await page.waitForFunction(() => !document.querySelector('[data-section-key="yn-220/ask"]').classList.contains("is-folded"));
    pass("folded, the question and the chosen answer stay; unfolded again, the whole reply");

    // The keyboard: Reply again opens the reply's controls on the card; Details closes its body again.
    await r29Card.locator(".home-answer-given footer button", { hasText: words.details }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), words.again);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-section-key="yn-220/ask"] .home-card-body:not([hidden]) .home-ask-reply'), null, { timeout: 10_000 });
    assert.equal(await r29Card.getAttribute("class").then((c) => c.includes("is-open")), true);
    await nothingCut();
    await shot("r29-reply-again", r29Card);
    await r29Card.locator(".home-answer-given footer button", { hasText: words.details }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-section-key="yn-220/ask"] .home-card-body')?.hidden);
    pass("from the keyboard: Reply again opens the reply's controls on the card, Details closes its body");

    await page.locator('[data-project-home="p-next"]').evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot("page");
  } finally {
    await context.close();
  }
}
