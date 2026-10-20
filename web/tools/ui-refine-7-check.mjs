// UI refine 7 in a browser, on a production build with every API answered
// here: Home spans the pane in columns with a widget column (Machines first),
// arranged per device; the turn dock follows its Settings sliders.
// Screenshots for review; no Core.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/ui-refine-7-browser");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], mutations: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "" };
const agent = { ...base, id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1",
  settings: { reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write", permissionPreset: "ask" },
  connectionState: "connected", threadId: "thread-a" };
const projects = [
  { id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Research", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const turns = Array.from({ length: 24 }, (_, n) => ({
  id: `t${n}`,
  status: "completed",
  items: [
    { id: `u${n}`, type: "userMessage", content: [{ type: "text", text: `Step ${n + 1}: tidy the next part of the layout.` }] },
    { id: `r${n}`, type: "agentMessage", text: `Done with step ${n + 1}. The layout keeps its place while it updates.` },
  ],
}));
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const section = (key, title, text) => ({ key, kind: "report", title, version: 1, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: ago(5), updatedTurnId: "t1", body: markdown(text), attachments: [], refs: {}, seen: null, history: false });
const counts = (working, idle) => ({ working, idle, waiting: 0, error: 0, offline: 0, total: working + idle });
const home = {
  generatedAt: ago(0),
  order: ["p1", "p2"],
  needsYou: [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "release", title: "Ship today?", since: ago(20) }],
  projects: [
    { project: { id: "p1", name: "Yuzuno" }, agents: counts(1, 0), errors: [], pending: [], jobs: [], unseen: 1, missing: [],
      brief: { version: 3, history: [], sections: [
        { ...section("release", "Ship today?", "The release is ready."), kind: "ask",
          ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait" }], freeText: true } } },
        section("progress", "Progress", "**Home** now spans the pane, with a column of widgets beside the projects."),
      ] } },
    { project: { id: "p2", name: "Research" }, agents: counts(0, 1), errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: { version: 1, history: [], sections: [section("plan", "Plan", "Three experiments queued for tonight.")] } },
  ],
};
const machineLoad = {
  at: ago(0),
  cpu: { cores: 32, totalPct: 38, jobsPct: 12, agentsPct: 9, otherPct: 17 },
  memory: { totalMiB: 40960, usedMiB: 18432, availableMiB: 22528, jobsMiB: 4096, agentsMiB: 3072 },
  gpus: [{ name: "GPU 0", utilPct: 41, memUsedMiB: 6144, memTotalMiB: 24576 }],
  jobs: [{ id: "job-1", name: "web-check", agentId: "a", agentName: "Mori", projectId: "p1", cpuPct: 12, memMiB: 2048 }],
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.hostname, "yuzuno-ui-refine-7.test");
    const path = url.pathname;
    // The project panels read their repositories' activity through the
    // collaboration API, as a POST that changes nothing.
    if (method === "POST" && path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      report.mutations.push({ method, path });
      if (method === "POST" && /^\/api\/agents\/[^/]+\/review$/.test(path)) return route.fulfill({ json: {} });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-7" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
      "/api/home": home,
      "/api/machine-load": machineLoad,
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
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
  const shot = (name) => page.screenshot({ path: resolve(output, name), animations: "disabled" });
  const box = (selector) => page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  });

  await page.goto("http://yuzuno-ui-refine-7.test/");
  await page.locator(".catchup-nav").first().click();
  await page.locator(".home-layout .home-machine:not([aria-busy])").waitFor();

  // Wide: the pane's whole width, projects on the left, widgets on the right.
  const pane = await box(".home-view");
  const needs = await box(".home-needs-area");
  const main = await box(".home-main");
  const widgets = await box(".home-widget-column");
  assert.ok(pane.width > 1000, `Home spans the pane: ${JSON.stringify(pane)}`);
  assert.ok(widgets.left >= main.right && widgets.left >= needs.right, `widgets beside: ${JSON.stringify({ needs, main, widgets })}`);
  assert.ok(Math.abs(widgets.top - needs.top) <= 2, "the widget column starts level with Needs you");
  // Its heading too: no padding from the panels' own .home-widgets rules.
  const head = await box(".home-widget-column-head");
  assert.ok(Math.abs(head.top - needs.top) <= 2, `the column heading is level with Needs you: ${JSON.stringify({ head, needs })}`);
  assert.ok(widgets.width >= 300 && widgets.width <= 400, `widget column width ${widgets.width}`);
  assert.equal(await page.locator('.home-widget-column [data-widget="machines"] .home-machines').count(), 1);
  await shot("home-1440.png");
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.waitForTimeout(150);
  assert.ok((await box(".home-view")).width > 1400, "still the whole pane when wider");
  await shot("home-1920.png");
  check("wide Home spans the pane: Needs you and projects on the left, a 300–400 px widget column with Machines on the right", { pane, widgets });

  // Narrow pane: one column, the widgets between Needs you and the projects.
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForTimeout(150);
  const n = { needs: await box(".home-needs-area"), widgets: await box(".home-widget-column"), main: await box(".home-main") };
  assert.ok(n.widgets.top >= n.needs.bottom && n.main.top >= n.widgets.bottom, `one column: ${JSON.stringify(n)}`);
  assert.ok(await page.locator(".home-view").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "no sideways scroll");
  await shot("home-820.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.ok(await page.locator(".home-view").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "no sideways scroll at 390");
  await shot("home-390.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  check("a narrow pane stacks Needs you, the widgets, then the projects, with no sideways scroll at 820 and 390 px");

  // Arranging: hide and show Machines again; the choice is kept on the device.
  const column = page.locator(".home-widget-column");
  await column.getByRole("button", { name: "Arrange" }).click();
  await shot("home-arrange.png");
  await column.getByRole("button", { name: "Hide Machines" }).click();
  await page.locator(".home-widget-column .home-machines").waitFor({ state: "detached" });
  await shot("home-widget-hidden.png");
  await column.locator(".home-widget-column-add").getByRole("button", { name: "Machines" }).click();
  await page.locator(".home-widget-column .home-machines").waitFor();
  await column.getByRole("button", { name: "Done" }).click();
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("yuzuno.homeWidgets.ws-7"))), { order: ["machines"], hidden: [], pins: [] });
  await column.getByRole("button", { name: "Manage" }).click();
  await page.getByRole("dialog").getByText("Where your agents run", { exact: false }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  check("widgets are arranged in place: Machines hides, comes back, and Manage opens the Machines page");

  // The turn dock follows its Settings.
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page.locator(".turn-dock .turn-dock-chip").first().waitFor();
  const dock = async () => ({
    numbers: await page.locator(".turn-dock .turn-dock-chip").count(),
    bars: await page.locator(".turn-dock .turn-dock-bar").count(),
  });
  assert.deepEqual(await dock(), { numbers: 5, bars: 5 });
  await page.getByRole("button", { name: "Settings and updates", exact: true }).click();
  const settings = page.locator(".modal.settings-modal");
  await page.locator("#settings-tab-appearance").click();
  const numbers = settings.locator('input[name="appearance-turn-numbers"]');
  const bars = settings.locator('input[name="appearance-turn-bars"]');
  assert.deepEqual([await numbers.getAttribute("max"), await bars.getAttribute("max")], ["12", "10"]);
  await numbers.fill("8");
  await bars.fill("2");
  await settings.locator(".dock-limits").nth(1).scrollIntoViewIfNeeded();
  await shot("settings-turn-dock.png");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  assert.deepEqual(await dock(), { numbers: 8, bars: 2 });
  await shot("turn-dock-8-2.png");
  await page.getByRole("button", { name: "Settings and updates", exact: true }).click();
  await page.locator("#settings-tab-appearance").click();
  await numbers.fill("0");
  assert.equal(await settings.locator('input[name="appearance-turn-numbers"] ~ output').textContent(), "Hidden");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  await page.locator(".turn-dock").waitFor({ state: "detached" });
  await shot("turn-dock-hidden.png");
  // Ten bars each side: the fade spreads over all ten, so the farthest
  // still shows (6 px at 0.18, as the fifth did with five).
  await page.getByRole("button", { name: "Settings and updates", exact: true }).click();
  await page.locator("#settings-tab-appearance").click();
  await numbers.fill("5");
  await bars.fill("10");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  await page.locator(".turn-dock .turn-dock-chip").first().waitFor();
  assert.deepEqual(await dock(), { numbers: 5, bars: 10 });
  const faintest = await page.locator(".turn-dock .turn-dock-bar").evaluateAll((bars) =>
    bars.map((bar) => ({ width: bar.getBoundingClientRect().width, opacity: Number(getComputedStyle(bar).opacity) }))
      .reduce((least, bar) => (bar.width < least.width ? bar : least)));
  assert.ok(faintest.width >= 5.5 && faintest.opacity >= 0.17, `the farthest bar is visible: ${JSON.stringify(faintest)}`);
  await shot("turn-dock-5-10.png");
  check("the turn dock numbers 8 turns with 2 bars, 0 hides it, and all ten bars on a side stay visible", { faintest });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mutations.filter((m) => !/\/review$/.test(m.path)), [], "no writes");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
}
