// The Jobs panel scrolls as one where a finger cannot flick a region nested
// in a dialog, or where a short window leaves each pane too little to be
// worth its own scrollbar (T-53). The machine-resources card then scrolls up
// and out of view with everything else, and the list and the chosen job
// stack in one column. With a fine pointer and enough height the desktop
// two-pane split is unchanged.
//
// Every API is answered here; no Core, and nothing is submitted, paused,
// cancelled, rerun or refreshed.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> \
//     node tools/jobs-touch-scroll-check.mjs
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
const report = { task: "T-53", checks: [], reads: [], posts: [], unexpected: [], errors: [], screenshots: [] };
const HOST = "yuzuno-t53-jobs.test";

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
  machine: { name: "Yuzuki2025", memoryAvailableMiB: 2000, logicalCpus: 8, memoryTotalMiB: 16384, swapTotalMiB: 4096, hostHeadroomMiB: 2048 },
  // The meters the user's machine shows: disk, Windows and a GPU.
  disk: { reserveGiB: 20, defaultRule: "20 GiB", bounds: { minGiB: 1, maxGiB: 500 }, observedAt: now, scope: "local",
    volumes: [{ device: 1, paths: [{ path: "/", role: "jobs" }], totalBytes: 1e12, availableBytes: 3e11, reserveBytes: 2.1e10, low: false, error: null }] },
  windows: { available: true, maxJobs: 2, set: true, defaultMaxJobs: 1, activeCount: 1, sharesThisBudget: true },
  gpus: { observedAt: now, problem: null, scope: "local",
    devices: [{ uuid: "GPU-1", index: 0, name: "NVIDIA RTX 4090", memoryTotalMiB: 24576, memoryFreeMiB: 20000,
      admission: "open", closedReason: null, closedBy: null, sharing: false, headroomMiB: 1024, reservations: [] }] },
};
const run = { id: "run-1", runId: 101, attempt: "1", name: "Synthetic CI", repository: "owner/repo", headSha: "a".repeat(40), status: "passed", rawStatus: "completed",
  conclusion: "success", url: "https://github.com/owner/repo/actions/runs/101", createdAt: now, startedAt: now, updatedAt: now, observedAt: now, cursor: 1 };
const review = { id: "review-1", taskRef: "T-47", taskTitle: "Synthetic task", repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7",
  status: "completed", conclusion: "no_findings", round: 1, phase: null, error: null, actualHarness: "claude", actualModel: "model-x", requestedHarness: "claude",
  requestedModel: "model-x", headSha: "b".repeat(40), baseSha: "c".repeat(40), createdAt: now, finishedAt: now, requestedBy: { kind: "user", id: "u", name: "" },
  findingsCount: 0, outdated: false, cursor: 1, policyVersion: 3, reasonCodes: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const router = async (route) => {
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
    "/api/jobs": { jobs: [running, done, ...Array.from({ length: 10 }, (_, i) => job(`job-${i}`, `Synthetic batch ${i + 1}`, i % 3 === 0 ? "running" : "succeeded"))], liveJobs: [running], hasMore: false, nextBefore: null },
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
};
const VIEWS = [
  { name: "tablet-1024x768-touch", w: 1024, h: 768, coarse: true, whole: true },
  { name: "tablet-1366x1024-touch", w: 1366, h: 1024, coarse: true, whole: true },
  { name: "desktop-1366x1024-mouse", w: 1366, h: 1024, coarse: false, whole: false },
  { name: "desktop-1920x1200-mouse", w: 1920, h: 1200, coarse: false, whole: false },
];
let failed = 0;
const check = (ok, what) => { report.checks.push(`${ok ? "PASS" : "FAIL"} ${what}`); console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const out = output;
await mkdir(out, { recursive: true });
for (const view of VIEWS) {
  const ctx = await browser.newContext({ viewport: { width: view.w, height: view.h },
    hasTouch: view.coarse, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await ctx.addInitScript(() => { window.EventSource = class { close() {} }; });
  await ctx.route("**/*", router);
  const tab = await ctx.newPage();
  tab.on("pageerror", (e) => report.errors.push(`${view.name}: ${e.message}`));
  await tab.goto(`https://${HOST}/`);
  await tab.locator(".jobs-nav").waitFor({ timeout: 10_000 });
  await tab.locator(".jobs-nav").click();
  await tab.locator(".jobs-dialog").waitFor({ timeout: 10_000 });
  await tab.locator(".jobs-dialog .job-row").first().click();
  await tab.waitForTimeout(600);

  const shape = () => tab.evaluate(() => {
    const own = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(s.overflowY);
    };
    const pane = document.querySelector(".jobs-pane");
    const card = document.querySelector(".jobs-budget");
    const close = document.querySelector(".jobs-dialog .modal-heading button");
    return {
      paneScrolls: own(".jobs-pane"), listScrolls: own(".job-list"), detailScrolls: own(".job-detail"),
      columns: getComputedStyle(document.querySelector(".jobs-browser")).gridTemplateColumns.split(" ").length,
      cardTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      paneTop: pane ? Math.round(pane.getBoundingClientRect().top) : null,
      closeTop: close ? Math.round(close.getBoundingClientRect().top) : null,
      detailThere: !!document.querySelector(".job-detail"),
      formReachable: !!document.querySelector(".jobs-dialog .job-form, .jobs-dialog .jobs-source-actions button"),
    };
  });

  const before = await shape();
  if (view.whole) {
    check(before.paneScrolls, `${view.name}: the panel scrolls as one`);
    check(!before.listScrolls, `${view.name}: the list has no scroll region of its own`);
    check(!before.detailScrolls, `${view.name}: the chosen job has no scroll region of its own`);
    check(before.columns === 1, `${view.name}: the list and the chosen job are in one column`);
    // The machine card leaves the viewport once the panel is scrolled.
    await tab.evaluate(() => { document.querySelector(".jobs-pane").scrollTop = 600; });
    await tab.waitForTimeout(250);
    const after = await shape();
    check(after.cardTop < after.paneTop, `${view.name}: the machine card scrolls up out of the panel (${after.cardTop} above ${after.paneTop})`);
    check(after.closeTop === before.closeTop, `${view.name}: the close button stays where it was`);
    check(after.detailThere && after.formReachable, `${view.name}: the chosen job and the New job action are still reachable`);
  } else {
    check(!before.paneScrolls, `${view.name}: the panel itself does not scroll`);
    check(before.listScrolls, `${view.name}: the list keeps its own scroll region`);
    check(before.detailScrolls, `${view.name}: the chosen job keeps its own scroll region`);
    check(before.columns === 2, `${view.name}: the two-pane split is unchanged`);
  }
  await tab.screenshot({ path: join(out, `${view.name}.png`), fullPage: false });
  report.screenshots.push(`${view.name}.png`);
  await ctx.close();
}
check(report.errors.length === 0, `no page errors${report.errors.length ? `: ${report.errors[0]}` : ""}`);
await browser.close();
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(failed ? `\n${failed} failed` : `\nall passed; evidence in ${out}`);
process.exit(failed ? 1 : 0);
