// YN-86 S3b in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, on a Project's page:
//  - "Talk to the project": both sides by default where the window is wide,
//    the requests first and two tabs on a phone; a side chosen fills the
//    width while the other narrows to nothing and is inert;
//  - the columns move as grid-template-columns over --motion-medium, the
//    closing side's content leaves before it is squeezed; frames at the
//    start, middle and end of "Both → Requests" and "Both → Conversation"
//    at 1440; with reduced motion nothing moves;
//  - at 1440, 940 and a phone (390), English and Chinese: nothing is wider
//    than the window or its column; long titles stay one line, cut; long
//    words and paste blocks stay inside their bubble; a card row's title
//    keeps at least 120px, its row in two lines in a narrow requests side;
//  - selection links the two sides, and a card's row shows that card;
//  - a card's source line (S3b-2) is one line inside its card, its details too,
//    with none of the user's words; See words → shows them in the conversation;
//  - nothing is sent but the reads.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-talk-check.mjs
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
await mkdir(join(output, "frames"), { recursive: true });
const report = { task: "YN-96", slice: "YN-86 S3b", runs: [], frames: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47396";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
// Synthetic names, long ones on purpose: they must be cut, never widen a column.
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "t", name: "YN-91 · 设置页排版与文案口语化的设计执行者", kind: "executor", status: "working",
    executor: { state: "running", agentId: "t", task: { id: "YN-91", title: "Settings layout and plain copy", shortName: "设置页排版" }, dispatchedAt: at(50) } },
  { ...base, id: "x", name: "YN-92 · 导出格式调研", kind: "executor", status: "idle",
    executor: { state: "delivered", agentId: "x", task: { id: "YN-92", title: "Export formats", shortName: "导出格式" }, dispatchedAt: at(90) } },
];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "l", name: "lead-1", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const spec = (text) => ({ root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: node("Markdown", { text }) } });
const settings = { id: "YN-91", title: "Settings layout and plain copy", shortName: "设置页排版", status: "doing", archived: false };
const exportTask = { id: "YN-92", title: "Export formats", shortName: "导出格式", status: "review", archived: false };
const designer = { agentId: "t", name: agents[1].name, kind: "executor", state: "running" };
const researcher = { agentId: "x", name: agents[2].name, kind: "executor", state: "delivered" };
let id = 400;
const section = (key, kind, title, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: lead, updatedAt: at(30), updatedTurnId: "t1", body: spec(`${title}: what it says.`),
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const sections = [
  section("yn-91", "status", "设置页重新排版，文案改口语（一张特意写长标题的卡片，看它会不会撑宽）", {
    status: { asOf: at(20), validFor: 86_400, stale: false }, card: { task: settings, responsible: designer } }),
  section("yn-92", "status", "导出格式调研", { status: { asOf: at(25), validFor: 86_400, stale: false }, card: { task: exportTask, responsible: researcher } }),
  section("yn-91/pick", "ask", "两版排版选一个", { owner: { agentId: "t", name: agents[1].name, state: "active" },
    ask: { question: "两版排版选一个", state: "open", reply: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], freeText: true } },
    card: { task: settings, responsible: designer } }),
];
const ids = Object.fromEntries(sections.map((s) => [s.key, s.id]));
const home = () => ({
  generatedAt: at(0), order: ["p-dev"],
  needsYou: [{ kind: "ask", projectId: "p-dev", agentId: "t", agentName: agents[1].name, sectionKey: "yn-91/pick", title: "两版排版选一个", since: at(20) }],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 1, idle: 2, waiting: 0, error: 0, offline: 0, total: 3 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 2, missing: [], brief: { version: 9, history: [], sections },
  }],
});
const desk = { agentId: "l", name: "lead-1" };
// Where the cards came from (S3b-2): R-5 made yn-91, R-4 was joined to yn-92. Never the user's words.
const R5_TITLE = "设置页重新排版、文案改口语，手机上也要好用（一个特意写长的标题，用来检查单行省略号）";
sections[0].card.handoffs = {
  requests: [{ n: 5, title: R5_TITLE, at: at(40), merged: false, messageId: "m5" }, { n: 4, title: "导出支持 CSV", at: at(60), merged: true, messageId: "m4" }],
  events: [{ kind: "card", index: 0, request: 5, at: at(39), state: "done", why: "有明确终点的设计", by: desk, to: { agentId: "t", name: agents[1].name },
    task: "YN-91", cardKey: "yn-91", sectionId: ids["yn-91"], title: sections[0].title }],
};
sections[1].card.handoffs = {
  requests: [{ n: 4, title: "导出支持 CSV", at: at(60), merged: true, messageId: "m4" }],
  events: [{ kind: "existing", index: 0, request: 4, at: at(59), state: "done", why: "和 09:40 的需求是同一件事的补充", by: desk,
    to: { agentId: "x", name: agents[2].name }, task: "YN-92", cardKey: "yn-92", sectionId: ids["yn-92"] }],
};
const LONG_WORD = `https://example.test/${"a-very-long-path-segment/".repeat(12)}end`;
const PASTE = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：机器卡搬进项目页的一条要求`).join("\n");
const TYPED = "把机器卡也搬进项目页，具体要求贴在下面：\n";
const card = (sectionId, key, title, task, responsible, live = true) => ({ sectionId, key, title, live, task: { id: task.id, status: task.status, archived: false }, responsible });
const requests = () => [
  { id: "r6", n: 6, text: TYPED + PASTE, textBlocks: [{ id: "p1", start: TYPED.length, end: TYPED.length + PASTE.length }], title: null,
    createdAt: at(4), frontAgentId: "l", messageId: "m6", delivery: "accepted", replies: [], notes: [], routes: [], cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] },
  { id: "r5", n: 5, text: `设置页重新排版、文案改口语，参考 ${LONG_WORD}`, textBlocks: null,
    title: "设置页重新排版、文案改口语，手机上也要好用（一个特意写长的标题，用来检查单行省略号）",
    createdAt: at(40), frontAgentId: "l", messageId: "m5", delivery: "accepted",
    replies: [{ n: 1, text: "手机上也看一下", textBlocks: null, at: at(30), messageId: "m5-1", deliveredTo: [{ agentId: "t", delivery: "accepted" }, { agentId: "l", delivery: "accepted" }] }],
    notes: [{ note: "好，拆成两件：排版交给设计，文案我来改。", by: desk, at: at(39) }],
    routes: [
      { kind: "card", index: 0, request: 5, at: at(39), state: "done", why: "有明确终点的设计", by: desk, to: { agentId: "t", name: agents[1].name }, task: "YN-91", cardKey: "yn-91", sectionId: ids["yn-91"], title: sections[0].title },
      { kind: "card", index: 1, request: 5, at: at(39), state: "done", why: "只是改字", by: desk, to: desk, task: "YN-93", cardKey: "yn-93", sectionId: null, title: "文案改口语" },
    ],
    cards: [card(ids["yn-91"], "yn-91", sections[0].title, settings, designer), card(null, null, "文案改口语", { id: "YN-93", status: "doing" }, { ...desk, kind: "lead", state: "idle" })],
    state: "doing", progress: { cards: 2, ended: 0 },
    lines: [{ kind: "ask", sectionId: ids["yn-91/pick"], key: "yn-91/pick", title: "两版排版选一个", state: "open", at: at(20), task: "YN-91", cardSectionId: ids["yn-91"] }] },
  { id: "r4", n: 4, text: "导出也要支持 CSV", textBlocks: null, title: "导出支持 CSV", createdAt: at(60), frontAgentId: "l", messageId: "m4", delivery: "accepted",
    replies: [], notes: [{ note: "和之前的导出调研是同一件事，并进去了。", by: desk, at: at(59) }],
    routes: [{ kind: "existing", index: 0, request: 4, at: at(59), state: "done", why: "和 09:40 的需求是同一件事的补充", by: desk, to: { agentId: "x", name: agents[2].name }, task: "YN-92", cardKey: "yn-92", sectionId: ids["yn-92"] }],
    cards: [card(ids["yn-92"], "yn-92", "导出格式调研：CSV、JSON 和 Markdown 三种格式逐项比较（长标题）", exportTask, researcher)],
    state: "doing", progress: { cards: 1, ended: 0 }, lines: [] },
  { id: "r3", n: 3, text: "备份能不能快一点", textBlocks: null, title: null, createdAt: at(70), frontAgentId: "l", messageId: "m3", delivery: "uncertain",
    replies: [], notes: [], routes: [], cards: [], state: "waiting", progress: { cards: 0, ended: 0 }, lines: [] },
  { id: "r2", n: 2, text: "对比一下导出格式", textBlocks: null, title: "导出格式调研", createdAt: at(200), frontAgentId: "l", messageId: "m2", delivery: "accepted",
    replies: [], notes: [{ note: "开一张调研卡。", by: desk, at: at(199) }],
    routes: [{ kind: "card", index: 0, request: 2, at: at(199), state: "done", why: "调研", by: desk, to: { agentId: "x", name: agents[2].name }, task: "YN-90", cardKey: "yn-90", sectionId: 390, title: "旧的导出调研" }],
    cards: [card(390, "yn-90", "旧的导出调研", { id: "YN-90", status: "done" }, null, false)],
    state: "done", progress: { cards: 1, ended: 1 },
    lines: [{ kind: "done", task: "YN-90", status: "done", at: at(150), cardSectionId: 390, title: "旧的导出调研" }] },
];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { requests: "Requests", both: "Both", chat: "Conversation", request: "Request →" },
  "zh-Hans": { requests: "需求单", both: "两者", chat: "对话", request: "需求单 →" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "en-1440", viewport: { width: 1440, height: 1000 }, language: "en", frames: true },
  { name: "en-940", viewport: { width: 940, height: 900 }, language: "en" },
  { name: "en-390", viewport: { width: 390, height: 844 }, language: "en", phone: true },
  { name: "zh-1440", viewport: { width: 1440, height: 1000 }, language: "zh-Hans" },
  { name: "zh-940", viewport: { width: 940, height: 900 }, language: "zh-Hans" },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", phone: true },
  { name: "en-1440-reduced", viewport: { width: 1440, height: 1000 }, language: "en", reduced: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "project-talk-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`project-talk-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks, ${report.frames.length} frames`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    reducedMotion: run.reduced ? "reduce" : "no-preference",
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-talk" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p-dev/front-desk") return route.fulfill({ json: { version: 1, agentId: null, effectiveAgentId: "l" } });
    if (path === "/api/projects/p-dev/requests" && method === "GET") return route.fulfill({ json: { requests: requests(), hasMore: false } });
    // A list read, though sent as POST (home-api.ts readLinkedRepositories): no repositories linked here.
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
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
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] },
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
  const talk = page.locator(".project-talk");
  const tab = (label) => page.locator(".project-talk-tabs [role=tab]").filter({ hasText: label }).first();
  const shot = async (name, locator = talk) => {
    const file = `${run.name}-${name}.png`;
    await locator.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  // Nothing wider than the window or than its column; titles kept to one line; card rows' titles at least 120px.
  const fits = () => page.evaluate(() => {
    const out = { page: document.scrollingElement.scrollWidth, window: innerWidth, view: document.querySelector(".home-view")?.scrollWidth, over: [], titles: [], rows: [], columns: {} };
    const talk = document.querySelector(".project-talk");
    const box = talk.getBoundingClientRect();
    if (box.right > innerWidth + 1) out.over.push({ el: "project-talk", right: box.right });
    for (const side of talk.querySelectorAll(".project-talk-side[data-open]")) {
      const frame = side.getBoundingClientRect();
      const name = side.classList.contains("project-talk-requests") ? "requests" : "chat";
      out.columns[name] = Math.round(frame.width);
      const scroll = side.querySelector(".project-talk-scroll");
      if (scroll.scrollWidth > scroll.clientWidth + 1) out.over.push({ el: `${name} scroll`, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth });
      for (const el of side.querySelectorAll(".request-card, .request-card-row, .request-card-merged, .project-talk-mine, .project-talk-bubble, .pasted-text-chip, .project-talk-project, .project-talk-line, .routing-event")) {
        const at = el.getBoundingClientRect();
        if (at.width && (at.right > frame.right + 1 || at.left < frame.left - 1)) out.over.push({ el: el.className, right: Math.round(at.right), frame: Math.round(frame.right) });
      }
      for (const title of side.querySelectorAll(".request-card-title span")) {
        const at = title.getBoundingClientRect();
        if (!at.width) continue;
        const line = Number.parseFloat(getComputedStyle(title).lineHeight) || 20;
        out.titles.push({ text: title.textContent.slice(0, 16), oneLine: at.height < line * 1.5, cut: title.scrollWidth > title.clientWidth + 1 });
      }
      for (const row of side.querySelectorAll(".request-card-row")) {
        const title = row.querySelector(".request-card-row-title").getBoundingClientRect();
        const who = row.querySelector(".request-card-row-who").getBoundingClientRect();
        if (!title.width) continue;
        out.rows.push({ title: Math.round(title.width), twoLines: who.top >= title.bottom - 2 });
      }
    }
    return out;
  });
  const fitsOk = (fit, what) => {
    assert.ok(fit.page <= fit.window + 1 && (fit.view ?? 0) <= fit.window + 1, `${what}: page ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.over, [], `${what}: everything inside its column`);
    assert.ok(fit.titles.every((t) => t.oneLine), `${what}: request titles one line ${JSON.stringify(fit.titles)}`);
    assert.ok(fit.rows.every((r) => r.title >= 119.5), `${what}: card row titles at least 120px ${JSON.stringify(fit.rows)}`);
  };
  // The talk's own motion has ended: its columns' transition and its sides' animations. A working Agent's dot
  // in a card row pulses for ever, and is not the talk's motion.
  const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"
    || !(a.transitionProperty === "grid-template-columns" || String(a.animationName ?? "").startsWith("project-talk-"))), null, { timeout: 5000 });
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-talk&p=p-dev`);
    await page.locator('[data-project-home="p-dev"]').waitFor({ timeout: 15_000 });
    await page.locator('.request-card[data-request="5"]').waitFor({ timeout: 15_000 });
    await talk.scrollIntoViewIfNeeded();
    const narrow = run.viewport.width <= 900;
    // The default: both where the window is wide, the requests first on a phone; the tabs to match.
    const view = await talk.getAttribute("data-view");
    const tabs = (await page.locator(".project-talk-tabs [role=tab]").allInnerTexts()).map((t) => t.trim());
    if (narrow) {
      assert.equal(view, "requests");
      assert.deepEqual(tabs, [`${w.requests} 5`, w.chat]);
    } else {
      assert.equal(view, "both");
      assert.deepEqual(tabs, [`${w.requests} 5`, w.both, w.chat]);
    }
    let fit = await fits();
    fitsOk(fit, "the first view");
    // The long title is cut on its one line; the 940 window's requests side is narrow enough for two-line card rows.
    assert.ok(fit.titles.some((t) => t.cut), "the long title is cut");
    if (run.viewport.width === 940) {
      assert.ok(fit.columns.requests < 460, `the requests side is narrow at 940: ${fit.columns.requests}`);
      assert.ok(fit.rows.length && fit.rows.every((r) => r.twoLines), `card rows in two lines: ${JSON.stringify(fit.rows)}`);
    }
    if (run.viewport.width === 1440) assert.ok(fit.rows.every((r) => !r.twoLines), "a wide requests side keeps card rows on one line");
    await shot("talk");
    pass("the first view, its tabs, and nothing wider than its column", { view, tabs, widths: fit });

    if (!narrow) {
      // A side chosen fills the width, the other inert; its columns move over --motion-medium, or not with reduced motion.
      const grid = page.locator(".project-talk-columns");
      const motion = await grid.evaluate((el) => ({ property: getComputedStyle(el).transitionProperty, duration: getComputedStyle(el).transitionDuration,
        medium: getComputedStyle(document.documentElement).getPropertyValue("--motion-medium").trim() }));
      if (run.reduced) assert.equal(motion.duration, "0s", JSON.stringify(motion));
      else {
        assert.equal(motion.property, "grid-template-columns");
        // Both as the browser writes a time: "240ms", ".24s".
        const ms = (time) => Number.parseFloat(time) * (/ms$/.test(time) ? 1 : 1000);
        assert.equal(ms(motion.duration), ms(motion.medium), JSON.stringify(motion));
      }
      if (run.frames) await frames();
      await tab(w.requests).click();
      const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.transitionProperty === "grid-template-columns"
        || String(a.animationName ?? "").startsWith("project-talk-")).length);
      if (run.reduced) assert.equal(moving, 0, "nothing moves with reduced motion");
      await settled();
      const state = await page.evaluate(() => {
        const chat = document.querySelector(".project-talk-chat");
        const button = chat.querySelector("button");
        button?.focus();
        return { inert: chat.inert, focused: document.activeElement === button, width: chat.getBoundingClientRect().width,
          requests: document.querySelector(".project-talk-requests").getBoundingClientRect().width, talk: document.querySelector(".project-talk-columns").getBoundingClientRect().width };
      });
      assert.ok(state.inert && !state.focused, `the closed side is inert: ${JSON.stringify(state)}`);
      assert.ok(state.width < 2 && Math.abs(state.requests - state.talk) < 2, `the requests fill the width: ${JSON.stringify(state)}`);
      fit = await fits();
      fitsOk(fit, "requests alone");
      await shot("requests");
      pass(run.reduced ? "with reduced motion a side chosen fills the width at once, the other inert" : "a side chosen fills the width over --motion-medium, the other inert",
        { motion, moving, state });
      await tab(w.both).click();
      await settled();
    }

    // Selection links the sides: Request → selects its request; a request's title shows its words.
    if (narrow) {
      await tab(w.chat).click();
      assert.equal(await page.locator(".project-talk-chat").getAttribute("data-motion"), "switch");
      await settled();
      fit = await fits();
      fitsOk(fit, "the conversation on a phone");
      await shot("chat");
    }
    await page.locator(".project-talk-project", { hasText: "拆成两件" }).locator(".project-talk-chip").click();
    await page.locator('.request-card[data-request="5"][data-selected]').waitFor({ timeout: 5000 });
    await settled();
    const seen = await page.evaluate(() => {
      const card = document.querySelector('.request-card[data-request="5"]').getBoundingClientRect();
      const side = document.querySelector(".project-talk-requests .project-talk-scroll").getBoundingClientRect();
      return { card: [card.top, card.bottom], side: [side.top, side.bottom], view: document.querySelector(".project-talk").dataset.view };
    });
    assert.ok(seen.card[0] < seen.side[1] && seen.card[1] > seen.side[0], `the request is in view in its side: ${JSON.stringify(seen)}`);
    if (narrow) assert.equal(seen.view, "requests", "Request → goes over to the requests");
    await page.locator('.request-card[data-request="6"] .request-card-title').click();
    await page.locator('.project-talk-mine[data-words="6"]').waitFor({ timeout: 5000 });
    await settled();
    const words6 = await page.evaluate(() => {
      const words = document.querySelector('.project-talk-mine[data-words="6"]').getBoundingClientRect();
      const side = document.querySelector(".project-talk-chat .project-talk-scroll").getBoundingClientRect();
      return { words: [words.top, words.bottom], side: [side.top, side.bottom], chip: !!document.querySelector('.project-talk-mine[data-words="6"] .pasted-text-chip') };
    });
    assert.ok(words6.chip, "the pasted text is a block in the conversation");
    assert.ok(words6.words[0] < words6.side[1] && words6.words[1] > words6.side[0], `the words are in view in the conversation: ${JSON.stringify(words6)}`);
    fit = await fits();
    fitsOk(fit, "after linking");
    pass("Request → selects its request and a title shows its words, each in view in its own side", { seen, words: words6 });

    // A card's row shows that card on the page.
    if (narrow) await tab(w.requests).click();
    await settled();
    await page.locator('.request-card[data-request="5"] .request-card-row').first().click();
    await page.waitForFunction(() => {
      const card = document.querySelector('.project-home [data-section-key="yn-91"]')?.getBoundingClientRect();
      return card && card.top < innerHeight && card.bottom > 0;
    }, null, { timeout: 5000 });
    pass("a request's card row shows that card on the page");

    // S3b-2: the card says where it came from in one line, cut, never wider than the card; its details stay inside it
    // and carry no words of the user's; See words → goes back to them in the conversation.
    const sourced = page.locator('.project-home [data-section-key="yn-91"]').first();
    const source = sourced.locator(".card-source").first();
    await source.scrollIntoViewIfNeeded();
    const inside = () => source.evaluate((el) => {
      const frame = el.closest(".home-section").getBoundingClientRect();
      const line = el.querySelector(".card-source-text");
      const over = [...el.querySelectorAll("*")].map((part) => part.getBoundingClientRect())
        .filter((box) => box.width && (box.right > frame.right + 1 || box.left < frame.left - 1)).length;
      const box = line.getBoundingClientRect();
      return { over, cut: line.scrollWidth > line.clientWidth + 1, oneLine: box.height < 1.5 * (Number.parseFloat(getComputedStyle(line).lineHeight) || 20),
        page: document.scrollingElement.scrollWidth, window: innerWidth };
    });
    let fitSource = await inside();
    assert.ok(fitSource.over === 0 && fitSource.oneLine && fitSource.cut && fitSource.page <= fitSource.window + 1, `the source line: ${JSON.stringify(fitSource)}`);
    await source.locator(".card-source-line").click();
    await source.locator(".card-source-detail").waitFor({ timeout: 5000 });
    fitSource = await inside();
    assert.ok(fitSource.over === 0 && fitSource.page <= fitSource.window + 1, `the source's details: ${JSON.stringify(fitSource)}`);
    assert.ok(!(await sourced.innerText()).includes("参考 https://example.test"), "no words of the user's on the card");
    await shot("card-source", sourced);
    await source.locator(".card-source-requests .talk-link").first().click();
    // The words were on the page already: wait for the request to be selected, and the page's scroll to land.
    await page.locator('.request-card[data-request="5"][data-selected]').waitFor({ timeout: 5000 });
    await settled();
    await page.waitForFunction(() => {
      const talk = document.querySelector(".project-talk").getBoundingClientRect();
      const words = document.querySelector('.project-talk-mine[data-words="5"]').getBoundingClientRect();
      const side = document.querySelector(".project-talk-chat .project-talk-scroll").getBoundingClientRect();
      return talk.top >= -1 && talk.top < innerHeight && words.top < side.bottom && words.bottom > side.top;
    }, null, { timeout: 5000 }).catch(() => {});
    const back = await page.evaluate(() => {
      const words = document.querySelector('.project-talk-mine[data-words="5"]').getBoundingClientRect();
      const side = document.querySelector(".project-talk-chat .project-talk-scroll").getBoundingClientRect();
      const talk = document.querySelector(".project-talk").getBoundingClientRect();
      return { words: [words.top, words.bottom], side: [side.top, side.bottom], talk: [talk.top, talk.bottom], window: innerHeight,
        selected: !!document.querySelector('.request-card[data-request="5"][data-selected]'), view: document.querySelector(".project-talk").dataset.view };
    });
    assert.ok(back.selected && back.view !== "requests", `the request selected, its words shown: ${JSON.stringify(back)}`);
    assert.ok(back.words[0] < back.side[1] && back.words[1] > back.side[0], `the words in view in the conversation: ${JSON.stringify(back)}`);
    assert.ok(back.talk[0] < back.window && back.talk[1] > 0, `the talk brought into view: ${JSON.stringify(back)}`);
    pass("a card's source line stays inside the card, its details carry no words, and See words → shows them", { source: fitSource, back });
    await shot("page", page.locator("body"));
  } finally {
    await context.close();
  }

  /** Frames of "Both → Requests" and "Both → Conversation": every animation of the talk paused at its start, middle and end. */
  async function frames() {
    for (const [to, label] of [["requests", w.requests], ["chat", w.chat]]) {
      await tab(w.both).click();
      await settled();
      const started = await page.evaluate(async (label) => {
        const button = [...document.querySelectorAll(".project-talk-tabs [role=tab]")].find((b) => b.textContent.trim().startsWith(label));
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        getComputedStyle(document.querySelector(".project-talk-columns")).gridTemplateColumns;
        const talk = document.querySelector(".project-talk");
        // The motion this switch started: an earlier side's entry, finished and held by its fill, is not part of it.
        window.__talkAnimations = document.getAnimations().filter((a) => talk.contains(a.effect?.target) && a.playState === "running"
          && (a.transitionProperty === "grid-template-columns" || String(a.animationName ?? "").startsWith("project-talk-")));
        for (const animation of window.__talkAnimations) animation.pause();
        return window.__talkAnimations.map((a) => ({ kind: a.animationName ? `animation ${a.animationName}` : `transition ${a.transitionProperty}`,
          target: a.effect.target.className, duration: a.effect.getComputedTiming().duration }));
      }, label);
      assert.ok(started.some((a) => a.kind === "transition grid-template-columns" && a.duration === 240), `the columns move: ${JSON.stringify(started)}`);
      assert.ok(started.some((a) => a.kind === "animation project-talk-out"), `the closing side's content leaves: ${JSON.stringify(started)}`);
      const medium = 240;
      // A quarter of the way too: the standard curve has done most of its distance by the middle.
      for (const [step, ms] of [["0-start", 0], ["0b-quarter", medium / 4], ["1-middle", medium / 2], ["2-end", null]]) {
        const widths = await page.evaluate((ms) => {
          for (const animation of window.__talkAnimations) {
            if (ms === null) animation.finish();
            else animation.currentTime = Math.min(ms, animation.effect.getComputedTiming().endTime);
          }
          const side = (name) => document.querySelector(`.project-talk-${name}`);
          const content = (name) => side(name).querySelector(".project-talk-scroll");
          const opacity = (name) => Number(getComputedStyle(content(name)).opacity);
          // The content's own width: a side closing keeps it as it began, its column clipping it (no re-wrap).
          const inner = (name) => Math.round(content(name).getBoundingClientRect().width);
          // Card rows of the requests laid out in two lines: a closing side keeps its layout too.
          const twoLines = [...side("requests").querySelectorAll(".request-card-row")].filter((row) => {
            const title = row.querySelector(".request-card-row-title").getBoundingClientRect();
            return row.querySelector(".request-card-row-who").getBoundingClientRect().top >= title.bottom - 2;
          }).length;
          return { requests: Math.round(side("requests").getBoundingClientRect().width), chat: Math.round(side("chat").getBoundingClientRect().width),
            requestsOpacity: opacity("requests"), chatOpacity: opacity("chat"), requestsInner: inner("requests"), chatInner: inner("chat"), twoLines };
        }, ms);
        const file = `frames/${run.name}-both-to-${to}-${step}.png`;
        await talk.screenshot({ path: join(output, file) });
        report.frames.push({ run: run.name, from: "both", to, step, ms: ms ?? "end", file, widths, animations: step === "0-start" ? started : undefined });
      }
      const [start, , middle, end] = report.frames.slice(-4).map((f) => f.widths);
      const growing = to === "requests" ? "requests" : "chat";
      assert.ok(start[growing] < middle[growing] && middle[growing] < end[growing], `the chosen side widens: ${JSON.stringify([start, middle, end])}`);
      const closing = to === "requests" ? "chatOpacity" : "requestsOpacity";
      assert.ok(start[closing] > 0.9 && middle[closing] < 0.05, `the closing side's content is gone by the middle: ${JSON.stringify([start, middle])}`);
      // The side closing is never seen squeezed: its content keeps the width it began with, or is all but gone
      // (opacity at most 0.1), at the quarter and the middle (Dev Lead 2, seq 12212).
      const quarter = report.frames.at(-3).widths;
      const gone = to === "requests" ? "chat" : "requests";
      for (const [name, frame] of [["quarter", quarter], ["middle", middle]])
        assert.ok(Math.abs(frame[`${gone}Inner`] - start[`${gone}Inner`]) <= 1 || frame[`${gone}Opacity`] <= 0.1,
          `the closing side's content at the ${name}: ${JSON.stringify({ start, frame })}`);
      if (gone === "requests")
        for (const frame of [quarter, middle])
          assert.ok(frame.twoLines === start.twoLines || frame.requestsOpacity <= 0.1, `the requests keep their rows' layout: ${JSON.stringify({ start, frame })}`);
      const staying = to === "requests" ? "requestsOpacity" : "chatOpacity";
      assert.ok([start, middle, end].every((f) => f[staying] === 1), `the side staying open is never faded: ${JSON.stringify([start, middle, end])}`);
      pass(`frames of Both → ${to}`, { frames: report.frames.slice(-4).map((f) => f.file) });
    }
    await tab(w.both).click();
    await settled();
    // Back to both: the side coming back slides in from its own side.
    await tab(w.chat).click();
    await settled();
    const back = await page.evaluate(async (label) => {
      const button = [...document.querySelectorAll(".project-talk-tabs [role=tab]")].find((b) => b.textContent.trim().startsWith(label));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const talk = document.querySelector(".project-talk");
      return document.getAnimations().filter((a) => talk.contains(a.effect?.target)
        && (a.transitionProperty === "grid-template-columns" || String(a.animationName ?? "").startsWith("project-talk-")))
        .map((a) => a.animationName ?? a.transitionProperty);
    }, w.both);
    assert.ok(back.includes("project-talk-in"), `the requests come back in: ${JSON.stringify(back)}`);
    await settled();
    pass("a side coming back slides in", { animations: back });
  }
}
