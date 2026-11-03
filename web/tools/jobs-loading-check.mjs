// T-19 slice 2e (F1: WK:JB-04, JB-07, CI-04): in Chromium on a production build of the app with a
// synthetic Workspace that is never written to. Each answer from Core is held until the check lets
// it go, so what shows before it can be seen:
// - Jobs: the list says it is being read, not that there are no jobs; a chosen job says it is
//   being read, not that none is chosen. On a narrow window (640 px, where the list and the job
//   stack) the chosen job is brought to the top of the panel: smoothly, or at once under reduced
//   motion. A wide window leaves the list where it is.
// - GitHub Actions: the list says it is being read; a chosen run's jobs and steps card is there at
//   once, saying it is being read, and the steps fill it when they come.
// Screenshots of each held state go to YUZUNO_BROWSER_OUTPUT. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/jobs-loading-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/jobs-loading");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const now = new Date().toISOString();
const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
// Thirty finished jobs, so on a narrow window the chosen one's details start below the fold.
const jobs = Array.from({ length: 30 }, (_, n) => ({ id: `job-${n + 1}`, requestId: `r${n + 1}`, name: `Synthetic job ${n + 1}`,
  taskRef: "T-1", agentId: "a", agent: { name: "Mori" }, machine: { name: "Local" }, status: "succeeded", reserved: false, reason: "success",
  resources, reservation: resources, cursor: 100 - n, createdAt: now, startedAt: now, finishedAt: now, argv: ["/usr/bin/true"], cwd: "/w",
  env: {}, outputs: [] }));
const ciRun = { id: "github:1:42:1", name: "Synthetic CI", repository: "o/r", runId: "42", attempt: "1", headSha: "a".repeat(40),
  status: "passed", rawStatus: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/42/attempts/1", observedAt: now, cursor: 1 };
const ciReport = { run: ciRun, error: null, details: { jobs: [{ id: 1, name: "Build", status: "passed", url: "https://github.com/o/r/actions/runs/42/job/1",
  steps: [{ number: 1, name: "Compile", status: "completed", conclusion: "success" }] }], page: 1, hasMore: false, nextPage: null, observedAt: now } };
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
  "/api/home": { generatedAt: now, order: ["p"], needsYou: [], projects: [] },
};
// Answers held until the check lets them go; a gate let go stays open.
function gate() { let open; const promise = new Promise((r) => { open = r; }); return { promise, open }; }
let gates = {};
const answers = {
  list: () => ({ jobs, liveJobs: [], hasMore: false, nextBefore: null }),
  detail: () => jobs[0],
  ci: () => ({ runs: [ciRun], subscriptions: [], hasMore: false, nextBefore: null }),
  report: () => ciReport,
};
const kindOf = (path) =>
  path === "/api/jobs" ? "list" : path === "/api/jobs/job-1" ? "detail" : path === "/api/ci" ? "ci" : path.startsWith("/api/ci/") ? "report" : null;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (/^\/api\/jobs\/job-\d+\/logs$/.test(url.pathname)) return route.fulfill({ json: { text: "synthetic output", oldestOffset: 0, totalBytes: 16 } });
    const kind = kindOf(url.pathname);
    if (kind) {
      await gates[kind]?.promise;
      return route.fulfill({ json: answers[kind]() });
    }
    return route.fulfill({ json: gets[url.pathname] ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "narrow", viewport: { width: 640, height: 860 }, reducedMotion: "no-preference", narrow: true },
  { name: "narrow-reduced", viewport: { width: 640, height: 860 }, reducedMotion: "reduce", narrow: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  gates = { list: gate(), detail: gate(), ci: gate(), report: gate() };
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  const texts = (selector) => page.locator(selector).allTextContents();
  try {
    await page.goto("http://yuzuno-jobs.test/");
    await page.locator(".toolbar-nav .jobs-nav").first().click();
    await page.locator(".jobs-dialog").waitFor();
    await page.waitForTimeout(400);

    // The list, held.
    const before = await texts(".jobs-browser .jobs-empty");
    await page.screenshot({ path: join(output, `${tag}-list-reading.png`) });
    ok(`${tag}: before Core answers, the job list says it is being read (${JSON.stringify(before)})`,
      before.includes("Reading jobs…") && !before.includes("No jobs yet."), before);
    gates.list.open();
    await page.locator(".jobs-browser .job-row").nth(29).waitFor();
    ok(`${tag}: then the jobs come, and the reading line is gone`, !(await texts(".jobs-browser .jobs-empty")).includes("Reading jobs…"));

    // A chosen job, held: where its box is, frame by frame from the click.
    await page.evaluate(() => {
      const pane = document.querySelector(".jobs-pane");
      const list = document.querySelector(".job-list");
      window.__place = () => {
        const box = document.querySelector(".job-detail").getBoundingClientRect();
        const top = pane.getBoundingClientRect().top;
        return { top: Math.round(box.top - top), pane: Math.round(pane.scrollTop), list: Math.round(list?.scrollTop ?? 0),
          busy: document.querySelector(".job-detail").getAttribute("aria-busy"), text: document.querySelector(".job-detail").textContent };
      };
      window.__frames = [];
      addEventListener("click", () => {
        const t0 = performance.now();
        const frame = () => {
          window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__place() });
          if (performance.now() - t0 < 900) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
    const start = await page.evaluate(() => window.__place());
    await page.locator(".jobs-browser .job-row").first().click();
    await page.waitForTimeout(1050);
    const frames = await page.evaluate(() => window.__frames);
    report.measures[`${tag}: chosen job`] = { start, frames };
    await page.screenshot({ path: join(output, `${tag}-job-reading.png`) });
    const last = frames.at(-1);
    ok(`${tag}: a chosen job says it is being read until its answer comes (aria-busy ${last.busy})`,
      frames.every((f) => /Reading this job…/.test(f.text) && !/Select a job/.test(f.text)) && last.busy === "true", last);
    if (run.narrow) {
      const moving = frames.filter((f) => f.top !== last.top && f.top !== start.top);
      ok(`${tag}: on a narrow window it comes to the top of the panel (from ${start.top} px to ${last.top} px below the panel's top)`,
        start.top > run.viewport.height && Math.abs(last.top) <= 4, { start, last });
      if (reduced)
        ok(`${tag}: at once under reduced motion (first frame ${frames[0].top} px, ${moving.length} frames between)`,
          Math.abs(frames[0].top - last.top) <= 4 && moving.length === 0, frames.slice(0, 3));
      else
        ok(`${tag}: smoothly otherwise (${moving.length} frames between ${start.top} and ${last.top} px)`, moving.length >= 3, frames.slice(0, 6));
    } else {
      ok(`${tag}: a wide window leaves the list and the panel where they were`,
        frames.every((f) => f.pane === start.pane && f.list === start.list), { start, last });
    }
    gates.detail.open();
    await page.locator(".job-log").waitFor();
    const shown = await page.evaluate(() => window.__place());
    ok(`${tag}: then the job shows, no longer busy`, shown.busy === null && !/Reading this job/.test(shown.text), shown.busy);

    // GitHub Actions, held.
    await page.getByRole("tab", { name: "GitHub Actions" }).click();
    await page.locator(".ci-jobs").waitFor();
    await page.waitForTimeout(400);
    const ciBefore = await page.locator(".ci-jobs").textContent();
    await page.screenshot({ path: join(output, `${tag}-ci-reading.png`) });
    ok(`${tag}: before Core answers, the Actions list says it is being read`,
      /Reading runs…/.test(ciBefore) && !/No Actions runs observed yet/.test(ciBefore));
    gates.ci.open();
    await page.locator(".ci-jobs .job-row").first().click();
    await page.locator(".ci-jobs .job-detail", { hasText: "Reading its jobs and steps…" }).waitFor();
    const held = await page.evaluate(() => {
      const box = document.querySelector(".ci-jobs .job-detail");
      const cards = [...box.querySelectorAll(".job-card")].map((c) => c.querySelector(".job-card-heading")?.textContent ?? "");
      return { busy: box.getAttribute("aria-busy"), cards };
    });
    await page.screenshot({ path: join(output, `${tag}-ci-steps-reading.png`) });
    ok(`${tag}: a chosen run's jobs and steps card is there at once, saying it is being read (${JSON.stringify(held.cards)})`,
      held.busy === "true" && held.cards.length === 2 && /Jobs and steps/.test(held.cards[1]), held);
    gates.report.open();
    await page.locator(".ci-child-job").first().waitFor();
    const filled = await page.evaluate(() => ({ busy: document.querySelector(".ci-jobs .job-detail").getAttribute("aria-busy"),
      text: document.querySelector(".ci-jobs .job-detail").textContent }));
    ok(`${tag}: then its steps fill that card`, filled.busy === null && !/Reading its jobs/.test(filled.text) && /Compile/.test(filled.text), filled.busy);
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("nothing was written", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "jobs-loading-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
