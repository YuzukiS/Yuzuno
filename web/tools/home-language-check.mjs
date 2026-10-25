// T-189: Home in the interface language, in Chromium (en-US), with every API
// answered here (no Core, no Agent run). Through the real app:
//  - in English: Needs you, a project's frame and its Ask, report and status
//    cards, with a reply begun on the report and an answer typed to the Ask,
//    neither sent, and Defer open;
//  - the language changed in another window: Home's own words are Chinese;
//    the project, Agent and card names, the Brief's text, the Ask's question
//    and options and both unsent replies as they were; nothing sent;
//  - back to English in another window: Home is as it was, the replies kept;
//  - an order Core refused to save: its banner follows the language changed
//    in another window, Core's reason as it came.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-language-check.mjs
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
const report = { task: "T-189", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-home-language.test";

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [
  { id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Atlas", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" },
];
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const section = (key, kind, title, text, extra = {}) => ({ key, kind, title, version: 1, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: ago(5), updatedTurnId: "t1", body: markdown(text), attachments: [], refs: {}, seen: null, history: false, ...extra });
// What the Agent wrote, in its own words: shown as written in either language.
const BODY = { ship: "The release is ready.", progress: "Cards now fold one by one.", load: "CPU is busy with the nightly build." };
const home = {
  generatedAt: ago(0),
  order: ["p1", "p2"],
  needsYou: [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "ship", title: "Ship today?", since: ago(20) }],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: 3,
    missing: [{ agentId: "a", agentName: "Mori", turnId: "t0", at: ago(70), outcome: "missing" }],
    brief: { version: 3, history: [], sections: [
      section("ship", "ask", "Ship today?", BODY.ship, { ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "yes", label: "Ship" }, { id: "no", label: "Wait" }], freeText: true } } }),
      section("progress", "report", "Progress", BODY.progress),
      section("load", "status", "Build load", BODY.load, { status: { asOf: ago(240), validFor: 3600, stale: true }, time: { nextUpdate: ago(-120) } }),
    ] },
  }, {
    // A second, quiet project, so Home can be reordered.
    project: { id: "p2", name: "Atlas" }, agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] },
  }],
};
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };
// Home's later reads wait while the refused order's banner is checked: a
// read that succeeds clears the banner, as it should.
let holdHome = false;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  // Linked repositories are read with a POST; this project has none.
  if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
  if (path === "/api/home" && holdHome) return new Promise(() => {});
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-home-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machine-load": machineLoad, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates,
    "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  }[path];
  if (json) return route.fulfill({ json });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
});
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();

async function elsewhere(language, heading) {
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await page.locator(".home-needs-you h2", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}
// What Home shows, by part: its own words, and what came from Agents or the user.
const shown = () => page.evaluate(() => {
  const text = (el) => el?.textContent.replace(/\s+/g, " ").trim() ?? null;
  const one = (selector) => text(document.querySelector(selector));
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].map(text);
  const card = (key) => {
    const el = document.querySelector(`[data-section-key="${key}"]`);
    return {
      kind: text(el.querySelector(".home-kind")),
      title: text(el.querySelector("h3")),
      changed: text(el.querySelector(".home-changed")),
      meta: all(".home-section-meta > span", el),
      buttons: all(".home-section-head button", el).filter(Boolean),
      times: all(":scope > .home-card-body > .home-section-time > span", el),
      body: text(el.querySelector(".home-section-body")),
    };
  };
  const ship = document.querySelector('[data-section-key="ship"]');
  const reply = document.querySelector('[data-section-key="progress"] .home-card-reply');
  const panel = document.querySelector('[data-home-project="p1"]');
  return {
    lang: document.querySelector(".home-view").getAttribute("lang"),
    needs: { heading: one(".home-needs-you h2"), item: all(".home-needs-item > span > span, .home-needs-item > span > strong, .home-needs-since"), title: document.querySelector(".home-needs-item").getAttribute("title") },
    project: { name: text(panel.querySelector(".home-panel-head h2")), chips: all(".home-panel-chips > span", panel) },
    cards: { ship: card("ship"), progress: card("progress"), load: card("load") },
    ask: {
      question: text(ship.querySelector(".home-question")),
      options: all(".home-ask-options button", ship),
      target: all(".home-ask-reply > .home-reply-target label, .home-ask-reply > .home-reply-target option", ship),
      placeholder: ship.querySelector(".home-text-reply textarea").getAttribute("placeholder"),
      typed: ship.querySelector(".home-text-reply textarea").value,
      send: text(ship.querySelector(".home-text-reply button")),
      defer: all(".home-defer button", ship),
    },
    reply: {
      head: text(reply.querySelector(".home-card-reply-head span")),
      to: text(reply.querySelector(".home-reply-target label")),
      placeholder: reply.querySelector("textarea").getAttribute("placeholder"),
      typed: reply.querySelector("textarea").value,
      send: text(reply.querySelector(".home-text-reply button")),
      close: reply.querySelector(".home-card-reply-head button").getAttribute("aria-label"),
    },
    seenAll: text(panel.querySelector(".home-panel-foot .secondary-button")),
    team: text(panel.querySelector(".home-team-details summary")),
    missing: text(panel.querySelector(".home-missing li")),
    counts: all(".home-agent-counts .home-count", panel),
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  await page.locator('[data-section-key="load"]').waitFor({ timeout: 10_000 });
  // Begun, not sent: a reply to the report and an answer to the Ask; Defer open.
  await page.locator('[data-section-key="progress"] .home-reply-open').click();
  const DRAFT = "Please keep the fold — 先别改";
  const ANSWER = "Ship after the docs land 文档之后";
  await page.locator('[data-section-key="progress"] .home-card-reply textarea').fill(DRAFT);
  await page.locator('[data-section-key="ship"] .home-text-reply textarea').fill(ANSWER);
  await page.locator('[data-section-key="ship"] .home-defer > button').click();
  await page.locator('[data-section-key="ship"] .home-defer [role="group"]').waitFor();
  await page.locator('[data-home-project="p1"] .home-team-details summary').click();

  // ---- In English.
  const en = await shown();
  await page.screenshot({ path: join(output, "home-en.png"), fullPage: true });
  assert.equal(en.lang, "en");
  assert.equal(en.needs.heading, "Needs you1");
  assert.deepEqual(en.needs.item, ["Yuzuno · Mori", "Ship today?", "20 min ago"]);
  assert.match(en.needs.title, /^Ship today\? · waiting since /);
  assert.deepEqual(en.project, { name: "Yuzuno", chips: ["3 new", "1 needs you"] });
  assert.deepEqual([en.cards.ship.kind, en.cards.progress.kind, en.cards.load.kind], ["Ask", "Report", "Status"]);
  assert.equal(en.cards.progress.changed, "New");
  assert.deepEqual(en.cards.progress.meta, ["Mori", "5 min ago"]);
  assert.deepEqual(en.cards.progress.buttons, ["Reply", "Seen"]);
  assert.equal(en.cards.load.times.length, 2);
  assert.match(en.cards.load.times[0], /^Data as of .+ · older than its 1 h validity$/);
  assert.equal(en.cards.load.times[1], "Next update in 2 h");
  assert.deepEqual(en.ask.options, ["Ship", "Wait"]);
  assert.deepEqual(en.ask.target, ["Send to", "Mori"]);
  assert.deepEqual([en.ask.placeholder, en.ask.send], ["Write a reply…", "Send"]);
  assert.deepEqual(en.ask.defer, ["Defer", "1 hour", "Tomorrow", "Next week"]);
  assert.deepEqual(en.reply, { head: "Reply to “Progress” · version 1", to: "To", placeholder: "A reply for Mori…", typed: DRAFT, send: "Send", close: "Close the reply; the draft is kept" });
  assert.deepEqual([en.seenAll, en.team], ["Seen all", "Team details & history"]);
  assert.equal(en.missing, "Mori ended a turn without updating the Brief · 1 h ago");
  assert.deepEqual(en.counts, ["0 working", "1 idle", "0 waiting", "0 errors"]);
  check("English: Needs you, the project's frame, each card's kind, state, times and controls, Defer and both replies");

  // ---- Changed to Chinese in another window.
  const before = report.writes.length;
  await elsewhere("zh-Hans", "需要你处理");
  const zh = await shown();
  await page.screenshot({ path: join(output, "home-zh.png"), fullPage: true });
  assert.equal(zh.lang, "zh-Hans");
  assert.equal(zh.needs.heading, "需要你处理1");
  assert.deepEqual(zh.needs.item, ["Yuzuno · Mori", "Ship today?", "20 分钟前"]);
  assert.match(zh.needs.title, /^Ship today\? · 自 .+ 起等待$/);
  assert.deepEqual(zh.project, { name: "Yuzuno", chips: ["3 条新内容", "1 项需要你"] });
  assert.deepEqual([zh.cards.ship.kind, zh.cards.progress.kind, zh.cards.load.kind], ["Ask", "报告", "状态"]);
  assert.equal(zh.cards.progress.changed, "新");
  assert.deepEqual(zh.cards.progress.meta, ["Mori", "5 分钟前"]);
  assert.deepEqual(zh.cards.progress.buttons, ["回复", "已看"]);
  assert.match(zh.cards.load.times[0], /^数据截至 .+ · 已超过 1 小时的有效期$/);
  assert.equal(zh.cards.load.times[1], "下次更新 2 小时后");
  assert.deepEqual(zh.ask.target, ["发送给", "Mori"]);
  assert.deepEqual([zh.ask.placeholder, zh.ask.send], ["写一条回复…", "发送"]);
  assert.deepEqual(zh.ask.defer, ["推迟", "1 小时", "明天", "下周"]);
  assert.deepEqual(zh.reply, { head: "回复 “Progress” · 版本 1", to: "发给", placeholder: "给 Mori 的回复…", typed: DRAFT, send: "发送", close: "关闭回复；草稿会保留" });
  assert.deepEqual([zh.seenAll, zh.team], ["全部标为已看", "团队详情与历史"]);
  assert.equal(zh.missing, "Mori 结束了一个 Turn，但没有更新 Brief · 1 小时前");
  assert.deepEqual(zh.counts, ["工作中 0", "就绪 1", "等待中 0", "出错 0"]);
  check("Chinese: Home's own words follow the language changed in another window");
  // What Agents and the user wrote, as it was.
  for (const key of ["ship", "progress", "load"]) {
    assert.equal(zh.cards[key].title, en.cards[key].title);
    assert.equal(zh.cards[key].body, en.cards[key].body);
    assert.ok(zh.cards[key].body.includes(BODY[key]), `${key}: ${zh.cards[key].body}`);
  }
  assert.deepEqual([zh.ask.question, zh.ask.options], ["Ship the release today?", ["Ship", "Wait"]]);
  assert.deepEqual([zh.reply.typed, zh.ask.typed], [DRAFT, ANSWER]);
  assert.deepEqual(report.writes.slice(before), [], "changing the language sends nothing");
  check("Chinese: names, the Brief's text, the Ask's question and options as written; both unsent replies kept; nothing sent");

  // ---- Back to English in another window.
  await elsewhere("en", "Needs you");
  const back = await shown();
  assert.deepEqual(back, en);
  assert.deepEqual(report.writes, []);
  check("English again: Home is as it was, the unsent replies still there");

  // ---- An order Core refused to save: the banner follows the language.
  const banner = page.locator(".home-error-banner");
  holdHome = true;
  await page.locator(".home-header-tools .quiet-button").click();
  await page.locator('[data-home-project="p1"] .home-reorder button').nth(1).click();
  await banner.waitFor({ timeout: 10_000 });
  const refused = await banner.textContent();
  const reason = refused.match(/^The order was not saved: (.+) · Showing the last reading\.$/)?.[1];
  assert.ok(reason, refused);
  assert.deepEqual(report.writes, [{ method: "POST", path: "/api/home/order" }]);
  await elsewhere("zh-Hans", "需要你处理");
  assert.equal(await banner.textContent(), `顺序未保存：${reason} · 显示的是上一次读取的内容。`);
  assert.equal(await page.locator(".home-header-tools .quiet-button").textContent(), "完成");
  await elsewhere("en", "Needs you");
  assert.equal(await banner.textContent(), refused);
  assert.equal(report.writes.length, 1, "changing the language sends nothing");
  check("A refused order: its banner follows the language, Core's reason as it came", { reason });
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
