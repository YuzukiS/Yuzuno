// A research desk (T-9), in a browser: the two synthetic desks of
// research-fixtures.mjs as their report pages draw them (T-18: a report's
// body is read on its page, opened from its Home card, always at high
// density), on a desktop and on a 390 px phone, light theme.
// - Desktop: claims, view and sources side by side; a phone: one column, the
//   claims first and the sources after the view; nothing scrolls sideways.
// - Arrow keys move a row's selection and its visible focus; the parts of a
//   row, the evidence, the definitions and the next steps each show.
// - Reads only: the desk asks Core for its numbers and nothing else; no
//   write leaves the page.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { benchmark, doseStudy, fixtureFiles } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/research-desk");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-research.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], shots: [] };
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
async function shot(name, full = false) {
  await page.screenshot({ path: resolve(output, name), fullPage: full });
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "sora", name: "Sora", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null };
const projects = [{ id: "p1", name: "Research (synthetic)", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "sora", name: "Sora", state: "active" };
const section = (put, version, extra = {}) => ({
  key: put.key, kind: "report", title: put.title, version, owner, body: put.body, attachments: [], refs: {},
  seen: { version, at: iso(-MIN) }, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN), ...extra,
});
const refs = { "task:T-12": { kind: "task", id: "T-12", found: true, title: "Quiet machine run", state: "doing", tone: "active" } };
const sections = [section(doseStudy, 3), section(benchmark, 2, { refs })];
const pointer = (document, at) => at.split("/").slice(1).reduce((value, step) => (value && typeof value === "object" ? value[step] : undefined), document);
/** Core's research read of a desk, from the fixture files, as research.rs answers it. */
function research(put, version) {
  const desk = put.body.elements.desk.props;
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
    attachment: source.snapshot, takenAt: iso(-60 * MIN), size: 1200, sha256: "5f3c".padEnd(64, "0"), available: true,
    ...(source.sha256 ? { stated: "different" } : {}),
  }]));
  return { key: put.key, version, elementId: "desk", values, sources };
}
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Research (synthetic)" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: 5, sections, history: [] },
    unseen: 0, missing: [],
  }],
});
const machineLoad = () => ({
  at: new Date().toISOString(),
  cpu: { cores: 32, totalPct: 20, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 40107, usedMiB: 12000, availableMiB: 28107, jobsMiB: 0, agentsMiB: null },
  gpus: [], jobs: [],
});

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const desk = path.match(/^\/api\/projects\/p1\/brief\/research\/([^/]+)\/desk$/);
  if (desk) {
    report.reads.push(`${path}?${url.searchParams}`);
    const put = [doseStudy, benchmark].find((item) => item.key === decodeURIComponent(desk[1]));
    return put ? route.fulfill({ json: research(put, Number(url.searchParams.get("version"))) }) : route.fulfill({ status: 404, json: { error: "no desk" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/sora": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    // Where another browser left the Agent's conversation (T-170): nowhere.
    "/api/agents/sora/reading": () => ({ handoff: null }),
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
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}
const card = (key) => page.locator(`.home-view [data-section-key="${key}"]`);
/** The desk on the report page that is open. */
const desk = () => page.locator(".home-report .research-desk");
/** A section's report page, opened from its card on Home (T-18). */
async function openReport(key) {
  const opener = card(key).locator(".home-report-open");
  await opener.scrollIntoViewIfNeeded();
  await opener.click();
  await desk().waitFor();
}
async function closeReport() {
  await page.locator(".home-report .report-back").click();
  await page.locator(".home-report").waitFor({ state: "hidden" });
}

async function open(width, height) {
  page = await browser.newPage({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  if (!(await page.locator(".home-view").isVisible())) await page.locator(".toolbar-nav .catchup-nav").first().click();
  const toggle = page.locator('.home-view .home-panel-toggle[aria-expanded="false"]');
  await page.locator(".home-view .home-panel-toggle").first().waitFor();
  if (await toggle.count()) await toggle.first().click();
  await card("dose-study").waitFor();
  await openReport("dose-study");
  await until("the snapshot numbers", async () => (await desk().innerText()).includes("−2.04"));
  await sleep(200);
}
/** Boxes of the desk's three parts and whether anything scrolls sideways. */
const layout = () =>
  page.evaluate(() => {
    const root = document.querySelector(".home-report .research-desk");
    const box = (selector) => {
      const r = root.querySelector(selector).getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const scroller = document.scrollingElement;
    const sideways = [...document.querySelectorAll(".home-report *")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).overflowX !== "hidden").map((el) => el.className).slice(0, 5);
    const body = root.closest(".brief-body"), style = getComputedStyle(body);
    const bodyWidth = Math.round(body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    return { claims: box(".research-claims"), main: box(".research-main"), aside: box(".research-aside"), bodyWidth, page: scroller.scrollWidth > scroller.clientWidth, sideways };
  });
/** The desk's own layouts (research.css), by the width of the body it is in: three
 *  columns from 960 px, the claims across the top from 640 px, else one column. */
const expected = (s) => (s.bodyWidth >= 960 ? "three" : s.bodyWidth >= 640 ? "strip" : "stack");
const drawn = (s) =>
  s.claims.right <= s.main.left && s.main.right <= s.aside.left && Math.abs(s.claims.top - s.main.top) < 4 && Math.abs(s.main.top - s.aside.top) < 4 ? "three"
    : s.claims.bottom <= s.main.top + 1 && s.main.right <= s.aside.left && Math.abs(s.main.top - s.aside.top) < 4 ? "strip"
      : s.claims.bottom <= s.main.top + 1 && s.main.bottom <= s.aside.top + 1 && Math.abs(s.claims.left - s.main.left) < 4 ? "stack" : "other";
const radio = (label, text) => desk().locator(`[role="radiogroup"][aria-label="${label}"] [role="radio"]`, { hasText: text });
const selected = (label) => desk().locator(`[role="radiogroup"][aria-label="${label}"] [role="radio"][aria-checked="true"]`);

try {
  {
    const density = "high";
    await step("desktop 1440, on the report page at high density: claims, view and sources laid out as the desk's width calls for; keys move the selection; every view shows", async () => {
      await open(1440, 900);
      assert.equal(await desk().getAttribute("data-density"), "high", "a report page reads at high density");
      await desk().scrollIntoViewIfNeeded();
      const shown = await layout();
      assert.equal(drawn(shown), expected(shown), JSON.stringify(shown));
      assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
      report.layouts = [...(report.layouts || []), { width: 1440, bodyWidth: shown.bodyWidth, layout: drawn(shown) }];
      await shot(`desktop-${density}-claim.png`);
      // Keys: from the selected row, down to the next, the focus with it.
      const rows = "Recovery time vs placebo (v2): rows";
      await selected(rows).focus();
      const before = await selected(rows).innerText();
      await page.keyboard.press("ArrowUp");
      await until("the row above", async () => (await selected(rows).innerText()) !== before);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"));
      assert.equal(focused, "true", "the focus moved with the selection");
      const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      assert.notEqual(ring, "none", "the focus is visible");
      await shot(`desktop-${density}-keyboard.png`);
      await page.keyboard.press("ArrowDown");
      await radio("Show", "Each arm's own mean").click();
      await until("the parts", async () => (await desk().locator(".research-caption").innerText().catch(() => "")) === "High dose");
      await shot(`desktop-${density}-parts.png`);
      for (const [view, wait, file] of [
        ["Evidence & limits", "Symptom-free for 72 hours.", "evidence"],
        ["Definitions", "v1 → v2", "definitions"],
        ["Next steps", "nothing runs from this card", "next"],
      ]) {
        await radio("Views of this desk", view).click();
        await until(view, async () => (await desk().locator(".research-main").innerText()).includes(wait));
        assert.ok(!(await layout()).page, `${view}: nothing scrolls sideways`);
        await shot(`desktop-${density}-${file}.png`);
      }
      // The second desk, of another shape, by the same component.
      await closeReport();
      await openReport("pass-bench");
      await until("the benchmark numbers", async () => (await desk().innerText()).includes("−6.1"));
      await shot(`desktop-${density}-benchmark.png`);
      await page.close();
    });
  }
  await step("desktop 2400, on the report page: the desk in the layout its width calls for, nothing sideways", async () => {
    await open(2400, 1000);
    await desk().scrollIntoViewIfNeeded();
    const shown = await layout();
    assert.equal(drawn(shown), expected(shown), JSON.stringify(shown));
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    report.layouts = [...(report.layouts || []), { width: 2400, bodyWidth: shown.bodyWidth, layout: drawn(shown) }];
    await shot("desktop-2400-claim.png");
    await page.close();
  });
  await step("phone 390: one column, claims first and sources after the view; nothing scrolls sideways; the plan's link shows its state", async () => {
    await open(390, 844);
    await desk().scrollIntoViewIfNeeded();
    const shown = await layout();
    assert.ok(shown.claims.bottom <= shown.main.top + 1 && shown.main.bottom <= shown.aside.top + 1, JSON.stringify(shown));
    assert.ok(Math.abs(shown.claims.left - shown.main.left) < 4, "one column");
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    await shot("phone-390-claim.png");
    await shot("phone-390-page.png", true);
    await closeReport();
    await openReport("pass-bench");
    await radio("Views of this desk", "Next steps").click();
    await until("the linked task", async () => (await desk().innerText()).includes("Quiet machine run"));
    await desk().scrollIntoViewIfNeeded();
    await shot("phone-390-next.png");
    await page.close();
  });
  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: report.unexpected.join("\n") });
  if (!report.reads.length) report.failures.push({ name: "reads", error: "the desk never read its numbers" });
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
