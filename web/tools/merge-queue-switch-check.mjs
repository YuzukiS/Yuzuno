// T-37 S2b: a repository's merge queue switch in a Project's settings, in
// Chromium, with every API answered here (no Core, no CLI, no daily
// configuration). Through the real Manage projects dialog: off says Core
// writes nothing; turning it on lists every write first and saves nothing
// until confirmed; off saves at once; a paused queue says why and unpauses;
// in Chinese after a language change in another window; on a phone, the row
// fits its width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/merge-queue-switch-check.mjs
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
const report = { task: "T-37", checks: [], reads: [], writes: [], unexpected: [], errors: [], console: [], unmodelled: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-merge-queue-switch.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture/lab", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected", closedAt: null };
const projects = [{ id: "p1", name: "Lab", defaultDirs: { local: "/fixture/lab" }, archivedAt: null, createdAt: "", updatedAt: "" }];
const repositories = [{ id: 7, fullName: "owner/repo", url: "https://github.com/owner/repo", syncedAt: new Date().toISOString(), error: null }];
// What Core keeps for the repository (merge_queue::store::repository).
const queue = { repositoryId: 7, enabled: false, paused: null, landing: "core-merge" };
const templates = { workspace: { version: 0, templates: [] }, project: { id: "p1", version: 0, templates: [] }, available: [],
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false };
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}${url.search}`);
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) {
    return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  }
  if (path === "/api/merge-queue/repositories/7") {
    if (method === "PUT") {
      const body = JSON.parse(request.postData() || "{}");
      report.writes.push({ method, path, body });
      if (typeof body.enabled === "boolean") queue.enabled = body.enabled;
    }
    return route.fulfill({ json: queue });
  }
  if (path === "/api/merge-queue/repositories/7/unpause" && method === "POST") {
    report.writes.push({ method, path, body: JSON.parse(request.postData() || "{}") });
    queue.paused = null;
    return route.fulfill({ json: { repositoryId: 7, unpaused: true } });
  }
  // Reads that are POSTs, and change nothing: the dialog's GitHub links.
  if (method === "POST" && ["/api/collaboration/github_repositories", "/api/collaboration/github_refresh", "/api/collaboration/github_links"].includes(path))
    return route.fulfill({ json: { repositories, links: [], refreshing: false } });
  if (method === "POST" && path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false, nextAfterSeq: null } });
  if (method !== "GET" && path.startsWith("/api/")) {
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/executor-templates") return route.fulfill({ json: templates });
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws-merge-queue-switch" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": () => ({ generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] }),
    "/api/updates": () => unmanagedUpdates, "/api/jobs/budget": () => idleJobsBudget, "/api/jobs": () => noJobs, "/api/jobs/live": () => noLiveJobs,
    "/api/ci": () => noCiRuns, "/api/reviews": () => noReviews, "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] }),
    "/api/models": () => ({ models: [] }),
    "/api/projects/p1/services": () => ({ services: [] }),
    "/api/projects/p1/home-editors": () => ({ version: 0, editorAgentIds: null }),
    "/api/projects/p1/handover": () => ({ projectId: "p1", version: 0, markdown: "", history: [], limit: 32 * 1024 }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path === "/api/agents/a") return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (path.endsWith("/codex/usage")) return route.fulfill({ json: usage });
  if (path.endsWith("/codex/mcp")) return route.fulfill({ json: mcp });
  if (path.startsWith("/api/")) {
    report.unmodelled[path] = (report.unmodelled[path] || 0) + 1;
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    await route.fulfill({ status: 404, body: "" });
  }
}

async function openRow(page) {
  await page.locator(".workspace-scope").first().click({ timeout: 10_000 });
  await page.locator("button", { hasText: /^Manage projects…$/ }).click({ timeout: 10_000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.locator("button", { hasText: "Lab" }).first().click({ timeout: 10_000 });
  const row = dialog.locator(".merge-queue-switch").first();
  await row.locator('input[role="switch"]').waitFor({ timeout: 10_000 });
  await row.scrollIntoViewIfNeeded();
  return row;
}
// Whether the row, and each control and line in it, fits its own width.
const fits = (row) => row.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, button, small, p, li")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.textContent.slice(0, 40)),
}));
const queueWrites = () => report.writes.filter((w) => w.path.startsWith("/api/merge-queue/"));

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 50); } close() {} };
});
await context.route("**/*", serve);
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
// Kept for reading a failure; not counted.
page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
const other = await context.newPage();
try {
  await page.goto(`https://${HOST}/`);
  await page.locator(".workspace-scope").first().waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- Off: Core writes nothing; turning it on lists every write first.
  let row = await openRow(page);
  assert.equal(await row.getAttribute("aria-label"), "Merge queue for owner/repo");
  await row.getByText("Off: Core writes nothing to GitHub here.").waitFor({ timeout: 10_000 });
  await row.getByText("Lands with core-merge: Core sends the merge itself.", { exact: false }).waitFor({ timeout: 10_000 });
  await row.screenshot({ path: join(output, "1-off.png") });
  await row.locator('input[role="switch"]').click();
  const confirm = row.locator(".merge-queue-confirm");
  await confirm.waitFor({ timeout: 10_000 });
  const listed = await confirm.textContent();
  for (const words of ["a merge commit pinned to the released head", "queue/merge-", "a draft PR from it", "closing that draft PR and deleting its branch", "never force-pushes"])
    assert.ok(listed.includes(words), words);
  assert.equal(await row.locator('input[role="switch"]').isChecked(), false, "the switch stays off while it asks");
  assert.equal(queueWrites().length, 0, "nothing is saved before the confirmation");
  await row.screenshot({ path: join(output, "2-confirm.png") });
  check("off says Core writes nothing; turning it on lists every write, and nothing is saved before the confirmation");

  await confirm.getByRole("button", { name: "Turn on" }).click();
  await row.getByText("On: Core merges PRs released for merge in this repository.").waitFor({ timeout: 10_000 });
  assert.deepEqual(queueWrites().map((w) => w.body), [{ enabled: true }]);
  await row.locator('input[role="switch"]').click();
  await row.getByText("Off: Core writes nothing to GitHub here.").waitFor({ timeout: 10_000 });
  assert.deepEqual(queueWrites().map((w) => w.body), [{ enabled: true }, { enabled: false }], "off saves at once");
  assert.equal(await row.locator(".merge-queue-confirm").count(), 0, "with no confirmation");
  check("Turn on saves the switch on; off saves at once with no confirmation", { writes: queueWrites().map((w) => w.body) });

  // ---- A paused queue says why and unpauses.
  queue.enabled = true;
  queue.paused = { reason: "main_red", detail: "Main CI run 91 concluded failure", main: "b".repeat(40) };
  await page.reload();
  await page.locator(".workspace-scope").first().waitFor({ timeout: 10_000 });
  row = await openRow(page);
  const paused = row.locator(".merge-queue-paused");
  await paused.getByText("Paused: main_red").waitFor({ timeout: 10_000 });
  await paused.getByText("Main CI run 91 concluded failure").waitFor({ timeout: 10_000 });
  await row.screenshot({ path: join(output, "3-paused.png") });
  await paused.getByRole("button", { name: "Unpause" }).click();
  await paused.waitFor({ state: "detached", timeout: 10_000 });
  const unpause = queueWrites().find((w) => w.path.endsWith("/unpause"));
  assert.match(unpause?.body?.requestId || "", /^[0-9a-f-]{36}$/, "the unpause carries a request id");
  check("a paused queue shows Core's reason and detail as given, and Unpause ends it");

  // ---- In Chinese after a language change elsewhere.
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  await page.locator('.merge-queue-switch[aria-label="owner/repo 的合并队列"]').waitFor({ timeout: 10_000 });
  row = page.locator(".merge-queue-switch").first();
  await row.getByText("已开启：Core 合并此仓库中已放行合并的 PR。").waitFor({ timeout: 10_000 });
  await row.getByText("落地方式 core-merge", { exact: false }).waitFor({ timeout: 10_000 });
  await row.screenshot({ path: join(output, "4-zh.png") });
  check("in Chinese after a language change in another window");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await page.locator('.merge-queue-switch[aria-label="Merge queue for owner/repo"]').waitFor({ timeout: 10_000 });

  // ---- On a phone: the row and its confirmation fit.
  queue.enabled = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".workspace-scope").first().waitFor({ timeout: 10_000 });
  row = await openRow(page);
  await row.locator('input[role="switch"]').click();
  await row.locator(".merge-queue-confirm").waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(row), { box: true, wider: [] }, "on a phone the row and its confirmation fit their width");
  await row.screenshot({ path: join(output, "5-phone.png") });
  await row.getByRole("button", { name: "Cancel" }).click();
  check("at 390 px the row and its confirmation fit their width");

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), [
    "PUT /api/merge-queue/repositories/7", "PUT /api/merge-queue/repositories/7", "POST /api/merge-queue/repositories/7/unpause",
  ], "the switch on, off and one unpause; nothing else written");
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
