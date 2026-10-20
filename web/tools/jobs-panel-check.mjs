// T-79: the Jobs panel and the conversation's docks in a browser.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes. JOBS_PANEL_PROBE=outside runs only the
// outside-press checks, which also hold for the panel before T-79.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/jobs-panel");
const probe = process.env.JOBS_PANEL_PROBE || "";
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], screenshots: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const agent = {
  id: "a",
  name: "Mori",
  status: "idle",
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
};
const turns = Array.from({ length: 6 }, (_, i) => ({
  id: `t${i + 1}`,
  status: "completed",
  items: [
    { id: `u${i + 1}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：跑一下检查` }] },
    {
      id: `r${i + 1}`,
      type: "agentMessage",
      text: Array.from({ length: 4 }, (_, p) => `第 ${i + 1} 轮回答第 ${p + 1} 段：检查已提交到 Jobs，结果会回到这里。`).join("\n\n"),
    },
  ],
}));
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };

const resources = { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 };
const base = {
  agentId: "a",
  agent: { name: "Mori" },
  machine: { name: "lab-host" },
  resources,
  reservation: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 },
  cwd: "/fixture/web",
  env: {},
  argv: ["/bin/sh", "-c", "npm run check"],
  requestId: "r",
  usage: null,
  outputs: [],
  guardGit: true,
  timeoutSeconds: 900,
};
const jobs = [
  {
    ...base,
    id: "run-1",
    name: "ui tests",
    taskRef: "T-79",
    status: "running",
    reserved: true,
    reason: "Running within its reservation",
    createdAt: ago(200_000),
    startedAt: ago(125_000),
    finishedAt: null,
    cursor: 40,
    usage: { MemoryCurrent: String(512 * 1048576), MemoryPeak: String(700 * 1048576), TasksMax: "512" },
  },
  {
    ...base,
    id: "queue-1",
    name: "cargo build",
    taskRef: "T-77",
    agentId: "b",
    agent: { name: "Dev 4" },
    status: "queued",
    reserved: false,
    exclusive: true,
    reason: "Waiting for shared machine capacity",
    createdAt: ago(60_000),
    startedAt: null,
    finishedAt: null,
    cursor: 41,
  },
  {
    ...base,
    id: "fail-1",
    name: "browser check",
    taskRef: "T-79",
    status: "failed",
    reserved: false,
    reason: "The command exited with status 1",
    createdAt: ago(3_700_000),
    startedAt: ago(3_650_000),
    finishedAt: ago(3_400_000),
    cursor: 39,
    outputs: ["acceptance/report.json"],
    result: { reason: "exit-code", evidence: { systemd: { Result: "exit-code", MemoryPeak: String(900 * 1048576), TasksMax: "512" } } },
  },
  ...Array.from({ length: 12 }, (_, i) => ({
    ...base,
    id: `done-${i}`,
    name: `check ${12 - i}`,
    taskRef: "T-79",
    status: i === 3 ? "cancelled" : "succeeded",
    reserved: false,
    reason: i === 3 ? "Cancelled on request" : "success",
    createdAt: ago(7_200_000 + i * 600_000),
    startedAt: ago(7_190_000 + i * 600_000),
    finishedAt: ago(7_100_000 + i * 600_000),
    cursor: 38 - i,
  })),
];
const jobPage = { jobs, liveJobs: [], hasMore: false, nextBefore: null };
const log = {
  text: Array.from({ length: 60 }, (_, i) => `[${String(i).padStart(2, "0")}] ✓ check step ${i + 1} passed`).join("\n"),
  offset: 0,
  nextOffset: 2400,
  oldestOffset: 0,
  totalBytes: 2400,
  truncated: false,
};
const budget = {
  machine: {
    name: "lab-host",
    memoryAvailableMiB: 16_000,
    scope: "fixture",
    maximumBudget: { cpuMillis: 24_000, memoryMiB: 20_053, swapMiB: 4096 },
    suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 },
  },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 6000, memoryMiB: 10_240, swapMiB: 0 },
  reserved: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 },
  queuedCount: 1,
  activeCount: 1,
};
const sha = "a".repeat(40);
const run = (id, name, status, conclusion, updatedMs) => ({
  id: `github:1:${id}:1`,
  name,
  repository: "example/yuzuno-next",
  runId: String(id),
  attempt: "1",
  headSha: sha,
  status,
  rawStatus: status === "running" ? "in_progress" : "completed",
  conclusion,
  url: `https://github.com/example/yuzuno-next/actions/runs/${id}`,
  createdAt: ago(updatedMs + 300_000),
  startedAt: ago(updatedMs + 290_000),
  updatedAt: ago(updatedMs),
  observedAt: ago(updatedMs),
  cursor: id,
});
const ciPage = {
  runs: [run(52, "web", "failed", "failure", 1_200_000), run(53, "core", "running", null, 30_000), run(51, "docs", "passed", "success", 9_000_000)],
  subscriptions: [
    {
      id: "sub",
      agentId: "a",
      agent: { name: "Mori" },
      taskRef: "T-79",
      active: true,
      expiresAt: ago(-6 * 86_400_000),
      watchId: "w",
      watch: { id: "w", kind: "pull", number: 55, url: "https://github.com/example/yuzuno-next/pull/55", expectedSha: sha, currentHeadSha: sha, state: "watching", error: null, observedAt: ago(30_000), lastAttemptAt: ago(30_000) },
    },
  ],
  hasMore: false,
  nextBefore: null,
};
const ciReport = (r) => ({
  run: r,
  error: null,
  details: {
    jobs: [
      { id: 1, name: "typecheck and unit tests", status: "passed", rawStatus: "completed", conclusion: "success", url: "https://github.com/example/yuzuno-next/actions/runs/52/job/1", stepsTruncated: false, steps: [{ number: 1, name: "Checkout", status: "completed", conclusion: "success" }, { number: 2, name: "npm test", status: "completed", conclusion: "success" }] },
      { id: 2, name: "browser checks", status: "failed", rawStatus: "completed", conclusion: "failure", url: "https://github.com/example/yuzuno-next/actions/runs/52/job/2", stepsTruncated: false, steps: [{ number: 1, name: "Checkout", status: "completed", conclusion: "success" }, { number: 2, name: "Chromium checks", status: "completed", conclusion: "failure" }, { number: 3, name: "Upload report", status: "completed", conclusion: "skipped" }] },
    ],
    page: 1,
    nextPage: null,
    hasMore: false,
    pageLimitReached: false,
    observedAt: r.observedAt,
  },
});
const review = (id, cursor, patch) => ({
  id,
  taskId: "task-79",
  taskRef: "T-79",
  taskTitle: "第四批界面调整",
  linkId: "l",
  repository: "example/yuzuno-next",
  number: 55,
  url: "https://github.com/example/yuzuno-next/pull/55",
  round: 1,
  status: "completed",
  phase: "completed",
  conclusion: "no_findings",
  requestedHarness: "codex",
  requestedModel: "gpt-6.1-sol",
  actualHarness: "codex",
  actualModel: "gpt-6.1-sol",
  baseSha: "b".repeat(40),
  headSha: sha,
  mergeBaseSha: "c".repeat(40),
  createdAt: ago(5_000_000),
  finishedAt: ago(4_400_000),
  error: null,
  requestedBy: { kind: "agent", id: "a", name: "Mori" },
  findingsCount: 0,
  outdated: false,
  cursor,
  ...patch,
});
const reviewPage = {
  reviews: [
    review("r3", 3, { round: 3, status: "running", phase: "reviewing", conclusion: null, finishedAt: null, createdAt: ago(240_000) }),
    review("r2", 2, { round: 2, conclusion: "changes_requested", findingsCount: 2, createdAt: ago(3_000_000), finishedAt: ago(2_500_000) }),
    review("r1", 1, {}),
  ],
  hasMore: false,
  nextBefore: null,
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
const shot = async (name) => {
  await page.screenshot({ path: resolve(output, name) });
  report.screenshots.push(name);
};
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class {
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 18, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-jobs-panel.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const path = url.pathname;
    const jobId = path.match(/^\/api\/jobs\/([^/]+)(\/logs)?$/);
    const json =
      {
        "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a": detail,
        "/api/updates": unmanagedUpdates,
        "/api/jobs/budget": budget,
        "/api/jobs": jobPage,
        "/api/jobs/live": noLiveJobs,
        "/api/ci": ciPage,
        "/api/reviews": reviewPage,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      }[path] ??
      (jobId && !["budget", "live"].includes(jobId[1])
        ? jobId[2]
          ? log
          : jobs.find((j) => j.id === jobId[1])
        : path.startsWith("/api/ci/")
          ? ciReport(ciPage.runs.find((r) => r.id === decodeURIComponent(path.slice(8))))
          : undefined);
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://yuzuno-jobs-panel.test/");
  await page.locator("[data-composer-input]").waitFor();
  await page.locator(".conversation-job").first().waitFor();
  const dialog = page.getByRole("dialog");
  const jobsButton = page.getByRole("button", { name: "Jobs", exact: true });

  // A press outside the panel closes it, however it was opened and however
  // much it holds, as for Settings and Tasks & messages.
  const pressOutside = async (where) => {
    const box = await dialog.boundingBox();
    const at =
      where === "side"
        ? { x: Math.max(3, box.x / 2), y: box.y + box.height / 2 }
        : { x: box.x + box.width / 2, y: Math.max(3, box.y / 2) };
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` : null;
    }, at);
    await page.mouse.click(at.x, at.y);
    await dialog.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    return { where, box, at, hit, open: await dialog.count() };
  };
  const outside = [];
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await dialog.waitFor();
  outside.push({ panel: "Settings", ...(await pressOutside("side")) });
  await jobsButton.click();
  await dialog.waitFor();
  await page.locator(".job-row").filter({ hasText: "browser check" }).click();
  await page.locator(".job-log").waitFor();
  outside.push({ panel: "Jobs from the toolbar, a job open", ...(await pressOutside("side")) });
  await page.locator(".conversation-job").first().click();
  await dialog.waitFor();
  await page.locator(".job-log").waitFor();
  outside.push({ panel: "Jobs from the dock", ...(await pressOutside("top")) });
  report.outside = outside;
  console.log(JSON.stringify(outside));
  for (const o of outside) assert.equal(o.open, 0, `${o.panel}: a press outside closes it (${o.hit})`);
  check("a press outside closes Jobs, from the toolbar or the dock, as it closes Settings", { outside });
  if (probe === "outside") {
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  } else {
    // The conversation's column is centred in the whole pane between the
    // jobs dock and the turn dock, and clear of both.
    const column = () =>
      page.evaluate(() => {
        const r = (s) => document.querySelector(s)?.getBoundingClientRect();
        const pane = r(".conversation-scroll");
        const inner = r(".conversation-inner");
        const left = r(".work-dock");
        const right = r(".turn-dock");
        return {
          offset: Math.round((inner.left + inner.width / 2 - (pane.left + pane.width / 2)) * 10) / 10,
          width: Math.round(inner.width),
          clearLeft: !left || inner.left >= left.right - 0.5,
          clearRight: !right || inner.right <= right.left + 0.5,
          docks: [!!left, !!right],
        };
      });
    const centred = [];
    for (const width of [1440, 1180, 980]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const c = await column();
      centred.push({ viewport: width, ...c });
      assert.deepEqual(c.docks, [true, true], `both docks at ${width}`);
      assert.ok(Math.abs(c.offset) <= 4, `centred at ${width}: ${JSON.stringify(c)}`);
      assert.ok(c.clearLeft && c.clearRight, `clear of both docks at ${width}: ${JSON.stringify(c)}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    check("the conversation stays centred in the pane between the jobs and turn docks", { centred });

    // The dock shows how long a running job has run so far, as it shows a
    // finished one's time, and keeps counting.
    const dockLabel = (name) => page.locator(".conversation-job").filter({ hasText: name }).locator(".work-dock-label small:not(.work-dock-when)");
    const running = dockLabel("ui tests");
    const first = await running.textContent();
    assert.match(first, /^Running · 2m \d+s$/);
    await page.waitForFunction(
      (was) => [...document.querySelectorAll(".conversation-job")].find((el) => el.textContent.includes("ui tests"))?.querySelector(".work-dock-label small")?.textContent !== was,
      first,
      { timeout: 3000 },
    );
    assert.match(await dockLabel("browser check").textContent(), /^Failed · 4m 10s$/);
    check("the dock counts a running job's time as it shows a finished one's", { first, then: await running.textContent() });

    // Coming near the dock unfolds each job's latest moment with its name:
    // finished, started or queued, quieter than its status.
    const moment = (name) => page.locator(".conversation-job").filter({ hasText: name }).locator(".work-dock-label .work-dock-when");
    const opacity = (name) => moment(name).evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(await opacity("browser check"), "0", "hidden until the pointer comes near");
    await page.locator(".conversation-job").filter({ hasText: "browser check" }).hover();
    await page.waitForFunction(() => [...document.querySelectorAll(".conversation-job .work-dock-label .work-dock-when")].every((el) => getComputedStyle(el).opacity === "0.8"), null, { timeout: 3000 });
    const moments = {
      finished: await moment("browser check").textContent(),
      running: await moment("ui tests").textContent(),
      queued: await moment("cargo build").textContent(),
    };
    assert.match(moments.finished, /^Finished \S/);
    assert.match(moments.running, /^Started \S/);
    assert.match(moments.queued, /^Queued \S/);
    const sizes = await page.evaluate(() => {
      const item = [...document.querySelectorAll(".conversation-job")].find((el) => el.textContent.includes("browser check"));
      const px = (sel) => parseFloat(getComputedStyle(item.querySelector(sel)).fontSize);
      return { status: px(".work-dock-label small:not(.work-dock-when)"), moment: px(".work-dock-label .work-dock-when") };
    });
    assert.ok(sizes.moment < sizes.status, `the moment is smaller than the status: ${JSON.stringify(sizes)}`);
    assert.equal(await page.locator(".conversation-job").filter({ hasText: "browser check" }).locator(".work-dock-tip .work-dock-when").isVisible(), false, "a wide dock does not repeat it in the tip");
    await shot("dock-moments-1440.png");
    await page.mouse.move(1000, 600);
    check("near the dock each job shows its latest moment, quietly (finished, started or queued)", { moments, sizes });

    // Jobs: the sources as Settings lists its categories, then the rows in two
    // groups: still going, and ended however they ended (a failure included).
    await jobsButton.click();
    await dialog.waitFor();
    const tabs = page.getByRole("tablist", { name: "Job source" }).getByRole("tab");
    assert.deepEqual(await tabs.allTextContents(), ["Local2", "GitHub Actions", "Reviews"]);
    assert.equal(await tabs.first().getAttribute("aria-selected"), "true");
    const groups = () => page.locator(".job-group-title").evaluateAll((els) => els.map((el) => el.textContent));
    assert.deepEqual(await groups(), ["Running and queued2", "Finished13"]);
    assert.equal(await page.locator(".job-group-done .job-row").count(), 10);
    await page.getByRole("button", { name: "Show 3 more" }).click();
    assert.equal(await page.locator(".job-group-done .job-row").count(), 13);
    // Each row says when it was queued and, once it has, when it finished.
    assert.match(await page.locator(".job-row").filter({ hasText: "browser check" }).locator(".job-row-moments").textContent(), /^Queued .+ · Finished .+$/);
    assert.match(await page.locator(".job-row").filter({ hasText: "cargo build" }).locator(".job-row-moments").textContent(), /^Queued [^·]+$/);
    const runningRow = page.locator(".job-row").filter({ hasText: "ui tests" }).locator(".job-row-time");
    const rowTime = await runningRow.textContent();
    await page.waitForFunction((was) => [...document.querySelectorAll(".job-row")].find((r) => r.textContent.includes("ui tests"))?.querySelector(".job-row-time")?.textContent !== was, rowTime, { timeout: 3000 });
    // Rows wear the dock's own marks.
    const marks = await page.evaluate(() => {
      const mark = (el) => el && { node: !!el.querySelector(".work-dock-node"), color: getComputedStyle(el.querySelector(".work-dock-node")).backgroundColor };
      return {
        row: mark(document.querySelector(".job-row .status-mark.state-failed")),
        dock: mark(document.querySelector(".conversation-job.state-failed")),
      };
    });
    assert.ok(marks.row?.node && marks.dock?.node);
    assert.equal(marks.row.color, marks.dock.color, "a failed mark is the same colour in the panel and on the dock");
    await page.locator(".job-row").filter({ hasText: "browser check" }).click();
    await page.locator(".job-log").waitFor();
    assert.deepEqual(await page.locator(".job-card-heading strong").allTextContents(), ["Summary", "Command", "Output", "Declared output files"]);
    assert.match(await page.locator(".job-detail-title .job-state").textContent(), /^Failed · 4m 10s$/);
    assert.equal(await page.locator(".job-detail-actions").getByRole("button", { name: "Run again…" }).count(), 1);
    await shot("local-light-1440.png");
    check("Local: sources rail, two groups with Finished folded, queued and finished times, live row times, the dock's marks and card details", { rowTime });

    // The budget as meters, its form a step away.
    const meters = await page.getByRole("meter").evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), el.getAttribute("aria-valuetext"), el.getAttribute("aria-valuenow")]));
    assert.deepEqual(meters, [["CPU reserved", "2.1 / 6 reserved", "35"], ["RAM reserved", "3.1 GiB / 10.0 GiB reserved", "31"]]);
    assert.match(await page.locator(".jobs-budget").innerText(), /1 active · 1 queued/);
    check("the machine budget reads as two meters", { meters });

    // Arrow keys move through the sources, as in Settings.
    await tabs.first().focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "jobs-tab-github_actions");
    await page.locator(".ci-jobs .job-row").first().waitFor();
    assert.deepEqual(await groups(), ["Running and queued1", "History2"]);
    await page.locator(".ci-jobs .job-row").filter({ hasText: "web" }).click();
    await page.locator(".ci-child-job").first().waitFor();
    assert.deepEqual(await page.locator(".ci-child-job").evaluateAll((els) => els.map((el) => el.open)), [false, true], "a failed CI job opens");
    assert.equal(await page.locator(".ci-child-job[open] li .status-mark.state-failed").count(), 1);
    await shot("actions-light-1440.png");
    check("GitHub Actions: the same groups and marks; a failed job opens on its steps");

    await page.locator("#jobs-tab-github_actions").focus();
    await page.keyboard.press("ArrowDown");
    await page.locator(".review-jobs .job-row").first().waitFor();
    assert.deepEqual(await groups(), ["Running and queued1", "Finished2"]);
    await page.locator(".review-jobs .job-row").filter({ hasText: "Round 2" }).click();
    assert.match(await page.locator(".review-jobs .job-detail-title .job-state").textContent(), /Changes requested/);
    await shot("reviews-light-1440.png");
    check("Reviews: the same two groups; changes requested is finished, not a group of its own");

    await tabs.first().click();
    await page.getByRole("button", { name: "New job", exact: true }).click();
    assert.deepEqual(await page.locator(".job-form-group > legend").allTextContents(), ["What runs", "Limits", "Checks and files"]);
    await shot("new-job-light-1440.png");
    await page.getByRole("button", { name: "Back to jobs", exact: true }).click();
    check("a new job reads in three groups: what runs, its limits, its checks and files");

    for (const [theme, width] of [["dark", 1440], ["light", 390], ["dark", 390]]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${theme} ${width}: inside the window`);
      assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width}: no sideways scroll`);
      await shot(`local-${theme}-${width}.png`);
    }
    check("dark and narrow: the panel fits, with no sideways scroll");

    assert.deepEqual(report.errors, []);
    report.status = "passed";
  }
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
