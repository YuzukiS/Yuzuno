// The turn dock's own two controls, by touch (T-15, #459 round 1, P2b).
//
// By touch the dock gives up its presses: its bars and numbers are a scale a
// finger cannot tell apart, and the reading index is the way in (V8). That
// rule was written as "nothing here takes a touch", and it took two things
// with it that are not the scale: loading earlier inputs, and reading by
// inputs rather than by Turns. A touch reader could do neither, which the
// comment above the rule itself contradicted.
//
// Reading by inputs is the app's default (App.tsx readBy), so the fixture
// only has to answer the inputs read with a page that has earlier ones.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-dock-controls.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

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
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 800 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 条输入` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(14) },
    ],
  })),
};
// A page of inputs with earlier ones behind it: that is what draws the
// dock's "earlier inputs" control.
const inputs = {
  total: 20,
  hasBefore: true,
  inputs: Array.from({ length: 5 }, (_, i) => ({
    turnId: `t${i + 3}`, itemId: `u${i + 3}`, position: [i + 3, 0],
    by: "user", preview: `第 ${i + 4} 条输入`,
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

for (const pointer of ["coarse", "fine"]) {
  const coarse = pointer === "coarse";
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: coarse, isMobile: coarse, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { close() {} };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, process.env.T15_LANG || "en");
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/\/conversation\/inputs$/.test(path)) return route.fulfill({ json: inputs });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${pointer}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);

  const seen = await page.evaluate(() => {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, there: false };
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { sel, there: true, shown: false };
      const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + r.height / 2],
        [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + 2],
        [r.left + r.width / 2, r.bottom - 2]];
      let landed = 0;
      for (const [x, y] of points) {
        const at = document.elementFromPoint(x, y);
        if (at === el || el.contains(at)) landed++;
      }
      return { sel, there: true, shown: true, w: Math.round(r.width), h: Math.round(r.height),
        min: Math.round(Math.min(r.width, r.height)), landed, of: points.length,
        events: getComputedStyle(el).pointerEvents,
        name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24) };
    };
    // A bar of the scale, for the contrast: it is meant to take nothing.
    const bar = [...document.querySelectorAll(".turn-dock-stop")].find((s) => !s.querySelector(".turn-dock-chip"));
    return {
      earlier: read(".turn-dock-earlier"),
      switcher: read(".turn-dock-by button"),
      barEvents: bar ? getComputedStyle(bar).pointerEvents : null,
    };
  });

  console.log(`\n--- ${pointer} pointer ---`);
  console.log(`  earlier  ${JSON.stringify(seen.earlier)}`);
  console.log(`  switcher ${JSON.stringify(seen.switcher)}`);
  console.log(`  a bar of the scale: pointer-events ${seen.barEvents}`);

  check(seen.earlier.there && seen.earlier.shown,
    `the way to earlier inputs is on screen (${seen.earlier.name || "absent"})`);
  if (seen.earlier.shown) {
    check(seen.earlier.events !== "none",
      `and it takes a press (pointer-events ${seen.earlier.events})`);
    check(seen.earlier.landed === seen.earlier.of,
      `at its middle and each edge (${seen.earlier.landed}/${seen.earlier.of})`);
    if (coarse)
      check(seen.earlier.min >= 40, `and is a finger's worth by touch (${seen.earlier.w}x${seen.earlier.h})`);
  }
  // The switcher between reading by inputs and by Turns, the same way.
  check(seen.switcher.there && seen.switcher.shown,
    `the switch between inputs and Turns is on screen (${seen.switcher.name || "absent"})`);
  if (seen.switcher.shown) {
    check(seen.switcher.events !== "none", `and it takes a press (pointer-events ${seen.switcher.events})`);
    check(seen.switcher.landed === seen.switcher.of,
      `at its middle and each edge (${seen.switcher.landed}/${seen.switcher.of})`);
    if (coarse)
      check(seen.switcher.min >= 40, `and is a finger's worth by touch (${seen.switcher.w}x${seen.switcher.h})`);
  }
  // The scale itself still gives its presses up by touch: that half of V8
  // stands, and these checks would mean little if it had been undone. Read by
  // inputs there are no numbered bars to read it from, so it is only checked
  // where the fixture has one (t15-dock-touch.mjs reads it by Turns).
  if (seen.barEvents === null)
    console.log("NOTE no numbered bar in this fixture: it is read by inputs, so the scale is the inputs' own");
  else if (coarse)
    check(seen.barEvents === "none", `the scale still takes none (bar pointer-events ${seen.barEvents})`);
  else
    check(seen.barEvents !== "none", `with a mouse the scale is clickable again (${seen.barEvents})`);
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
