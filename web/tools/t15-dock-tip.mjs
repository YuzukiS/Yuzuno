// Where a Job, a run or a sub-agent says its name (T-15, #459 new pair, P2).
//
// Below 760px of conversation the dock's labels are hidden, so each item's
// tip is the only place its name shows to a pointer or a keyboard. Making the
// dock a scroll container to stop it spilling over the composer (round 1,
// P2a) clipped that tip away: a non-visible overflow on one axis makes the
// other non-visible too, so `overflow-y: auto` took `overflow-x` with it, and
// the tip sits at `left: 100% + 8px` — outside the dock's 40px. The hover
// strip (`.work-dock::before`, inset -20px) went the same way. Touch never
// saw either, because there the dock takes no presses at all.
//
// The scrolling is an inner box now, and the tip is drawn into the page from
// the item's own rect. Both halves are checked here: that nothing of the dock
// clips, and that the tip is wholly on screen and on top where it claims to
// be — by pointer and by keyboard — while the composer's "+" keeps its 40px
// and the dock's last entry stays above it.
//
// A third screen, wide, because being drawn into the page costs the tip two
// things that came from the nav it used to live in. The rule that stops a
// wide conversation saying the time twice is inside
// `@container conversation (min-width: 760px)`, and the body is in no such
// container, so it stopped matching; and the nav's `lang` no longer reaches
// it, so CJK in the tip broke and rendered as whatever the document says
// (#459 R6, P3). Both are carried on the tip itself now, and read here.
//
// Two screens for the rest, because those halves live under different conditions. The
// tip is a pointer's and a keyboard's, so it is read with a mouse; the 40px
// "+" rule is a finger's (`(hover: none) and (pointer: coarse)`), and the
// press the dock once stole was a finger's too, so that is read by touch.
// With a mouse the "+" is its ordinary 30px and nothing is wrong with that.
//
// One measurement note: the tip is `pointer-events: none`, as it was before
// this change, so a hit test cannot land on it in the product. To ask "is it
// really painted here, on top?", this check turns that off for the duration
// of the hit test and puts it back. The product stays non-interactive.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-dock-tip.mjs
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
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "working", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
// A full dock: every group at its Appearance limit, so it has to scroll.
const job = (i, status) => ({
  id: `j${i}`, name: `web-check-${i} 跨设备布局量测`, status, reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
  resources: res, reservation: res, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: status === "running" ? null : iso(-100_000 + i * 1000),
  reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running"), job(1, "running"), job(2, "succeeded"), job(3, "failed"),
  job(4, "succeeded"), job(5, "succeeded"), job(6, "succeeded")];
const run = (i, status, conclusion) => ({
  id: `c${i}`, name: `CI · web (${i})`, repository: "YuzukiS/yuzuno-public", runId: `${1000 + i}`,
  attempt: "1", headSha: "f8b8a0b", status, rawStatus: status, conclusion,
  url: "https://example.invalid/", createdAt: iso(-400_000 + i * 1000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000 + i * 1000), observedAt: iso(-5_000), cursor: i, runWatched: status === "running",
});
const ci = { runs: [run(0, "running", null), run(1, "completed", "success"), run(2, "completed", "success")],
  subscriptions: [], hasMore: false, nextBefore: null };
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(14) },
      ...(i >= 34
        ? [{ id: `sa${i}`, type: "claudeToolUse", name: "Task", status: i === 39 ? "inProgress" : "completed",
            subAgent: { taskId: `st${i}`, runId: `sr${i}`, type: "Explore",
              description: `中屏布局量测 ${i}`, prompt: "量测" } }]
        : []),
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

/** How far down the dock is *drawn*: each entry clipped to the box that
    scrolls, since an entry scrolled out of view still has a rect below it.
    Read with the box at the top and again at the end, the honest worst case. */
const drawnBottom = (page) => page.evaluate(() => {
  const scroll = document.querySelector(".work-dock-scroll");
  const dock = document.querySelector(".work-dock");
  if (!scroll || !dock) return null;
  const clip = scroll.getBoundingClientRect();
  const read = () => {
    let deepest = -Infinity, name = null;
    for (const el of document.querySelectorAll(".work-dock-item")) {
      const r = el.getBoundingClientRect();
      const bottom = Math.min(r.bottom, clip.bottom);
      if (bottom > r.top && bottom > deepest) { deepest = bottom; name = el.className; }
    }
    return { bottom: Math.round(deepest), name };
  };
  const atTop = read();
  scroll.scrollTop = scroll.scrollHeight;
  const atEnd = read();
  scroll.scrollTop = 0;
  return { clip: Math.round(clip.bottom), dock: Math.round(dock.getBoundingClientRect().bottom),
    atTop: atTop.bottom, atEnd: atEnd.bottom,
    composer: Math.round(document.querySelector(".composer-area")?.getBoundingClientRect().top ?? 0) };
});

const browser = await launchBrowser();
const errors = [];

/** The same 951x669 screen with an 84px inset, by mouse or by finger. */
const open = async (touch, width = 951) => {
  const context = await browser.newContext({
    viewport: { width, height: 669 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { close() {} };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, lang);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: ci });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${touch ? "touch" : "mouse"}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(900);
  return { context, page };
};

const { context, page } = await open(false);

// The shape of the thing first: a narrow conversation, a dock that scrolls
// inside itself, and a dock that clips nothing.
const shape = await page.evaluate(() => {
  const panel = document.querySelector(".main-panel");
  const dock = document.querySelector(".work-dock");
  const scroll = document.querySelector(".work-dock-scroll");
  const label = document.querySelector(".work-dock-label");
  const items = [...document.querySelectorAll(".work-dock-item")];
  const composer = document.querySelector(".composer-area");
  return {
    container: Math.round(panel?.getBoundingClientRect().width ?? 0),
    labelsShown: label ? getComputedStyle(label).display !== "none" : null,
    dockOverflow: dock ? `${getComputedStyle(dock).overflowX}/${getComputedStyle(dock).overflowY}` : null,
    scrollOverflow: scroll ? `${getComputedStyle(scroll).overflowX}/${getComputedStyle(scroll).overflowY}` : null,
    scrolls: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
    items: items.length,
    composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : null,
  };
});
const drawn = await drawnBottom(page);
console.log(`\n--- 951x669 with a mouse, an 84px inset ---`);
console.log(`  conversation container ${shape.container}px, labels shown: ${shape.labelsShown}`);
console.log(`  overflow: dock ${shape.dockOverflow}, inner box ${shape.scrollOverflow}, scrolls ${shape.scrolls}`);
console.log(`  ${shape.items} items; drawn down to ${JSON.stringify(drawn)}`);

check(shape.container < 760 && shape.labelsShown === false,
  `the conversation is narrow enough to hide the labels (${shape.container}px)`);
check(shape.dockOverflow === "visible/visible",
  `the dock itself clips nothing (overflow ${shape.dockOverflow})`);
check(shape.scrollOverflow !== "visible/visible" && shape.scrolls === true,
  `and the scrolling is the box inside it (${shape.scrollOverflow}, scrolls ${shape.scrolls})`);
check(!!drawn && drawn.clip <= drawn.composer && drawn.dock <= drawn.composer,
  `the dock's box ends above the composer (box ${drawn?.clip}, dock ${drawn?.dock} <= ${drawn?.composer})`);
check(!!drawn && drawn.atTop <= drawn.composer && drawn.atEnd <= drawn.composer,
  `and no entry is drawn over it, scrolled to the top or to the end (${drawn?.atTop}, ${drawn?.atEnd} <= ${drawn?.composer})`);

/** Hover or focus an item, then read where its tip went. */
const tipAfter = async (how) => {
  if (how === "pointer") await page.locator(".work-dock-item").nth(2).hover();
  else await page.locator(".work-dock-item").nth(2).focus();
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const tip = document.querySelector(".work-dock-tip");
    if (!tip) return { there: false };
    const r = tip.getBoundingClientRect();
    const style = getComputedStyle(tip);
    // Painted on top where it says it is? The tip is pointer-events: none in
    // the product, as it was before, so a hit test is given one moment of
    // pointer events and then has them taken away again.
    const was = tip.style.pointerEvents;
    tip.style.pointerEvents = "auto";
    const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    tip.style.pointerEvents = was;
    return {
      there: true,
      box: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) },
      inViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      onPage: tip.parentElement === document.body,
      insideScrollBox: !!tip.closest(".work-dock-scroll"),
      shown: style.visibility !== "hidden" && Number(style.opacity) !== 0,
      paint: `visibility ${style.visibility}, opacity ${style.opacity}`,
      events: style.pointerEvents,
      onTop: at === tip || tip.contains(at),
      says: (tip.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      window: { w: window.innerWidth, h: window.innerHeight },
    };
  });
};

for (const how of ["pointer", "keyboard"]) {
  const tip = await tipAfter(how);
  console.log(`\n--- the tip, by ${how} ---`);
  console.log(`  ${JSON.stringify(tip)}`);
  check(tip.there, `${how}: the item names itself`);
  if (!tip.there) continue;
  check(tip.shown, `${how}: and the name is shown (${tip.paint})`);
  check(tip.inViewport, `${how}: wholly on screen (${JSON.stringify(tip.box)} in ${tip.window.w}x${tip.window.h})`);
  check(tip.onPage && !tip.insideScrollBox,
    `${how}: outside the box that scrolls, so nothing clips it (on body: ${tip.onPage})`);
  check(tip.onTop, `${how}: and painted on top where it sits ("${tip.says}")`);
  check(tip.events === "none", `${how}: while still taking no presses of its own (${tip.events})`);
  // Let it go again before the next way in.
  await page.locator(".conversation-scroll").hover().catch(() => {});
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(200);
}

await context.close();

// And on a finger's screen, the press this dock once stole is still whole.
const { context: touchContext, page: touchPage } = await open(true);
const plus = await touchPage.evaluate(() => {
  const coarse = matchMedia("(hover: none) and (pointer: coarse)").matches;
  const el = document.querySelector(".composer-plus");
  if (!el) return { coarse, there: false };
  const r = el.getBoundingClientRect();
  const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + r.height / 2],
    [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + 2],
    [r.left + r.width / 2, r.bottom - 2]];
  const thieves = [];
  let landed = 0;
  for (const [x, y] of points) {
    const at = document.elementFromPoint(x, y);
    if (at === el || el.contains(at)) landed++;
    else if (at) thieves.push(`${at.className || at.tagName}`);
  }
  const dock = document.querySelector(".work-dock");
  const items = [...document.querySelectorAll(".work-dock-item")];
  return { coarse, there: true, w: Math.round(r.width), h: Math.round(r.height), landed,
    of: points.length, thieves,
    dockEvents: dock ? getComputedStyle(dock).pointerEvents : null, items: items.length };
});
console.log(`\n--- 951x669 by finger: the composer's "+" ---\n  ${JSON.stringify(plus)}`);
check(plus.coarse, `this screen really is a finger's (coarse pointer: ${plus.coarse})`);
check(plus.there && Math.min(plus.w, plus.h) >= 40, `"+" is a finger's worth (${plus.w}x${plus.h})`);
check(plus.landed === plus.of,
  `and takes every press at its middle and edges (${plus.landed}/${plus.of}${plus.thieves?.length ? `, taken by ${plus.thieves.join(", ")}` : ""})`);
const touchDrawn = await drawnBottom(touchPage);
console.log(`  drawn down to ${JSON.stringify(touchDrawn)}`);
check(!!touchDrawn && touchDrawn.clip <= touchDrawn.composer && touchDrawn.dock <= touchDrawn.composer,
  `by finger too, the dock's box ends above the composer (box ${touchDrawn?.clip}, dock ${touchDrawn?.dock} <= ${touchDrawn?.composer})`);
check(!!touchDrawn && touchDrawn.atTop <= touchDrawn.composer && touchDrawn.atEnd <= touchDrawn.composer,
  `and no entry is drawn over it either way it is scrolled (${touchDrawn?.atTop}, ${touchDrawn?.atEnd} <= ${touchDrawn?.composer})`);
await touchContext.close();

// A wide conversation: the time is beside the node there, so the tip must
// not repeat it, and the tip must still be in the reader's language.
const { context: wideContext, page: widePage } = await open(false, 1440);
await widePage.locator(".work-dock-item").nth(2).hover();
await widePage.waitForTimeout(300);
const wide = await widePage.evaluate(() => {
  const panel = document.querySelector(".main-panel");
  const tip = document.querySelector(".work-dock-tip");
  const label = document.querySelector(".work-dock-item .work-dock-label .work-dock-when");
  const drawn = (el) => {
    if (!el) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inTip = tip?.querySelector("small.work-dock-when") ?? null;
  return {
    conversation: Math.round(panel?.getBoundingClientRect().width ?? 0),
    tipThere: !!tip,
    // What the nav used to give it, and the body does not.
    lang: tip?.getAttribute("lang") ?? null,
    closestLang: tip?.closest("[lang]")?.getAttribute("lang") ?? null,
    wideFlag: tip?.hasAttribute("data-wide") ?? null,
    besideTheNode: drawn(label),
    timeInTip: !!inTip && drawn(inTip),
  };
});
console.log(`\n--- 1440 wide, a mouse: what the tip kept of the nav ---\n  ${JSON.stringify(wide)}`);
check(wide.conversation >= 760, `the conversation is wide enough to say the time beside the node (${wide.conversation}px)`);
check(wide.tipThere, `the tip is there to read (${wide.tipThere})`);
check(wide.besideTheNode, `and the time is beside the node (${wide.besideTheNode})`);
check(wide.timeInTip === false,
  `so the tip does not say it twice (in the tip: ${wide.timeInTip}, flag ${wide.wideFlag})`);
check(wide.lang === "zh-Hans" || wide.lang === "en",
  `the tip carries the reader's language itself, the nav's no longer reaching it (${wide.lang})`);
check(wide.lang === (lang === "zh-Hans" ? "zh-Hans" : "en"),
  `and it is the language being read (${wide.lang} for ${lang})`);
await wideContext.close();

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
