// What the folded bar says when Core answers but its updates do not
// (T-15, #459 new pair, P3).
//
// On a short screen the bottom bar becomes a panel and the Core status entry
// stands in for it (V5). The bar had two separate lines — Core's own state
// and, beside it, "live updates reconnecting" — and the entry read only the
// first. So a workbench whose updates had stopped arriving looked settled:
// a healthy dot, no count, nothing said. Core answering is not the same as
// hearing from it, and that difference is exactly what a folded bar must not
// swallow.
//
// Three readings of the same screen, because the count only means something
// if it goes away: the stream reconnecting, still connecting, and open.
//
// Where the words go is not free. The entry is portaled into the toolbar's
// actions, whose buttons cannot shrink below 40px on a touched screen; the
// first try wrote the stream's state out beside the count, which took the
// entry to 289px of a 413px actions area and laid it over the Jobs and Tasks
// buttons — a press aimed at Jobs opened the status panel. So the stream's
// words live in the entry's name and in the panel, and the count stands for
// them in the row. That is checked here too: no toolbar button may answer a
// press with the entry.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-status-stream.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// The words this screen is read by, from StatusBar.tsx.
const words = lang === "zh-Hans"
  ? { reconnecting: "实时更新正在重新连接", connecting: "实时更新正在连接",
      need: (n) => `${n} 个待查看`, quiet: "没有待查看的" }
  : { reconnecting: "Live updates reconnecting", connecting: "Live updates connecting",
      need: (n) => `${n} need${n === 1 ? "s" : ""} a look`, quiet: "nothing needs a look" };

// Nothing else in the bar is asking for attention: no unreachable machine,
// no plan limit, no update notice. So a count of 1 can only be the stream.
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(30) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

/** The short screen, with the updates stream in one of its three states. */
const open = async (stream) => {
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([lang, stream]) => {
    // A stand-in for the real EventSource, so the page reaches the state
    // under test without a server: "open" answers, "reconnecting" answers
    // and then stops (useWorkspaceEvents sets reconnecting on error after a
    // successful open), "connecting" never answers at all.
    window.EventSource = class {
      constructor() {
        this.readyState = 0;
        this.onopen = this.onmessage = this.onerror = null;
        if (stream === "connecting") return;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          if (stream !== "reconnecting") return;
          setTimeout(() => { this.readyState = 2; this.onerror?.(); }, 150);
        }, 60);
      }
      addEventListener() {}
      close() { this.readyState = 2; }
    };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, [lang, stream]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    // Core answers throughout: a snapshot and no error is what makes it
    // healthy (connection-status.ts), which is the whole point here.
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: [], liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null } });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/machines") return route.fulfill({ json: { machines: [] } });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${stream}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  return { context, page };
};

/** The entry as a reader and a looker each get it. */
const readEntry = (page) => page.evaluate(() => {
  const el = document.querySelector(".core-status-entry");
  const bar = document.querySelector(".statusbar");
  const line = document.querySelector(".event-connection-status");
  if (!el) return { there: false, barShown: bar ? getComputedStyle(bar).display !== "none" : null };
  // Whether the line is really drawn, not just its own `display`: the folded
  // panel hides it through an ancestor, which a one-element read misses.
  const seen = (node) => {
    if (!node) return null;
    if (node.checkVisibility) return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && node.offsetParent !== null;
  };
  // The accessible name, skipping what is hidden from a reader: reading
  // textContent instead folds the visible duplicate back in and hides
  // whether the state is said once or twice.
  const walk = (node) => {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (node.getAttribute("aria-hidden") === "true") return "";
    return [...node.childNodes].map(walk).join("");
  };
  const text = (s) => (el.querySelector(s)?.textContent || "").replace(/\s+/g, " ").trim();
  // The room the entry takes from the row it was portaled into: every
  // toolbar button must still answer a press at its own middle.
  const actions = el.closest(".toolbar-actions") || document.querySelector(".toolbar-actions");
  const covered = [];
  for (const b of document.querySelectorAll(".toolbar button, .toolbar-actions button")) {
    if (b === el || el.contains(b)) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    if (at && (at === el || el.contains(at))) covered.push(`${b.className || b.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return {
    there: true,
    name: (el.getAttribute("aria-label") || walk(el)).replace(/\s+/g, " ").trim(),
    state: text(".core-status-state"),
    count: text(".core-status-count"),
    needsLook: el.classList.contains("needs-look"),
    dotHealthy: el.querySelector(".core-status-mark")?.hasAttribute("data-healthy") ?? null,
    // The bar's own line is folded away on this screen; the entry stands in
    // for it, and must not be saying the same thing twice beside it.
    barLineShown: seen(line), barLineThere: !!line,
    width: Math.round(el.getBoundingClientRect().width),
    actionsWidth: actions ? Math.round(actions.getBoundingClientRect().width) : null,
    covered,
    inViewport: (() => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.right <= window.innerWidth; })(),
  };
});

for (const stream of ["reconnecting", "connecting", "open"]) {
  const { context, page } = await open(stream);
  const e = await readEntry(page);
  console.log(`\n--- 951x669, Core answering, updates ${stream} ---\n  ${JSON.stringify(e)}`);
  check(e.there, `${stream}: the folded bar has its entry`);
  if (!e.there) { await context.close(); continue; }
  check(e.inViewport, `${stream}: and it is on screen`);
  if (stream === "open") {
    // The control: with nothing wrong, the count and the words are gone.
    // Without this the assertions above could be passing on anything.
    check(!e.count && !e.needsLook, `open: nothing is counted (count "${e.count}")`);
    check(!e.state, `open: and nothing is written out — the dot says it (state "${e.state}")`);
    check(e.dotHealthy === true, `open: the dot reads settled`);
    check(e.covered.length === 0,
      `open: the entry (${e.width}px of ${e.actionsWidth}px) covers no toolbar button${e.covered.length ? `: ${e.covered.join(", ")}` : ""}`);
    check(e.name.includes(words.quiet), `open: a reader is told it is quiet ("${e.name}")`);
  } else {
    const word = words[stream];
    check(e.count === words.need(1), `${stream}: it is counted, once (count "${e.count}")`);
    check(e.needsLook, `${stream}: and the entry is marked as wanting a look`);
    check(e.name.includes(word), `${stream}: a reader is told the state ("${e.name}")`);
    check(!e.state,
      `${stream}: and the words stay out of the row, where there is no space for them (state "${e.state}")`);
    check(e.name.includes(words.need(1)), `${stream}: and the count`);
    check(e.name.split(word).length === 2, `${stream}: each thing said once, not twice`);
    check(e.dotHealthy !== true, `${stream}: the dot does not read settled (${e.dotHealthy})`);
    check(e.covered.length === 0,
      `${stream}: the entry (${e.width}px of ${e.actionsWidth}px) covers no toolbar button${e.covered.length ? `: ${e.covered.join(", ")}` : ""}`);
    check(e.barLineShown !== true,
      `${stream}: the bar's own line stays folded away, so it is not said twice (there: ${e.barLineThere}, drawn: ${e.barLineShown})`);
  }
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
