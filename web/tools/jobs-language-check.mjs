// T-189: the Jobs panel in the interface language, in Chromium (en-US), with
// every API answered here (no Core; nothing is submitted, paused, cancelled,
// rerun, watched or refreshed with GitHub). Through the real app:
//  - in English: the Jobs panel's local source, a running job chosen and its
//    detail open, the budget, then the GitHub Actions and Reviews sources;
//  - the language changed in another window while the panel is open: the
//    panel is Chinese; job, Agent, task and machine names, commands, paths,
//    Core's reasons and the run's and review's names as they came; the
//    chosen job, the source and the open detail kept; nothing sent;
//  - back to English in another window: the panel is as it was.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/jobs-language-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-189", checks: [], reads: [], posts: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-jobs-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", threadId: "native-a", cwd: "/fixture", model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const home = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
const now = new Date().toISOString();
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
// Synthetic jobs: one running, one finished; Core's reason as Core would say it.
const REASON = "Synthetic reservation held for the fixture";
const job = (id, name, status, extra = {}) => ({
  id, requestId: id, name, taskRef: "T-47", agentId: "a", agent: { name: "Mori" }, machine: { name: "Local WSL" }, status,
  reserved: status === "running", reason: status === "running" ? REASON : null, resources, reservation: resources, cursor: id === "job-run" ? 2 : 1,
  createdAt: now, startedAt: now, finishedAt: status === "running" ? null : now, argv: ["/bin/sh", "-c", "python train.py"], cwd: "/fixture", env: {}, outputs: [], ...extra,
});
const running = job("job-run", "Synthetic training", "running");
const done = job("job-done", "Synthetic eval", "succeeded");
const budget = {
  budget: { cpuMillis: 4000, memoryMiB: 4096, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 0,
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budgetBounds: { minimum: { cpuMillis: 200, memoryMiB: 128, swapMiB: 0 }, maximum: { cpuMillis: 64000, memoryMiB: 65536, swapMiB: 65536 } },
  machine: { name: "Local WSL", memoryAvailableMiB: 2000, logicalCpus: 8, memoryTotalMiB: 16384, swapTotalMiB: 4096, hostHeadroomMiB: 2048 },
};
const run = { id: "run-1", runId: 101, attempt: "1", name: "Synthetic CI", repository: "owner/repo", headSha: "a".repeat(40), status: "passed", rawStatus: "completed",
  conclusion: "success", url: "https://github.com/owner/repo/actions/runs/101", createdAt: now, startedAt: now, updatedAt: now, observedAt: now, cursor: 1 };
const review = { id: "review-1", taskRef: "T-47", taskTitle: "Synthetic task", repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7",
  status: "completed", conclusion: "no_findings", round: 1, phase: null, error: null, actualHarness: "claude", actualModel: "model-x", requestedHarness: "claude",
  requestedModel: "model-x", headSha: "b".repeat(40), baseSha: "c".repeat(40), createdAt: now, finishedAt: now, requestedBy: { kind: "user", id: "u", name: "" },
  findingsCount: 0, outdated: false, cursor: 1, policyVersion: 3, reasonCodes: [] };
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
  if (method !== "GET") {
    // A submit, pause, cancel, watch or GitHub refresh would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-jobs-language" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": budget,
    "/api/jobs": { jobs: [running, done], liveJobs: [running], hasMore: false, nextBefore: null },
    "/api/jobs/live": { agents: {} },
    "/api/jobs/job-run": running,
    "/api/jobs/job-run/logs": { text: "step 1\nstep 2\n", totalBytes: 14, oldestOffset: 0, truncated: false },
    "/api/jobs/runs": { runs: [] },
    "/api/ci": { runs: [run], subscriptions: [], hasMore: false, nextBefore: null },
    "/api/ci/live": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
    "/api/reviews": { reviews: [review], hasMore: false, nextBefore: null },
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
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();

const setLanguage = (language) => other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
const dialog = () => page.locator(".jobs-dialog");
const panel = () => dialog().evaluate((el) => {
  const texts = (selector) => [...el.querySelectorAll(selector)].map((n) => n.textContent.trim());
  return {
    lang: el.getAttribute("lang"),
    title: el.querySelector(".modal-heading h2")?.textContent,
    sources: texts('[role="tab"]'),
    selected: el.querySelector('[role="tab"][aria-selected="true"]')?.id,
    heading: el.querySelector(".jobs-source h3, .jobs-source [id$='-title']")?.textContent ?? null,
    groups: texts(".job-group-title"),
    rows: texts(".job-row .job-state"),
    names: texts(".job-row .job-name, .job-row strong"),
    detail: el.querySelector(".job-detail")?.textContent ?? "",
    budget: el.querySelector(".jobs-budget")?.textContent ?? "",
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator(".jobs-nav").waitFor({ timeout: 10_000 });
  await page.locator(".jobs-nav").click();
  await dialog().waitFor({ timeout: 10_000 });
  await dialog().locator(".job-row", { hasText: "Synthetic training" }).click();
  await dialog().locator(".job-detail .job-command").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);

  // ---- In English.
  const en = await panel();
  assert.deepEqual([en.lang, en.title], ["en", "Jobs"]);
  assert.deepEqual(en.sources.slice(0, 3).map((s) => s.replace(/\d+$/, "")), ["Local", "GitHub Actions", "Reviews"]);
  assert.match(en.detail, /Running/);
  assert.match(en.detail, new RegExp(REASON));
  assert.match(en.budget, /in use/);
  check("in English: the Jobs panel's local source, a running job's detail and the budget", { en });

  // ---- Changed to Chinese in another window, the detail open.
  const before = report.reads.length;
  await setLanguage("zh-Hans");
  await dialog().locator(".modal-heading h2", { hasText: "Job" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const zh = await panel();
  assert.equal(zh.lang, "zh-Hans");
  assert.deepEqual(zh.sources.slice(0, 3).map((s) => s.replace(/\d+$/, "")), ["本地", "GitHub Actions", "审查"]);
  assert.equal(zh.selected, en.selected, "the same source");
  assert.match(zh.detail, /运行中/);
  assert.match(zh.detail, /摘要/);
  assert.match(zh.detail, /Synthetic training/, "the job's name as it came");
  assert.match(zh.detail, new RegExp(REASON), "Core's reason as it came");
  assert.match(zh.detail, /python train\.py/, "the command as it came");
  assert.match(zh.budget, /使用中/);
  assert.match(zh.budget, /Local WSL/, "the machine's name as it came");
  assert.ok(await dialog().locator(".job-detail .job-command").isVisible(), "the detail stays open");
  assert.deepEqual(report.reads.slice(before).filter((read) => !read.startsWith("GET ")), [], "nothing sent");
  await page.screenshot({ path: join(output, "jobs-zh.png") });
  // The other sources, in Chinese.
  await dialog().locator("#jobs-tab-github_actions").click();
  await dialog().locator(".ci-jobs .job-row").first().waitFor({ timeout: 10_000 });
  const ci = await dialog().locator(".ci-jobs").textContent();
  assert.match(ci, /监视 CI/);
  assert.match(ci, /已通过/);
  assert.match(ci, /Synthetic CI/, "the run's name as it came");
  await dialog().locator("#jobs-tab-reviews").click();
  await dialog().locator(".review-jobs .job-row").first().waitFor({ timeout: 10_000 });
  const reviews = await dialog().locator(".review-jobs").textContent();
  assert.match(reviews, /没有可操作的发现/);
  assert.match(reviews, /owner\/repo#7 · 第 1 轮/);
  assert.deepEqual(report.posts, [], "nothing submitted, paused, cancelled, watched or refreshed");
  check("changed to Chinese in another window: the panel, its local, Actions and Reviews sources are Chinese; names, commands and Core's reason as they came; the detail kept; nothing sent", { zh, ci, reviews });

  // ---- Back to English in another window, on the local source again.
  await dialog().locator("#jobs-tab-local").click();
  await dialog().locator(".job-row", { hasText: "Synthetic training" }).click();
  await setLanguage("en");
  await dialog().locator(".modal-heading h2", { hasText: "Jobs" }).waitFor({ timeout: 10_000 });
  await dialog().locator(".job-detail .job-command").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const back = await panel();
  assert.deepEqual([back.lang, back.title, back.sources, back.groups, back.rows], [en.lang, en.title, en.sources, en.groups, en.rows], "as it was in English");
  check("back to English in another window: the panel as it was");

  assert.deepEqual(report.posts, [], "nothing sent at all");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(output, "check-report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
