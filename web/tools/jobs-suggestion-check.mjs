// T-38 C: the submit form says what earlier runs of the same name or command
// suggest requesting, in a browser: the note under the limits, the limits left
// as typed until "Use suggestion" is pressed, light and dark, wide and narrow.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes (nothing is submitted).
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/jobs-suggestion");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], posts: [], screenshots: [] };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {},
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] };
const budget = {
  machine: { name: "lab-host", memoryAvailableMiB: 30_000, scope: "fixture", logicalCpus: 32, memoryTotalMiB: 40_107, swapTotalMiB: 16_384,
    hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 16000, memoryMiB: 40_960, swapMiB: 0 },
  reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 },
  queuedCount: 0,
  activeCount: 0,
};
const empty = { runs: [], subscriptions: [], reviews: [], hasMore: false, nextBefore: null };
// The K4 calibration of 2026-11-04: 20 GiB asked, 2.6 GiB at its peak on 1.2 cores.
const suggestion = { memoryMiB: 4096, cpuMillis: 1800, memoryPeakMiB: 2662, averageCpuCores: 1.2, basedOn: [{ jobId: "k4" }] };

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
  const asked = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-jobs-suggestion.test");
    const path = url.pathname;
    if (request.method() !== "GET") {
      report.posts.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: "This check submits nothing" } });
    }
    if (path === "/api/jobs/suggestion") {
      const q = Object.fromEntries(url.searchParams);
      asked.push(q);
      return route.fulfill({ json: { suggestion: q.name === "K4 calibration" ? suggestion : null } });
    }
    const json = {
      "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": detail,
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": budget,
      "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null },
      "/api/jobs/live": noLiveJobs,
      "/api/ci": empty,
      "/api/reviews": empty,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
    }[path];
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
  await page.goto("http://yuzuno-jobs-suggestion.test/");
  await page.locator("[data-composer-input]").waitFor();
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await dialog.waitFor();
  await page.getByRole("button", { name: "New job", exact: true }).click();
  // The submit form's own fields: the machine budget above it has a CPU quota too.
  const form = page.locator(".job-form");
  await form.getByLabel("Name", { exact: true }).fill("K4 calibration");
  await form.getByLabel("Existing task").fill("T-38");
  await form.getByLabel("Command").fill("python3 calib.py --clips 12");
  await form.getByLabel("RAM limit (MiB)").fill("20480");
  await form.getByLabel("CPU quota").fill("4");
  const note = page.locator(".job-suggestion");
  await note.waitFor({ timeout: 5000 }).catch(() => {});
  assert.equal(await note.count(), 1, "the form says what earlier runs suggest");
  assert.match(await note.locator("p").textContent(), /^The last measured run of this name or command in this task peaked at 2\.6 GiB RAM and 1\.20 CPU cores\. Suggested: 4\.0 GiB RAM and 1\.8 CPU/);
  assert.deepEqual(asked.at(-1), { taskId: "T-38", name: "K4 calibration", argv: JSON.stringify(["/bin/sh", "-c", "python3 calib.py --clips 12"]) });
  assert.deepEqual([await form.getByLabel("RAM limit (MiB)").inputValue(), await form.getByLabel("CPU quota").inputValue()], ["20480", "4"]);
  await note.scrollIntoViewIfNeeded();
  await shot("suggestion-light-1440.png");
  check("the note says the peak and the suggestion; the limits stay as typed");
  for (const [theme, width] of [["dark", 1440], ["light", 390]]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    await note.scrollIntoViewIfNeeded();
    const box = await dialog.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${theme} ${width}: inside the window`);
    assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme} ${width}: no sideways scroll`);
    const noteBox = await note.boundingBox();
    assert.ok(noteBox.x >= 0 && noteBox.x + noteBox.width <= width + 1, `${theme} ${width}: the note fits`);
    await shot(`suggestion-${theme}-${width}.png`);
  }
  check("dark and narrow: the note fits, no sideways scroll");
  await page.getByRole("button", { name: "Use suggestion", exact: true }).click();
  assert.deepEqual([await form.getByLabel("RAM limit (MiB)").inputValue(), await form.getByLabel("CPU quota").inputValue()], ["4096", "1.8"]);
  await shot("used-light-390.png");
  check("Use suggestion fills the limits, and only then");
  assert.deepEqual(report.posts, [], "nothing submitted");
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
