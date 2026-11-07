// T-34 S1: Settings → Executor templates in Chromium (en-US), with every API
// answered here (no Core, no CLI, no daily configuration). Through the real
// Settings: an empty list, a template added (its id following its label),
// its harness, permissions and instructions chosen, and saved as a whole list
// against the version read; the editor in Chinese after a language change in
// another window, unsaved text kept; on a phone, the editor fits its width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-templates-check.mjs
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
const report = { task: "T-34", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-templates.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// What Core keeps and answers (executor_templates::view).
let saved = { version: 0, templates: [] };
const view = () => ({ workspace: saved, available: saved.templates.map((template) => ({ template, source: "workspace" })),
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false,
  appliesTo: "Dispatches from a template from now on; executors already created keep their own settings." });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (path === "/api/executor-templates" && method === "PUT") {
    const body = JSON.parse(request.postData() || "{}");
    report.writes.push({ method, path, body });
    if (body.expectedVersion !== saved.version) return route.fulfill({ status: 400, json: { error: "version_conflict: these executor templates changed; reload before saving" } });
    saved = { version: saved.version + 1, templates: body.templates };
    return route.fulfill({ json: view() });
  }
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-templates" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/executor-templates": view(),
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

async function openEditor(page) {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("executor");
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "Executor templates" }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator("#settings-editor-executor-templates");
  await box.waitFor({ timeout: 10_000 });
  return box;
}
// Whether the editor, and each field in it, fits its own width.
const fits = (box) => box.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, select, textarea, button")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));

const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();
try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // Settings › Executors' one save bar (YN-8 S5), below the page's blocks.
  const bar = page.locator(".settings-savebar:not([hidden])");
  // ---- An empty list; a template added and saved.
  let box = await openEditor(page);
  await box.getByText("No template yet: a dispatch makes a general executor.").waitFor({ timeout: 10_000 });
  assert.equal(await bar.count(), 0, "nothing to save yet");
  assert.equal(await box.getByRole("button", { name: "Save templates" }).count(), 0, "no Save of its own on the page");
  await box.getByRole("button", { name: "Add template" }).click();
  await box.locator('input[aria-label="Label"]').fill("Code reviewer");
  assert.equal(await box.locator('input[aria-label="Id"]').inputValue(), "code-reviewer", "a new template's id follows its label");
  await box.locator('select[aria-label="Harness"]').selectOption("claude");
  await box.locator('select[aria-label="Permissions"]').selectOption("auto");
  await box.locator('textarea[aria-label="Instructions"]').fill("Read the acceptance first, then the linked PR.");
  await bar.getByText("1 change not saved").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(output, "1-unsaved.png") });
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await box.getByText("Saved.").waitFor({ timeout: 10_000 });
  const put = report.writes.find((w) => w.path === "/api/executor-templates");
  assert.deepEqual(put.body, { expectedVersion: 0, templates: [{ id: "code-reviewer", label: "Code reviewer", harness: "claude",
    permissionMode: "auto", instructions: "Read the acceptance first, then the linked PR." }] });
  await bar.getByText("All changes saved.").waitFor({ timeout: 10_000 }); // what was saved is what is shown
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "the editor fits its width");
  await page.screenshot({ path: join(output, "2-saved.png") });
  check("a template added, its id following its label, and saved as the whole list against version 0", { body: put.body });

  // ---- In Chinese after a language change elsewhere; unsaved text kept.
  // The template's page (YN-8 S5b) stays open: its way back names the list.
  await box.locator('textarea[aria-label="Instructions"]').fill("Read the acceptance first.");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  await box.locator(".settings-crumb", { hasText: "执行者模板" }).waitFor({ timeout: 10_000 });
  assert.equal(await box.getAttribute("lang"), "zh-Hans");
  assert.equal(await box.locator('textarea[aria-label="说明"]').inputValue(), "Read the acceptance first.", "the unsaved text stays");
  await bar.getByText("1 处更改还没保存").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(output, "3-zh.png") });
  check("in Chinese after a language change in another window, the unsaved text kept");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await box.locator(".settings-crumb", { hasText: "Executor templates" }).waitFor({ timeout: 10_000 });

  // ---- On a phone: the editor fits.
  // The same fixture, at a phone's width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  box = await openEditor(page);
  // The list, then a template's page (YN-8 S5b).
  await box.locator(".executor-template-row").first().waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "on a phone the list fits its width");
  await page.screenshot({ path: join(output, "4-phone-list.png"), fullPage: false });
  await box.locator(".executor-template-row").first().click();
  await box.locator('input[aria-label="Label"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(box), { box: true, wider: [] }, "on a phone the editor fits its width");
  await page.screenshot({ path: join(output, "4-phone.png"), fullPage: false });
  check("at 390 px the list, the template's page and each field fit their width");

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), ["PUT /api/executor-templates"], "one save, nothing else written");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
