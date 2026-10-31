// One way back to the latest messages, never two (T-15). The conversation had
// three: a bar for the source being read, a link where a loaded window ends,
// and a floating button. Two could show at once and the floating one covered
// the text. The bar now carries the only one, and the floating button stands
// in only when no bar does. Nothing is sent, and nothing jumps to the end.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-one-way-back.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/work", model: "claude-opus-5",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 9, reviewedSeq: 9,
  connectionState: "connected", goal: "", projectId: null,
};
const turns = Array.from({ length: 30 }, (_, i) => ({
  id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 2000 + i * 60,
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮的问题。` }] },
    { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回复。`.repeat(10) },
  ],
}));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const browser = await launchBrowser();
const errors = [];

/** Every way back to the latest on the screen now, and what covers the text. */
const waysBack = (page) => page.evaluate(() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const labels = ["Back to latest", "返回最新"];
  const found = [...document.querySelectorAll("button, a")]
    .filter((el) => labels.some((l) => (el.textContent || "").trim().includes(l)) && shown(el))
    .map((el) => ({
      where: el.closest(".source-navigation") ? "reading-bar"
        : el.closest(".conversation-history-window") ? "history-window"
        : el.classList.contains("jump-latest") ? "floating" : "elsewhere",
      text: (el.textContent || "").trim().slice(0, 24),
    }));
  const scroll = document.querySelector(".conversation-scroll");
  return { found, bar: !!document.querySelector(".source-navigation"),
    atEnd: scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4 : null,
    top: Math.round(scroll?.scrollTop ?? -1) };
});

async function open(detail) {
  const context = await browser.newContext({ viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
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
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return { context, page };
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// Scrolled up in the latest messages: only the floating button.
{
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns });
  await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = Math.round(s.scrollHeight * 0.4); });
  await page.waitForTimeout(400);
  const seen = await waysBack(page);
  console.log("scrolled up  ", JSON.stringify(seen));
  check(seen.found.length === 1, `one way back while merely scrolled up (${seen.found.length}: ${seen.found.map((f) => f.where).join(", ") || "none"})`);
  check(seen.found[0]?.where === "floating", "and it is the floating one, since no bar is showing");
  check(seen.atEnd === false, "nothing scrolled the conversation to the end by itself");
  await context.close();
}
// A window of earlier messages: the bar carries it, and nothing repeats it.
{
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns,
    conversation: { hasAfter: true, hasBefore: false } });
  await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = Math.round(s.scrollHeight * 0.4); });
  await page.waitForTimeout(400);
  const seen = await waysBack(page);
  console.log("history window", JSON.stringify(seen));
  check(seen.bar, "a reading bar shows for a window of earlier messages");
  check(seen.found.length === 1, `still one way back (${seen.found.length}: ${seen.found.map((f) => f.where).join(", ") || "none"})`);
  check(seen.found[0]?.where === "reading-bar", "and it is the bar's, not the floating one or the window's");
  check(seen.atEnd === false, "nothing jumped to the end");
  await context.close();
}
await browser.close();
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
