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
const LANG = process.env.T15_LANG || "en";
assert.ok(LANG === "en" || LANG === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${LANG}`);
const HOME_LABEL = LANG === "zh-Hans" ? "返回 Home" : "Back to Home";
// A Home item that leads into this conversation: an approval with no project
// of its own, which Home sends on as `{kind: "request"}` — the path that
// opens a source whose origin is Home.
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const home = {
  generatedAt: ago(0),
  order: [],
  needsYou: [{ kind: "approval", agentId: "a", agentName: "Dev 8 · Mac / iOS",
    requestId: "req-1", title: "Run the check", since: ago(12) }],
  projects: [],
  links: [],
};

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
  // Where the floating one sits: it must ride the composer's edge, not lie
  // over a line of the reply being read (T-15, Dev 7 audit D1).
  const pill = document.querySelector(".jump-latest");
  const over = (() => {
    if (!pill) return null;
    const p = pill.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const covered = [...document.querySelectorAll(".conversation-inner [data-item-id] p, .conversation-inner [data-item-id] li")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top;
      }).length;
    return { covered, aboveComposerBy: composer ? Math.round(composer.top - p.bottom) : null,
      straddles: composer ? p.bottom >= composer.top - 1 : null };
  })();
  const bar = document.querySelector(".source-navigation");
  const homeAction = document.querySelector(".source-navigation-home");
  return { found, over, bar: !!bar,
    // What the bar offers, in order, so "primary" is a position and not a guess.
    barActions: bar ? [...bar.querySelectorAll("button")].filter(shown)
      .map((el) => (el.textContent || "").trim().slice(0, 24)) : [],
    homeAction: homeAction && shown(homeAction) ? (homeAction.textContent || "").trim() : null,
    homeOpen: !!document.querySelector('.toolbar-nav .catchup-nav[aria-current="page"]'),
    atEnd: scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 4 : null,
    top: Math.round(scroll?.scrollTop ?? -1) };
});

async function open(detail) {
  const context = await browser.newContext({ viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
  }, LANG);
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
    if (path === "/api/home") return route.fulfill({ json: home });
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
  check(seen.over?.covered === 0, `and it covers no line of the reply (${seen.over?.covered} covered)`);
  check(seen.over?.straddles === true,
    `it rides the composer's edge rather than floating above it (gap ${seen.over?.aboveComposerBy}px)`);
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
// A window opened from the rail offers no way back to Home: there is nowhere
// to go back to, and the bar is for the latest.
{
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns,
    conversation: { hasAfter: true, hasBefore: false } });
  await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = Math.round(s.scrollHeight * 0.4); });
  await page.waitForTimeout(400);
  const seen = await waysBack(page);
  console.log("rail window   ", JSON.stringify({ bar: seen.bar, barActions: seen.barActions, homeAction: seen.homeAction }));
  check(seen.homeAction === null, `and no way back to Home, which is not where this came from (${seen.homeAction})`);
  await context.close();
}

/** Opened from Home into this conversation: the path whose source's origin is
 * Home. Home's own item sends `{kind: "request"}`, which opens a source with
 * the default origin. */
const fromHome = async () => {
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns,
    conversation: { hasAfter: true, hasBefore: false } });
  await page.locator(".toolbar-nav .catchup-nav").first().click();
  await page.locator(".home-needs-item").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".home-needs-item").first().click();
  await page.locator(".source-navigation").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(700);
  return { context, page };
};

// The finding: the bar's one button went Home *instead of* to the latest, and
// `sourceOrigin` starts at "home", so a reader brought here by a Home link
// had no way to the latest at all — the floating button is suppressed while
// the bar shows, and the window's own link went when the bar became the one
// entry for it (#459 R3, P2).
{
  const { context, page } = await fromHome();
  const seen = await waysBack(page);
  console.log("from Home     ", JSON.stringify(seen));
  check(seen.bar, "a reading bar shows for a source opened from Home");
  check(seen.found.length === 1,
    `one way back to the latest (${seen.found.length}: ${seen.found.map((f) => f.where).join(", ") || "none"})`);
  check(seen.found[0]?.where === "reading-bar", "and it is the bar's, the floating one being suppressed under it");
  check(seen.barActions[0]?.includes(LANG === "zh-Hans" ? "返回最新" : "Back to latest"),
    `the way to the latest is the bar's first action (${JSON.stringify(seen.barActions)})`);
  check(seen.homeAction === HOME_LABEL,
    `and going back to Home stands beside it, not in its place (${seen.homeAction})`);
  check(seen.atEnd === false, "nothing jumped to the end on the way in");
  // Pressing it arrives at the latest and lets the source go. Whether the
  // bar itself then goes depends on Core no longer reporting a window —
  // `backToLatest` asks for the latest with `live.navigate({})` — and this
  // fixture answers every read with the same window, so the bar stays here.
  // What the conversation itself decides is asserted instead: it is at the
  // end, the source is let go, and its Home action goes with it.
  await page.locator(".source-navigation .quiet-button").first().click();
  await page.waitForTimeout(900);
  const after = await waysBack(page);
  console.log("  pressed latest", JSON.stringify({ bar: after.bar, atEnd: after.atEnd, found: after.found.length, homeAction: after.homeAction }));
  check(after.atEnd === true, `pressing it lands at the latest (atEnd ${after.atEnd})`);
  check(after.homeAction === null,
    `the source is let go, so the way back to Home goes with it (${after.homeAction})`);
  check(after.found.length === 1 && after.found[0]?.where === "reading-bar",
    `and the one way back is still the bar's, this fixture keeping its window open (${after.found.length}: ${after.found.map((f) => f.where).join(", ") || "none"})`);
  await context.close();
}
// And the other action still goes Home.
{
  const { context, page } = await fromHome();
  await page.locator(".source-navigation-home").click();
  await page.waitForTimeout(800);
  const after = await waysBack(page);
  console.log("  pressed Home  ", JSON.stringify({ homeOpen: after.homeOpen, bar: after.bar }));
  check(after.homeOpen, `the other action goes back to Home (${after.homeOpen})`);
  await context.close();
}
await browser.close();
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
