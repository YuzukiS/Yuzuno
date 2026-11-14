// A report's Tabs (YN-113 R6), in a browser: the production bundle with an
// explicit API fixture (one synthetic report, no Core, daily window or real
// Agent). Checks what JSDOM can't: on a 1440 px desktop and a 390 px phone,
// the row of tabs over the page shown, the page's title left to its tab by
// the stylesheet, the keys moving the real focus, a row too wide for the
// phone scrolling sideways on its own (the page never does) with the
// focused tab scrolled into view, and Home's card drawing no tabs. Reads
// only: nothing is written. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
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
const HOST = "yuzuno-tabs.test";
const WS = "ws-tabs";
const report = { task: "YN-129", checks: [], failures: [], errors: [], unexpected: [], writes: [], receipts: [], shots: [],
  limits: ["Chromium only: not iOS Safari, not a real iPhone, not the native desktop window.", "Synthetic report; no screen reader was run."] };
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
async function shot(name, options = {}) {
  await page.screenshot({ path: resolve(output, name), ...options });
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "daily-digest", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const md = (text) => ({ type: "Markdown", props: { text } });
const page_ = (title, ...children) => ({ type: "Group", props: { title }, children });
// Six pages, as many as a Tabs takes: their row is wider than a phone.
const digest = { root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", size: "small" } }, children: ["lead", "more"] },
  lead: md("Three stories and **five new papers** worth reading today; one policy change."),
  more: { type: "Tabs", props: { id: "more", label: "Categories" }, children: ["news", "papers", "code", "policy", "data", "talks"] },
  news: page_("News", "stories"),
  stories: md("- An open model reaches 1.0, ahead on long-context tests.\n- A chip export rule takes effect next month.\n- A city opens its transit data."),
  papers: page_("Papers", "reading"),
  reading: { type: "Table", props: { id: "reading", title: "New papers", columns: [{ key: "paper", label: "Paper" }, { key: "why", label: "Why read it" }],
    rows: [
      { id: "p1", cells: { paper: "Sparse attention at 1M tokens", why: "Halves memory with the same accuracy" } },
      { id: "p2", cells: { paper: "Agents that test their own patches", why: "A benchmark with real repositories" } },
      { id: "p3", cells: { paper: "Retrieval that cites its pages", why: "Fewer unsupported answers" } },
      { id: "p4", cells: { paper: "Small models for tool calls", why: "Runs on a laptop" } },
      { id: "p5", cells: { paper: "Data mixtures by curriculum", why: "Same score with less data" } },
    ] } },
  code: page_("Open source", "repos"),
  repos: md("Two releases worth a look: a tokenizer at 2.0 and a vector index with disk storage."),
  policy: page_("Policy", "rule"),
  rule: md("A transit data rule takes effect on the 1st: stops and timetables must be published openly."),
  data: page_("Datasets", "sets"),
  sets: md("A labelled set of street signs in twelve languages."),
  talks: page_("Talks", "talk"),
  talk: md("A recorded talk on evaluating agents with real repositories."),
} };
const section = { id: 7, key: "digest", kind: "report", title: "Today's news and papers", version: 3, owner, body: digest, attachments: [], refs: {},
  seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN) };
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "daily-digest" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: [section], history: [] }, unseen: 1, missing: [] }] });
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 16000, usedMiB: 4000, availableMiB: 12000, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
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
  // A live report's page, drawn whole, says that version was opened (YN-86): answered for this report at its version only.
  if (request.method() === "POST" && path === "/api/projects/p1/brief/opened") {
    const sent = JSON.parse(request.postData() || "null");
    if (sent?.key === section.key && sent.version === section.version && sent.sectionId === section.id && sent.workspaceId === WS) {
      report.receipts.push(`${sent.key}@${sent.version}`);
      return route.fulfill({ json: { projectId: "p1", sectionId: section.id, key: section.key, version: section.version, at: new Date().toISOString(), recorded: true } });
    }
  }
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (["/api/agents/a/codex/usage", "/api/agents/a/codex/mcp", "/api/agents/a/conversation/inputs"].includes(path))
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
    "/api/waits/live": () => ({ agents: {} }),
    "/api/machine-live": () => ({ machines: [] }),
    // The project's page (YN-96): no front desk Agent and no requests, as project-talk-check answers them.
    "/api/projects/p1/front-desk": () => ({ version: 1, agentId: null, effectiveAgentId: null }),
    "/api/projects/p1/requests": () => ({ requests: [], hasMore: false }),
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
async function open(width, height, at) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce", hasTouch: width < 600, isMobile: width < 600 });
  page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${width}: pageerror: ${error.message}`));
  const answered404 = (message) => /\/api\/agents\/a\/(codex\/usage|codex\/mcp|conversation\/inputs)\b/.test(message.location()?.url ?? "");
  page.on("console", (message) => message.type() === "error" && !answered404(message) && report.errors.push(`${width}: console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}${at}`);
}
const reportAt = `/#/report?w=${WS}&p=p1&k=digest&v=3&s=7`;
async function openReport(width, height) {
  await open(width, height, reportAt);
  await page.locator(".home-report .brief-tablist").waitFor({ timeout: 15_000 });
  await sleep(200);
}
/** What the row of tabs and the pages show now, read from the page. */
const tabsNow = () => page.evaluate(() => {
  const list = document.querySelector(".home-report .brief-tablist");
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  };
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panels = [...document.querySelectorAll('.home-report [role="tabpanel"]')];
  const scroller = document.scrollingElement;
  return {
    label: list.getAttribute("aria-label"),
    tabs: tabs.map((tab) => ({ text: tab.textContent, selected: tab.getAttribute("aria-selected"), tabIndex: tab.tabIndex, box: box(tab) })),
    shown: panels.map((panel) => panel.checkVisibility()),
    titles: panels.map((panel) => { const h = panel.querySelector(":scope > .brief-group > h4"); return h ? h.checkVisibility() : null; }),
    focused: tabs.indexOf(document.activeElement),
    list: { ...box(list), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollLeft: Math.round(list.scrollLeft), overflowX: getComputedStyle(list).overflowX },
    pageSideways: scroller.scrollWidth > window.innerWidth + 1,
    viewport: window.innerWidth,
  };
});
const selected = (state) => state.tabs.findIndex((tab) => tab.selected === "true");

try {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await step(`${width}: the row of tabs over the first page; the others hidden, their titles left to the tabs`, async () => {
      await openReport(width, height);
      const state = await tabsNow();
      assert.equal(state.label, "Categories");
      assert.deepEqual(state.tabs.map((tab) => tab.text), ["News", "Papers", "Open source", "Policy", "Datasets", "Talks"]);
      assert.equal(selected(state), 0);
      assert.deepEqual(state.tabs.map((tab) => tab.tabIndex), [0, -1, -1, -1, -1, -1]);
      assert.deepEqual(state.shown, [true, false, false, false, false, false]);
      assert.equal(state.titles[0], false, "the page's title is on its tab, not again in the page");
      assert.equal(state.pageSideways, false, "the page itself never scrolls sideways");
      assert.equal(state.list.overflowX, "auto");
      if (width === 390) assert.ok(state.list.scrollWidth > state.list.clientWidth, `six tabs are wider than a phone: ${state.list.scrollWidth} > ${state.list.clientWidth}`);
      else assert.ok(state.list.scrollWidth <= state.list.clientWidth, "on a desktop they fit");
      await shot(`tabs-${width}.png`);
      return { list: state.list };
    });

    await step(`${width}: the keys move the focus and the page; End scrolls the last tab into view`, async () => {
      await openReport(width, height);
      await page.locator('.brief-tablist [role="tab"]').first().focus();
      const moves = [];
      for (const [key, at] of [["ArrowRight", 1], ["ArrowLeft", 0], ["ArrowLeft", 5], ["Home", 0], ["End", 5]]) {
        await page.keyboard.press(key);
        await sleep(60);
        const state = await tabsNow();
        assert.equal(selected(state), at, key);
        assert.equal(state.focused, at, `${key} moves the focus`);
        assert.deepEqual(state.shown, state.tabs.map((_, i) => i === at), `${key} shows its page`);
        moves.push([key, at, state.list.scrollLeft]);
      }
      const state = await tabsNow();
      const last = state.tabs[5].box;
      assert.ok(last.left >= state.list.left - 1 && last.right <= state.list.right + 1, `the focused tab is in view: ${JSON.stringify(last)} in ${JSON.stringify(state.list)}`);
      if (width === 390) assert.ok(state.list.scrollLeft > 0, "the row scrolled, not the page");
      assert.equal(state.pageSideways, false);
      await shot(`tabs-${width}-end.png`);
      // Tab leaves the row for the page shown.
      await page.keyboard.press("Tab");
      const into = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      assert.equal(into, "tabpanel");
      return { moves };
    });

    await step(`${width}: a click on a tab shows its page; Papers' table is there`, async () => {
      await openReport(width, height);
      await page.locator('.brief-tablist [role="tab"]', { hasText: "Papers" }).click();
      await sleep(80);
      const state = await tabsNow();
      assert.equal(selected(state), 1);
      assert.ok(await page.locator('.home-report [role="tabpanel"]:not([hidden])').getByText("Sparse attention at 1M tokens").isVisible());
      await shot(`tabs-${width}-papers.png`);
    });
  }

  await step("390: Home's card shows the summary only, no tabs", async () => {
    // Home, as a link names it; its project glance opens the project's page, where its cards are (YN-86).
    await open(390, 844, `/#/home?w=${WS}`);
    await page.locator('[data-glance-project="p1"] .project-glance-open').click();
    const project = page.locator('[data-project-home="p1"]');
    await project.waitFor({ timeout: 15_000 });
    const card = project.locator('.home-section[data-section-key="digest"]');
    await card.waitFor({ timeout: 15_000 });
    assert.ok(await card.getByText("worth reading today").isVisible());
    assert.equal(await card.locator('[role="tablist"], [role="tabpanel"]').count(), 0);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: resolve(output, "card-390.png") });
    report.shots.push("card-390.png");
  });

  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: report.unexpected.join("\n") });
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
