// T-38 B: lowering a running job's memory limit from its card, in a browser.
// The form starts from twice the peak (at least what the job uses now plus
// 256 MiB), sends the new limit, and the card then says from what to what;
// a job on another machine has no such action. Production bundle in an
// isolated browser with an explicit API fixture; no Core, daily window or
// writes beyond the fixture's one POST.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/jobs-lower-memory");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], posts: [], screenshots: [] };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {},
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] };
const mib = (n) => String(n * 1048576);
const base = { agentId: "a", agent: { name: "Mori" }, machine: { name: "lab-host" }, cwd: "/fixture/research", env: {},
  argv: ["/bin/sh", "-c", "./calibrate.sh"], requestId: "r", outputs: [], guardGit: true, timeoutSeconds: 3600, taskRef: "T-38",
  status: "running", reserved: true, reason: "Running with verified cgroup limits", createdAt: ago(3_600_000), startedAt: ago(3_500_000), finishedAt: null };
// The K4 calibration of 2026-11-04: 20 GiB asked, 2.6 GiB at its peak.
let calibration = { ...base, id: "calib", name: "K4 calibration", cursor: 12,
  resources: { cpuMillis: 4000, memoryMiB: 20480, swapMiB: 0 }, reservation: { cpuMillis: 4100, memoryMiB: 20544, swapMiB: 0 },
  usage: { MemoryCurrent: mib(2400), MemoryPeak: mib(2662), TasksMax: "512" } };
const remote = { ...base, id: "remote", name: "remote sweep", cursor: 11, machine: { name: "owl" }, executor: { kind: "ssh", machineId: "owl", machineName: "owl" },
  resources: { cpuMillis: 1000, memoryMiB: 8192, swapMiB: 0 }, reservation: { cpuMillis: 1100, memoryMiB: 8256, swapMiB: 0 }, usage: null };
const jobs = () => [calibration, remote];
const budget = {
  machine: { name: "lab-host", memoryAvailableMiB: 30_000, scope: "fixture", logicalCpus: 32, memoryTotalMiB: 40_107, swapTotalMiB: 16_384,
    hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 16000, memoryMiB: 40_960, swapMiB: 0 },
  reserved: { cpuMillis: 4100, memoryMiB: 20_544, swapMiB: 0 },
  queuedCount: 0,
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
    assert.equal(url.hostname, "yuzuno-jobs-lower-memory.test");
    const path = url.pathname;
    if (request.method() !== "GET") {
      // The one write this check expects: the new limit of the calibration.
      assert.equal(`${request.method()} ${path}`, "POST /api/jobs/calib/memory", `No other writes: ${request.method()} ${path}`);
      const body = JSON.parse(request.postData() || "{}");
      report.posts.push(body);
      calibration = { ...calibration, resources: { ...calibration.resources, memoryMiB: body.memoryMiB },
        reservation: { ...calibration.reservation, memoryMiB: body.memoryMiB + 64 },
        limitChanges: [{ by: { kind: "user", name: "You" }, at: new Date().toISOString(), fromMiB: 20480, toMiB: body.memoryMiB }] };
      return route.fulfill({ json: calibration });
    }
    const jobId = path.match(/^\/api\/jobs\/([^/]+)(\/logs)?$/);
    const json =
      {
        "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a": detail,
        "/api/updates": unmanagedUpdates,
        "/api/jobs/budget": budget,
        "/api/jobs": { jobs: jobs(), liveJobs: [], hasMore: false, nextBefore: null },
        "/api/jobs/live": noLiveJobs,
        "/api/ci": empty,
        "/api/reviews": empty,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
      }[path] ??
      (jobId && !["budget", "live"].includes(jobId[1])
        ? jobId[2]
          ? { text: "", offset: 0, nextOffset: 0, oldestOffset: 0, totalBytes: 0, truncated: false }
          : jobs().find((j) => j.id === jobId[1])
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
  await page.goto("http://yuzuno-jobs-lower-memory.test/");
  await page.locator("[data-composer-input]").waitFor();
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await dialog.waitFor();
  const row = (name) => page.locator(".job-row").filter({ has: page.locator(".job-row-title strong", { hasText: new RegExp(`^${name}$`) }) });
  await row("K4 calibration").click();
  await page.locator(".job-detail").waitFor();
  const lower = page.getByRole("button", { name: "Lower memory limit…", exact: true });
  await lower.waitFor({ timeout: 5000 }).catch(() => {});
  assert.equal(await lower.count(), 1, "a running job on this host can be lowered");
  await lower.click();
  const input = page.getByLabel("New memory limit (MiB)");
  await input.waitFor();
  // Twice the 2,662 MiB peak.
  assert.equal(await input.inputValue(), "5324");
  await shot("lower-form-light-1440.png");
  check("the form starts from twice the peak and says the bounds");
  await input.fill("5324");
  await page.getByRole("button", { name: "Lower limit", exact: true }).click();
  const said = page.locator(".job-detail .job-limit-changes");
  await said.waitFor({ timeout: 5000 }).catch(() => {});
  assert.equal(await said.count(), 1, "the card says the limit was lowered");
  assert.match(await said.textContent(), /^Lowered from 20\.0 GiB to 5\.2 GiB by You, /);
  assert.deepEqual(report.posts, [{ memoryMiB: 5324 }]);
  await shot("lowered-light-1440.png");
  check("the new limit is sent as asked, and the card says from what to what, by whom");
  await row("remote sweep").click();
  await page.locator(".job-detail").filter({ hasText: "remote sweep" }).waitFor();
  assert.equal(await lower.count(), 0, "not on another machine");
  check("a job on another machine has no such action");
  await row("K4 calibration").click();
  await said.waitFor();
  for (const [theme, width] of [["dark", 1440], ["light", 390]]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${theme} ${width}: inside the window`);
    assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width}: no sideways scroll`);
    await shot(`lowered-${theme}-${width}.png`);
  }
  check("dark and narrow: the panel fits, no sideways scroll");
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
