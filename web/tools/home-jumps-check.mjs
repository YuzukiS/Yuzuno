// YN-86: Home's own jumps and a report's opened receipt, in Chromium, on a
// production build with every API answered here by a stand-in Core that
// keeps the receipts it is sent (no Core, no GitHub, nobody's data). A long
// Home on a wide window and a phone: the bar stays at the top of Home's own
// scroller wherever it is scrolled, each jump lands its target clear of the
// bar (a folded project opened at once), nothing scrolls sideways, and a
// report over Home hides it. A report opened, closed and read again, by this
// client and a second one, is no longer New and stays on Home. Screenshots
// for review.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-jumps-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/yn86/browser");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shot = async (target, name) => {
  await target.screenshot({ path: resolve(output, name) });
  report.screenshots.push(name);
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const names = { p1: "atlas-notes", p2: "orbit-lab", p3: "tidepool" };
const projects = Object.entries(names).map(([id, name]) => ({ id, name, defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }));
const owner = { agentId: "a", name: "Mori", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const body = (text) => ({ root: "body", elements: {
  body: node("BriefBody", { summary: { lead: "lead" } }, ["lead", "notes"]),
  lead: node("Markdown", { text }),
  notes: node("Markdown", { text: Array.from({ length: 6 }, (_, i) => `Synthetic note ${i + 1}: a sample of 40 runs.`).join("\n\n") }),
} });
let nextId = 1;
const reportSection = (key, title, minutes, extra = {}) => ({ id: nextId++, key, kind: "report", title, version: 1, owner, updatedAt: ago(minutes),
  updatedTurnId: "t1", body: body(`${title}: the synthetic result holds on the sample.`), attachments: [], refs: {}, seen: null, history: false, ...extra });
const ask_ = (key, title) => ({ ...reportSection(key, title, 30), kind: "ask", body: { root: "b", elements: { b: node("BriefBody", {}, []) } },
  ask: { question: `${title}?`, reply: { options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], freeText: true }, state: "open" } });

/** A long Home: two Asks at the top, many reports, and the newest report in the last project. */
function longHome() {
  nextId = 1;
  const sections = {
    p1: [ask_("decide-layout", "Which layout"), ask_("decide-rows", "How many rows"),
      ...Array.from({ length: 8 }, (_, i) => reportSection(`eval-${i}`, `Evaluation ${i + 1}`, 120 + i))],
    p2: Array.from({ length: 8 }, (_, i) => reportSection(`sweep-${i}`, `Sweep ${i + 1}`, 200 + i)),
    p3: [reportSection("fresh", "Fresh comparison", 2), ...Array.from({ length: 4 }, (_, i) => reportSection(`older-${i}`, `Older note ${i + 1}`, 400 + i))],
  };
  const needsYou = sections.p1.filter((s) => s.kind === "ask").map((s) => ({ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori",
    sectionKey: s.key, title: s.title, since: ago(30) }));
  return { sections, needsYou, opened: {} };
}
/** Nothing to jump to: one status, no Ask, every widget hidden. */
function emptyHome() {
  nextId = 1;
  return { sections: { p1: [{ ...reportSection("load", "Load", 5), kind: "status", status: { asOf: ago(5), validFor: 86400, stale: false } }] },
    needsYou: [], opened: {} };
}
/** Core's Home read of `state`, with each live section's receipt as Core keeps it. */
function homeRead(state) {
  const ids = Object.keys(state.sections);
  return {
    generatedAt: ago(0), order: ids, needsYou: state.needsYou,
    projects: ids.map((id) => {
      const sections = state.sections[id].map((s) => ({ ...s, opened: state.opened[s.id] ?? null }));
      return { project: { id, name: names[id] }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
        errors: [], pending: [], jobs: [], missing: [], brief: { version: 4, history: [], sections },
        unseen: sections.filter((s) => Math.max(s.seen?.version ?? 0, s.opened?.version ?? 0) < s.version).length };
    }),
  };
}
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open(state, viewport, { label, widgetsHidden = false } = {}) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch,
    isMobile: viewport.touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((hidden) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (hidden) localStorage.setItem("yuzuno.homeWidgets.ws-jumps", JSON.stringify({ order: ["machines"], hidden: ["machines"], pins: [] }));
  }, widgetsHidden);
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    assert.equal(url.hostname, "yuzuno-home-jumps.test");
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    const receipt = path.match(/^\/api\/projects\/(p\d)\/brief\/opened$/);
    if (method === "POST" && receipt) {
      const sent = request.postDataJSON();
      report.writes.push({ label, method, path, body: sent });
      const live = state.sections[receipt[1]]?.find((s) => s.id === sent.sectionId && s.key === sent.key && s.version === sent.version);
      if (sent.workspaceId !== "ws-jumps" || !live) return route.fulfill({ status: 400, json: { error: "version_changed: not live. Nothing was recorded." } });
      const recorded = (state.opened[live.id]?.version ?? 0) < live.version;
      if (recorded) state.opened[live.id] = { version: live.version, at: ago(0) };
      return route.fulfill({ json: { projectId: receipt[1], sectionId: live.id, key: live.key, version: live.version, at: state.opened[live.id].at, recorded } });
    }
    if (method !== "GET") {
      report.writes.push({ label, method, path });
      return route.fulfill({ json: {} });
    }
    if (path === "/api/agents/a/codex/mcp") return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-jumps" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }, "/api/agents/a/reading": { handoff: null },
      "/api/home": path === "/api/home" ? homeRead(state) : null, "/api/machine-load": machineLoad,
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" }[extname(file)] });
  });
  const toHome = async () => {
    await page.goto("http://yuzuno-home-jumps.test/");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator(".home-view .home-jumps").waitFor();
    await page.locator(".home-view .home-panel").first().waitFor();
  };
  await toHome();
  return { context, page, toHome };
}
const card = (page, key) => page.locator(`.home-view .home-panel [data-section-key="${key}"]`);
const jump = (page, kind) => page.locator(`.home-view .home-jumps [data-jump="${kind}"]`);
const focusedKey = (page) => page.evaluate(() => document.activeElement?.dataset?.sectionKey ?? document.activeElement?.id ?? null);
/** Where the bar is, and whether it is at the top of Home's scroller and inside the window. */
const barPlace = (page) => page.evaluate(() => {
  const view = document.querySelector(".home-view"), bar = view.querySelector(".home-jumps");
  const v = view.getBoundingClientRect(), b = bar.getBoundingClientRect();
  return { atTop: Math.abs(b.top - v.top) <= 1, inWindow: b.top >= 0 && b.bottom <= innerHeight, bottom: b.bottom, scrollTop: view.scrollTop,
    scrolled: view.scrollTop > 0, max: view.scrollHeight - view.clientHeight };
});
/** Whether `selector`'s box is wholly below the bar and inside Home's scroller. */
const clearOfBar = (page, selector) => page.evaluate((selector) => {
  const view = document.querySelector(".home-view"), bar = view.querySelector(".home-jumps"), target = document.querySelector(selector);
  const v = view.getBoundingClientRect(), b = bar.getBoundingClientRect(), t = target.getBoundingClientRect();
  return { below: t.top >= b.bottom - 1, inView: t.top < v.bottom, top: t.top, barBottom: b.bottom };
}, selector);
const sideways = (page) => page.evaluate(() => {
  const view = document.querySelector(".home-view");
  return Math.max(document.documentElement.scrollWidth - innerWidth, view.scrollWidth - view.clientWidth);
});
const toBottom = (page) => page.evaluate(() => {
  const view = document.querySelector(".home-view");
  view.scrollTop = view.scrollHeight;
});

try {
  for (const viewport of [{ name: "wide", width: 1440, height: 900, touch: false }, { name: "phone", width: 390, height: 844, touch: true }]) {
    const state = longHome();
    const { context, page } = await open(state, viewport, { label: viewport.name });
    const v = viewport.name;
    assert.deepEqual(await page.locator(".home-view .home-jumps button").allTextContents(), ["Asks2", "Latest report", "My widgets1"]);
    assert.equal(await page.locator(".toolbar .home-jumps, header.toolbar .home-jumps").count(), 0, "not in the app's toolbar");
    await shot(page, `${v}-top.png`);
    // The last project folded by hand; then from the very bottom of Home.
    await page.locator("#home-project-p3 .home-panel-toggle").click();
    await page.locator("#home-project-p3.is-collapsed").waitFor();
    await toBottom(page);
    const bottom = await barPlace(page);
    assert.ok(bottom.scrolled && bottom.atTop && bottom.inWindow, `${v}: the bar at the bottom of a long Home ${JSON.stringify(bottom)}`);
    assert.equal(await jump(page, "asks").isVisible() && await jump(page, "report").isVisible() && await jump(page, "widgets").isVisible(), true);
    await shot(page, `${v}-bottom-bar.png`);
    check(`${v}: the three jumps stay at the top of Home's scroller at the bottom of a long page (scrolled ${bottom.scrollTop} of ${bottom.max} px)`);
    assert.ok(await sideways(page) <= 0, `${v}: no sideways scroll`);
    check(`${v}: nothing scrolls sideways (${viewport.width} px)`);
    // The newest report, in the folded project: opened, scrolled to clear of the bar, focused, in one press.
    await jump(page, "report").click();
    await page.waitForFunction(() => document.activeElement?.dataset?.sectionKey === "fresh");
    assert.equal(await page.locator("#home-project-p3.is-collapsed").count(), 0, `${v}: its project opened`);
    const fresh = await clearOfBar(page, '.home-panel [data-section-key="fresh"]');
    assert.ok(fresh.below && fresh.inView, `${v}: the report clear of the bar ${JSON.stringify(fresh)}`);
    await shot(page, `${v}-latest-report.png`);
    check(`${v}: Latest report reaches the newest report in a folded project in one press, below the bar, focused`);
    // The Asks, from the bottom again: each press the next, each clear of the bar.
    for (const key of ["decide-layout", "decide-rows"]) {
      await toBottom(page);
      await jump(page, "asks").click();
      await page.waitForFunction((key) => document.activeElement?.dataset?.sectionKey === key, key);
      const place = await clearOfBar(page, `.home-panel [data-section-key="${key}"]`);
      assert.ok(place.below && place.inView, `${v}: ${key} clear of the bar ${JSON.stringify(place)}`);
    }
    check(`${v}: Asks goes to each open Ask in turn, below the bar, focused`);
    await toBottom(page);
    await jump(page, "widgets").click();
    await page.waitForFunction(() => document.activeElement?.id === "home-widgets");
    const widgets = await clearOfBar(page, "#home-widgets");
    assert.ok(widgets.below && widgets.inView, `${v}: My widgets clear of the bar ${JSON.stringify(widgets)}`);
    check(`${v}: My widgets is reached and focused below the bar`);
    // Under a report, Home and its bar are hidden and out of reach.
    await card(page, "fresh").locator(".home-report-open").click();
    await page.locator(".home-report .report-head h1").waitFor();
    assert.equal(await page.locator(".home-view .home-jumps").isVisible(), false, `${v}: the bar is hidden under the report`);
    const covered = await page.evaluate(() => {
      const bar = document.querySelector(".home-jumps").getBoundingClientRect();
      const hit = document.elementFromPoint(bar.left + 10, bar.top + bar.height / 2);
      return { inReport: !!hit?.closest(".home-report"), inert: document.querySelector(".home-view").inert };
    });
    assert.ok(covered.inReport && covered.inert, `${v}: ${JSON.stringify(covered)}`);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".home-jumps")), false, `${v}: Tab never reaches the bar`);
    await shot(page, `${v}-report-over-home.png`);
    check(`${v}: a report over Home hides the bar; nothing of it is reached`);
    await page.locator(".home-report .report-back").click();
    await page.locator(".home-report").waitFor({ state: "hidden" });
    await context.close();
  }

  // Nothing to go to: each jump says why and goes nowhere.
  {
    const state = emptyHome();
    const { context, page } = await open(state, { width: 390, height: 844, touch: true }, { label: "empty", widgetsHidden: true });
    for (const [kind, why] of [["asks", "No Ask is waiting for you"], ["report", "No report on Home yet."], ["widgets", "No widgets on show."]]) {
      assert.equal(await jump(page, kind).getAttribute("aria-disabled"), "true", kind);
      assert.ok((await jump(page, kind).getAttribute("aria-description")).startsWith(why), kind);
      const before = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
      // Playwright waits for an aria-disabled control to be enabled: the press is forced, as a user's would land.
      await jump(page, kind).click({ force: true });
      assert.equal(await page.evaluate(() => document.querySelector(".home-view").scrollTop), before, `${kind} goes nowhere`);
    }
    await shot(page, "phone-empty-bar.png");
    assert.ok(await sideways(page) <= 0);
    check("phone: with no open Ask, no report and every widget hidden, each jump says why and does nothing");
    await context.close();
  }

  // Opened, closed and read again, here and by a second client: no longer New, still on Home, never marked seen.
  {
    const state = longHome();
    const wide = { width: 1440, height: 900, touch: false };
    const first = await open(state, wide, { label: "first" });
    const second = await open(state, wide, { label: "second" });
    const isNew = async (page, key) => (await card(page, key).locator(".home-changed").count()) > 0;
    assert.equal(await isNew(first.page, "eval-0"), true);
    assert.equal(await isNew(second.page, "eval-0"), true);
    await card(first.page, "eval-0").locator(".home-report-open").click();
    await first.page.locator(".home-report .report-head h1").waitFor();
    await first.page.waitForFunction(() => !document.querySelector(".home-report .report-head .home-changed"));
    const receipts = report.writes.filter((w) => w.label === "first" && w.path === "/api/projects/p1/brief/opened");
    assert.equal(receipts.length, 1);
    assert.deepEqual(receipts[0].body, { workspaceId: "ws-jumps", sectionId: state.sections.p1[2].id, key: "eval-0", version: 1 });
    await first.page.locator(".home-report .report-back").click();
    await first.page.locator(".home-report").waitFor({ state: "hidden" });
    assert.equal(await isNew(first.page, "eval-0"), false, "back on Home, no longer New");
    assert.equal(await card(first.page, "eval-0").locator(".home-seen").count(), 1, "Seen still offered: the card stays");
    await shot(card(first.page, "eval-0"), "wide-opened-card.png");
    await first.toHome();
    assert.equal(await isNew(first.page, "eval-0"), false, "after a reload too");
    assert.equal(await card(first.page, "eval-0").count(), 1);
    // The second client, open all along: its next read has it, the card still where it was.
    await second.page.locator(".home-refresh").click();
    await second.page.waitForFunction(() => !document.querySelector('.home-panel [data-section-key="eval-0"] .home-changed'));
    assert.equal(await card(second.page, "eval-0").count(), 1);
    assert.equal(await isNew(second.page, "eval-1"), true, "another report stays New");
    assert.deepEqual(report.writes.filter((w) => w.label === "first" || w.label === "second").map((w) => w.path), ["/api/projects/p1/brief/opened"],
      "one receipt; nothing marked seen");
    check("open → back → reload and a second client: the report is no longer New, stays on Home, with one receipt and no Seen");
    await first.context.close();
    await second.context.close();
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
}
assert.deepEqual(report.errors, []);
assert.deepEqual(report.unexpected, []);
console.log(`${report.checks.length} checks passed`);
