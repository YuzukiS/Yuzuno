// What a conversation with nothing running pays for the work dock (T-15,
// #459 R4, P2).
//
// Nine rules key the conversation's shape on `.work-dock:not(:empty)`: the
// left gutter and the request pin's offset (work-dock.css), the column and
// the room it is centred in (turn-dock.css), the reading strips' left edge
// (conversation-strips.css), and on a phone the work button and the strip
// the dock buttons sit in (phone-docks.css). On main the nav held its
// children directly, so a dock with nothing in it was `:empty` and none of
// that applied.
//
// Then an earlier finding here (#459 new pair, P2) put a scrolling box
// inside the nav so that each item's tip could escape it. The nav is never
// `:empty` after that — it always holds that box — so every one of those
// rules began matching every conversation. A conversation with no Jobs, no
// runs and no sub-agents gave up the gutter and the offsets for a dock that
// is not drawn, and on a phone it showed the button that opens the empty
// drawer.
//
// This is measured, not read off the stylesheets: Chromium evaluates `:has`,
// so the gutter, the offsets and the button are read from the page at two
// widths, with nothing running and with work running. A source check would
// only say the selectors changed; this says what a reader gets.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-empty-dock.mjs
// T15_LANG=zh-Hans reads the same screens in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "working", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 12, reviewedSeq: 12, connectionState: "connected", goal: "", projectId: null,
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
const jobs = [0, 1].map((i) => ({
  id: `j${i}`, name: `web-check-${i}`, status: "running", reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
  resources: res, reservation: res, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: null, reserved: false, cursor: i, requestId: `r${i}`,
}));
// A working Agent, so the request pin is on screen to be offset or not.
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`, status: i === 11 ? "inProgress" : "completed",
    startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：接着看下一部分。` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文内容".repeat(18) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

/** The same conversation, with work running or with none. */
const open = async ({ width, height, working, phone }) => {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([lang, inset]) => {
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 40); }
      addEventListener() {} close() {} };
    if (inset) addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", `${inset}px`));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
  }, [lang, phone ? 0 : 84]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs")
      return route.fulfill({ json: working ? { jobs, liveJobs: [], hasMore: false, nextBefore: null } : noJobs });
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
  page.on("pageerror", (e) => errors.push(`${width}x${height} ${working ? "working" : "quiet"}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  if (await page.locator(".app.phone-list").count())
    await page.locator(".agent-list .agent-select").first().click();
  await page.locator(".conversation-scroll").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  return { context, page };
};

/** What the conversation gives up for the dock, as the page computes it. */
const read = (page) => page.evaluate(() => {
  const drawn = (el) => {
    if (!el) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const body = document.querySelector(".main-panel .conversation-body");
  const dock = document.querySelector(".main-panel .work-dock");
  const scroll = document.querySelector(".main-panel .work-dock-scroll");
  const strips = document.querySelector(".main-panel .conversation-strips");
  const pin = document.querySelector(".main-panel .current-turn-prompt");
  const left = (el) => (el ? getComputedStyle(el).left : null);
  return {
    dockThere: !!dock,
    dockDrawn: drawn(dock),
    // The box exists whether or not anything is in it: that is the whole
    // reason `:empty` stopped telling these rules anything.
    scrollThere: !!scroll,
    scrollEmpty: scroll ? scroll.children.length === 0 : null,
    items: document.querySelectorAll(".main-panel .work-dock-item").length,
    gutterLeft: body ? getComputedStyle(body).getPropertyValue("--gutter-left").trim() : null,
    stripsLeft: left(strips),
    pinThere: !!pin,
    pinLeft: left(pin),
    phoneWorkButton: drawn(document.querySelector(".main-panel .phone-dock-work")),
    innerLeft: (() => {
      const inner = document.querySelector(".main-panel .conversation-inner");
      const pane = document.querySelector(".main-panel .conversation-scroll");
      if (!inner || !pane) return null;
      return Math.round(inner.getBoundingClientRect().left - pane.getBoundingClientRect().left);
    })(),
  };
});

// A middling screen: the one this task is for.
const quiet = await open({ width: 951, height: 669, working: false });
const q = await read(quiet.page);
console.log(`\n--- 951x669, nothing running ---\n  ${JSON.stringify(q)}`);
const busy = await open({ width: 951, height: 669, working: true });
const b = await read(busy.page);
console.log(`--- 951x669, two Jobs running ---\n  ${JSON.stringify(b)}`);

// The ground the measurement stands on: the box is there either way, so
// `:empty` on the nav cannot be what tells these rules anything.
check(q.scrollThere && b.scrollThere, `the scrolling box is inside the dock either way (${q.scrollThere}, ${b.scrollThere})`);
check(q.scrollEmpty === true && q.items === 0, `with nothing in it when nothing runs (${q.items} items)`);
check(b.items > 0, `and the items in it when work runs (${b.items})`);
check(!q.dockDrawn, `a dock with nothing in it is not drawn (${q.dockDrawn})`);
check(b.dockDrawn, `and one with work in it is (${b.dockDrawn})`);

// What it costs. 42px is the dock's own width plus 2; the conversation's
// own gutter is narrower, and a dock that is not drawn must not take it.
check(q.gutterLeft !== b.gutterLeft,
  `a quiet conversation does not give up the dock's gutter (quiet ${q.gutterLeft}, working ${b.gutterLeft})`);
check(q.pinThere && b.pinThere, `the request pin is on screen in both (${q.pinThere}, ${b.pinThere})`);
check(q.pinLeft !== b.pinLeft,
  `nor the request pin's offset (quiet ${q.pinLeft}, working ${b.pinLeft})`);
check(q.stripsLeft !== b.stripsLeft,
  `nor the reading strips' left edge (quiet ${q.stripsLeft}, working ${b.stripsLeft})`);
check(q.innerLeft !== null && b.innerLeft !== null && q.innerLeft < b.innerLeft,
  `so the text starts further left when nothing runs (${q.innerLeft}px vs ${b.innerLeft}px)`);
await quiet.context.close();
await busy.context.close();

// And a phone, where the cost is a button that opens an empty drawer.
const phoneQuiet = await open({ width: 390, height: 844, working: false, phone: true });
const pq = await read(phoneQuiet.page);
const phoneBusy = await open({ width: 390, height: 844, working: true, phone: true });
const pb = await read(phoneBusy.page);
console.log(`\n--- 390x844 phone, nothing running ---\n  ${JSON.stringify(pq)}`);
console.log(`--- 390x844 phone, two Jobs running ---\n  ${JSON.stringify(pb)}`);
check(!pq.phoneWorkButton,
  `a phone with nothing running offers no way into an empty dock (${pq.phoneWorkButton})`);
check(pb.phoneWorkButton,
  `and one with work running does (${pb.phoneWorkButton})`);
await phoneQuiet.context.close();
await phoneBusy.context.close();

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
