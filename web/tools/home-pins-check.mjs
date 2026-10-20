// Brief sections pinned to Home's widget column (T-115), in a browser.
// - A status section pins from its card; the widget shows the same body as
//   the project (Columns included), its project, author and update time, and
//   leads back to the source. Asks and team content offer no pin.
// - Pinning, viewing and reloading post nothing to Core (no Seen), and the
//   needs-you count is the same; the layout holds through a reload and an
//   Agent's new version, which changes only the content.
// - A pin hides and shows again apart from Unpin; a section removed and
//   written again under its key, or an ask now under it, is not shown as it.
// - Another workspace on the same device has its own layout.
// - Light and dark, 1440 and 390 px: no sideways scroll; screenshots.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/home-pins");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-pins.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [] };
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

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "sora", name: "Sora", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null };
const projects = [{ id: "p1", name: "Curve study", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "sora", name: "Sora", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const body = (children, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, children), ...elements } });
const overviewBody = (progress) => body(["now", "split"], {
  now: node("Group", { title: "Where we are", tone: "accent" }, ["summary"]),
  summary: md("Run 12 is converging."),
  split: node("Columns", { widths: [3, 2] }, ["work", "next"]),
  work: node("Group", { title: "Progress" }, ["progress"]),
  progress: md(progress),
  next: node("Group", { title: "Next" }, ["decisions"]),
  decisions: node("Checklist", { items: [{ id: "split", text: "Choose the run 13 split", done: false }] }),
});
const section = (fields) => ({ attachments: [], refs: {}, seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN), owner, ...fields });
const f = {
  version: 4,
  sections: [
    section({ id: 11, key: "overview", kind: "status", title: "Curve study overview", version: 3, body: overviewBody("Run 12 is running."),
      status: { asOf: iso(-5 * MIN), validFor: 86400, stale: false } }),
    section({ id: 12, key: "decide", kind: "ask", title: "Which split for run 13?", version: 1, body: body(["why"], { why: md("The larger split costs 6% of data.") }),
      ask: { question: "Larger split or keep?", state: "open", reply: { options: [{ id: "larger", label: "Larger" }, { id: "keep", label: "Keep" }] } } }),
  ],
  teamSections: [section({ id: 13, key: "old", kind: "report", title: "Earlier notes", version: 1, body: body(["n"], { n: md("Before editors were chosen.") }) })],
};
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: f.sections.filter((s) => s.kind === "ask" && s.ask.state === "open")
    .map((s) => ({ kind: "ask", projectId: "p1", agentId: "sora", agentName: "Sora", sectionKey: s.key, title: s.title, since: s.updatedAt })),
  projects: [{
    project: { id: "p1", name: "Curve study" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: f.version, sections: f.sections, teamSections: f.teamSections, history: [] },
    unseen: f.sections.filter((s) => !s.seen).length, missing: [],
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
const serve = (workspaceId) => async (route) => {
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
  const json = {
    "/api/workspace": () => ({ workspace: { id: workspaceId }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/sora": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci": () => noCiRuns,
    // Live CI for the Agents' waiting badges, polled by the app since T-122.
    "/api/ci/live": () => ({ agents: {} }),
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
};
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
async function open(ctx, workspaceId, theme = "light", width = 1440) {
  const tab = await ctx.newPage();
  await tab.setViewportSize({ width, height: 900 });
  await tab.addInitScript(({ theme }) => {
    window.EventSource = class {
      constructor() {
        window.__homeEvents = this;
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance") || "{}");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme, fontSize: 16, palette: "garden" }));
  }, { theme });
  tab.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  tab.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await tab.route("**/*", serve(workspaceId));
  await tab.goto(`https://${HOST}/`);
  await toHome(tab);
  return tab;
}
/** The app reopens the last conversation on a reload; Home is one click away. */
async function toHome(tab) {
  await tab.locator(".toolbar-nav .catchup-nav").first().waitFor();
  if (!(await tab.locator(".home-view").isVisible())) await tab.locator(".toolbar-nav .catchup-nav").first().click();
  await tab.locator('.home-view [data-section-key="overview"]').waitFor();
}
const column = () => page.locator(".home-widget-column");
const pinned = () => column().locator(".home-pinned");
const layout = (workspaceId) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), `yuzuno.homeWidgets.${workspaceId}`);
const briefChanged = () =>
  page.evaluate(() => window.__homeEvents?.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: "" }));
const needs = () => page.locator(".home-needs-you h2").innerText();

try {
  page = await open(context, "ws-a");
  const before = await needs();
  await step("a status pins from its card; asks and team content offer no pin", async () => {
    const card = (key) => page.locator(`.home-view .home-main [data-section-key="${key}"]`);
    assert.equal(await card("decide").locator(".home-pin").count(), 0, "an ask offers no pin");
    assert.equal(await page.locator('.home-view [data-section-key="old"] .home-pin').count(), 0, "team content offers no pin");
    await card("overview").getByRole("button", { name: "Pin “Curve study overview” to Widgets" }).click();
    await pinned().waitFor();
    assert.equal(await card("overview").locator(".home-pin").getAttribute("aria-pressed"), "true");
    assert.match(await pinned().locator(".home-pinned-from").innerText(), /^Curve study · Sora · Updated /);
    // The same body as in the project: its columns stack in the narrow column.
    assert.equal(await pinned().locator(".brief-columns").count(), 1);
    assert.match(await pinned().locator(".home-pinned-body").innerText(), /Run 12 is running\./);
    assert.deepEqual((await layout("ws-a")).pins, [{ projectId: "p1", key: "overview", id: 11, title: "Curve study overview", projectName: "Curve study" }]);
    await column().screenshot({ path: resolve(output, "pinned-light-1440.png") });
  });
  await step("pinning, reading and reloading tell Core nothing; Needs you counts the same; the layout holds", async () => {
    assert.equal(await needs(), before);
    await page.reload();
    await toHome(page);
    await pinned().waitFor();
    assert.match(await pinned().innerText(), /Run 12 is running\./);
    assert.equal(await needs(), before);
    assert.deepEqual(report.writes, [], "no Seen or any other write");
  });
  await step("an Agent's new version changes the content, never the layout", async () => {
    const saved = JSON.stringify(await layout("ws-a"));
    Object.assign(f.sections[0], { version: 4, body: overviewBody("Run 12 is done; ablations started."), updatedAt: new Date().toISOString() });
    f.version += 1;
    await briefChanged();
    await until("the new version in the widget", async () => /ablations started/.test(await pinned().innerText()));
    assert.equal(JSON.stringify(await layout("ws-a")), saved);
  });
  await step("hidden, a pin stays pinned and shows again; Unpin is separate; Open leads to the source", async () => {
    await column().getByRole("button", { name: "Arrange" }).click();
    await column().getByRole("button", { name: "Hide Curve study overview" }).click();
    await pinned().waitFor({ state: "detached" });
    assert.equal((await layout("ws-a")).pins.length, 1);
    await column().locator(".home-widget-column-add").getByRole("button", { name: "Curve study overview" }).click();
    await pinned().waitFor();
    assert.equal(await column().getByRole("button", { name: "Unpin Curve study overview" }).count(), 1);
    await column().getByRole("button", { name: "Done" }).click();
    await pinned().getByRole("button", { name: "Open in Curve study" }).click();
    await until("the source highlighted", () => page.locator('.home-main [data-section-key="overview"][data-home-highlight]').count());
  });
  await step("a section written again under the key is another section; an ask under it is not offered", async () => {
    const original = { ...f.sections[0] };
    Object.assign(f.sections[0], { id: 21, version: 1, body: overviewBody("Someone's new overview.") });
    f.version += 1;
    await briefChanged();
    await until("the pin sees another section", async () => (await pinned().getAttribute("data-pin-state")) === "replaced");
    assert.doesNotMatch(await pinned().innerText(), /new overview/);
    assert.equal(await pinned().getByRole("button", { name: "Pin the new section" }).count(), 1);
    Object.assign(f.sections[0], { kind: "ask", ask: { question: "Keep it?", state: "open", reply: { options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] } } });
    f.version += 1;
    await briefChanged();
    await until("no pin offered for an ask", async () => (await pinned().getByRole("button", { name: "Pin the new section" }).count()) === 0);
    await column().screenshot({ path: resolve(output, "replaced-light-1440.png") });
    f.sections[0] = original;
    f.version += 1;
    await briefChanged();
    await until("the pinned section again", async () => (await pinned().getAttribute("data-pin-state")) === "shown");
  });
  await step("another workspace on this device has its own layout", async () => {
    const other = await open(context, "ws-b");
    assert.equal(await other.locator(".home-widget-column .home-pinned").count(), 0);
    assert.equal(await other.evaluate(() => localStorage.getItem("yuzuno.homeWidgets.ws-b")), null);
    await other.close();
  });
  await step("light and dark at 1440 and 390 px: the pinned section fits, nothing scrolls sideways", async () => {
    const shots = {};
    for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 390], ["dark", 390]]) {
      const tab = await open(context, "ws-a", theme, width);
      await tab.locator(".home-widget-column .home-pinned").waitFor();
      const fit = await tab.evaluate(() => {
        const view = document.querySelector(".home-view");
        const pin = document.querySelector(".home-pinned");
        return { page: document.documentElement.scrollWidth > innerWidth, view: view.scrollWidth > view.clientWidth + 1, pin: pin.scrollWidth > pin.clientWidth + 1 };
      });
      assert.deepEqual(fit, { page: false, view: false, pin: false }, `${theme}-${width}`);
      await tab.locator(".home-widget-column .home-pinned").scrollIntoViewIfNeeded();
      await tab.locator(".home-widget-column .home-pinned").screenshot({ path: resolve(output, `pinned-${theme}-${width}.png`) });
      shots[`${theme}-${width}`] = fit;
      await tab.close();
    }
    return { shots };
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
