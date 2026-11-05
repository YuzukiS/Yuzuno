// T-34 S3a: a Project's handover document in its settings, in Chromium, with
// every API answered here (no Core, no CLI, no daily configuration). Through
// the real Manage projects dialog: an empty document written and saved as
// version 1 against version 0, its past version shown; a save after another
// window saved refused as a conflict, the typed text kept, then reloaded; the
// section in Chinese after a language change in another window, unsaved text
// kept; on a phone, the section and its fields fit their width.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/project-handover-check.mjs
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
const report = { task: "T-34", checks: [], reads: [], writes: [], unexpected: [], errors: [], console: [], unmodelled: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-project-handover.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture/lab", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected", closedAt: null };
const projects = [{ id: "p1", name: "Lab", defaultDirs: { local: "/fixture/lab" }, archivedAt: null, createdAt: "", updatedAt: "" }];
// What Core keeps and answers (handover::read_in).
const versions = [];
const answer = () => ({
  projectId: "p1",
  version: versions.length,
  markdown: versions.at(-1)?.markdown ?? "",
  history: [...versions].reverse().map(({ markdown, ...v }) => ({ ...v, bytes: Buffer.byteLength(markdown) })),
  limit: 32 * 1024,
});
const write = (markdown, reason) => versions.push({ version: versions.length + 1, markdown, writtenBy: { id: "user", name: "You" },
  approvedBy: null, reason: reason ?? null, at: new Date(Date.UTC(2026, 10, 5, 8, versions.length)).toISOString() });
const templates = { workspace: { version: 0, templates: [] }, project: { id: "p1", version: 0, templates: [] }, available: [],
  defaultNamePattern: "{task} · {label}", limits: { templates: 50, instructionsBytes: 8192, maxConcurrent: 64 }, opencodeEnabled: false };
// Well-formed answers for what the selected Agent's panels read: `{}` there
// sends the app to its error boundary with no page error (browser pitfalls).
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
  if (path === "/api/projects/p1/handover") {
    if (method === "PUT") {
      const body = JSON.parse(request.postData() || "{}");
      report.writes.push({ method, path, body });
      if (body.expectedVersion !== versions.length) return route.fulfill({ status: 400, json: { error: "version_conflict: this Project's handover changed; reload before saving" } });
      write(body.markdown, body.reason);
      return route.fulfill({ json: answer() });
    }
    const asked = url.searchParams.get("version");
    if (asked) {
      const past = versions[Number(asked) - 1];
      return route.fulfill({ json: { projectId: "p1", past: { ...past, bytes: Buffer.byteLength(past.markdown) } } });
    }
    return route.fulfill({ json: answer() });
  }
  // Reads that are POSTs, and change nothing: the dialog's GitHub links.
  if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
  if (method === "POST" && ["/api/collaboration/github_links", "/api/collaboration/github_refresh"].includes(path))
    return route.fulfill({ json: { links: [], repositories: [], refreshing: false } });
  if (method === "POST" && path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false, nextAfterSeq: null } });
  if (method !== "GET" && path.startsWith("/api/")) {
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/executor-templates") return route.fulfill({ json: templates });
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws-project-handover" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": () => ({ generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] }),
    "/api/updates": () => unmanagedUpdates, "/api/jobs/budget": () => idleJobsBudget, "/api/jobs": () => noJobs, "/api/jobs/live": () => noLiveJobs,
    "/api/ci": () => noCiRuns, "/api/reviews": () => noReviews, "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] }),
    "/api/models": () => ({ models: [] }),
    "/api/projects/p1/services": () => ({ services: [] }),
    "/api/projects/p1/home-editors": () => ({ version: 0, editorAgentIds: null }),
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

async function openSection(page) {
  await page.locator(".workspace-scope").first().click({ timeout: 10_000 });
  await page.locator("button", { hasText: /^Manage projects…$/ }).click({ timeout: 10_000 });
  const dialog = page.locator('[role="dialog"]').first();
  await dialog.locator("button", { hasText: "Lab" }).first().click({ timeout: 10_000 });
  const section = dialog.locator("#project-settings-handover");
  await section.waitFor({ timeout: 10_000 });
  await section.scrollIntoViewIfNeeded();
  return section;
}
// Whether the section, and each field in it, fits its own width.
const fits = (section) => section.evaluate((el) => ({
  box: el.scrollWidth <= el.clientWidth + 1,
  wider: [...el.querySelectorAll("input, textarea, button")].filter((c) => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).map((c) => c.getAttribute("aria-label") || c.textContent),
}));

const saves = () => report.writes.filter((w) => w.path === "/api/projects/p1/handover");

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

  // ---- An empty document, written and saved as version 1.
  let section = await openSection(page);
  await section.getByText("No version yet.").waitFor({ timeout: 10_000 });
  assert.equal(await section.getByRole("button", { name: "Save handover" }).isDisabled(), true, "nothing to save yet");
  const first = "# Lab\n\nBuild with `make`; test with `make check`.\nThe fixtures live in tests/fixtures.";
  await section.locator('textarea[aria-label="Handover document"]').fill(first);
  await section.locator('input[aria-label="Why this change"]').fill("First notes");
  await section.getByText("Unsaved changes").waitFor({ timeout: 10_000 });
  await section.getByText(`${Buffer.byteLength(first)} of 32768 bytes.`).waitFor({ timeout: 10_000 });
  await section.screenshot({ path: join(output, "1-unsaved.png") });
  await section.getByRole("button", { name: "Save handover" }).click();
  await section.getByText("Saved.").waitFor({ timeout: 10_000 });
  assert.deepEqual(saves()[0]?.body, { expectedVersion: 0, markdown: first, reason: "First notes" }, "a save names the version it was read at");
  await section.getByText("Version 1", { exact: true }).waitFor({ timeout: 10_000 });
  await section.getByText("First notes", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await section.locator('input[aria-label="Why this change"]').inputValue(), "", "the reason goes with the version saved");
  await section.getByRole("button", { name: "Show version 1" }).click();
  assert.equal(await section.locator(".project-handover-past").textContent({ timeout: 10_000 }), first, "a past version is readable");
  assert.deepEqual(await fits(section), { box: true, wider: [] }, "the section fits its width");
  await section.screenshot({ path: join(output, "2-saved.png") });
  check("an empty document written and saved as version 1 against version 0, its reason kept and the version readable", { body: saves()[0].body });

  // ---- Another window saved meanwhile: refused as a conflict, the typed text kept, then reloaded.
  write("# Lab\n\nSaved in another window.", null);
  await section.locator('textarea[aria-label="Handover document"]').fill("Overwritten");
  await section.getByRole("button", { name: "Save handover" }).click();
  await section.locator('[role="alert"]', { hasText: "version_conflict: this Project" }).waitFor({ timeout: 10_000 });
  assert.equal(saves()[1].body.expectedVersion, 1);
  assert.equal(await section.locator('textarea[aria-label="Handover document"]').inputValue(), "Overwritten", "a refused save keeps what was typed");
  await section.screenshot({ path: join(output, "3-conflict.png") });
  await section.getByRole("button", { name: "Reload the saved handover" }).click();
  await section.getByText("Version 2", { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal(await section.locator('textarea[aria-label="Handover document"]').inputValue(), "# Lab\n\nSaved in another window.");
  assert.equal(await section.locator('[role="alert"]').count(), 0);
  check("a save after another window's refused as a conflict with the typed text kept, then the saved version reloaded");

  // ---- In Chinese after a language change elsewhere; unsaved text kept.
  await section.locator('textarea[aria-label="Handover document"]').fill("Unsaved notes");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  await section.locator("h3", { hasText: "交接文档" }).waitFor({ timeout: 10_000 });
  assert.equal(await section.getAttribute("lang"), "zh-Hans");
  assert.equal(await section.locator('textarea[aria-label="交接文档"]').inputValue(), "Unsaved notes", "the unsaved text stays");
  await section.getByText("有未保存的更改").waitFor({ timeout: 10_000 });
  await section.screenshot({ path: join(output, "4-zh.png") });
  check("in Chinese after a language change in another window, the unsaved text kept");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await section.locator("h3", { hasText: "Handover" }).waitFor({ timeout: 10_000 });

  // ---- On a phone: the section fits.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".workspace-scope").first().waitFor({ timeout: 10_000 });
  section = await openSection(page);
  await section.locator('textarea[aria-label="Handover document"]').waitFor({ timeout: 10_000 });
  assert.deepEqual(await fits(section), { box: true, wider: [] }, "on a phone the section fits its width");
  await page.screenshot({ path: join(output, "5-phone.png"), fullPage: false });
  check("at 390 px the section and each field fit their width");

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes.map((w) => `${w.method} ${w.path}`), ["PUT /api/projects/p1/handover", "PUT /api/projects/p1/handover"],
    "two saves, nothing else written");
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
