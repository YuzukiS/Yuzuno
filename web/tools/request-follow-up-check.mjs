// YN-233 (R-45): a request's follow-ups in its first look, and one press to them in its conversation, in Chromium with
// the real page and every API answered here (no Core, no daily data). Synthetic data in R-44's shape: one task (YN-232)
// done with its report delivered (in History), the task's progress written, and the user's two follow-ups after it.
// Four states of that request, each at 1180 px and on a 390 px phone, in English and Chinese, and once with reduced
// motion:
//  - waiting: the newest follow-up delivered, no note names it: Waiting for a reply, in progress, Confirm done not the
//    main action, nothing saying it waits for the user, no next step; that it waits for the project's reply, and since
//    when;
//  - answered: a note names it in replyTo: the project's reply; For you to accept again;
//  - legacy: R-44 as it is, a note after both follow-ups naming none: the project's later note, said to reply to none,
//    not counted as replied;
// Only the project speaks in the zone (the user's choice on YN-233): no Agent's name in its words.
//  - unsent: the newest not confirmed delivered: said so, with Send again, never "delivered".
// Then Show in the conversation: the block opens at its conversation, the follow-up in view (on a phone, above the
// dock) with the focus, it and what came of it marked, the mark flashing once (not with reduced motion). Nothing is
// wider than the window. Screenshots and a JSON report go to YUZUNO_BROWSER_OUTPUT.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-follow-up-check.mjs
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
const report = { task: "YN-233", fixture: "synthetic, R-44's shape", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47396";
// Each run's times are from its own start (check), so "5 min ago" is still 5 minutes into the later runs.
let now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
const EXEC = "YN-232 · 只读调查";
const agents = [
  { ...base, id: "l", name: "Dev Lead", kind: "lead" },
  { ...base, id: "e232", name: EXEC, kind: "executor",
    executor: { state: "archived", task: { id: "YN-232", title: "核对执行者侧栏与选中会话的状态来源", shortName: "侧栏状态调查" } } },
];
const projects = [{ id: "p-dev", name: "yuzuno-next", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const reportTitle = "R-44 · 侧栏「Between turns」点开后变「Awaits a shell」：是未读规则，不是刷新慢";
const r44Report = {
  id: 661, key: "yn-232", kind: "report", title: reportTitle, version: 3, owner: { agentId: "e232", name: EXEC, state: "closed" },
  author: { agentId: "e232", name: EXEC }, updatedAt: at(10), updatedTurnId: "t1",
  body: { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", size: "wide" } }, ["lead"]),
    lead: node("Markdown", { text: "**不是刷新慢**：本机还没看这一轮结束时，行故意显示 Between turns，点开停留 1.2 秒记为已看后才显示 Awaits a shell。" }),
  } },
  attachments: [], refs: {}, seen: { version: 3, at: at(9) }, history: true, historyReason: "seen",
  card: { task: { id: "YN-232", title: "核对执行者侧栏与选中会话的状态来源", shortName: "侧栏状态调查", status: "done", archived: false },
    responsible: { agentId: "e232", name: EXEC, kind: "executor", state: "archived" } },
};
const F1 = "什么是未读规则？我没有点开看的意思吗？";
const F2 = "什么情况？这个request不会更新回复我了吗？";
const ANSWER = "对，就是这个意思：这一轮结束后你在这台设备上还没点开看过，侧栏就先显示 Between turns；点开停留约 1.2 秒才显示 Awaits a shell。";
const LATE = "可以继续在 R-44 追问。之前我只交了调查报告，漏了回到这里答你。建议等待状态常显，未读另加小点。";
const desk = { agentId: "l", name: "Dev Lead" };
/** R-44 in one of the four states. */
function r44(scenario) {
  const to = (agentId, name, closed, delivery = "accepted") => ({ agentId, name, closed, delivery });
  const notes = [{ n: 1, note: "我会用当前版本复现点开前后状态变化，再说明原因。", by: desk, at: at(19), replyTo: null }];
  if (scenario === "answered") notes.push({ n: 2, note: ANSWER, by: desk, at: at(2), replyTo: [2] });
  // R-44 as an older Core keeps it: no n, no replyTo, recipients by ID only.
  if (scenario === "legacy") notes.push({ note: LATE, by: desk, at: at(3) });
  const legacy = scenario === "legacy";
  return {
    id: "req-44", n: 44, text: "左侧执行者的between turns等状态在我点进去之后会变成其他的真实情况，为什么会这样？", textBlocks: null, images: [], files: [],
    title: "查明点开执行者后侧栏状态改变的原因", createdAt: at(20), frontAgentId: "l", messageId: "m44", delivery: "accepted",
    replies: [
      { n: 1, text: F1, textBlocks: null, images: [], files: [], at: at(12.5), messageId: "m44-1",
        deliveredTo: [legacy ? { agentId: "e232", delivery: "accepted" } : to("e232", EXEC, true)] },
      { n: 2, text: F2, textBlocks: null, images: [], files: [], at: at(5), messageId: "m44-2",
        deliveredTo: [legacy ? { agentId: "l", delivery: "accepted" } : to("l", "Dev Lead", false, scenario === "unsent" ? "sending" : "accepted")] },
    ],
    notes: legacy ? notes.map(({ note, by, at }) => ({ note, by, at })) : notes,
    routes: [], state: "ended", confirmedAt: null, progress: { cards: 1, ended: 1 },
    cards: [{
      sectionId: 661, key: "yn-232", title: reportTitle, live: false,
      responsible: { agentId: "e232", name: EXEC, kind: "executor", state: "archived" },
      task: { id: "YN-232", status: "done", archived: false, blocker: null, progress: "已验收 core.39 的只读调查和界面对照记录。" },
      result: { id: "res-232", status: "review", reportedAt: at(13) },
      deliverables: { resultId: "res-232", reportedAt: at(13), items: [{ kind: "report", title: reportTitle, note: null, key: "yn-232", version: 3,
        sectionId: 661, state: "history", currentVersion: 3 }] },
      prs: { items: [] },
    }],
    lines: [{ kind: "done", task: "YN-232", status: "done", at: at(12), cardSectionId: 661, title: reportTitle }],
  };
}
const home = () => ({
  generatedAt: at(0), order: ["p-dev"], needsYou: [],
  projects: [{
    project: { id: "p-dev", name: "yuzuno-next" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 9, history: [r44Report], sections: [] },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

/** What each state's first look and jump must say, in each language. */
const words = {
  en: {
    waiting: { state: "Waiting for a reply", group: "doing", lines: /^Delivered · waiting for the project to reply · waiting 5 min1 more waits for the project's reply$/,
      head: /^You followed up 2 times · newest · 5 min ago2 follow-ups · 0 replied$/, marked: ["reply:2"] },
    answered: { state: "For you to accept", group: "needs", lines: new RegExp(`^The project replied · 2 min ago${ANSWER}$`), head: /· 1 replied$/,
      marked: ["reply:2", "note:2"] },
    legacy: { state: "For you to accept", group: "needs", lines: new RegExp(`^The project added a note · 3 min ago${LATE}Not marked as a reply to any follow-up$`),
      head: /· 0 replied$/, marked: ["reply:1", "reply:2", "note:2"] },
    unsent: { state: "Waiting for a reply", group: "doing", lines: /^Not confirmed delivered · Send again$/, head: /· 0 replied$/, marked: ["reply:2"] },
    show: "Show in the conversation →",
  },
  "zh-Hans": {
    waiting: { state: "等回复", group: "doing", lines: /^已送达 · 等项目回复 · 已等 5 分钟另 1 条也在等项目回复$/,
      head: /^你追问 2 次 · 最近一条 · 5 分钟前共 2 条 · 0 条已回复$/, marked: ["reply:2"] },
    answered: { state: "等你验收", group: "needs", lines: new RegExp(`^项目回复 · 2 分钟前${ANSWER}$`), head: /· 1 条已回复$/, marked: ["reply:2", "note:2"] },
    legacy: { state: "等你验收", group: "needs", lines: new RegExp(`^项目后续留言 · 3 分钟前${LATE}这条留言没有标明回复的是哪条追问$`), head: /· 0 条已回复$/,
      marked: ["reply:1", "reply:2", "note:2"] },
    unsent: { state: "等回复", group: "doing", lines: /^没确认送达 · 再发一次$/, head: /· 0 条已回复$/, marked: ["reply:2"] },
    show: "在对话中查看 →",
  },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "zh-1180", viewport: { width: 1180, height: 900 }, phone: false, language: "zh-Hans" },
  { name: "zh-phone-390", viewport: { width: 390, height: 844 }, phone: true, language: "zh-Hans" },
  { name: "en-1180", viewport: { width: 1180, height: 900 }, phone: false, language: "en" },
  { name: "en-phone-390", viewport: { width: 390, height: 844 }, phone: true, language: "en" },
  { name: "zh-1180-reduced", viewport: { width: 1180, height: 900 }, phone: false, language: "zh-Hans", reduced: true },
];
let passed = 0;
try {
  for (const run of runs) for (const scenario of ["waiting", "answered", "legacy", "unsent"]) await check(run, scenario);
} finally {
  await browser.close();
  await writeFile(join(output, "request-follow-up-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`request-follow-up-check: ${report.runs.length} runs, ${passed} checks`);

function pass(run, scenario, what, facts) {
  passed += 1;
  console.log(`PASS [${run.name} ${scenario}] ${what}${facts ? ` ${JSON.stringify(facts)}` : ""}`);
}

async function check(run, scenario) {
  now = Date.now();
  const w = words[run.language][scenario];
  const result = { run: run.name, scenario, viewport: run.viewport, facts: {}, shots: [] };
  report.runs.push(result);
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC", deviceScaleFactor: run.phone ? 2 : 1,
    reducedMotion: run.reduced ? "reduce" : "no-preference", ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
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
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-r44" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/projects\/[^/]+\/brief\/opened$/.test(path)) {
      const body = JSON.parse(request.postData() || "{}");
      return route.fulfill({ json: { projectId: "p-dev", sectionId: body.sectionId, key: body.key, version: body.version, at: at(0), recorded: true } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w+\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, scenario, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) return route.fulfill({ json: { requests: [r44(scenario)], hasMore: false } });
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
  page.on("pageerror", (error) => report.errors.push(`${run.name} ${scenario}: ${error.message}`));
  const shot = async (name, target) => {
    const file = `${run.name}-${scenario}-${name}.png`;
    await target.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const tap = async (locator) => (run.phone ? locator.tap() : locator.click());
  const block = page.locator('[data-request-block="44"]');
  const text = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, " ").trim());
  const wider = () => page.evaluate(() => {
    const view = document.querySelector(".home-view").getBoundingClientRect();
    return [...document.querySelectorAll('[data-request-block="44"], [data-request-block="44"] *')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > view.right + 1 || r.left < view.left - 1); })
      .map((el) => el.className || el.tagName);
  });
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-r44`);
    const open = page.locator('[data-glance-project="p-dev"] .project-glance-open');
    await open.waitFor({ timeout: 15_000 });
    await tap(open);
    await block.locator(".request-follow").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(300);

    // The first look: the follow-up and what came of it, without opening anything.
    const zone = block.locator(".request-follow");
    const first = {
      zone: await zone.getAttribute("data-state"),
      head: await text(zone.locator(".request-follow-head")),
      said: await text(zone.locator(".request-follow-said")),
      lines: await text(zone.locator(".request-follow-lines")),
      state: await text(block.locator(".request-state")),
      group: await block.getAttribute("data-group"),
      inNeeds: await page.locator('.request-group[data-group="needs"] [data-request-block="44"]').count(),
      primary: await block.locator('.request-block-action[data-action="confirm"]').evaluate((el) => el.classList.contains("is-primary")),
      settle: await block.locator(".request-block-settle").count(),
      next: await block.locator(".request-next").count(),
      progress: await text(block.locator(".request-progress")).catch(() => null),
      opened: await block.locator(".request-block-body").count(),
      wider: await wider(),
    };
    result.facts.firstLook = first;
    assert.equal(first.zone, scenario === "legacy" ? "later" : scenario, JSON.stringify(first));
    assert.match(first.head, w.head, JSON.stringify(first));
    assert.equal(first.said, F2);
    assert.match(first.lines, w.lines, JSON.stringify(first));
    // The user's choice on YN-233: only the project replies; no Agent is named in the zone's words.
    assert.doesNotMatch(await text(zone), /Dev Lead|YN-232/, "no Agent named in the zone");
    assert.equal(first.state, w.state);
    assert.equal(first.group, w.group);
    assert.equal(first.inNeeds, w.group === "needs" ? 1 : 0, "in Needs you only when it is the user's turn");
    const waits = scenario === "waiting" || scenario === "unsent";
    // With its task's progress shown (R-38 §2.2) the next step says "confirm it done, or follow up", not the fact's
    // line; while the follow-up waits for a reply, neither says it, and Confirm done is not the main action.
    assert.deepEqual([first.primary, first.settle, first.next], waits ? [false, 0, 0] : [true, 0, 1],
      `${waits ? "not " : ""}the user's to accept: ${JSON.stringify(first)}`);
    assert.ok(first.progress?.includes("已验收 core.39"), "the original work's progress stays");
    assert.equal(first.opened, 0, "read without opening anything");
    assert.deepEqual(first.wider, [], "nothing wider than the window");
    await block.scrollIntoViewIfNeeded();
    await shot("first-look", block);
    pass(run, scenario, "the first look says the follow-up and what came of it", { lines: first.lines, state: first.state });

    // One press: the conversation, at the follow-up, in view and above the dock, with the focus and its marks.
    const link = zone.locator(".request-follow-foot .talk-link");
    assert.equal(await text(link), words[run.language].show);
    await tap(link);
    const target = block.locator('.request-thread > li[data-reply="2"]');
    await target.waitFor({ timeout: 5000 });
    const flashing = await page.evaluate(() => new Promise((done) => {
      // The flash is seen once its jump lands: within settle's time, on a marked line.
      const started = performance.now();
      const look = () => {
        const marked = [...document.querySelectorAll('[data-request-block="44"] .request-thread > li[data-focus]')];
        const playing = marked.some((li) => li.getAnimations().some((a) => a.animationName === "request-thread-flash"));
        if (playing || performance.now() - started > 1500) done(playing);
        else requestAnimationFrame(look);
      };
      look();
    }));
    await page.waitForTimeout(run.reduced ? 200 : 900);
    const landed = await page.evaluate(() => {
      const block = document.querySelector('[data-request-block="44"]');
      const view = document.querySelector(".home-view").getBoundingClientRect();
      const dock = document.querySelector(".home-dock")?.getBoundingClientRect();
      const target = block.querySelector('.request-thread > li[data-reply="2"]').getBoundingClientRect();
      return {
        view: block.querySelector(".request-block-body")?.dataset.view ?? null,
        tab: block.querySelector('.request-block-tabs [aria-selected="true"]')?.dataset.view ?? null,
        focused: document.activeElement?.matches?.('[data-request-block="44"] .request-thread > li[data-reply="2"]') ?? false,
        marked: [...block.querySelectorAll(".request-thread > li[data-focus]")].map((li) => li.dataset.threadItem),
        inView: target.top >= view.top - 1 && target.bottom <= view.bottom + 1,
        aboveDock: !dock || target.bottom <= dock.top + 1,
        reportShown: !!block.querySelector('.request-task, [data-section-key="yn-232"]'),
      };
    });
    result.facts.jump = { ...landed, flashing, wider: await wider() };
    assert.deepEqual({ view: landed.view, tab: landed.tab, focused: landed.focused, inView: landed.inView, aboveDock: landed.aboveDock, reportShown: landed.reportShown },
      { view: "thread", tab: "thread", focused: true, inView: true, aboveDock: true, reportShown: false }, JSON.stringify(result.facts.jump));
    assert.deepEqual(landed.marked, w.marked);
    assert.equal(flashing, !run.reduced, run.reduced ? "reduced motion: marked, no flash" : "the marks flash once as it lands");
    assert.deepEqual(result.facts.jump.wider, [], "nothing wider than the window");
    await shot("jumped", block.locator(".request-block-body"));
    pass(run, scenario, "one press opens the conversation at the follow-up, marked, with the focus", { marked: landed.marked, flashing });
  } catch (error) {
    await page.screenshot({ path: join(output, `${run.name}-${scenario}-failed.png`), fullPage: true }).catch(() => {});
    result.error = String(error?.stack || error);
    throw error;
  } finally {
    await context.close();
  }
}
