// The research loop on Agents and Jobs (T-17 slice 4), in a browser: a
// record's proposed next check, a task's recorded spend in its Jobs panel,
// and a run that names the method record it follows and the record that
// explains its analysis decision. Desktop light and dark, and a 390 px phone.
// - A proposal reads as a proposal; nothing is read or started for it.
// - The spend card says known cost with the unknown, unrecorded and running
//   attempts apart, and that it limits nothing.
// - The run card says the method version it followed and that a newer one
//   exists; the decided gate says which record explains it.
// - Words are readable (contrast at least 4.5:1); nothing scrolls sideways.
// - Reads only, and every read is one this fixture answers on purpose.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/research-loop");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-research-loop.test";
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

// ---------------------------------------------------------------- fixture
const at = "2026-11-02T09:00:00Z";
const mina = { kind: "agent", id: "mina", name: "Mina" };
const methodV1 = { schema: "research/1", type: "method", id: "timing", title: "Timing protocol", field: "systems",
  text: "Ten iterations in one process." };
const methodV2 = { ...methodV1, text: "Ten fresh processes under each link order.",
  revises: { activitySeq: 3, reason: "Iterations in one process share caches and memory layout." } };
const observation = { schema: "research/1", type: "observation", id: "ranking-flips", title: "Ranking flips with link order", field: "systems",
  text: "Swapping the link order reverses which layout is faster.", method: { activitySeq: 3, id: "timing", title: "Timing protocol" },
  next: { action: "check", text: "Time fresh processes under both link orders: a ranking that still flips is the measurement, not the layout." } };
const task = { id: "T-1", title: "Is layout B faster? (synthetic)", description: "Time two layouts under a fixed method.",
  status: "doing", version: 3, projectId: "p1", progress: "", blocker: "", github: [], assigneeAgentId: "mina", assignee: mina,
  createdAt: at, updatedAt: at, createdBy: mina, updatedBy: mina, result: null };
const activities = [
  { seq: 1, taskId: "T-1", kind: "created", actor: mina, at },
  { seq: 3, taskId: "T-1", kind: "comment", body: "Method v1.", actor: mina, at, research: methodV1 },
  { seq: 5, taskId: "T-1", kind: "comment", body: "Observed.", actor: mina, at, research: observation },
  { seq: 6, taskId: "T-1", kind: "comment", body: "Method v2.", actor: mina, at, research: methodV2 },
];
// One stage of a run that followed method version 1 and was cancelled at its
// gate, as the observation explains; the method has a newer version since.
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
const job = { id: "job-1", name: "Layout timing · time", taskRef: "T-1", agentId: "mina", agent: { name: "Mina" }, machine: { name: "Core host" },
  resources, reservation: { cpuMillis: 1100, memoryMiB: 576, swapMiB: 0 }, cwd: "/fixture", env: {}, argv: ["/usr/bin/true"], requestId: "r",
  usage: null, outputs: [], guardGit: true, timeoutSeconds: 900, status: "succeeded", reserved: false, reason: "success", cursor: 9,
  createdAt: at, startedAt: at, finishedAt: at, run: { id: "run-1", stage: "time", attempt: 1 },
  result: { reason: "success", artifacts: [], cost: { knownUsd: 0.42, unknownEntries: 0, complete: true }, evidence: { systemd: { Result: "success" } } } };
const run = { id: "run-1", name: "Layout timing", experiment: "layouts", status: "cancelled", costLimitUsd: null, cancelRequestedAt: at,
  cost: { knownUsd: 0.42, unknownEntries: 0, attemptsRunning: 0, complete: true },
  method: { activitySeq: 3, id: "timing", title: "Timing protocol", version: 1 },
  methodNow: { state: "readable", revisedBy: 6, latestActivitySeq: 6 },
  stages: [{ key: "time", status: "succeeded", needs: [], retry: null, reusedFrom: null, attempts: [{ id: "job-1", status: "succeeded", reason: null, run: { attempt: 1 } }],
    analysis: { id: "gate-1", state: "cancelled", jobId: "job-1", attemptId: "attempt-1", execution: "succeeded",
      record: { activitySeq: 5, version: 1, record: { type: "observation", id: "ranking-flips", title: "Ranking flips with link order" }, next: observation.next },
      recordNow: { state: "readable", revisedBy: null, latestActivitySeq: 5 } } }] };
const spend = { taskId: "T-1", attempts: 4, byStatus: { cancelled: 1, failed: 1, running: 1, succeeded: 1 },
  usd: { knownUsd: 1.75, attemptsReporting: 2, attemptsNotRecorded: 1, attemptsWithUnknown: 1, unknownEntries: 1, invalidLines: 0, attemptsRunning: 1, complete: false },
  compute: { cpuSeconds: 12.34, workerWallSeconds: 20, attemptsMeasured: 2, attemptsUnmeasured: 1 },
  gpu: { attemptsReserving: 1, measured: false }, runs: 1, reusedStages: 1, truncated: false, scope: "fixture" };
const agents = [mina].map((a) => ({ ...a, projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: at, updatedAt: at, status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null }));
const projects = [{ id: "p1", name: "Layouts (synthetic)", defaultDirs: {}, archivedAt: null, createdAt: at, updatedAt: at }];
const home = () => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "Layouts (synthetic)" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }],
});
const READS = ["task_get", "task_list", "task_research_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list", "job_cost"];

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
  if (path.startsWith("/api/collaboration/")) {
    const operation = path.split("/").at(-1);
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (!READS.includes(operation)) report.writes.push(`${request.method()} ${path}`);
    report.reads.push(operation);
    const answer = {
      task_list: () => ({ tasks: [task], hasMore: false, counts: { doing: 1 } }),
      task_get: () => ({ task, activities, executions: [], hasMore: false }),
      peers_list: () => ({ peers: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "test" } }),
      github_links: () => ({ links: [], repositories: [], refreshing: false }),
      github_refresh: () => ({ links: [], repositories: [], refreshing: false }),
      github_repositories: () => ({ links: [], repositories: [], refreshing: false }),
      job_cost: () => (body.taskId === "T-1" ? spend : { error: "not this task" }),
    }[operation];
    if (!answer) report.unexpected.push(path);
    return route.fulfill({ json: answer ? answer() : {} });
  }
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 1 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/machine-load": () => ({ at, cpu: { cores: 8, totalPct: 5, jobsPct: 0, agentsPct: null, otherPct: null },
      memory: { totalMiB: 16000, usedMiB: 4000, availableMiB: 12000, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] }),
    "/api/projects/p1/repo-activity": () => ({ observedAt: at, repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => ({ jobs: [job], liveJobs: [], hasMore: false, nextBefore: null }),
    "/api/jobs/live": () => noLiveJobs,
    "/api/jobs/runs": () => ({ runs: [], hasMore: false, nextBefore: null }),
    "/api/jobs/runs/run-1": () => run,
    "/api/jobs/job-1": () => job,
    "/api/jobs/job-1/logs": () => ({ text: "timed\n", offset: 0, nextOffset: 6, oldestOffset: 0, totalBytes: 6, truncated: false }),
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: at, agents: {} }),
    "/api/tasks/T-1/workspaces": () => ({ taskId: "T-1", repositories: [], workspaces: [] }),
    "/api/pr-reviews": () => ({ reviews: [], hasMore: false, nextBefore: null }),
    "/api/pr-operations": () => ({ operations: [], repositories: [], hasMore: false, nextBefore: null }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/agents/")) return route.fulfill({ json: path.endsWith("/reading") ? { handoff: null } : { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}

async function open(width, height, theme) {
  page = await browser.newPage({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce", hasTouch: width < 600 });
  await page.addInitScript((theme) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 50); }
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
  }, theme);
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
}
/** Each piece of text inside `selector`, with its contrast against what is behind it. */
const contrast = (selector) =>
  page.evaluate((selector) => {
    const rgb = (text) => (text.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const behind = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length >= 3 && (color.length < 4 || color[3] > 0.95)) return color;
      }
      return [255, 255, 255];
    };
    const rows = [];
    const all = selector.split(",").flatMap((part) => [part.trim(), `${part.trim()} *`]).join(", ");
    for (const el of document.querySelectorAll(all)) {
      if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
      const fg = lum(rgb(getComputedStyle(el).color)), bg = lum(behind(el));
      rows.push({ what: el.className || el.tagName, text: el.textContent.trim().slice(0, 40), ratio: Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100 });
    }
    return rows;
  }, selector);
/** Elements inside `selector` that run past its right edge, and page-wide sideways scroll. */
const sideways = (selector) =>
  page.evaluate((selector) => {
    const scroller = document.scrollingElement;
    const boxes = [...document.querySelectorAll(selector)];
    return { page: scroller.scrollWidth > scroller.clientWidth + 1,
      inside: boxes.flatMap((box) => [...box.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > box.getBoundingClientRect().right + 1).map((el) => el.className)).slice(0, 5) };
  }, selector);
async function readable(selector) {
  const rows = await contrast(selector);
  assert.ok(rows.length > 0, `${selector} has text`);
  assert.deepEqual(rows.filter((row) => row.ratio < 4.5), [], `every word of ${selector} is readable`);
  const wide = await sideways(selector);
  assert.ok(!wide.page && wide.inside.length === 0, JSON.stringify(wide));
  return { lowestContrast: Math.min(...rows.map((row) => row.ratio)), measured: rows.length };
}

for (const [width, height, theme, name] of [[1440, 960, "light", "desktop-light"], [1440, 960, "dark", "desktop-dark"], [390, 844, "light", "phone"]]) {
  await step(`${name}: a record's proposed next check reads as a proposal, and nothing is read for it`, async () => {
    report.reads.length = 0;
    await open(width, height, theme);
    await page.getByRole("button", { name: "Tasks & messages", exact: true }).first().click();
    await page.locator('button[data-task-id="T-1"]').first().click();
    const next = page.locator(".task-research-next").first();
    await next.waitFor();
    assert.equal(await next.getAttribute("data-action"), "check");
    assert.equal(await next.getAttribute("title"), "A proposal: nothing runs or stops because of it.");
    const text = await next.innerText();
    assert.ok(text.includes("Proposes a next check") && text.includes("Time fresh processes under both link orders"), text);
    assert.ok(!report.reads.includes("task_research_get"), "nothing is read for a proposal");
    await next.scrollIntoViewIfNeeded();
    const measured = await readable(".task-research-next");
    await page.locator(".task-research").nth(1).screenshot({ path: resolve(output, `${name}-next.png`) });
    report.shots.push(`${name}-next.png`);
    return measured;
  });
  await step(`${name}: the task's Jobs show its recorded spend, unknown apart, limiting nothing`, async () => {
    await page.getByRole("button", { name: "Related jobs", exact: true }).first().click();
    const card = page.locator(".job-task-spend");
    await until("the spend card", async () => (await card.count()) && (await card.innerText()).includes("$1.75"));
    const text = await card.innerText();
    for (const expected of ["Recorded spend on this task",
      "$1.75 · 1 with an unknown amount · 1 attempt recorded none · 1 still running",
      "12.3 s of CPU over 2 measured attempts · 1 not measured · GPU use is not measured; 1 attempt reserved a GPU",
      "4 attempts, each counted once, in 1 run and single Jobs · 1 reused stage ran nothing and is not counted again",
      "nothing resets when the method or the run changes"])
      assert.ok(text.includes(expected), `${expected}: ${text}`);
    assert.ok(report.reads.includes("job_cost"));
    await card.scrollIntoViewIfNeeded();
    const measured = await readable(".job-task-spend");
    await card.screenshot({ path: resolve(output, `${name}-spend.png`) });
    report.shots.push(`${name}-spend.png`);
    return measured;
  });
  await step(`${name}: a run names the method version it followed and the record that explains its decision`, async () => {
    await page.locator(".job-row").filter({ hasText: "Layout timing · time" }).first().click();
    const card = page.locator(".job-run");
    await until("the run card", async () => (await card.count()) && (await page.locator(".job-run-method").count()));
    const text = await card.innerText();
    for (const expected of ["Follows the method “Timing protocol”, activity 3, version 1; a newer version is activity 6, and the run keeps the version it followed",
      "Cancelled, as the observation “Ranking flips with link order” (activity 5) explains · It proposed a next check: Time fresh processes"])
      assert.ok(text.includes(expected), `${expected}: ${text}`);
    assert.ok(!/verified/i.test(await page.locator(".job-run-method, .job-run-explained").allInnerTexts().then((all) => all.join(" "))));
    await card.scrollIntoViewIfNeeded();
    const measured = await readable(".job-run-method, .job-run-explained");
    await card.screenshot({ path: resolve(output, `${name}-run.png`) });
    report.shots.push(`${name}-run.png`);
    return measured;
  });
  await page.close();
}

await browser.close();
await step("reads only: nothing is written, no other host is asked, and every read is one the fixture answers", async () => {
  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
});
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.failures.length ? `FAILED ${report.failures.length}` : `PASSED ${report.checks.length}`);
process.exit(report.failures.length ? 1 : 0);
