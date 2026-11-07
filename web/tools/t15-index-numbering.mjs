// What the reading index calls its rows (T-15, #459 round 1, P3b).
//
// The index numbered its rows `loadedNumbering ? index + 1 : index + 1` —
// the same number either way, so the prop did nothing — and its default said
// `true` while its own comment described the opposite polarity. TurnNavigator
// already makes this distinction in words ("Loaded turn" against "Turn"),
// because while only part of a conversation is loaded the numbers count what
// is here, not the whole conversation. The index now says the same.
//
// Two passes over the same conversation: one whose detail carries a history
// window, one without.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-index-numbering.mjs
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
const turns = Array.from({ length: 6 }, (_, i) => ({
  id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 600 + i * 60,
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮的问题` }] },
    { id: `r${i}`, type: "agentMessage", text: "正文".repeat(12) },
  ],
}));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function rowsWith(history) {
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
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
  const detail = {
    agent, pending: [], messageReceipts: [], artifacts: [], turns,
    // A loaded window of an older part of the conversation.
    ...(history ? { history: { fromSeq: 10, toSeq: 20 } } : {}),
  };
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
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
  page.on("pageerror", (e) => errors.push(`${history ? "history" : "whole"}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.locator(".conversation-index-entry").click();
  await page.waitForTimeout(500);
  const seen = await page.evaluate(() => ({
    there: !!document.querySelector(".rail-turn-index"),
    numbers: [...document.querySelectorAll(".rail-turn-index-number")]
      .slice(0, 3)
      .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()),
  }));
  await context.close();
  return seen;
}

const whole = await rowsWith(false);
const part = await rowsWith(true);
console.log(`\nthe whole conversation loaded: ${JSON.stringify(whole.numbers)}`);
console.log(`a window of it loaded:         ${JSON.stringify(part.numbers)}`);

check(whole.there && part.there, "the index opens in both");
check(whole.numbers.length > 0 && part.numbers.length > 0, "and numbers its rows in both");
// The number counts the same rows either way; what changes is what it claims
// to be counting.
check(whole.numbers.every((text) => !/Loaded|已载入/.test(text)),
  `with the whole conversation the rows are its Turns (${whole.numbers[0]})`);
check(part.numbers.every((text) => /Loaded|已载入/.test(text)),
  `with only a window loaded each row says the number counts what is here (${part.numbers[0]})`);
check(whole.numbers[0] !== part.numbers[0],
  `so the two read differently ("${whole.numbers[0]}" against "${part.numbers[0]}")`);
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
