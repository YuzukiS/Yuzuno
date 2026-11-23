// R-25: the "Requests | Conversation" tabs of a Project's page in Chromium, on a
// production build with every API answered here by a stand-in Core (no Core, no
// GitHub, nobody's data). A long request list and a long conversation, on a
// desktop window and a phone: the tabs stay under Home's jumps wherever the page
// is scrolled, at the middle and at the end of either view; the bar's sticky rule
// turned off (the layout before the fix) leaves them above the scroller; a click
// where the tabs are switches the view; the keyboard reaches them, their focus
// ring is drawn, and Enter switches too; the jumps and the dock's composer stay
// usable; one tablist is rendered. Screenshots for review.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-tabs-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/r25/browser");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [], shown: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shot = async (target, name) => {
  const file = `${name}.png`;
  await target.screenshot({ path: resolve(output, file) });
  report.screenshots.push(file);
};
const HOST = "localhost:47391";
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const LONG = "A synthetic line of what was asked, for a long page, 0123456789.";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "",
  connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const body = (text) => ({ root: "body", elements: { body: node("BriefBody", {}, ["text"]), text: node("Markdown", { text }) } });
let nextId = 100;
const card = (n) => ({
  sectionId: null, key: `yn-${n}`, title: `Card ${n}`, live: true,
  task: { id: `YN-${n}`, status: "doing", archived: false }, responsible: null,
});
const section = (n) => ({ id: nextId++, key: `yn-${n}`, kind: "status", title: `Card ${n}`, version: 1, owner,
  updatedAt: ago(10 + n), updatedTurnId: "t1", body: body(`Card ${n} is at work.`), attachments: [], refs: {},
  seen: null, history: false, card: { task: { id: `YN-${n}`, title: `Card ${n}`, status: "doing", archived: false }, responsible: null } });
/** The requests, newest first as Core gives them: 24 of them, each with a card, so the page is long in either view. */
const requests = Array.from({ length: 24 }, (_, index) => {
  const n = 24 - index;
  return { id: `r${n}`, n, text: `${LONG} R-${n}. ${LONG}`, textBlocks: null, images: [], files: [], title: null,
    createdAt: ago(n * 5), frontAgentId: "a", messageId: `m${n}`, delivery: "accepted", replies: [], notes: [], routes: [],
    cards: [card(n)], state: "doing", progress: { cards: 1, ended: 0 }, lines: [] };
});
const sections = requests.map((request) => section(request.n));
const home = () => ({
  generatedAt: ago(0), order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    contentEditors: { version: 1, editorAgentIds: ["a"] }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 3, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const run of [{ name: "desktop-1280", viewport: { width: 1280, height: 720 }, phone: false },
    { name: "phone-390", viewport: { width: 390, height: 844 }, phone: true }]) await runCheck(run);
} finally {
  await browser.close();
  await writeFile(join(output, "project-tabs-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.writes, [], "nothing was written");
console.log(`project-tabs-check: ${report.checks.length} checks`);
async function runCheck(run) {
  const context = await browser.newContext({
    viewport: run.viewport, locale: "en-US", timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (method !== "GET" && path !== "/api/collaboration/github_repositories") {
      report.writes.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    if (path === "/api/workspace") {
      return route.fulfill({ json: { workspace: { id: "ws-tabs" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" } });
    }
    if (path === "/api/home") return route.fulfill({ json: home() });
    if (path === "/api/projects/p1/front-desk") return route.fulfill({ json: { version: 1, agentId: "a", effectiveAgentId: "a" } });
    if (path === "/api/projects/p1/requests") return route.fulfill({ json: { requests, hasMore: false } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-live": { machines: [] },
      "/api/machine-load": {
        at: ago(0),
        cpu: { cores: 8, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 32768, usedMiB: 8000, availableMiB: 24768, jobsMiB: 1024, agentsMiB: null },
        gpus: null, jobs: [],
      },
      "/api/collaboration/github_repositories": { repositories: [], links: [] },
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
  const pageBox = () => page.locator('[data-project-home="p1"]');
  /** Only one tablist, and the view under it. */
  const view = async () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-project-home="p1"] .project-view-tabs')];
    const selected = tabs[0] ? [...tabs[0].querySelectorAll('[role="tab"]')].filter((el) => el.getAttribute("aria-selected") === "true").map((el) => el.dataset.tab) : [];
    return { tabs: tabs.length, selected, view: document.querySelector('[data-project-home="p1"]')?.dataset.view ?? null,
      hidden: document.querySelector(".project-home-body")?.hidden ?? null };
  });
  /** The page as scrolled: where jumps, the tabs' bar and its buttons are in the scroller, and what is under each. */
  const place = () => page.evaluate(() => {
    const scroller = document.querySelector(".home-view");
    const panel = document.querySelector('[data-project-home="p1"]');
    const jumps = panel.querySelector(".home-jumps").getBoundingClientRect();
    // Before R-25 there was no bar of its own: the tabs themselves stood in the page (the base build this check runs on).
    const bar = panel.querySelector(".project-view-tabs-bar") ?? panel.querySelector(".project-view-tabs");
    const strip = panel.querySelector(".project-view-tabs");
    const barBox = bar.getBoundingClientRect(), stripBox = strip.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const buttons = [...strip.querySelectorAll('[role="tab"]')].map((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round((box.left + box.right) / 2), Math.round((box.top + box.bottom) / 2));
      return { tab: button.dataset.tab, x: Math.round((box.left + box.right) / 2), y: Math.round((box.top + box.bottom) / 2),
        top: Math.round(box.top), bottom: Math.round(box.bottom), hit: hit === button || (hit && button.contains(hit)) };
    });
    return {
      scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
      viewTop: Math.round(view.top), viewBottom: Math.round(view.bottom),
      jumps: { top: Math.round(jumps.top), bottom: Math.round(jumps.bottom) },
      bar: { top: Math.round(barBox.top), bottom: Math.round(barBox.bottom), position: getComputedStyle(bar).position },
      strip: { top: Math.round(stripBox.top), bottom: Math.round(stripBox.bottom), left: Math.round(stripBox.left), right: Math.round(stripBox.right) },
      buttons,
    };
  });
  const scrollTo = async (where) => {
    await page.evaluate((where) => {
      const scroller = document.querySelector(".home-view");
      scroller.scrollTop = where === "end" ? scroller.scrollHeight : Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
    }, where);
    await page.waitForTimeout(80);
  };
  /** The tabs are stuck under the jumps, wholly seen, and each button is what a click at its middle hits. At the
   * page's very top they are in their own place: there the base build (the page before R-25) meets this too. */
  const stuck = async (where) => {
    const at = await place();
    assert.ok(at.strip.top >= at.viewTop - 1 && at.strip.bottom <= at.viewBottom + 1, `${where}: the tabs are wholly in the scroller: ${JSON.stringify(at)}`);
    assert.ok(at.strip.top >= at.jumps.bottom - 1, `${where}: the tabs start at or below the jumps' bottom: ${JSON.stringify(at)}`);
    if (at.scrollTop > 0) assert.equal(at.bar.position, "sticky", `${where}: the tabs' bar is sticky: ${JSON.stringify(at)}`);
    assert.deepEqual(at.buttons.map((button) => button.hit), [true, true], `${where}: a click at each tab's middle lands on it: ${JSON.stringify(at)}`);
    return at;
  };
  const pressTabs = async (name) => {
    const at = await stuck(`before pressing ${name}`);
    const button = at.buttons.find((entry) => entry.tab === name);
    assert.ok(button, `${name} is drawn`);
    await page.mouse.click(button.x, button.y);
    await page.waitForFunction((name) => document.querySelector('[data-project-home="p1"]')?.dataset.view === name, name, { timeout: 10_000 });
  };
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-tabs&p=p1`);
    await pageBox().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".request-block").length === 24, null, { timeout: 15_000 });
    const opened = await view();
    assert.deepEqual(opened, { tabs: 1, selected: ["requests"], view: "requests", hidden: false }, "one tablist, Requests at first");
    const top = await stuck("at the page's top");
    assert.equal(top.scrollTop, 0);
    await shot(page, `${run.name}-requests-top`);
    // Requests, scrolled to its end: the tabs are still under the jumps (the fix), where before it they left with the page.
    await scrollTo("end");
    const requestsEnd = await stuck("requests, end");
    await shot(page, `${run.name}-requests-end`);
    // The bar's sticky rule turned off: the layout before the fix, with the page still scrolled as it is.
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.id = "r25-before";
      style.textContent = ".project-view-tabs-bar{position:static !important}";
      document.head.append(style);
    });
    const before = await place();
    assert.ok(before.strip.bottom < before.viewTop || before.strip.top < before.viewTop,
      `before the fix the tabs scroll out of the scroller: ${JSON.stringify(before)}`);
    report.shown.push({ run: run.name, where: "requests end, sticky off", ...before });
    await shot(page, `${run.name}-requests-before-fixed`);
    await page.evaluate(() => document.getElementById("r25-before")?.remove());
    // Requests at its middle too, then Conversation by a click where the tabs are.
    await scrollTo("middle");
    const requestsMiddle = await stuck("requests, middle");
    await shot(page, `${run.name}-requests-middle`);
    await pressTabs("chat");
    assert.deepEqual(await view(), { tabs: 1, selected: ["chat"], view: "chat", hidden: true }, "Conversation shown, one tablist");
    await page.waitForFunction(() => document.querySelector(".project-talk-thread li"), null, { timeout: 15_000 });
    await page.waitForTimeout(200);
    const chatEnd = await stuck("conversation, opened at its newest");
    assert.ok(chatEnd.scrollTop > 0, "the conversation opens at its newest, scrolled");
    // The dock's composer is under the scroller and usable while the conversation is scrolled.
    const composer = page.locator(".home-dock .project-talk-compose .cm-content");
    await composer.waitFor({ timeout: 10_000 });
    const dock = await page.evaluate(() => {
      const field = document.querySelector(".home-dock .project-talk-compose .cm-content");
      const box = field.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), seen: box.top >= 0 && box.bottom <= innerHeight + 1,
        editable: field.getAttribute("contenteditable") };
    });
    assert.ok(dock.seen && dock.editable === "true", `the composer is seen and writable at the conversation's end: ${JSON.stringify(dock)}`);
    await composer.click();
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest(".home-dock .project-talk-compose")),
      "a press on the composer takes the keyboard");
    await shot(page, `${run.name}-chat-end`);
    await scrollTo("middle");
    const chatMiddle = await stuck("conversation, middle");
    await shot(page, `${run.name}-chat-middle`);
    // The keyboard: from the last jump, Tab reaches the tabs; their focus ring is drawn and Enter switches the view.
    await page.evaluate(() => document.querySelector('.home-jumps [data-jump="report"]').focus({ preventScroll: true }));
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement, style = getComputedStyle(el);
      return { tab: el.dataset.tab, outline: style.outlineStyle, width: parseFloat(style.outlineWidth), tabIndex: el.tabIndex };
    });
    assert.equal(focus.tab, "requests", `Tab from the jumps reaches the Requests tab: ${JSON.stringify(focus)}`);
    assert.ok(focus.outline !== "none" && focus.width >= 1, `its focus ring is drawn: ${JSON.stringify(focus)}`);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tab), "chat", "Tab goes on to Conversation");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-project-home="p1"]')?.dataset.view === "requests", null, { timeout: 10_000 });
    assert.deepEqual(await view(), { tabs: 1, selected: ["requests"], view: "requests", hidden: false }, "Enter on Requests shows them");
    await stuck("requests, back from the keyboard");
    // The top's navigation stays above the tabs, and nothing is wider than the window.
    const widths = await page.evaluate(() => {
      const scroller = document.querySelector(".home-view");
      return { page: document.scrollingElement.scrollWidth, window: innerWidth, view: scroller.scrollWidth, box: scroller.clientWidth };
    });
    assert.ok(widths.page <= widths.window + 1 && widths.view <= widths.box + 1, JSON.stringify(widths));
    await shot(page, `${run.name}-requests-keyboard`);
    check(`${run.name}: the tabs stay under the jumps at the top, middle and end of both views, a click and Enter switch, the composer and the jumps stay usable, one tablist`,
      { top, before, requestsMiddle, requestsEnd, chatEnd, chatMiddle, dock, focus, widths });
  } finally {
    await context.close();
  }
}
