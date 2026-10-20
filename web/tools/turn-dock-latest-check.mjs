// T-79: the turn dock at the end of a conversation whose latest Turn has just
// begun, and its Back to latest stop. Production bundle in an isolated
// browser with an explicit API fixture; no Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/turn-dock-latest");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a",
  name: "Mori",
  status: "working",
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
// Twelve finished Turns long enough to fill the window, then the latest:
// only its request so far, far shorter than the window.
const turns = [
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `t${i + 1}`,
    status: "completed",
    items: [
      { id: `u${i + 1}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮的问题` }] },
      {
        id: `r${i + 1}`,
        type: "agentMessage",
        text: Array.from({ length: 8 }, (_, p) => `第 ${i + 1} 轮回答的第 ${p + 1} 段，足够长以占满一屏。`).join("\n\n"),
      },
    ],
  })),
  {
    id: "latest",
    status: "inProgress",
    items: [{ id: "u-latest", type: "userMessage", content: [{ type: "text", text: "继续" }] }],
  },
];
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
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
    assert.equal(url.hostname, "yuzuno-turn-dock.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const json = {
      "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": detail,
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) {
      report.unexpected.push(url.pathname);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://yuzuno-turn-dock.test/");
  const dock = page.locator(".turn-dock");
  await dock.waitFor();
  const reading = () => page.evaluate(() => document.querySelector('.turn-dock [aria-current="location"]')?.dataset.turnChoice);
  const latestStop = page.locator(".turn-dock-latest");
  const pane = page.locator(".conversation-scroll");

  // At the end, the Turn that has just begun is the one read, though the
  // window's top line still falls inside the Turn before it.
  await page.waitForFunction(() => {
    const p = document.querySelector(".conversation-scroll");
    return p && p.scrollHeight - p.scrollTop - p.clientHeight < 8;
  });
  const geometry = await page.evaluate(() => {
    const p = document.querySelector(".conversation-scroll").getBoundingClientRect();
    const last = document.querySelector('[data-turn-id="latest"], #turn-latest')?.getBoundingClientRect();
    return { paneTop: p.top, lastTop: last?.top ?? null, lastHeight: last?.height ?? null };
  });
  assert.ok(geometry.lastTop !== null && geometry.lastTop > geometry.paneTop + 32, `the latest Turn is shorter than the window: ${JSON.stringify(geometry)}`);
  await page.waitForFunction(() => document.querySelector('.turn-dock [aria-current="location"]')?.dataset.turnChoice === "latest");
  assert.equal(await latestStop.count(), 0, "no Back to latest stop at the latest");
  check("a just-begun latest Turn holds the reading marker at the end", geometry);

  // Away from the latest: the stop exists but only shows near the dock.
  await page.mouse.move(500, 400);
  await pane.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await latestStop.waitFor({ state: "attached" });
  assert.notEqual(await reading(), "latest");
  const shown = () => latestStop.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, events: getComputedStyle(el).pointerEvents }));
  assert.deepEqual(await shown(), { opacity: "0", events: "none" }, "hidden while the pointer is elsewhere");
  assert.ok(await page.locator(".jump-latest").isVisible(), "the conversation's own Back to latest stays");
  const box = await dock.boundingBox();
  // Just left of the dock still counts as near it.
  await page.mouse.move(box.x - 8, box.y + box.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-dock-latest")).opacity === "1");
  assert.deepEqual(await shown(), { opacity: "1", events: "auto" });
  await page.screenshot({ path: resolve(output, "dock-latest-near.png") });
  check("Back to latest shows on the dock only while the pointer is near it, and the conversation's own button stays");

  await latestStop.click();
  await page.waitForFunction(() => {
    const p = document.querySelector(".conversation-scroll");
    return p.scrollHeight - p.scrollTop - p.clientHeight < 8;
  });
  await page.waitForFunction(() => document.querySelector('.turn-dock [aria-current="location"]')?.dataset.turnChoice === "latest");
  await latestStop.waitFor({ state: "detached" });
  check("the dock's stop returns to the latest Turn and then leaves");

  // Keyboard: focus inside the dock shows the stop too.
  await page.mouse.move(500, 400);
  await pane.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
  await latestStop.waitFor({ state: "attached" });
  await page.locator(".turn-dock-stop").first().focus();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".turn-dock-latest")).opacity === "1");
  check("focus in the dock shows the stop as well");

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
