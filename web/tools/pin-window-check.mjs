// T-79: the request pin when its original is outside the conversation's
// window (T-77). A Turn started by a peer's mail, a long stretch of the
// Agent's work, then the first request of your own: read near the start, the
// request is below and not mounted, and the pin stays hidden; scrolled past,
// it pins. Production bundle in an isolated browser with an explicit API
// fixture; no Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/pin-window");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], places: [] };
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
const long = (label, n) =>
  Array.from({ length: 6 }, (_, p) => `${label} ${n} 的第 ${p + 1} 段：把检查结果逐条整理，长到足以占住窗口的一大块。`).join("\n\n");
const turns = [
  {
    id: "before",
    status: "completed",
    items: [
      { id: "u0", type: "userMessage", content: [{ type: "text", text: "先看一下现状" }] },
      { id: "r0", type: "agentMessage", text: long("现状", 0) },
    ],
  },
  {
    id: "current",
    status: "inProgress",
    _yuzunoSource: "peer",
    items: [
      { id: "mail", type: "userMessage", content: [{ type: "text", text: "Peer delivery: Dev 4 asks for a check" }] },
      ...Array.from({ length: 60 }, (_, i) => ({ id: `work-${i}`, type: "agentMessage", text: long("工作", i) })),
      { id: "human", type: "userMessage", content: [{ type: "text", text: "我自己的请求：请把结论写清楚。" }] },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `after-${i}`, type: "agentMessage", text: long("结论", i) })),
    ],
  },
];
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
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
    assert.equal(url.hostname, "yuzuno-pin-window.test");
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
  await page.goto("http://yuzuno-pin-window.test/");
  const pane = page.locator(".conversation-scroll");
  const prompt = page.locator(".current-turn-prompt");
  await prompt.waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const p = document.querySelector(".conversation-scroll");
    return p && p.scrollHeight - p.scrollTop - p.clientHeight < 8;
  });
  // The pane, the original request and the pin, once nothing moves.
  const state = (label) =>
    pane.evaluate(
      (el, label) =>
        new Promise((done) => {
          let last = "";
          let still = 0;
          let frames = 0;
          const look = () => {
            const top = el.getBoundingClientRect().top;
            const human = document.querySelector('#turn-current .user-message[data-item-id="human"]')?.getBoundingClientRect();
            const pin = document.querySelector(".current-turn-prompt");
            const now = {
              label,
              scrollTop: Math.round(el.scrollTop),
              turnMounted: !!document.getElementById("turn-current"),
              mailMounted: !!document.querySelector('[data-item-id="mail"]'),
              humanTop: human ? Math.round(human.top - top) : null,
              humanBottom: human ? Math.round(human.bottom - top) : null,
              pinned: pin?.dataset.pinned === "true",
              progress: Number(pin?.style.getPropertyValue("--pin-progress")),
              // What the Turn has mounted, first and last, to tell where an
              // unmounted request lies.
              mountedIds: (() => {
                const ids = [...(document.getElementById("turn-current")?.querySelectorAll("[data-item-id]") ?? [])].map((el) => el.dataset.itemId);
                return ids.length > 6 ? [...ids.slice(0, 3), "…", ...ids.slice(-3)] : ids;
              })(),
              humanNodes: [...document.querySelectorAll('#turn-current [data-item-id="human"]')].map((el) => el.className),
            };
            const key = JSON.stringify(now);
            still = key === last ? still + 1 : 0;
            last = key;
            if (still >= 3 || ++frames > 120) done({ ...now, settled: still >= 3 });
            else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }),
      label,
    );
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // At the latest, the request is above what is read: pinned.
  let at = await state("latest");
  report.places.push(at);
  assert.ok(at.humanBottom === null || at.humanBottom < 0, `the request is above the view at the latest: ${JSON.stringify(at)}`);
  assert.ok(at.settled && at.pinned, `pinned at the latest: ${JSON.stringify(at)}`);
  check("at the latest, the request above is pinned", at);
  // A message keeps focus, as after a jump to it: its row stays mounted
  // below however far up the reader goes, and must not count as read.
  await page.locator('[data-item-id="after-7"]').focus();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.itemId), "after-7");

  // Near the Turn's start, the request is far below and not mounted.
  for (let step = 0; step < 60 && !(at = await state(`up ${step}`)).mailMounted; step++) await page.mouse.wheel(0, -1500);
  await page.locator('[data-item-id="mail"]').scrollIntoViewIfNeeded();
  at = await state("start of the Turn");
  report.places.push(at);
  assert.ok(at.settled && at.turnMounted && at.mailMounted, `reading the Turn's start: ${JSON.stringify(at)}`);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.itemId), "after-7", "focus stayed below");
  assert.equal(at.humanTop, null, `the request is outside the window, below: ${JSON.stringify(at)}`);
  assert.ok(!at.pinned && at.progress === 0, `the pin stays hidden while its request is below: ${JSON.stringify(at)}`);
  await page.screenshot({ path: resolve(output, "turn-start-hidden.png") });
  check("near a peer-started Turn's start, its own request below and unmounted keeps the pin hidden", at);

  // Coming down to the request: hidden while it is in view, pinned once it
  // has gone over the top edge.
  for (let step = 0; step < 80 && (at = await state(`down ${step}`)).humanTop === null; step++) await page.mouse.wheel(0, 1200);
  for (let step = 0; step < 8 && at.humanTop !== null && Math.abs(at.humanTop - 300) > 2; step++) {
    await page.mouse.wheel(0, at.humanTop - 300);
    at = await state(`place ${step}`);
  }
  report.places.push(at);
  assert.ok(at.settled && at.humanTop !== null && Math.abs(at.humanTop - 300) <= 2, `the request in view: ${JSON.stringify(at)}`);
  assert.ok(!at.pinned, `hidden while the request is in view: ${JSON.stringify(at)}`);
  await page.mouse.wheel(0, at.humanBottom + 400);
  at = await state("past the request");
  report.places.push(at);
  assert.ok(at.settled && (at.humanBottom === null || at.humanBottom < 0), `the request has gone over the top: ${JSON.stringify(at)}`);
  assert.ok(at.pinned && at.progress === 1, `pinned once the request has gone over the top: ${JSON.stringify(at)}`);
  check("in view it stays hidden; past the top edge it pins");

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
