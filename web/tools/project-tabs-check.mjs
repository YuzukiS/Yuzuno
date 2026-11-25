// R-25, R-36: a Project's page has one bar at the top, its jumps (Asks, Latest report) and its "Requests |
// Conversation" switch in one row, stuck at the top of Home's scroller. In Chromium, on a production build with every
// API answered here by a stand-in Core (no Core, no GitHub, nobody's data): a long request list and a long
// conversation, in English and Chinese, on a desktop window and phones 390 and 320 CSS pixels wide. The four controls
// share one row, one height and one centre line, overlap nothing and run past no edge, at the top, middle and end of
// either view; only the views show a selected state; on a phone Latest report is its icon with its name kept for
// assistive technology; a click where each control is lands on it; Asks and Latest report land their card clear of
// the bar, from either view; the keyboard reaches the views, their focus ring is drawn and Enter switches; the dock's
// composer stays usable; one tablist is rendered. Long counts at 320 and the largest text size keep the row too.
// Screenshots for review.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-tabs-check.mjs
// YUZUNO_SHOTS_ONLY=1 takes only each run's first screenshots and asserts nothing (a build from before R-36).
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/r36/browser");
const shotsOnly = process.env.YUZUNO_SHOTS_ONLY === "1";
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [], unexpected: [], rows: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const shot = async (target, name, options = {}) => {
  const file = `${name}.png`;
  await target.screenshot({ path: resolve(output, file), ...options });
  report.screenshots.push(file);
};
const HOST = "localhost:47391";
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const LONG = "A synthetic line of what was asked, for a long page, 0123456789.";
const words = {
  en: { requests: "Requests", chat: "Conversation", report: "Latest report", asks: (n) => `Asks waiting for you: ${n}` },
  zh: { requests: "请求", chat: "对话", report: "最新报告", asks: (n) => `等你回复的提问：${n} 个` },
};

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "",
  connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const body = (text) => ({ root: "body", elements: { body: node("BriefBody", {}, ["text"]), text: node("Markdown", { text }) } });
/** A page of `total` requests, newest first as Core gives them, each with a card. R-2's card is the project's one
 * report, so Latest report goes far down the list; R-3's task has the one open Ask (or `asks` of them, for long
 * counts), so Asks goes to Needs you at the page's top. */
function fixture(total, asks) {
  let nextId = 100;
  const card = (n) => ({ sectionId: null, key: `yn-${n}`, title: `Card ${n}`, live: true,
    task: { id: `YN-${n}`, status: "doing", archived: false }, responsible: null });
  const bound = (n) => ({ task: { id: `YN-${n}`, title: `Card ${n}`, status: "doing", archived: false }, responsible: null });
  const section = (n) => ({ id: nextId++, key: `yn-${n}`, kind: n === 2 ? "report" : "status", title: `Card ${n}`, version: 1, owner,
    updatedAt: ago(10 + n), updatedTurnId: "t1", body: body(`Card ${n} is at work.`), attachments: [], refs: {},
    seen: null, history: false, card: bound(n) });
  const ask = (i) => ({ id: nextId++, key: `yn-3/ask${i ? `-${i}` : ""}`, kind: "ask", title: `Choose the layout ${i}`, version: 1, owner,
    updatedAt: ago(9), updatedTurnId: "t1", body: body("Which layout?"), attachments: [], refs: {}, seen: null, history: false,
    ask: { question: `Choose the layout ${i}?`, state: "open", reply: { options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], freeText: true } },
    card: bound(3) });
  const requests = Array.from({ length: total }, (_, index) => {
    const n = total - index;
    return { id: `r${n}`, n, text: `${LONG} R-${n}. ${LONG}`, textBlocks: null, images: [], files: [], title: null,
      createdAt: ago(n * 5), frontAgentId: "a", messageId: `m${n}`, delivery: "accepted", replies: [], notes: [], routes: [],
      cards: [card(n)], state: "doing", progress: { cards: 1, ended: 0 }, lines: [] };
  });
  const askSections = Array.from({ length: asks }, (_, i) => ask(i));
  const sections = [...requests.map((request) => section(request.n)), ...askSections];
  const needsYou = askSections.map((s) => ({ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: s.key, title: s.title, since: ago(9) }));
  const home = () => ({
    generatedAt: ago(0), order: ["p1"], needsYou,
    projects: [{ project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      contentEditors: { version: 1, editorAgentIds: ["a"] }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: { version: 3, history: [], sections } }],
  });
  return { requests, home, askKey: askSections[0]?.key, total };
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const desktop = { width: 1280, height: 720 }, phone390 = { width: 390, height: 844 }, phone320 = { width: 320, height: 640 };
const runs = [
  { name: "desktop-1280-en", viewport: desktop, language: "en", theme: "light" },
  { name: "desktop-1280-zh", viewport: desktop, language: "zh", theme: "dark" },
  { name: "phone-390-en", viewport: phone390, phone: true, language: "en", theme: "dark" },
  { name: "phone-390-zh", viewport: phone390, phone: true, language: "zh", theme: "dark" },
  { name: "phone-320-en", viewport: phone320, phone: true, language: "en", theme: "dark" },
  { name: "phone-320-zh", viewport: phone320, phone: true, language: "zh", theme: "dark" },
  // Long counts on the narrowest phone, and the largest text size: the row holds, a view's name may give way.
  { name: "phone-320-en-long-counts", viewport: phone320, phone: true, language: "en", theme: "dark", total: 120, asks: 120, short: true, mayEllipsize: true },
  { name: "phone-390-en-text-24", viewport: phone390, phone: true, language: "en", theme: "dark", fontSize: 24, short: true, mayEllipsize: true },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const run of runs) await runCheck(run);
} finally {
  await browser.close();
  await writeFile(join(output, "project-tabs-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.writes, [], "nothing was written");
console.log(`project-tabs-check: ${report.checks.length} checks${shotsOnly ? " (screenshots only)" : ""}`);

async function runCheck(run) {
  const data = fixture(run.total ?? 24, run.asks ?? 1);
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "zh" ? "zh-CN" : "en-US", timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(({ language, theme, fontSize }) => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ palette: "yuzu", theme, fontSize }));
  }, { language: run.language, theme: run.theme, fontSize: run.fontSize ?? 16 });
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
    if (path === "/api/home") return route.fulfill({ json: data.home() });
    if (path === "/api/projects/p1/front-desk") return route.fulfill({ json: { version: 1, agentId: "a", effectiveAgentId: "a" } });
    if (path === "/api/projects/p1/requests") return route.fulfill({ json: { requests: data.requests, hasMore: false } });
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
  const panel = page.locator('[data-project-home="p1"]');
  /** The bar and what is around it, as close-up for review: the jumps and, on a build from before R-36, the tabs' own bar. */
  const barShot = async (name) => {
    const clip = await page.evaluate(() => {
      const home = document.querySelector('[data-project-home="p1"]');
      const boxes = [home.querySelector(".home-jumps"), home.querySelector(".project-view-tabs-bar") ?? home.querySelector(".project-view-tabs")]
        .filter(Boolean).map((el) => el.getBoundingClientRect());
      const top = Math.min(...boxes.map((b) => b.top)), bottom = Math.max(...boxes.map((b) => b.bottom));
      return { x: 0, y: Math.max(0, top - 12), width: innerWidth, height: Math.min(innerHeight, bottom + 12) - Math.max(0, top - 12) };
    });
    await shot(page, name, { clip });
  };
  /** One tablist, which tab is selected and the view under it. */
  const view = async () => page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-project-home="p1"] .project-view-tabs')];
    const selected = tabs[0] ? [...tabs[0].querySelectorAll('[role="tab"]')].filter((el) => el.getAttribute("aria-selected") === "true").map((el) => el.dataset.tab) : [];
    return { tabs: tabs.length, selected, view: document.querySelector('[data-project-home="p1"]')?.dataset.view ?? null,
      hidden: document.querySelector(".project-home-body")?.hidden ?? null };
  });
  /** The bar as drawn now: its box, each of the four controls and their words, what a click at each one's middle hits. */
  const place = () => page.evaluate(() => {
    const scroller = document.querySelector(".home-view");
    const home = document.querySelector('[data-project-home="p1"]');
    const bar = home.querySelector(".home-jumps");
    const tabs = home.querySelector(".project-view-tabs");
    const round = (box) => ({ left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom),
      height: Math.round(box.height * 10) / 10, centre: Math.round(((box.top + box.bottom) / 2) * 10) / 10 });
    const seen = (el) => {
      if (!el) return null;
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return box.width > 2 && box.height > 2 && style.visibility !== "hidden" && style.clipPath === "none";
    };
    const control = (el, kind) => {
      const box = el.getBoundingClientRect();
      const x = Math.round((box.left + box.right) / 2), y = Math.round((box.top + box.bottom) / 2);
      const hit = document.elementFromPoint(x, y);
      const label = el.querySelector(".home-jump-label, .project-view-label");
      const count = el.querySelector(".home-jump-count, .project-view-count");
      return { kind, x, y, ...round(box), hit: hit === el || (!!hit && el.contains(hit)),
        label: label ? { text: label.textContent, seen: seen(label), cut: label.scrollWidth > label.clientWidth + 1,
          centre: seen(label) ? round(label.getBoundingClientRect()).centre : null } : null,
        count: count ? { text: count.textContent, seen: seen(count), centre: round(count.getBoundingClientRect()).centre } : null,
        selected: el.getAttribute("aria-selected"), pressed: el.getAttribute("aria-pressed"),
        background: getComputedStyle(el).backgroundColor, weight: getComputedStyle(el).fontWeight };
    };
    const jumps = [...bar.querySelectorAll(".home-jump")].map((el) => control(el, el.dataset.jump));
    const views = tabs ? [...tabs.querySelectorAll('[role="tab"]')].map((el) => control(el, el.dataset.tab)) : [];
    const view = scroller.getBoundingClientRect();
    return {
      scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
      view: { top: Math.round(view.top), bottom: Math.round(view.bottom), left: Math.round(view.left + scroller.clientLeft), right: Math.round(view.left + scroller.clientLeft + scroller.clientWidth) },
      bar: { ...round(bar.getBoundingClientRect()), position: getComputedStyle(bar).position, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
        holdsTabs: !!tabs && bar.contains(tabs), oldBar: !!home.querySelector(".project-view-tabs-bar") },
      tabs: tabs ? round(tabs.getBoundingClientRect()) : null,
      jumps, views,
      padding: getComputedStyle(scroller).scrollPaddingTop,
      widths: { page: document.scrollingElement.scrollWidth, window: innerWidth, view: scroller.scrollWidth, box: scroller.clientWidth },
    };
  });
  /** The four in one row of the stuck bar: same top, height and centre line, side by side without overlap, inside the
   * scroller's width, each what a click at its middle hits; nothing scrolls sideways. */
  const oneRow = async (where) => {
    const at = await place();
    const fail = (what) => `${run.name}, ${where}: ${what}: ${JSON.stringify(at)}`;
    assert.ok(at.bar.holdsTabs && !at.bar.oldBar, fail("the views are in the jumps' bar, and there is no second bar"));
    const all = [...at.jumps, ...at.views];
    assert.deepEqual(all.map((c) => c.kind), ["asks", "report", "requests", "chat"], fail("the four, in order"));
    const items = [at.jumps[0], at.jumps[1], at.tabs];
    for (const item of items) {
      assert.ok(Math.abs(item.top - items[0].top) <= 1 && Math.abs(item.height - items[0].height) <= 1, fail("one top and one height"));
      assert.ok(Math.abs(item.centre - items[0].centre) <= 1, fail("one centre line"));
    }
    const sorted = [...all].sort((a, b) => a.left - b.left);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].left >= sorted[i - 1].right - 0.5, fail(`${sorted[i - 1].kind} and ${sorted[i].kind} do not overlap`));
    for (const c of all) {
      assert.ok(c.left >= at.view.left - 1 && c.right <= at.view.right + 1, fail(`${c.kind} is wholly inside the scroller's width`));
      assert.ok(c.top >= at.view.top - 1 && c.bottom <= at.view.bottom + 1, fail(`${c.kind} is wholly in the scroller`));
      assert.ok(c.hit, fail(`a click at ${c.kind}'s middle lands on it`));
      assert.ok(c.count === null || c.count.seen, fail(`${c.kind}'s count is seen`));
    }
    // Words drawn on one centre line: every label or count seen shares the bar's.
    for (const c of all) {
      const centre = c.label?.seen ? c.label.centre : c.count?.centre;
      if (centre !== null && centre !== undefined) assert.ok(Math.abs(centre - items[0].centre) <= 1.5, fail(`${c.kind}'s words on the bar's centre line`));
    }
    for (const c of at.views) {
      assert.ok(c.label.seen, fail(`${c.kind}'s name is drawn`));
      if (!run.mayEllipsize) assert.ok(!c.label.cut, fail(`${c.kind}'s name is whole`));
    }
    // Only the views show a selected state.
    for (const c of at.jumps) assert.ok(c.selected === null && c.pressed === null, fail(`${c.kind} has no selected state`));
    const [selected, other] = [at.views.find((c) => c.selected === "true"), at.views.find((c) => c.selected === "false")];
    assert.ok(selected && other && selected.background !== other.background, fail("the selected view is drawn apart"));
    assert.ok(at.bar.scrollWidth <= at.bar.clientWidth + 1, fail("nothing runs past the bar"));
    assert.ok(at.widths.page <= at.widths.window + 1 && at.widths.view <= at.widths.box + 1, fail("nothing scrolls sideways"));
    if (at.scrollTop > 0) {
      assert.equal(at.bar.position, "sticky", fail("the bar is sticky"));
      assert.ok(Math.abs(at.bar.top - at.view.top) <= 1, fail("the bar is at the scroller's top"));
    }
    report.rows.push({ run: run.name, where, ...at });
    return at;
  };
  /** Each control by the name assistive technology reads, whatever is drawn: one each. */
  const names = async (asks) => {
    const counts = {
      asks: await page.getByRole("button", { name: w.asks(asks), exact: true }).count(),
      report: await page.getByRole("button", { name: w.report, exact: true }).count(),
      requests: await page.getByRole("tab", { name: `${w.requests} ${data.total}`, exact: true }).count(),
      chat: await page.getByRole("tab", { name: w.chat, exact: true }).count(),
    };
    assert.deepEqual(counts, { asks: 1, report: 1, requests: 1, chat: 1 }, `${run.name}: each control by its name: ${JSON.stringify(counts)}`);
    return counts;
  };
  const scrollTo = async (where) => {
    await page.evaluate((where) => {
      const scroller = document.querySelector(".home-view");
      scroller.scrollTop = where === "end" ? scroller.scrollHeight : where === "top" ? 0 : Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
    }, where);
    await page.waitForTimeout(80);
  };
  const pressControl = async (kind) => {
    const at = await oneRow(`before pressing ${kind}`);
    const c = [...at.jumps, ...at.views].find((entry) => entry.kind === kind);
    await page.mouse.click(c.x, c.y);
  };
  const waitView = (name) => page.waitForFunction((name) => document.querySelector('[data-project-home="p1"]')?.dataset.view === name, name, { timeout: 10_000 });
  /** Once a smooth scroll has ended: the scroller's position unchanged for ten frames (at most 5 s). */
  const settled = () => page.evaluate(() => new Promise((done) => {
    const scroller = document.querySelector(".home-view");
    const started = performance.now();
    let last = -1, same = 0;
    const tick = () => {
      same = scroller.scrollTop === last ? same + 1 : 0;
      last = scroller.scrollTop;
      if (same >= 10 || performance.now() - started > 5000) return done(last);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  /** A jump's card: focused, in the requests, its top clear of the bar's bottom and wholly in the scroller or filling it. */
  const landed = async (id, what) => {
    await page.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 10_000 });
    await settled();
    const at = await page.evaluate((id) => {
      const el = document.getElementById(id), box = el.getBoundingClientRect();
      const bar = document.querySelector('[data-project-home="p1"] .home-jumps').getBoundingClientRect();
      const view = document.querySelector(".home-view").getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), barBottom: Math.round(bar.bottom), viewBottom: Math.round(view.bottom),
        focused: document.activeElement === el, view: document.querySelector('[data-project-home="p1"]').dataset.view };
    }, id);
    assert.ok(at.focused && at.view === "requests", `${run.name}: ${what} lands in the requests: ${JSON.stringify(at)}`);
    assert.ok(at.top >= at.barBottom - 1, `${run.name}: ${what}'s card starts below the bar: ${JSON.stringify(at)}`);
    assert.ok(at.top < at.viewBottom, `${run.name}: ${what}'s card is in view: ${JSON.stringify(at)}`);
    return at;
  };
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-tabs&p=p1`);
    await panel.waitFor({ timeout: 15_000 });
    await page.waitForFunction((total) => document.querySelectorAll(".request-block").length === total, data.total, { timeout: 20_000 });
    await page.waitForTimeout(200);
    if (shotsOnly) {
      await shot(page, `${run.name}-requests-top`);
      await barShot(`${run.name}-bar`);
      check(`${run.name}: screenshots only`);
      return;
    }
    assert.deepEqual(await view(), { tabs: 1, selected: ["requests"], view: "requests", hidden: false }, "one tablist, Requests at first");
    const top = await oneRow("at the page's top");
    assert.equal(top.scrollTop, 0);
    const named = await names(run.asks ?? 1);
    // Wide: every word drawn. On a phone Latest report is its icon (its name read, and in its tip); at 320, Asks too.
    const labelSeen = Object.fromEntries(top.jumps.map((c) => [c.kind, c.label.seen]));
    if (!run.phone) assert.deepEqual(labelSeen, { asks: true, report: true }, `${run.name}: the jumps' names drawn`);
    else assert.equal(labelSeen.report, false, `${run.name}: Latest report is its icon on a phone`);
    await shot(page, `${run.name}-requests-top`);
    await barShot(`${run.name}-bar`);
    if (run.short) {
      await scrollTo("end");
      await oneRow("requests, end");
      await shot(page, `${run.name}-requests-end`);
      check(`${run.name}: one row at the top and end, nothing overlaps or runs past the edge`, { top, named, labelSeen });
      return;
    }
    // Scrolled: the bar stays at the scroller's top with all four in it.
    await scrollTo("middle");
    const requestsMiddle = await oneRow("requests, middle");
    await scrollTo("end");
    const requestsEnd = await oneRow("requests, end");
    await shot(page, `${run.name}-requests-end`);
    // Asks from the end of the list: its Ask, at the page's top, lands clear of the bar.
    await pressControl("asks");
    const asksLanded = await landed(`home-section-p1-${data.askKey}`, "Asks");
    await oneRow("after Asks");
    await shot(page, `${run.name}-asks-landed`);
    // Conversation by a click where it is; the conversation opens at its newest, the bar still in one row.
    await pressControl("chat");
    await waitView("chat");
    assert.deepEqual(await view(), { tabs: 1, selected: ["chat"], view: "chat", hidden: true }, "Conversation shown, one tablist");
    await page.waitForFunction(() => document.querySelector(".project-talk-thread li"), null, { timeout: 15_000 });
    await page.waitForTimeout(200);
    const chatEnd = await oneRow("conversation, opened at its newest");
    assert.ok(chatEnd.scrollTop > 0, "the conversation opens at its newest, scrolled");
    const composer = page.locator(".home-dock .project-talk-compose .cm-content");
    await composer.waitFor({ timeout: 10_000 });
    const dock = await page.evaluate(() => {
      const field = document.querySelector(".home-dock .project-talk-compose .cm-content");
      const box = field.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom), seen: box.top >= 0 && box.bottom <= innerHeight + 1,
        editable: field.getAttribute("contenteditable") };
    });
    assert.ok(dock.seen && dock.editable === "true", `the composer is seen and writable at the conversation's end: ${JSON.stringify(dock)}`);
    await shot(page, `${run.name}-chat-end`);
    await scrollTo("middle");
    const chatMiddle = await oneRow("conversation, middle");
    await shot(page, `${run.name}-chat-middle`);
    // Latest report from the conversation: the requests shown again, its card far down the list landed clear of the bar.
    await pressControl("report");
    const reportLanded = await landed("home-section-p1-yn-2", "Latest report");
    await oneRow("after Latest report");
    await shot(page, `${run.name}-report-landed`);
    // The keyboard: from Latest report, Tab reaches Requests; its focus ring is drawn; Tab goes on to Conversation,
    // and Enter there shows it.
    await page.evaluate(() => document.querySelector('.home-jumps [data-jump="report"]').focus({ preventScroll: true }));
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const el = document.activeElement, style = getComputedStyle(el);
      return { tab: el.dataset.tab, outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.equal(focus.tab, "requests", `Tab from the jumps reaches the Requests tab: ${JSON.stringify(focus)}`);
    assert.ok(focus.outline !== "none" && focus.width >= 1, `its focus ring is drawn: ${JSON.stringify(focus)}`);
    await shot(page, `${run.name}-keyboard`);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.tab), "chat", "Tab goes on to Conversation");
    await page.keyboard.press("Enter");
    await waitView("chat");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await waitView("requests");
    assert.deepEqual(await view(), { tabs: 1, selected: ["requests"], view: "requests", hidden: false }, "Enter on Requests shows them");
    await oneRow("requests, back from the keyboard");
    check(`${run.name}: one row at the top, middle and end of both views; Asks and Latest report land clear of it; a click and Enter switch; the composer stays usable; one tablist`,
      { top: { bar: top.bar, tabs: top.tabs, jumps: top.jumps, views: top.views }, named, labelSeen, requestsMiddle: requestsMiddle.bar, requestsEnd: requestsEnd.bar,
        chatEnd: chatEnd.bar, chatMiddle: chatMiddle.bar, asksLanded, reportLanded, dock, focus });
  } finally {
    await context.close();
  }
}
