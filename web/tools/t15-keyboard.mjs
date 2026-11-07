// The on-screen keyboard on a workbench that is not a phone (T-15).
//
// T-170 made the phone shell fit what the keyboard leaves, because Mobile
// Safari scrolled the document and left the composer below it. That was
// gated on the phone layout — and a tablet, or a folding phone opened, is
// wide enough to keep the side-by-side layout while having exactly the same
// keyboard over the bottom of it. There the shell stayed 100dvh and the
// input area went under the keyboard.
//
// SYNTHETIC, and in two ways. There is no on-screen keyboard in a desktop
// browser, so window.visualViewport is replaced with one this script drives;
// and the heights are chosen, not measured off a device. What is really being
// checked is the wiring: that a touched screen which is not a phone follows
// the visual viewport at all, that the shell fits what is left, and that a
// screen with a mouse is not touched by any of it. Whether iOS reports the
// heights this assumes is T-170's Simulator evidence, not this file's.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-keyboard.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }];
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [{ id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(30) }],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function open({ coarse }) {
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: coarse, isMobile: coarse, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((right) => {
    window.EventSource = class { close() {} };
    // A keyboard this script owns, in place of the one a desktop has not got.
    const listeners = { resize: new Set(), scroll: new Set() };
    const fake = {
      height: window.innerHeight, width: window.innerWidth, scale: 1, offsetTop: 0, offsetLeft: 0,
      addEventListener: (kind, fn) => listeners[kind]?.add(fn),
      removeEventListener: (kind, fn) => listeners[kind]?.delete(fn),
    };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
    window.__keyboard = (height) => {
      fake.height = height;
      for (const fn of listeners.resize) fn();
    };
    if (right)
      addEventListener("DOMContentLoaded", () =>
        document.documentElement.style.setProperty("--safe-right", `${right}px`));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, Number(process.env.T15_INSET_RIGHT || 84));
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: [], liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null } });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (error) => errors.push(`${coarse ? "touch" : "mouse"}: ${error.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return { context, page };
}

const state = () => {
  const root = document.documentElement;
  const app = document.querySelector(".app");
  const composer = document.querySelector(".composer-area");
  const ar = app?.getBoundingClientRect();
  const cr = composer?.getBoundingClientRect();
  return {
    keyboard: root.hasAttribute("data-keyboard"),
    visual: root.style.getPropertyValue("--visual-height").trim(),
    phone: !!app?.classList.contains("phone"),
    app: ar ? Math.round(ar.height) : 0,
    composerBottom: cr ? Math.round(cr.bottom) : 0,
    focused: (document.activeElement?.className || "").toString().slice(0, 30),
  };
};

// --- a touched screen that is not a phone ---
{
  const { context, page } = await open({ coarse: true });
  const before = await page.evaluate(state);
  check(!before.phone, "951x669 by touch is not the phone layout, so this is the case in question");
  check(!before.keyboard, "nothing is set before anything has focus");

  await page.click(".composer .cm-content");
  await page.waitForTimeout(150);
  // 300px of keyboard over a 669px screen.
  await page.evaluate(() => window.__keyboard(369));
  await page.waitForTimeout(250);
  const up = await page.evaluate(state);
  console.log(`\n--- touch, keyboard up (synthetic: 369px of 669 left) ---`);
  console.log(`  data-keyboard ${up.keyboard}  --visual-height "${up.visual}"  app ${up.app}  input area bottom ${up.composerBottom}  focus "${up.focused}"`);
  check(up.keyboard, "a touched screen that is not a phone follows the visual viewport");
  check(up.visual === "369px", `and the shell is told what is left (${up.visual})`);
  check(Math.abs(up.app - 369) <= 2, `the shell fits it (${up.app} of 369)`);
  check(up.composerBottom <= 371,
    `so the input area is above the keyboard rather than under it (bottom ${up.composerBottom} <= 369)`);

  await page.evaluate(() => window.__keyboard(669));
  await page.waitForTimeout(250);
  const down = await page.evaluate(state);
  check(!down.keyboard && down.visual === "", "and it is given back when the keyboard goes");
  check(Math.abs(down.app - 669) <= 2, `the shell is its own height again (${down.app})`);
  await context.close();
}

// --- a screen with a mouse: none of this applies ---
{
  const { context, page } = await open({ coarse: false });
  await page.click(".composer .cm-content");
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__keyboard(369));
  await page.waitForTimeout(250);
  const mouse = await page.evaluate(state);
  console.log(`\n--- mouse, same fake keyboard ---`);
  console.log(`  data-keyboard ${mouse.keyboard}  app ${mouse.app}`);
  check(!mouse.keyboard, "a screen with a mouse does not follow it, having no on-screen keyboard");
  check(Math.abs(mouse.app - 669) <= 2, `and keeps its height (${mouse.app})`);
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
