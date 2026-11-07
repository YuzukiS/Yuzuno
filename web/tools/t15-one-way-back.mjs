// One way back to the latest messages, never two (T-15). The conversation had
// three: a bar for the source being read, a link where a loaded window ends,
// and a floating button. Two could show at once and the floating one covered
// the text. A source's bar carries the only one, and the floating button
// stands in when no bar does, a window of earlier messages included (YN-19:
// it has no bar; newer pages load as the reader scrolls). On a desktop the
// floating one is centred on the column just above the composer, over no
// text and none of the composer. Nothing is sent, and nothing jumps to the
// end.
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
  // Where the floating one sits: just above the composer, centred on the
  // column, not over a line of the reply being read (T-15, Dev 7 audit D1;
  // YN-19).
  const pill = document.querySelector(".jump-latest");
  const over = (() => {
    if (!pill) return null;
    const p = pill.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    // Against the lines themselves, clipped to what the pane is showing.
    // Two things made this a coin flip before. A paragraph's box spans the
    // whole column however short its last line is, so blocks said "covered"
    // for text that ends well left of the pill; and a line scrolled past the
    // pane's edge keeps its rect down there, where the pane no longer draws
    // it, so a line nobody can see counted as covered. Which paragraph that
    // happened to be depended on the scroll, so any change in content height
    // flipped the answer (#459 R4).
    const view = document.querySelector(".conversation-scroll")?.getBoundingClientRect();
    const covered = [...document.querySelectorAll(".conversation-inner [data-item-id] p, .conversation-inner [data-item-id] li")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.height > 0 && p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top)) return false;
        const range = document.createRange();
        range.selectNodeContents(el);
        return [...range.getClientRects()].some((line) => {
          if (!(line.width > 0 && line.height > 0)) return false;
          // What the pane actually shows of this line.
          const top = view ? Math.max(line.top, view.top) : line.top;
          const bottom = view ? Math.min(line.bottom, view.bottom) : line.bottom;
          if (bottom - top <= 0) return false;
          return p.left < line.right && p.right > line.left && p.top < bottom && p.bottom > top;
        });
      }).length;
    const column = document.querySelector(".conversation-inner")?.getBoundingClientRect();
    return { covered, aboveComposerBy: composer ? Math.round(composer.top - p.bottom) : null,
      clearOfComposer: composer ? p.bottom <= composer.top + 0.5 : null,
      centredOff: column ? Math.round(((p.left + p.right) / 2 - (column.left + column.right) / 2) * 10) / 10 : null };
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
  check(seen.over?.clearOfComposer === true && seen.over.aboveComposerBy <= 24,
    `it sits just above the composer, not over it (gap ${seen.over?.aboveComposerBy}px)`);
  check(Math.abs(seen.over?.centredOff ?? 99) <= 2, `and is centred on the conversation column (${seen.over?.centredOff}px off)`);
  check(seen.atEnd === false, "nothing scrolled the conversation to the end by itself");
  await context.close();
}
// The same question asked on purpose rather than by luck: a line that
// reaches the pill's width, put at the pane's bottom edge where the pill is.
// Scrolling to a fraction leaves whichever line it leaves, so whether the
// overlap showed depended on the content's height — it passed in English,
// failed in Chinese, and changed with any edit that reflowed the text
// (#459 R4).
{
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns });
  // Up off the end first: that is what brings the floating one out at all.
  await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = Math.round(s.scrollHeight * 0.4); });
  await page.waitForTimeout(400);
  const placed = await page.evaluate(() => {
    const pane = document.querySelector(".conversation-scroll");
    const pill = document.querySelector(".jump-latest");
    if (!pane || !pill) return null;
    const p = pill.getBoundingClientRect();
    for (const el of document.querySelectorAll(".conversation-inner [data-item-id] p")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const line = [...range.getClientRects()].find((l) => l.width > 0 && l.right > p.left + 8);
      if (!line) continue;
      // Its middle just inside the pane's bottom edge, which is the band the
      // pill reaches into.
      const view = pane.getBoundingClientRect();
      pane.scrollTop += line.top + line.height / 2 - (view.bottom - 6);
      return { text: (el.textContent || "").trim().slice(0, 14) };
    }
    return null;
  });
  await page.waitForTimeout(400);
  const seen = await waysBack(page);
  console.log("line at the pill", JSON.stringify({ placed, over: seen.over, found: seen.found.length }));
  check(!!placed, `a reply line reaches the pill's width, to be put under it (${JSON.stringify(placed)})`);
  check(seen.over?.covered === 0,
    `and with one there on purpose the pill still covers no line (${seen.over?.covered} covered)`);
  check(seen.over?.clearOfComposer === true,
    `while still clear of the composer (gap ${seen.over?.aboveComposerBy}px)`);
  await context.close();
}
// A window of earlier messages: no bar, the floating one, and nothing
// repeats it (YN-19).
{
  const { context, page } = await open({ agent, pending: [], messageReceipts: [], artifacts: [], turns,
    conversation: { hasAfter: true, hasBefore: false } });
  await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = Math.round(s.scrollHeight * 0.4); });
  await page.waitForTimeout(400);
  const seen = await waysBack(page);
  console.log("history window", JSON.stringify(seen));
  check(!seen.bar, "no reading bar for a window of earlier messages");
  check(seen.found.length === 1, `still one way back (${seen.found.length}: ${seen.found.map((f) => f.where).join(", ") || "none"})`);
  check(seen.found[0]?.where === "floating", "and it is the floating one, not a bar's or the window's");
  check(seen.atEnd === false, "nothing jumped to the end");
  await context.close();
}
// A window opened from the rail offers no way back to Home: there is nowhere
// to go back to.
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
  // Pressing it arrives at the latest and lets the source go, and its bar
  // with it. `backToLatest` asks for the latest with `live.navigate({})`,
  // and this fixture answers every read with the same window of earlier
  // messages, so the floating one stands in for the bar here (YN-19).
  // What the conversation itself decides is asserted: it is at the end, the
  // source is let go, and its Home action goes with it.
  await page.locator(".source-navigation .quiet-button").first().click();
  await page.waitForTimeout(900);
  const after = await waysBack(page);
  console.log("  pressed latest", JSON.stringify({ bar: after.bar, atEnd: after.atEnd, found: after.found.length, homeAction: after.homeAction }));
  check(after.atEnd === true, `pressing it lands at the latest (atEnd ${after.atEnd})`);
  check(after.homeAction === null,
    `the source is let go, so the way back to Home goes with it (${after.homeAction})`);
  check(!after.bar && after.found.length === 1 && after.found[0]?.where === "floating",
    `the bar goes with it, and the floating one stands in, this fixture keeping its window open (${after.found.length}: ${after.found.map((f) => f.where).join(", ") || "none"})`);
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
