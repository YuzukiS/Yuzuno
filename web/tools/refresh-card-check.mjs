// A refreshing card's web face in Chromium (YN-113 R3): the production bundle
// with an explicit API fixture (synthetic cards, no Core, daily window or real
// Agent), at 1440 and 390 px, in English and Simplified Chinese:
//  - each card's head says how often it refreshes ("Daily 08:00"), or that it
//    is paused, and its foot says what the last run did (refreshed, caught up
//    after missed slots, paused) and when the next one is;
//  - the alarm opens the schedule panel in the card: every control inside the
//    card, the recent runs drawn, Save / Pause / Refresh now / Remove schedule;
//  - the report page lists this issue and Core's past ones, and a past issue
//    is read whole from Core and shown read only with the way back;
//  - nothing is wider than the window, in either language.
// Reads only: nothing is written. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/refresh-card-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-refresh.test";
const WS = "ws-refresh";
const report = { task: "YN-113 R3", checks: [], failures: [], errors: [], unexpected: [], writes: [], receipts: [], shots: [],
  limits: ["Chromium only: not iOS Safari, not a real iPhone, not the native desktop window."] };
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
  } finally {
    await page?.context().close().catch(() => {});
    page = undefined;
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}
async function shot(name, selector) {
  const path = resolve(output, name);
  await (selector ? page.locator(selector).first().screenshot({ path }) : page.screenshot({ path }));
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const owner = { agentId: "a", name: "Mori", state: "active" };
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Daily digest", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const reason = (message, messageZh) => ({ code: "why", message, messageZh });
const refresh = (extra = {}) => ({
  version: 3, cadence: { every: "day", at: "08:00" }, zone: "local", utcOffset: "+08:00",
  instruction: "Search the past 24 hours for three important stories and five new papers worth reading; only what is new since the last issue.",
  enabled: true, pausedReason: null, weeklyRuns: 7, nextAt: iso(22 * 60 * MIN), lastSlot: iso(-2 * 60 * MIN),
  run: { slot: iso(-2 * 60 * MIN), missed: 0, state: "refreshed", agentId: "a", turnId: "t1", sentAt: iso(-2 * 60 * MIN), endedAt: iso(-2 * 60 * MIN + 60_000) },
  recent: [
    { slot: iso(-50 * 60 * MIN), state: "refreshed", missed: 0 },
    { slot: iso(-26 * 60 * MIN), state: "skipped", missed: 0, reason: reason("Not refreshed on time: its owner was busy", "没按时刷新：主人一直在忙") },
    { slot: iso(-2 * 60 * MIN), state: "refreshed", missed: 0 },
  ],
  failures: 0, waiting: null, versions: 3, createdAt: iso(-5 * 24 * 60 * MIN), createdBy: "a", updatedAt: iso(-2 * 60 * MIN), ...extra,
});
const items = [
  { id: "n1", title: "An open model reaches 1.0", text: "Twelve points ahead of its last version on long-context tests.", meta: "News · 07:40", tags: ["News"], href: "https://example.com/news/1" },
  { id: "n2", title: "A chip export rule takes effect next month", text: "It covers accelerators above a set compute.", meta: "News · 06:15", tags: ["News"], href: "https://example.com/news/2" },
  { id: "p1", title: "Sparse attention at 1M tokens", text: "Halves memory with the same accuracy.", meta: "arXiv cs.CL · 02:10", tags: ["Papers"], href: "https://example.com/papers/1" },
];
const digestBody = { root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "top", size: "wide" } }, children: ["lead", "top"] },
  lead: { type: "Markdown", props: { text: "Three stories worth reading today, and five new papers: two more than yesterday." } },
  top: { type: "Collection", props: { id: "top", title: "Today's picks", layout: "list", items } },
} };
const simple = (lead) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", size: "wide" } }, children: ["lead"] },
  lead: { type: "Markdown", props: { text: lead } },
} });
const section = (key, id, title, body, extra = {}) => ({ id, key, kind: "report", title, version: 3, owner, body, attachments: [], refs: {},
  seen: null, history: false, updatedTurnId: null, updatedAt: iso(-2 * 60 * MIN), ...extra });
const sections = [
  section("digest", 51, "Today's news and papers", digestBody, { refresh: refresh() }),
  section("weekly", 52, "Weekly research round-up", simple("This week: five papers on agents that test their own patches."), {
    refresh: refresh({ cadence: { every: "week", at: "08:00", days: [1, 4] }, weeklyRuns: 2, versions: 1,
      run: { slot: iso(-26 * 60 * MIN), missed: 2, state: "refreshed", endedAt: iso(-26 * 60 * MIN + 60_000) }, nextAt: iso(70 * 60 * MIN), recent: [{ slot: iso(-26 * 60 * MIN), missed: 2, state: "refreshed" }] }),
  }),
  section("paused", 53, "Nightly briefing", simple("Last night: nothing new worth opening."), {
    refresh: refresh({ cadence: { every: "hours", at: "02:00", hours: 8 }, weeklyRuns: 21, enabled: false, nextAt: null, versions: 0,
      pausedReason: reason("Paused after 3 failures in a row", "连续失败 3 次，已自动暂停"),
      run: { slot: iso(-10 * 60 * MIN), missed: 0, state: "failed", reason: reason("Its owner was busy", "主人一直在忙"), endedAt: iso(-10 * 60 * MIN) }, recent: [] }),
  }),
];
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "Daily digest" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections, history: [] }, unseen: 3, missing: [] }] });
const issues = [
  { version: 3, at: iso(-2 * 60 * MIN), title: "Today's news and papers", lead: "Three stories worth reading today, and five new papers: two more than yesterday.", live: true },
  { version: 2, at: iso(-26 * 60 * MIN), title: "Yesterday's news", lead: "Two stories worth reading, and three new papers.", live: false, historyReason: "refreshed" },
  { version: 1, at: iso(-50 * 60 * MIN), title: "The day before", lead: "One long read and two papers.", live: false, historyReason: "refreshed" },
];
const oldIssue = section("digest", 51, "Yesterday's news", simple("Two stories worth reading, and three new papers."), {
  version: 2, history: true, historyReason: "refreshed", updatedAt: iso(-26 * 60 * MIN), refresh: undefined,
});
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 16384, usedMiB: 4000, availableMiB: 12384, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (path === "/api/agents/a/reading") return route.fulfill({ json: request.method() === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (path === "/api/projects/p1/brief/opened") {
    report.receipts.push(JSON.parse(request.postData() || "{}"));
    const receipt = JSON.parse(request.postData() || "{}");
    return route.fulfill({ json: { projectId: "p1", ...receipt, at: new Date().toISOString(), recorded: true } });
  }
  // A read the app makes with POST (a list of the Project's linked repositories).
  if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "the fixture writes nothing" } });
  }
  if (["/api/agents/a/codex/usage", "/api/agents/a/codex/mcp", "/api/agents/a/conversation/inputs"].includes(path))
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: new Date().toISOString(), repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/waits/live": () => ({ agents: {} }),
    "/api/machine-live": () => ({ machines: [] }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
    "/api/projects/p1/brief/refreshes/51/versions": () => ({ projectId: "p1", identity: 51, key: "digest", versions: issues }),
    "/api/projects/p1/brief/refreshes/51/versions/2": () => oldIssue,
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    return await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open(width, height, { language = "en" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce" });
  page = await context.newPage();
  await page.addInitScript(([ws, lang]) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 50); }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem(`yuzuno.homeWidgets.${ws}`, JSON.stringify({ order: [], hidden: [], pins: [] }));
  }, [WS, language]);
  page.on("pageerror", (error) => {
    if (!/ResizeObserver|Not implemented/.test(error.message)) {
      console.log(`PAGEERROR ${width}: ${error.message}\n${error.stack ?? ""}`);
      report.errors.push(`${width}: pageerror: ${error.message}`);
    }
  });
  const answered = (message) => /\/api\/agents\/a\/(codex\/usage|codex\/mcp|conversation\/inputs)\b/.test(message.location()?.url ?? "");
  page.on("console", (message) => message.type() === "error" && !answered(message) && !/ResizeObserver|Not implemented|Failed to load resource/.test(message.text())
    && (console.log(`CONSOLE ${width}: ${message.text()}`), report.errors.push(`${width}: console: ${message.text()}`)));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  const nav = page.locator(".toolbar-nav .catchup-nav").first();
  await nav.waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) {
    console.log(`SCREEN ${width}: ${await page.evaluate(() => document.body.innerText.slice(0, 2000))}`);
    await nav.click();
  }
  await page.locator(".home-view").waitFor({ timeout: 10_000 });
  // YN-86: a project's cards are on its page, opened from Home's glance.
  if (!(await page.locator('.home-view [data-section-key="digest"]').count())) {
    await page.locator(".project-glance-open").first().click();
  }
  await page.locator('.home-view [data-section-key="digest"]').waitFor({ timeout: 10_000 });
}

/** How a card and its panel lie in the window: no part past either edge. */
const geometry = () => page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const inWindow = (el) => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= window.innerWidth + 0.5; };
  const cards = [...document.querySelectorAll(".home-view [data-section-key]")].map((card) => ({
    key: card.dataset.sectionKey, size: card.dataset.cardSize,
    tag: card.querySelector(".home-refresh-tag")?.textContent.trim() ?? null,
    state: card.querySelector(".home-refresh-state")?.textContent.trim() ?? null,
    next: card.querySelector(".home-refresh-next")?.textContent.trim() ?? null,
    inside: inWindow(card), card: rect(card),
    clipped: card.scrollHeight > card.clientHeight + 1,
  }));
  const panel = document.querySelector(".home-refresh-panel");
  return {
    cards, width: window.innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    panel: panel ? { inside: inWindow(panel), rect: rect(panel), clipped: panel.scrollHeight > panel.clientHeight + 1,
      controls: [...panel.querySelectorAll("button, input, select, textarea")].map((el) => ({ tag: el.tagName, label: el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 24), inside: inWindow(el) })),
      dots: panel.querySelectorAll(".home-refresh-recent li").length } : null,
  };
});

const OVERFLOW = (where, found) => {
  assert.ok(found.pageWidth <= found.width + 1, `${where}: nothing wider than the window (${found.pageWidth} > ${found.width})`);
  assert.deepEqual(found.cards.filter((card) => !card.inside), [], `${where}: every card inside the window`);
  assert.deepEqual(found.cards.filter((card) => card.clipped), [], `${where}: no card clips its own content`);
  if (found.panel) {
    assert.ok(found.panel.inside, `${where}: the panel inside the window`);
    assert.equal(found.panel.clipped, false, `${where}: the panel clips none of its content`);
    assert.deepEqual(found.panel.controls.filter((control) => !control.inside), [], `${where}: every control inside the window`);
  }
};

try {
  for (const [width, height] of [[1440, 900], [390, 844]])
    await step(`${width}: the three refresh cards say their schedule and last run, all inside the window`, async () => {
      await open(width, height);
      const found = await geometry();
      assert.deepEqual(found.cards.map((card) => card.key).sort(), ["digest", "paused", "weekly"]);
      assert.deepEqual(found.cards.map((card) => card.key).sort(), ["digest", "paused", "weekly"]);
      const byKey = Object.fromEntries(found.cards.map((card) => [card.key, card]));
      assert.equal(byKey.digest.tag, "Daily 08:00");
      assert.match(byKey.digest.state, /^Refreshed /);
      assert.match(byKey.digest.next, /^Next /);
      assert.equal(byKey.weekly.tag, "Weekly Mon, Thu 08:00");
      assert.match(byKey.weekly.state, /Caught up .* · 2 missed$/);
      assert.equal(byKey.paused.tag, "Paused");
      assert.match(byKey.paused.state, /^Paused · Paused after 3 failures/);
      assert.equal(byKey.paused.next, null);
      OVERFLOW(`${width} deck`, found);
      await shot(`home-${width}.png`);
      for (const key of ["digest", "weekly", "paused"]) await shot(`card-${width}-${key}.png`, `.home-view [data-section-key="${key}"]`);
      return { cards: found.cards };
    });

  await step("the alarm opens the schedule panel with its bounds, runs and actions; 1440 and 390", async () => {
    const results = {};
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await open(width, height);
      const card = page.locator('.home-view [data-section-key="digest"]');
      await card.locator(".home-refresh-open").click();
      await page.locator(".home-refresh-panel").waitFor();
      const found = await geometry();
      assert.equal(found.panel.dots, 3, `${width}: the three recent runs drawn`);
      assert.ok(found.panel.controls.some((control) => control.label === "Save"), `${width}: Save`);
      assert.ok(found.panel.controls.some((control) => control.label === "Pause"), `${width}: Pause`);
      assert.ok(found.panel.controls.some((control) => control.label === "Refresh now"), `${width}: Refresh now`);
      assert.ok(found.panel.controls.some((control) => control.label === "Remove schedule"), `${width}: Remove schedule`);
      assert.equal(await card.locator(".home-refresh-open").getAttribute("aria-expanded"), "true");
      OVERFLOW(`${width} panel`, found);
      await shot(`panel-${width}.png`, '.home-view [data-section-key="digest"]');
      await page.locator(".home-refresh-actions").scrollIntoViewIfNeeded();
      await shot(`panel-actions-${width}.png`);
      results[width] = found.panel;
      await page.context().close();
      page = undefined;
    }
    return results;
  });

  await step("390 in Chinese: the card's own words follow, the Agent's stay as written", async () => {
    await open(390, 844, { language: "zh-Hans" });
    const card = page.locator('.home-view [data-section-key="digest"]');
    assert.equal((await card.locator(".home-refresh-tag").textContent()).trim(), "每天 08:00");
    assert.match((await card.locator(".home-refresh-state").textContent()).trim(), /^已刷新 /);
    await card.locator(".home-refresh-open").click();
    await page.locator(".home-refresh-panel").waitFor();
    assert.equal((await page.locator(".home-refresh-heading").first().textContent()).includes("每周约 7 次 Turn"), true);
    assert.equal(await page.locator(".home-refresh-actions").getByText("立即刷新").count(), 1);
    const found = await geometry();
    OVERFLOW("390 Chinese", found);
    await shot("panel-390-zh.png", '.home-view [data-section-key="digest"]');
  });

  for (const [width, height] of [[1440, 900], [390, 844]])
    await step(`${width}: the report page lists this issue and past ones; a past issue is read only, with the way back`, async () => {
      await open(width, height);
      await page.locator('.home-view [data-section-key="digest"] .home-report-open').click();
      await page.locator(".home-report h1").waitFor();
      const select = page.locator(".home-refresh-issues select");
      await select.waitFor();
      await until("both issues listed", async () => (await select.locator("option").count()) === 3);
      const selectBox = await select.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, width: innerWidth }; });
      assert.ok(selectBox.l >= -0.5 && selectBox.r <= selectBox.width + 0.5, `the issue list inside the window: ${JSON.stringify(selectBox)}`);
      assert.match((await select.locator("option").first().textContent()), /^This issue ·/);
      assert.equal((await page.locator(".home-report h1").textContent()).trim(), "Today's news and papers");
      const before = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth,
        banner: !!document.querySelector(".report-issue-banner") }));
      assert.ok(before.page <= before.width + 1, "the report page fits the window");
      assert.equal(before.banner, false);
      await shot(`report-${width}.png`);
      await select.selectOption("2");
      const banner = page.locator(".report-issue-banner");
      await banner.waitFor();
      assert.match(await banner.textContent(), /This is the issue from/);
      assert.match(await banner.textContent(), /Read only/);
      await until("the past issue's title", async () => (await page.locator(".home-report h1").textContent()).trim() === "Yesterday's news");
      assert.equal(await page.locator(".home-report .home-seen").count(), 0);
      assert.equal(await page.locator(".home-report .home-reply-open").count(), 0);
      const after = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth,
        banner: (() => { const r = document.querySelector(".report-issue-banner").getBoundingClientRect(); return { l: r.left, r: r.right }; })() }));
      assert.ok(after.page <= after.width + 1, "a past issue fits the window");
      assert.ok(after.banner.l >= -0.5 && after.banner.r <= after.width + 0.5, `the banner inside the window: ${JSON.stringify(after.banner)}`);
      await shot(`issue-${width}.png`);
      await banner.locator("button", { hasText: "Back to this issue" }).click();
      await until("back to this issue", async () => (await page.locator(".home-report h1").textContent()).trim() === "Today's news and papers");
      assert.equal(await page.locator(".report-issue-banner").count(), 0);
      return { read: report.receipts.length };
    });

  await step("the report page's schedule panel opens under its title, inside the window", async () => {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await open(width, height);
      await page.locator('.home-view [data-section-key="digest"] .home-report-open').click();
      await page.locator(".home-report h1").waitFor();
      await page.locator(".report-refresh-toggle").click();
      await page.locator(".home-refresh-panel.is-report").waitFor();
      const found = await page.evaluate(() => {
        const panel = document.querySelector(".home-refresh-panel.is-report");
        const r = panel.getBoundingClientRect();
        return { inside: r.left >= -0.5 && r.right <= innerWidth + 0.5, width: innerWidth, page: document.documentElement.scrollWidth,
          controls: [...panel.querySelectorAll("button, input, select, textarea")].every((el) => { const b = el.getBoundingClientRect(); return b.left >= -0.5 && b.right <= innerWidth + 0.5; }) };
      });
      assert.ok(found.inside && found.controls, `${width}: the report's panel inside: ${JSON.stringify(found)}`);
      assert.ok(found.page <= found.width + 1, `${width}: the report page fits`);
      await shot(`report-panel-${width}.png`);
      await page.context().close();
      page = undefined;
    }
  });
} finally {
  await browser.close().catch(() => {});
}

report.unexpected = [...new Set(report.unexpected)];
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.checks.length} checks passed, ${report.failures.length} failed; ${report.shots.length} screenshots in ${output}`);
if (report.failures.length) process.exit(1);
