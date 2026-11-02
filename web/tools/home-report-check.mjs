// A section's report over Home (T-18), in a browser: the production bundle
// with an explicit API fixture (synthetic sections, no Core, daily window or
// real Agent). Checks what JSDOM can't: the page's layout on a 1440 px
// desktop and a 390 px phone (rail or Contents, type sizes, nothing
// sideways), the long-text fold and sources by real visibility, a research
// desk still interactive on the page, Home's scroll place and focus after
// Back, the browser's Back, Escape, a link in the address and one in a
// conversation, a version notice, and reduced motion. Reads only: nothing
// is written. Screenshots and report.json go to YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-report.test";
const WS = "ws-report";
const report = { task: "T-18", checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], shots: [],
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
  await (selector ? page.locator(selector).screenshot({ path }) : page.screenshot({ path }));
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const linkHref = (version, sectionId = 7) => `https://${HOST}/#/report?w=${WS}&p=p1&k=eval&v=${version}&s=${sectionId}`;
const turns = [{ id: "t1", status: "completed", completedAt: Math.floor((now - 3 * MIN) / 1000), items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Where is the eval write-up?" }] },
  { id: "r1", type: "agentMessage", text: `It is on Home: [Synthetic eval: model B vs A](${linkHref(3)}).` },
] }];
const longText = Array.from({ length: 30 }, (_, i) => `Note ${i + 1}: the seeds, data order and evaluation split are the same in both arms.`).join("\n\n");
const evalBody = { root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["answer", "method", "loss", "long", "results", "sources"] },
  answer: { type: "Group", props: { tone: "accent" }, children: ["answer-text"] },
  "answer-text": { type: "Markdown", props: { text: "Model B lowers validation loss by 4% on the synthetic set, within the noise of three seeds." } },
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": { type: "Markdown", props: { text: "Three seeds per arm. Same data order, same evaluation split." } },
  loss: { type: "Metrics", props: { items: [{ label: "Validation loss (B)", value: 0.412, previous: 0.429 }, { label: "Seeds", value: 3 }] } },
  long: { type: "Markdown", props: { text: longText } },
  results: { type: "Table", props: { id: "results", title: "Results", columns: [{ key: "model", label: "Model" }, { key: "loss", label: "Validation loss" }],
    rows: [{ id: "a", cells: { model: "A", loss: 0.429 }, sourceIds: ["run-a"] }, { id: "b", cells: { model: "B", loss: 0.412 }, sourceIds: ["run-b"] }] } },
  sources: { type: "Sources", props: { items: [{ id: "run-a", label: "Run A log", href: "https://example.test/run-a" }, { id: "run-b", label: "Run B log", href: "https://example.test/run-b" }] } },
} };
const section = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: `Notes ${key}`, version, owner, body: evalBody, attachments: [], refs: {},
  seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN), ...extra });
const markdown = (text) => ({ root: "b", elements: { b: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text } } } });
// Cards above the report, so Home has a scroll place to keep.
const fillers = ["setup", "data", "baseline"].map((key, i) => section(key, 20 + i, 1, { title: `Notes on ${key}`,
  body: markdown(Array.from({ length: 6 }, (_, n) => `Paragraph ${n + 1} about the ${key}.`).join("\n\n")) }));
let evalVersion = 3;
const sections = () => [...fillers, section("eval", 7, evalVersion, { title: "Synthetic eval: model B vs A" }),
  { ...section("dose-study", 8, 3), title: doseStudy.title, body: doseStudy.body }];
const pointer = (document, at) => at.split("/").slice(1).reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), document);
/** Core's research read of the desk, from the fixture files, as research.rs answers it. */
function research(version) {
  const desk = doseStudy.body.elements.desk.props;
  const values = {};
  for (const plot of desk.plots)
    for (const row of plot.rows)
      for (const [id, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (!number || typeof number !== "object") continue;
          const found = pointer(fixtureFiles[number.from], number.pointer);
          values[`${id}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
        }
  const sources = Object.fromEntries(desk.sources.filter((source) => source.snapshot).map((source) => [source.id, {
    attachment: source.snapshot, takenAt: iso(-60 * MIN), size: 1200, sha256: "5f3c".padEnd(64, "0"), available: true }]));
  return { key: doseStudy.key, version, elementId: "desk", values, sources };
}
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: sections(), history: [] }, unseen: 1, missing: [] }] });
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 32, totalPct: 20, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 40107, usedMiB: 12000, availableMiB: 28107, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
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
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    // A list read (home-api.ts): it starts no GitHub sync.
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/projects/p1/brief/research/dose-study/desk") {
    report.reads.push(`${path}?${url.searchParams}`);
    return route.fulfill({ json: research(Number(url.searchParams.get("version"))) });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns }),
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
async function open(width, height, { motion = "reduce", at = "/" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
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
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${width}: console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}${at}`);
}
async function toHome() {
  const nav = page.locator(".toolbar-nav .catchup-nav").first();
  await nav.waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await nav.click();
  await card("eval").waitFor({ timeout: 10_000 });
}
const card = (key) => page.locator(`.home-view [data-section-key="${key}"]`);
const opener = (key) => card(key).locator(".home-report-open");
const reportPage = () => page.locator(".home-report");
async function openReport(key) {
  await opener(key).scrollIntoViewIfNeeded();
  await opener(key).click();
  await reportPage().locator(".report-head h1").waitFor();
  await sleep(150);
}
/** The page's layout: sizes, what shows, and whether anything scrolls sideways. */
const layout = () => page.evaluate(() => {
  const root = document.querySelector(".home-report");
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const px = (selector) => parseFloat(getComputedStyle(root.querySelector(selector)).fontSize);
  const sideways = [root, ...root.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && !["visible", "hidden", "clip"].includes(getComputedStyle(el).overflowX)
    && !el.closest(".result-table-scroll, pre, .research-desk")).map((el) => el.className || el.tagName).slice(0, 5);
  const scroller = document.scrollingElement;
  return {
    root: box(root), bar: box(root.querySelector(".report-bar")), main: box(root.querySelector(".report-main")), hero: box(root.querySelector(".report-hero")),
    lead: box(root.querySelector(".report-lead")), firstBlock: box(root.querySelector(".report-main > .report-block")),
    rail: root.querySelector(".report-rail")?.checkVisibility() ?? null, contents: root.querySelector(".report-contents")?.checkVisibility() ?? null,
    contentsHeight: box(root.querySelector(".report-contents > summary"))?.height ?? null,
    h1: px(".report-head h1"), leadSize: px(".report-lead .brief-markdown"),
    page: scroller.scrollWidth > scroller.clientWidth, sideways,
  };
});

try {
  await step("desktop 1440: Open report over Home; the summary first, rail, long text folded, sources on demand; Back keeps Home's place and focus", async () => {
    await open(1440, 900);
    await toHome();
    await card("eval").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
    assert.ok(before > 0, `Home scrolled (${before})`);
    await openReport("eval");
    const shown = await layout();
    assert.ok(shown.rail === true && shown.contents === false, JSON.stringify(shown));
    assert.equal(shown.h1, 30);
    assert.equal(shown.leadSize, 18);
    assert.ok(shown.lead.top < shown.hero.top && shown.hero.top < shown.firstBlock.top, "the conclusion, then the figure, then the rest");
    // The main column takes what the 1240 px page leaves beside the rail.
    assert.ok(shown.main.width >= 640 && shown.main.width <= 960, `main column ${shown.main.width}px`);
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    assert.equal(await page.evaluate(() => document.activeElement?.matches(".report-head h1")), true, "the title has focus");
    const under = await page.evaluate(() => { const v = document.querySelector(".home-view"); return { inert: v.inert, hidden: getComputedStyle(v).visibility }; });
    assert.deepEqual(under, { inert: true, hidden: "hidden" });
    await shot("desktop-report.png");
    // Long text: whole in the page, folded by its height; "Show all" shows it.
    const fold = reportPage().locator("#report-block-long");
    await fold.scrollIntoViewIfNeeded();
    const folded = await fold.evaluate((el) => { const body = el.querySelector(".report-fold-body"); return { client: body.clientHeight, scroll: body.scrollHeight }; });
    assert.ok(folded.client < folded.scroll, JSON.stringify(folded));
    await shot("desktop-fold.png", "#report-block-long");
    await fold.getByRole("button", { name: "Show all" }).click();
    const unfolded = await fold.evaluate((el) => { const body = el.querySelector(".report-fold-body"); return { client: body.clientHeight, scroll: body.scrollHeight }; });
    assert.ok(unfolded.client >= unfolded.scroll - 1, JSON.stringify(unfolded));
    assert.equal(await fold.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded"), "true");
    // Sources: a count, opened on demand.
    const sources = reportPage().locator("#report-block-sources");
    assert.equal(await sources.locator("a", { hasText: "Run A log" }).isVisible(), false);
    await sources.locator("summary").click();
    await until("the sources", () => sources.locator("a", { hasText: "Run A log" }).isVisible());
    // The outline goes to a block, below the sticky bar.
    await reportPage().locator(".report-rail button", { hasText: "Results" }).click();
    await sleep(150);
    const placed = await page.evaluate(() => ({
      bar: document.querySelector(".report-bar").getBoundingClientRect().bottom,
      block: document.querySelector("#report-block-results").getBoundingClientRect().top,
    }));
    assert.ok(placed.block >= placed.bar - 1 && placed.block <= placed.bar + 80, JSON.stringify(placed));
    await shot("desktop-results.png");
    // Back: Home as it was, focus on the button that opened the report.
    await reportPage().locator(".report-back").click();
    await until("the report closed", async () => !(await reportPage().count()));
    const after = await page.evaluate(() => ({
      top: document.querySelector(".home-view").scrollTop,
      focus: document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false,
      ring: document.querySelector('.home-view [data-section-key="eval"]').hasAttribute("data-report-return"),
    }));
    assert.ok(Math.abs(after.top - before) <= 1 && after.focus && after.ring, JSON.stringify({ before, ...after }));
    return { before, after, layout: shown, folded, unfolded, placed };
  });

  await step("desktop: a research desk on the report is the interactive one, reading its numbers at the version shown", async () => {
    await open(1440, 900);
    await toHome();
    await openReport("dose-study");
    const desk = reportPage().locator(".research-desk");
    await until("the snapshot numbers", async () => (await desk.innerText()).includes("−2.04"));
    await desk.locator('[role="radiogroup"][aria-label="Show"] [role="radio"]', { hasText: "Each arm's own mean" }).click();
    await until("the parts", async () => (await desk.locator(".research-caption").innerText().catch(() => "")) === "High dose");
    assert.ok(report.reads.some((read) => read.endsWith("version=3")), JSON.stringify(report.reads));
    const shown = await layout();
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    await shot("desktop-research.png");
  });

  await step("the browser's Back and Escape close the report; Copy link gives the report's link", async () => {
    await open(1440, 900);
    await toHome();
    await openReport("eval");
    await reportPage().getByRole("button", { name: "Copy link" }).click();
    const copied = await until("the copied link", () => page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(copied, linkHref(3));
    const address = page.url();
    await page.goBack();
    await until("closed by the browser's Back", async () => !(await reportPage().count()));
    assert.equal(page.url(), address, "the page itself stayed");
    await openReport("eval");
    await page.keyboard.press("Escape");
    await until("closed by Escape", async () => !(await reportPage().count()));
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false), true);
    return { copied };
  });

  await step("a report link in the address opens it over Home and leaves the address; a later version is said, with a way to it", async () => {
    evalVersion = 4;
    await open(1440, 900, { at: `/#/report?w=${WS}&p=p1&k=eval&v=3&s=7` });
    const notice = await until("the notice", async () => (await reportPage().locator(".report-notice").count()) && reportPage().locator(".report-notice p").innerText());
    assert.equal(notice, "This link is to version 3. The report is at version 4 now, and Home keeps only its newest version.");
    assert.equal(await reportPage().locator(".report-article").count(), 0);
    assert.equal(await page.evaluate(() => location.hash), "", "the link was read once, then removed");
    await shot("desktop-later.png");
    await reportPage().getByRole("button", { name: "Open version 4" }).click();
    await until("version 4", async () => /version 4/.test(await reportPage().locator(".report-meta").innerText().catch(() => "")));
    await reportPage().locator(".report-back").click();
    await until("Home", async () => !(await reportPage().count()) && page.locator(".home-view").isVisible());
    evalVersion = 3;
  });

  await step("a report link in a conversation opens the report, and Back returns to that message", async () => {
    await open(1440, 900);
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click({ timeout: 10_000 });
    const link = page.locator('[data-item-id="r1"] a', { hasText: "Synthetic eval" });
    await link.waitFor({ timeout: 10_000 });
    await link.click();
    await reportPage().locator(".report-head h1").waitFor();
    assert.equal(await page.locator(".home-view").count(), 1, "Home is under the report");
    const backButton = reportPage().locator(".report-back");
    assert.equal((await backButton.innerText()).trim(), "Back to the message");
    await backButton.click();
    await until("the conversation", async () => !(await page.locator(".home-view").count()) && page.locator('[data-item-id="r1"]').isVisible());
    return { url: page.url() };
  });

  await step("phone 390: one column with Contents, no rail, nothing sideways; Back returns to the card", async () => {
    await open(390, 844);
    await toHome();
    await openReport("eval");
    const shown = await layout();
    assert.ok(shown.rail === false && shown.contents === true && shown.contentsHeight >= 44, JSON.stringify(shown));
    assert.equal(shown.h1, 23);
    assert.equal(shown.leadSize, 16);
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    assert.ok(shown.hero.width >= shown.root.width - 1, `the figure edge to edge (${shown.hero.width} of ${shown.root.width})`);
    await shot("phone-report.png");
    await shot("phone-report-full.png", ".report-page");
    await reportPage().locator(".report-contents summary").click();
    await reportPage().locator(".report-contents button", { hasText: "Results" }).click();
    await sleep(150);
    await shot("phone-results.png");
    await reportPage().locator(".report-back").click();
    await until("the report closed", async () => !(await reportPage().count()));
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false), true);
    return { layout: shown };
  });

  await step("motion: the report rises in over 220 ms, and under reduced motion nothing moves", async () => {
    const animation = async (motion) => {
      await open(1440, 900, { motion });
      await toHome();
      await openReport("eval");
      return page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".home-report"));
        return { name: style.animationName, duration: style.animationDuration };
      });
    };
    const moving = await animation("no-preference");
    await page.context().close();
    const still = await animation("reduce");
    assert.deepEqual(moving, { name: "report-open", duration: "0.22s" });
    assert.equal(still.name, "none");
    return { moving, still };
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
