// T-38: bounded backfill in the Jobs panel, in a browser. A queue head short
// of the shared budget says how much may start ahead of it; the job behind it
// says what it waits for; a job that started ahead of it says which head and
// why it fitted. Production bundle in an isolated browser with an explicit API
// fixture; no Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/jobs-backfill");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], screenshots: [] };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {},
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] };
const mib = (memoryMiB) => ({ cpuMillis: 1000, memoryMiB, swapMiB: 0 });
const plus = (r) => ({ cpuMillis: r.cpuMillis + 100, memoryMiB: r.memoryMiB + 64, swapMiB: 0 });
const base = { agentId: "a", agent: { name: "Mori" }, machine: { name: "lab-host" }, cwd: "/fixture/research", env: {},
  argv: ["/bin/sh", "-c", "./check.sh"], requestId: "r", usage: null, outputs: [], guardGit: true, timeoutSeconds: 3600, taskRef: "T-38" };
const job = (id, name, memory, patch) => ({ ...base, id, name, resources: mib(memory), reservation: plus(mib(memory)), ...patch });
// The numbers of 2026-11-05: budget 40,960 MiB, 16,448 held by an earlier stage.
const head = "Waiting for shared RAM reservation: needs 24640 MiB including collector, 12160 MiB available; short 12480 MiB. Up to 13800 mCPU / 3968 MiB RAM / 0 MiB swap may start ahead of it meanwhile";
const behind = "Waiting behind check: bit-exact a0, which waits for shared RAM reservation: this job needs 1100 mCPU / 4160 MiB RAM / 0 MiB swap; 13800 mCPU / 3968 MiB RAM / 0 MiB swap may start ahead of it now";
const jobs = [
  job("stage", "earlier stage", 16384, { status: "running", reserved: true, reason: "Running with verified cgroup limits", createdAt: ago(900_000), startedAt: ago(890_000), finishedAt: null, cursor: 10 }),
  job("head", "check: bit-exact a0", 24576, { status: "queued", reserved: false, reason: head, createdAt: ago(600_000), startedAt: null, finishedAt: null, cursor: 11 }),
  job("passed", "k5 core tests", 12288, { status: "running", reserved: true, reason: "Running with verified cgroup limits", createdAt: ago(300_000), startedAt: ago(290_000), finishedAt: null, cursor: 12,
    admission: { passed: { jobId: "head", name: "check: bit-exact a0", waits: "shared RAM reservation", need: plus(mib(12288)),
      room: { cpuMillis: 14900, memoryMiB: 16320, swapMiB: 0 }, headNeed: plus(mib(24576)), at: ago(290_000) } } }),
  job("behind", "w10 web tests", 4096, { status: "queued", reserved: false, reason: behind, createdAt: ago(200_000), startedAt: null, finishedAt: null, cursor: 13 }),
];
const jobPage = { jobs, liveJobs: [], hasMore: false, nextBefore: null };
const budget = {
  machine: { name: "lab-host", memoryAvailableMiB: 30_000, scope: "fixture", logicalCpus: 32, memoryTotalMiB: 40_107, swapTotalMiB: 16_384,
    hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 16000, memoryMiB: 40_960, swapMiB: 0 },
  reserved: { cpuMillis: 2200, memoryMiB: 28_800, swapMiB: 0 },
  queuedCount: 2,
  activeCount: 2,
};
const empty = { runs: [], subscriptions: [], reviews: [], hasMore: false, nextBefore: null };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
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
    assert.equal(url.hostname, "yuzuno-jobs-backfill.test");
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
        "/api/ci": empty,
        "/api/reviews": empty,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      }[path] ??
      (jobId && !["budget", "live"].includes(jobId[1])
        ? jobId[2]
          ? { text: "", offset: 0, nextOffset: 0, oldestOffset: 0, totalBytes: 0, truncated: false }
          : jobs.find((j) => j.id === jobId[1])
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
  await page.goto("http://yuzuno-jobs-backfill.test/");
  await page.locator("[data-composer-input]").waitFor();
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await dialog.waitFor();
  // By the name a row shows: one row's note may name another job.
  const row = (name) => page.locator(".job-row").filter({ has: page.locator(".job-row-title strong", { hasText: new RegExp(`^${name}$`) }) });
  await row("check: bit-exact a0").waitFor();
  assert.match(await row("check: bit-exact a0").textContent(), /Up to 13800 mCPU \/ 3968 MiB RAM \/ 0 MiB swap may start ahead of it meanwhile/);
  assert.match(await row("w10 web tests").textContent(), /Waiting behind check: bit-exact a0, which waits for shared RAM reservation/);
  check("the head says how much may start ahead of it, and the job behind it what it waits for");
  await row("k5 core tests").click();
  const admission = page.locator(".job-detail .job-admission");
  await page.locator(".job-detail").waitFor();
  await admission.waitFor({ timeout: 5000 }).catch(() => {});
  assert.equal(await admission.count(), 1, "the detail says the job started ahead of the head");
  assert.equal(await admission.textContent(),
    "Started ahead of check: bit-exact a0, which waited for the shared RAM reservation: this job's 12.1 GiB RAM fitted in the 15.9 GiB RAM left beside check: bit-exact a0's 24.1 GiB RAM");
  await shot("backfill-light-1440.png");
  check("the job that started ahead of the head says which head and why it fitted");
  for (const [theme, width] of [["dark", 1440], ["light", 390]]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${theme} ${width}: inside the window`);
    assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width}: no sideways scroll`);
    if (await admission.isVisible()) {
      const a = await admission.boundingBox();
      assert.ok(a.x >= box.x && a.x + a.width <= box.x + box.width + 1, `${theme} ${width}: the admission line stays inside the panel`);
    }
    await shot(`backfill-${theme}-${width}.png`);
  }
  check("dark and narrow: the panel fits, the admission line inside it, no sideways scroll");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
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
