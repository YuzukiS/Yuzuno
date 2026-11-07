// YN-16 S5 in Chromium: the twelve samples of brief-samples.mjs on Home,
// every API answered here (no Core, no model), through the production build,
// in English and Simplified Chinese, light and dark, at 1440 px and on a
// phone (390 px, touch):
//  - every sample's card draws with no failed part;
//  - each of the eight that draw works on its card: one input, choice,
//    button, node, hotspot, step or event changes what the card shows, and
//    nothing opens the report;
//  - the four that do not draw show no interactive part, on the card or on
//    their report page;
//  - nothing is wider than the window, nothing is sent but reads, and
//    nothing is asked of another host.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node --experimental-strip-types tools/brief-samples-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";
import { SAMPLES } from "./brief-samples.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-16 S5", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "yuzuno-samples.test";
const PROJECT = "p-samples";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agents = [{ id: "l", name: "lead-1", harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/samples", projectId: PROJECT }];
const projects = [{ id: PROJECT, name: "sample-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "lead-1", state: "active" };
let id = 500;
// Each sample as Core keeps it: accepted by the real contract; its pictures kept, with their size.
const sections = SAMPLES.map((sample) => {
  const checked = checkBriefSection(sample.put);
  return { id: id++, key: checked.key, kind: "report", title: checked.title, version: 3, owner, updatedAt: at(10), updatedTurnId: "t1", body: checked.body,
    attachments: (sample.files ?? []).map((f) => ({ name: f.name, kind: "image", mime: "image/svg+xml", size: f.svg.length, snapshot: true, mayChange: false, takenAt: at(11), width: 400, height: 260 })),
    refs: { "task:T-12": { kind: "task", id: "T-12", found: true, key: "T-12", title: "Importer fix", state: "doing" } }, seen: null, history: false };
});
const files = Object.fromEntries(SAMPLES.flatMap((sample) => (sample.files ?? []).map((f) => [`/api/projects/${PROJECT}/brief/attachments/${sample.put.key}/${f.name}`, f.svg])));
const home = () => ({
  generatedAt: at(0), order: [PROJECT], needsYou: [],
  projects: [{ project: { id: PROJECT, name: "sample-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const INTERACTIVE = ".brief-input, .brief-calc, .brief-button, .brief-diagram, .brief-figure, .brief-steps, .brief-timeline";

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const theme of ["light", "dark"])
    for (const [name, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["phone-390", { width: 390, height: 844 }, true]])
      runs.push({ name: `${language}-${theme}-${name}`, language, theme, phone, viewport });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "brief-samples-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`brief-samples-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC", colorScheme: run.theme,
    ...(run.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addInitScript(([language, theme]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    if (!localStorage.getItem("yuzuno.selected.ws-s")) localStorage.setItem("yuzuno.selected.ws-s", JSON.stringify("l"));
  }, [run.language, run.theme]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    if (files[path]) return route.fulfill({ body: files[path], contentType: "image/svg+xml" });
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-s" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": home(),
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  const card = (sample) => page.locator(`#home-section-${PROJECT}-${sample.put.key}`);
  const live = (sample) => card(sample).locator(".home-card-frame.kind-interactive");
  const press = async (locator) => (run.phone ? locator.tap() : locator.click());
  const noReport = async (what) => {
    assert.equal(await page.locator(".home-report").count(), 0, `${what} opened no report`);
  };
  const text = async (sample) => (await live(sample).textContent()) ?? "";
  try {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await card(SAMPLES[0]).waitFor({ timeout: 15_000 });

    // ---- Every card draws, none with a failed part.
    for (const sample of SAMPLES) await card(sample).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator(".result-part-error").count(), 0, "no failed part");
    pass("all twelve sample cards draw with no failed part");

    // ---- The eight that draw: each works on its card; none opens the report.
    const by = Object.fromEntries(SAMPLES.map((sample) => [sample.id, sample]));
    const changed = {};
    const act = async (sampleId, doIt, settle) => {
      const sample = by[sampleId];
      await live(sample).waitFor({ timeout: 10_000 });
      const before = await text(sample);
      await doIt(live(sample));
      await page.waitForFunction(([sel, was]) => (document.querySelector(sel)?.textContent ?? "") !== was,
        [`#home-section-${PROJECT}-${sample.put.key} .home-card-frame.kind-interactive`, before], { timeout: 5000 });
      if (settle) await settle(live(sample));
      changed[sampleId] = true;
      await card(sample).screenshot({ path: join(output, `${run.name}-${sampleId}.png`) });
      result.shots.push(`${run.name}-${sampleId}.png`);
    };
    await act("recipe", (f) => press(f.locator(".brief-step").nth(1)), async (f) => assert.match(await f.textContent(), /313/));
    await act("bill", (f) => press(f.locator('[role="radio"]').nth(2)));
    await act("savings", async (f) => {
      await f.locator(".brief-number-field").last().focus();
      await page.keyboard.press("ArrowUp");
    });
    await act("parts", (f) => press(f.locator(".brief-figure-key-item").first()), async (f) =>
      assert.equal(await f.locator('[role="radio"][aria-checked="true"]').textContent(), "Frame"));
    await live(by.flow).locator(".brief-diagram svg").waitFor({ timeout: 10_000 });
    await act("flow", (f) => press(f.locator('.brief-diagram-node[data-node="ci"]')), async (f) => assert.match(await f.textContent(), /GitHub-hosted runners/));
    await act("wifi", (f) => press(f.locator(".brief-step-move").nth(1)), async (f) => assert.match(await f.textContent(), /Move closer/));
    await act("release", (f) => press(f.locator(".brief-timeline-items button").first()), async (f) => assert.match(await f.textContent(), /acceptance check/));
    await act("compare", (f) => press(f.locator('[role="radio"]').nth(1)), async (f) => assert.match(await f.textContent(), /0\.015/));
    await noReport("a sample's controls");
    pass("each of the eight samples that draw works on its card, opening no report", { changed });

    // ---- The four that do not draw: no interactive part on the card or the page.
    for (const sampleId of ["status", "yesno", "number", "task"]) {
      const sample = by[sampleId];
      assert.equal(await card(sample).locator(INTERACTIVE).count(), 0, `${sampleId}: nothing interactive on the card`);
      await card(sample).screenshot({ path: join(output, `${run.name}-${sampleId}.png`) });
      result.shots.push(`${run.name}-${sampleId}.png`);
    }
    // The page of one, opened by its title (a whole report has no Open report).
    const opener = card(by.task).locator(".home-summary-title-link, .home-report-open").first();
    if (await opener.count()) {
      await press(opener);
      const reportPage = page.locator(".home-report");
      await reportPage.waitFor({ timeout: 10_000 });
      assert.equal(await reportPage.locator(INTERACTIVE).count(), 0, "task: nothing interactive on the page");
      await press(reportPage.locator(".report-back"));
      await reportPage.waitFor({ state: "detached", timeout: 10_000 });
    }
    pass("the four samples that do not draw show no interactive part");

    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    pass("nothing wider than the window", widths);
  } finally {
    await context.close();
  }
}
