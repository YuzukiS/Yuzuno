// YN-86 S1a and S1b in Chromium, every API answered here (no Core, no daily
// configuration), through the production build:
//  - the whole of Home (S1b): Needs you with the Ask and the approval as
//    cards and the executor as a row, each project at a glance (a quiet one
//    on one line, two to a row where Home is 900 px wide), no return
//    overview; Latest report opens the report page, and Back returns the
//    focus to that jump, the glance no longer counting it new;
//  - a Project's name on the rail opens its page; the arrow before it only
//    folds the group, and Tab goes arrow, name, +;
//  - the page's three groups: Needs you, In progress (cards stay put for the
//    visit), and Done, closed at first, with the 30-day history inside;
//  - an unread report opened from its card comes back with New gone and the
//    card in the same place and the same group;
//  - on a phone (390), the whole of Home from the address and a project's
//    page from its glance; 1920, 1440, 940 and Chinese at 1440 otherwise;
//  - a project's cards in three columns from 932 px of card area and the
//    team's facts beside them only from 1250 px of page, under them below
//    that (YN-157);
//  - nothing is wider than the window, and nothing is sent but the reads and
//    the opened receipt;
//  - opening a page, by the rail's name, a glance tapped, Enter or from
//    another page, frames nothing, on the way or landed: its heading has the
//    focus, Tab goes on to its tools with their focus shown, and a card named
//    (its Ask, a glance's recent card) is still marked (R-23).
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-home-check.mjs
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
const report = { task: "YN-86", runs: [], posts: [], opened: [], unexpected: [], errors: [] };
const HOST = "localhost:47393";
// One time for the whole fixture, so cards given the same age are the same age, and order as the fixture lists them.
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/yuzuno", projectId: "p-dev",
};
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "t", name: "YN-90 · 设计", kind: "executor", projectId: "p-dev", executor: { state: "running", task: { id: "YN-90", title: "Settings layout", shortName: "设置页排版" } } },
  { ...base, id: "n", name: "notes-1", kind: "lead", projectId: "p-notes" },
  { ...base, id: "s", name: "site-1", kind: "lead", projectId: "p-site" },
];
const projects = [
  { id: "p-dev", name: "Yuzuno dev", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-notes", name: "Field notes", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-site", name: "Personal site", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
let id = 200;
const section = (key, kind, title, body, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: owner("l", "lead-1"), updatedAt: at(30),
  updatedTurnId: "t1", body, attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const sections = [
  section("q1", "ask", "Ship the settings page this week?", spec(["q"], { q: md("The layout is ready; the copy is not.") }), {
    ask: { question: "Ship the settings page this week?", state: "open", reply: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "Not yet" }], freeText: true } },
  }),
  section("status", "status", "This week", spec(["s"], { s: md("Two cards run; one waits for your choice.") }), {
    status: { asOf: at(20), validFor: 86_400, stale: false },
  }),
  section("design", "report", "Settings groups", spec(["a", "b"], {
    a: md("Two groups were compared; the first keeps the common controls together."),
    b: md("The second reads faster but puts the account controls two levels down."),
  })),
  section("read-a", "report", "Earlier read", spec(["a"], { a: md("Read at this version.") }), {
    updatedAt: at(240), seen: { version: 2, at: at(200) },
  }),
  section("old-status", "status", "Last month", spec(["s"], { s: md("Out of date.") }), {
    status: { asOf: at(60 * 24 * 30), validFor: 3600, stale: true },
  }),
];
const history = [section("kept", "report", "Kept report", spec(["a"], { a: md("From last week.") }), {
  version: 1, history: true, seen: { version: 1, at: at(5000) }, updatedAt: at(6000),
})];
const home = () => ({
  generatedAt: at(0),
  order: ["p-dev", "p-notes", "p-site"],
  needsYou: [
    { kind: "ask", projectId: "p-dev", agentId: "l", agentName: "lead-1", sectionKey: "q1", title: "Ship the settings page this week?", since: at(30) },
    { kind: "approval", projectId: "p-dev", agentId: "t", agentName: "YN-90 · 设计", requestId: "r-1", title: "Run the build", since: at(10) },
    { kind: "executor", projectId: "p-dev", agentId: "t", agentName: "YN-90 · 设计", state: "delivering", taskId: "YN-90", title: "Settings layout", since: at(6) },
  ],
  projects: [
    {
      project: { id: "p-dev", name: "Yuzuno dev" },
      agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
      contentEditors: { version: 1, editorAgentIds: ["l"] },
      errors: [], pending: [{ id: "r-1", agentId: "t", agentName: "YN-90 · 设计", method: "item/commandExecution/requestApproval", params: { command: "./build.sh", reason: "Run the build" }, createdAt: at(10) }],
      jobs: [{ id: "job-1", name: "web check", status: "running", agentId: "t", agentName: "YN-90 · 设计" }],
      unseen: 3, missing: [], brief: { version: 9, history, sections },
    },
    {
      project: { id: "p-notes", name: "Field notes" },
      agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      contentEditors: { version: 1, editorAgentIds: ["n"] },
      errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: {
        version: 2, history: [],
        sections: [
          section("weekly", "report", "Weekly notes", spec(["a"], { a: md("Read.") }), { owner: owner("n", "notes-1"), updatedAt: at(400), seen: { version: 2, at: at(300) } }),
          // The report updated last on Home: the bar's Latest report opens it (S1b).
          section("field-log", "report", "Field log", spec(["a", "b"], { a: md("Three sites logged this week."), b: md("The fourth waits for the rain to stop.") }), {
            owner: owner("n", "notes-1"), updatedAt: at(5),
          }),
        ],
      },
    },
    {
      // Nothing for the user and nothing at work: one line.
      project: { id: "p-site", name: "Personal site" },
      agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      contentEditors: { version: 1, editorAgentIds: ["s"] },
      errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: {
        version: 1, history: [],
        sections: [section("about", "report", "About page", spec(["a"], { a: md("Live.") }), { owner: owner("s", "site-1"), updatedAt: at(3 * 24 * 60), seen: { version: 2, at: at(60) } })],
      },
    },
  ],
});
/** Core's count of what each project has the user not read: marked seen, or a report opened whole (YN-86). */
const withUnseen = (value) => {
  for (const panel of value.projects)
    panel.unseen = panel.brief.sections.filter((s) => Math.max(s.seen?.version ?? 0, s.opened?.version ?? 0) < s.version).length;
  return value;
};
const state = { home: home() };
const findSection = (projectId, key) =>
  state.home.projects.find((panel) => panel.project.id === projectId)?.brief.sections.find((section) => section.key === key)
  ?? state.home.projects.find((panel) => panel.project.id === projectId)?.brief.history.find((section) => section.key === key);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { needs: /^Needs you/, newMark: "New", inProgress: "In progress" },
  "zh-Hans": { needs: /^等你/, newMark: "新", inProgress: "进行中" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const [name, viewport, phone] of [["1920", { width: 1920, height: 1100 }, false], ["1440", { width: 1440, height: 1000 }, false], ["940", { width: 940, height: 1100 }, false], ["phone-390", { width: 390, height: 844 }, true]]) {
  runs.push({ name: `${name}`, viewport, phone, language: "en" });
}
runs.push({ name: "zh-1440", viewport: { width: 1440, height: 1000 }, phone: false, language: "zh-Hans" });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "project-home-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads and the opened receipts");
for (const run of runs)
  assert.deepEqual(report.opened.filter((entry) => entry.run === run.name).map((entry) => entry.body.key), ["field-log", "design"], `${run.name}: each report opened once`);
console.log(`project-home-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  // The fixture's sections are one set of objects for every run: drop the read receipt the last run recorded,
  // so each width starts from the same unread report.
  for (const section of [...sections, ...history]) delete section.opened;
  state.home = home();
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
    if (path === "/api/workspace") {
      return route.fulfill({ json: { workspace: { id: "ws-project" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    }
    if (path === "/api/home") return route.fulfill({ json: withUnseen(state.home) });
    // Linked repositories are read with a POST (home-api.ts readLinkedRepositories): none here.
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/projects\/([^/]+)\/brief\/opened$/.test(path)) {
      const body = JSON.parse(request.postData() || "{}");
      const projectId = path.match(/^\/api\/projects\/([^/]+)\/brief\/opened$/)[1];
      const section = findSection(decodeURIComponent(projectId), body.key);
      report.opened.push({ run: run.name, projectId, body });
      if (section && section.id === body.sectionId) section.opened = { version: body.version, at: at(0) };
      return route.fulfill({ json: { projectId, sectionId: body.sectionId, key: body.key, version: body.version, at: at(0), recorded: true } });
    }
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
      "/api/machine-load": {
        at: at(0),
        cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null },
        gpus: null, jobs: [],
      },
      "/api/machine-live": { machines: [] },
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
  const shot = async (name) => {
    const file = `${run.name}-${name}.png`;
    await page.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const projectPage = () => page.locator('[data-project-home="p-dev"]');
  const card = (key) => page.locator(`#home-section-p-dev-${key}`);
  /** Nothing wider than the window: the page, Home's own scroller, and each of the given boxes within Home. */
  const noOverflow = async (boxes) => {
    const widths = await page.evaluate((selector) => {
      const view = document.querySelector(".home-view");
      const edge = view.getBoundingClientRect().right;
      const over = [...document.querySelectorAll(selector)].filter((el) => el.getBoundingClientRect().right > edge + 1 || el.scrollWidth > el.clientWidth + 1)
        .map((el) => `${el.className}: ${Math.round(el.getBoundingClientRect().right)} > ${Math.round(edge)} / ${el.scrollWidth} > ${el.clientWidth}`);
      return { page: document.scrollingElement.scrollWidth, window: innerWidth, view: view.scrollWidth, viewBox: view.clientWidth, over };
    }, boxes);
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    assert.ok(widths.view <= widths.viewBox + 1, JSON.stringify(widths));
    assert.deepEqual(widths.over, [], JSON.stringify(widths));
    return widths;
  };
  /** What `act` puts around a Project's page, on the way and once landed (R-23): Home's mark of where a jump
   * landed, on anything, and the page's own outline or ring, read every frame for 2.5 s. */
  const framesWhile = async (act) => {
    await page.evaluate(() => {
      const seen = (window.r23Frames = []);
      const observer = new MutationObserver((records) => {
        for (const { target } of records)
          if (target.hasAttribute("data-home-highlight")) seen.push(`marked: ${target.id || target.className}`);
      });
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-home-highlight"] });
      const until = performance.now() + 2500;
      const sample = () => {
        for (const el of document.querySelectorAll(".project-home")) {
          const style = getComputedStyle(el);
          if (style.outlineStyle !== "none" || style.boxShadow !== "none")
            seen.push(`framed ${el.dataset.projectHome}: ${style.outlineStyle} ${style.boxShadow}`);
        }
        if (performance.now() < until) requestAnimationFrame(sample);
        else {
          observer.disconnect();
          window.r23Done = true;
        }
      };
      window.r23Done = false;
      requestAnimationFrame(sample);
    });
    await act();
    await page.waitForFunction(() => window.r23Done, null, { timeout: 15_000 });
    return page.evaluate(() => [...new Set(window.r23Frames)]);
  };
  /** A page opened, not a card on it: nothing framed it, its heading has the focus and stands at the top. */
  const pageOpened = async (id, frames) => {
    assert.deepEqual(frames, [], `${id}: nothing frames the page, on the way or landed`);
    const place = await page.evaluate((id) => {
      const heading = document.querySelector(`[data-project-home="${id}"] .project-home-head h1`);
      const view = heading.closest(".home-view").getBoundingClientRect();
      const box = heading.getBoundingClientRect();
      const top = Math.max(view.top, 0);
      return {
        focused: document.activeElement === heading,
        ring: getComputedStyle(heading).outlineStyle,
        marks: document.querySelectorAll("[data-home-highlight]").length,
        top: Math.round(box.top - top),
        bottom: Math.round(box.bottom - top),
        room: Math.round(Math.min(view.bottom, innerHeight) - top),
      };
    }, id);
    assert.ok(place.focused, `${id}: the heading has the focus: ${JSON.stringify(place)}`);
    assert.equal(place.ring, "none", `${id}: the heading focused by code shows no ring`);
    assert.equal(place.marks, 0, `${id}: nothing is marked`);
    assert.ok(place.top >= -1 && place.top <= 160 && place.bottom <= place.room, `${id}: the page opens at its top: ${JSON.stringify(place)}`);
    return place;
  };
  /** A card named: marked once landed, its outline drawn, and the page around it framed by nothing. */
  const cardMarked = async (key) => {
    await page.waitForFunction((key) => document.getElementById(`home-section-p-dev-${key}`)?.hasAttribute("data-home-highlight"), key, { timeout: 10_000 });
    const marked = await page.evaluate((key) => {
      const card = document.getElementById(`home-section-p-dev-${key}`);
      const pageStyle = getComputedStyle(document.querySelector('[data-project-home="p-dev"]'));
      return {
        outline: getComputedStyle(card).outlineStyle,
        focused: document.activeElement === card,
        marks: [...document.querySelectorAll("[data-home-highlight]")].map((el) => el.id),
        page: pageStyle.outlineStyle,
      };
    }, key);
    assert.equal(marked.outline, "solid", `${key}: the card's mark is drawn: ${JSON.stringify(marked)}`);
    assert.ok(marked.focused, `${key}: the card has the focus`);
    assert.deepEqual(marked.marks, [`home-section-p-dev-${key}`], "only that card is marked");
    assert.equal(marked.page, "none", "the page itself is not framed");
    return marked;
  };
  try {
    if (run.phone) {
      // The address names Home, as a link from elsewhere does.
      await page.goto(`http://${HOST}/#/home?w=ws-project`);
    } else {
      await page.goto(`http://${HOST}/`);
      await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    }
    // The whole of Home (S1b, YN-86 §2.1).
    await page.locator('[data-glance-project="p-dev"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-needs-you]").length === 3, null, { timeout: 15_000 });
    assert.equal(await page.locator(".home-return-overview, .home-panel").count(), 0, "no return overview, no project panel");
    const needs = await page.locator("[data-needs-you]").evaluateAll((els) => els.map((el) => [el.dataset.needsYou, el.classList.contains("home-needs-card") ? "card" : "row"]));
    assert.deepEqual(needs, [["ask:p-dev:q1", "card"], ["approval:r-1", "card"], ["executor:t:delivering", "row"]]);
    assert.equal(await page.locator('[data-needs-you="ask:p-dev:q1"] [data-section-key="q1"] .home-ask').count(), 1, "the Ask answered in place");
    const glance = await page.locator("[data-glance-project]").evaluateAll((els) => els.map((el) => [el.dataset.glanceProject, el.classList.contains("is-quiet")]));
    assert.deepEqual(glance, [["p-dev", false], ["p-notes", false], ["p-site", true]]);
    const layout = await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      const style = getComputedStyle(view);
      const inner = view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const columns = getComputedStyle(document.querySelector(".project-glance-grid")).gridTemplateColumns.split(" ").length;
      const order = [...document.querySelector(".home-layout").children].map((el) => el.className);
      // Each part starts at Home's left edge and takes its whole width.
      const edges = [".home-needs-you", ".project-glance-list", ".home-widget-column"].map((selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return [selector, Math.round(box.left), Math.round(box.width)];
      });
      return { inner: Math.round(inner), columns, order, edges };
    });
    assert.deepEqual(layout.order, ["home-needs-area", "home-projects", "home-widget-column"]);
    for (const [selector, left, width] of layout.edges) {
      assert.ok(Math.abs(left - layout.edges[0][1]) <= 1, `${selector} starts where Needs you does: ${JSON.stringify(layout.edges)}`);
      assert.ok(Math.abs(width - layout.edges[0][2]) <= 1, `${selector} is as wide: ${JSON.stringify(layout.edges)}`);
    }
    assert.equal(layout.columns, layout.inner >= 900 ? 2 : 1, `two to a row from 900 px: ${JSON.stringify(layout)}`);
    if (run.name.endsWith("1440")) assert.equal(layout.columns, 2);
    if (run.phone) assert.equal(layout.columns, 1);
    const homeWidths = await noOverflow(".home-needs-card, .project-glance, .home-widget-column");
    await shot("home");
    // Each project at a glance, scrolled into view in Home's own scroller.
    await page.locator(".project-glance-list").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot("home-projects");
    pass("the whole of Home: Needs you's cards and row, each project at a glance, no overview; nothing wider than the window", { needs, glance, layout, homeWidths });
    // Latest report: its page over Home; Back returns to the jump, the glance counting it read.
    assert.equal(await page.locator('[data-glance-project="p-notes"] .home-chip.is-new').count(), 1);
    await page.locator('.home-jumps [data-jump="report"]').click();
    await page.locator(".home-report .report-head h1").waitFor({ timeout: 15_000 });
    assert.equal((await page.locator(".home-report .report-head h1").innerText()).trim(), "Field log");
    for (let i = 0; i < 80 && !report.opened.some((entry) => entry.run === run.name && entry.body.key === "field-log"); i++) await page.waitForTimeout(100);
    await page.locator(".home-report .report-back").click();
    await page.waitForFunction(() => !document.querySelector(".home-report"), null, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.jump ?? null), "report", "the focus is back on Latest report");
    await page.waitForFunction(() => !document.querySelector('[data-glance-project="p-notes"] .home-chip.is-new'), null, { timeout: 10_000 });
    pass("Latest report opens its page; Back returns the focus to the jump; its project no longer counts it new");
    let opening;
    if (run.phone) {
      // On a phone, a project's page from its glance, by touch.
      opening = await framesWhile(async () => {
        await page.locator('[data-glance-project="p-dev"] .project-glance-open').tap();
        await projectPage().waitFor({ timeout: 15_000 });
      });
    } else {
      // The rail's heading is two controls: arrow, name, +; the name opens the page.
      const head = page.locator('.project-group[data-group="p-dev"] .project-group-head');
      const fold = page.locator('.project-group[data-group="p-dev"] .project-group-fold');
      const name = page.locator('.project-group[data-group="p-dev"] .project-group-toggle');
      assert.equal(await fold.getAttribute("aria-expanded"), "true");
      const order = await head.evaluate((el) => [...el.children].slice(0, 3).map((child) => child.className.split(" ")[0]));
      assert.deepEqual(order, ["project-group-fold", "project-group-toggle", "project-group-add"], "keyboard order");
      await fold.click();
      await page.waitForFunction(() => document.querySelector('.project-group[data-group="p-dev"]')?.classList.contains("is-folded"));
      assert.equal(await fold.getAttribute("aria-expanded"), "false");
      assert.equal(await projectPage().count(), 0, "the arrow opens nothing");
      await fold.click();
      await page.waitForFunction(() => !document.querySelector('.project-group[data-group="p-dev"]')?.classList.contains("is-folded"));
      // Tab: the arrow, the name, then +.
      await fold.focus();
      await page.keyboard.press("Tab");
      assert.match(await page.evaluate(() => document.activeElement?.className ?? ""), /project-group-toggle/);
      await page.keyboard.press("Tab");
      assert.match(await page.evaluate(() => document.activeElement?.className ?? ""), /project-group-add/);
      opening = await framesWhile(async () => {
        await name.click();
        await projectPage().waitFor({ timeout: 15_000 });
      });
      pass("the rail's arrow folds only, its name opens the page, and Tab goes arrow, name, +", { order });
    }
    await projectPage().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-section-key]").length >= 4, null, { timeout: 15_000 });
    const opened = await pageOpened("p-dev", opening);
    await shot("project-opened");
    pass(`${run.phone ? "a glance tapped" : "the rail's name clicked"} opens the page at its heading, framed by nothing on the way or landed (R-23)`, opened);
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language);
    // No horizontal overflow: the page and Home's own scroller.
    await noOverflow(".project-home-head, .request-blocks");
    // YN-212: the page reads by request. With none, the Project's own block is all of it, open, in Needs you while an
    // Ask of its own waits; the 30-day history is in Done, closed.
    const titles = await page.locator(".request-group-title").evaluateAll((els) => els.map((el) => el.textContent.trim()));
    assert.match(titles[0], w.needs);
    assert.equal(await page.locator('.request-group[data-group="needs"] [data-project-block][data-open]').count(), 1, "the Project's block, open, in Needs you");
    assert.equal(await page.locator(".request-done").evaluate((el) => el.open), false, "Done is closed at first");
    assert.equal(await page.locator(".request-done .home-history").count(), 1, "the 30-day history is inside Done");
    await shot("project");
    pass("the Project's block open in Needs you; Done closed with the history inside; no overflow", titles);
    // The cards' columns and where the team's facts stand (YN-157): the team beside them only from 1250 px of page;
    // the cards' columns follow the Project's block's own width (a deck of its own, YN-212), at most 920 px.
    const shape = await page.evaluate(() => {
      const page = document.querySelector('[data-project-home="p-dev"]');
      const main = page.querySelector(".project-home-main");
      const deck = main.querySelector(".project-block-cards .home-brief");
      const box = getComputedStyle(deck.parentElement);
      const team = page.querySelector(".project-team");
      const teamBox = team.getBoundingClientRect(), mainBox = main.getBoundingClientRect();
      return { width: Math.round(page.clientWidth),
        cardArea: Math.round(deck.parentElement.clientWidth - Number.parseFloat(box.paddingLeft) - Number.parseFloat(box.paddingRight)),
        columns: getComputedStyle(deck).gridTemplateColumns.split(" ").length,
        team: team.tagName.toLowerCase(), beside: teamBox.left > mainBox.right - 1,
        spans: [...new Set([...deck.querySelectorAll("[data-section-key]")].map((el) => el.dataset.deckCols ?? "none"))] };
    });
    assert.equal(shape.columns, shape.cardArea >= 1248 ? 4 : shape.cardArea >= 932 ? 3 : shape.cardArea >= 560 ? 2 : 1, JSON.stringify(shape));
    assert.equal(shape.team, shape.width >= 1250 ? "aside" : "details", `the team beside only from 1250 px: ${JSON.stringify(shape)}`);
    assert.equal(shape.beside, shape.width >= 1250, JSON.stringify(shape));
    if (run.name === "1440") {
      assert.equal(shape.columns, 2, `two columns in the block at 1440: ${JSON.stringify(shape)}`);
      assert.equal(shape.team, "details", `the team below at 1440: ${JSON.stringify(shape)}`);
    }
    if (run.name === "1920") {
      assert.equal(shape.columns, 2, `two columns in the block at 1920: ${JSON.stringify(shape)}`);
      assert.equal(shape.team, "aside", `the team beside at 1920: ${JSON.stringify(shape)}`);
    }
    if (run.phone) assert.equal(shape.columns, 1, `one column on a phone: ${JSON.stringify(shape)}`);
    pass("the cards' columns follow the Project's block, and the team stands beside them only from 1250 px", shape);
    // The unread report: New, open it, read it, come back with New gone and the card in the same place.
    const unread = card("design");
    await unread.scrollIntoViewIfNeeded();
    assert.equal((await unread.locator(".home-changed").innerText()).trim(), w.newMark);
    const before = await unread.evaluate((el) => {
      return { top: Math.round(el.getBoundingClientRect().top), group: el.closest(".request-group")?.dataset.group ?? null };
    });
    await unread.locator(".home-report-open").click();
    await page.locator(".home-report .report-head h1").waitFor({ timeout: 15_000 });
    // The page records what it showed whole; wait for the receipt, then go Back.
    const designOpened = () => report.opened.filter((entry) => entry.run === run.name && entry.body.key === "design");
    for (let i = 0; i < 80 && !designOpened().length; i++) await page.waitForTimeout(100);
    assert.equal(designOpened().length, 1, "the report page records the version it showed");
    await page.locator(".home-report .report-back").click();
    await projectPage().waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => !document.querySelector("#home-section-p-dev-design .home-changed"), null, { timeout: 10_000 });
    const after = await unread.evaluate((el) => {
      return { top: Math.round(el.getBoundingClientRect().top), group: el.closest(".request-group")?.dataset.group ?? null };
    });
    assert.equal(after.group, before.group, "the card stays in the same group");
    assert.ok(Math.abs(after.top - before.top) <= 1, `the card does not move: ${JSON.stringify({ before, after })}`);
    await shot("project-read");
    pass("opening the unread report clears New and leaves the card in place", { before, after });
    // R-23: from this page to another, down this one first so that one's opening scrolls; then back by the keyboard.
    await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      view.scrollTop = view.scrollHeight;
    });
    if (run.phone) {
      // On a phone: Back to the whole of Home, and another project's glance tapped.
      await page.goBack();
      await page.locator('[data-glance-project="p-notes"]').waitFor({ timeout: 15_000 });
      const toOther = await framesWhile(async () => {
        await page.locator('[data-glance-project="p-notes"] .project-glance-open').tap();
        await page.locator('[data-project-home="p-notes"]').waitFor({ timeout: 15_000 });
      });
      pass("another project's page, its glance tapped, framed by nothing (R-23)", await pageOpened("p-notes", toOther));
      await page.goBack();
      await page.locator('[data-glance-project="p-dev"]').waitFor({ timeout: 15_000 });
      await page.locator('[data-glance-project="p-dev"] .project-glance-open').tap();
      await projectPage().waitFor({ timeout: 15_000 });
    } else {
      const toOther = await framesWhile(async () => {
        await page.locator('.project-group[data-group="p-notes"] .project-group-toggle').click();
        await page.locator('[data-project-home="p-notes"]').waitFor({ timeout: 15_000 });
      });
      const other = await pageOpened("p-notes", toOther);
      await shot("project-switched");
      pass("from one project's page to another, framed by nothing on the way or landed (R-23)", other);
      // The keyboard: Enter on the name opens the page at its heading; Tab goes on to the page's own tools, shown.
      await page.locator('.project-group[data-group="p-dev"] .project-group-toggle').focus();
      const byKey = await framesWhile(async () => {
        await page.keyboard.press("Enter");
        await projectPage().waitFor({ timeout: 15_000 });
      });
      await pageOpened("p-dev", byKey);
      await page.keyboard.press("Tab");
      const next = await page.evaluate(() => {
        const el = document.activeElement;
        const style = getComputedStyle(el);
        return {
          inHead: !!el.closest('[data-project-home="p-dev"] .project-home-head'),
          name: el.getAttribute("aria-label") ?? el.textContent.trim(),
          outline: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
        };
      });
      assert.ok(next.inHead, `Tab goes on from the heading to the page's tools: ${JSON.stringify(next)}`);
      assert.ok(next.outline !== "none" && next.width >= 1, `its focus is shown: ${JSON.stringify(next)}`);
      await shot("project-keyboard");
      pass("Enter on the name opens the page at its heading; Tab goes on to its tools, their focus shown (R-23)", next);
    }
    // A card named is still marked: the page's own Asks jump.
    await page.locator('[data-project-home="p-dev"] .home-jumps [data-jump="asks"]').click();
    const ask = await cardMarked("q1");
    await shot("project-ask-marked");
    pass("the page's Asks jump still marks the Ask (R-23)", ask);
    // And the status card, a glance's recent card on the whole of Home: the page opens at that card, marked.
    if (run.phone) await page.goBack();
    else await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    // By its whole title: "This week" is also in the Ask's "Ship the settings page this week?".
    const recent = page.locator('[data-glance-project="p-dev"] .project-glance-recent button', {
      has: page.locator(".project-glance-card", { hasText: /^This week$/ }),
    });
    await recent.waitFor({ timeout: 15_000 });
    await (run.phone ? recent.tap() : recent.click());
    await projectPage().waitFor({ timeout: 15_000 });
    const status = await cardMarked("status");
    await shot("project-status-marked");
    pass("the status card, from its glance, opens the page at that card, marked (R-23)", status);
  } finally {
    await context.close();
  }
}
