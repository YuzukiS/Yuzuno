// The way in to the work list and the Turn index, with the rail put away
// (T-15, #459 R1, P2).
//
// Both entries in the conversation's head open a view *in the rail*. They
// swapped which view the rail renders and nothing else — so with the rail
// collapsed from the toolbar, where `.rail-hidden .rail` is `display: none`,
// a press changed nothing a reader could see, while the index beside it
// still reported itself open. On a touched screen that is the whole way in:
// the docks there take no presses at all, by design, so the work list and
// the Turn index had no reachable entrance once the rail was away.
//
// So this reads the press a reader actually makes: put the rail away, press
// each entry, and ask whether the thing it names is on screen — and whether
// what the button says about itself matches. Closing a view leaves the rail
// as the reader had it; it is not this task's place to put it back.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-rail-open.mjs
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
  lastSeq: 12, reviewedSeq: 12, connectionState: "connected", goal: "", projectId: null,
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
// Something for the work view to hold, so pressing it has a reason.
const jobs = [0, 1, 2].map((i) => ({
  id: `j${i}`, name: `web-check-${i}`, status: i === 0 ? "failed" : "running", reason: null,
  agentId: "a", agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
  resources: res, reservation: res, exclusive: false, createdAt: iso(-600_000), startedAt: iso(-500_000),
  finishedAt: i === 0 ? iso(-100_000) : null, reserved: false, cursor: i, requestId: `r${i}`,
}));
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 14 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 4000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：接着看下一部分。` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文内容".repeat(16) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

// The toolbar's rail toggle, by the name it carries rather than by its place
// in the row: a button added before it would otherwise send these presses
// somewhere else and fail further down, where the cause is not obvious.
const RAIL_TOGGLE = lang === "zh-Hans"
  ? ["隐藏 Agent 侧栏", "显示 Agent 侧栏"]
  : ["Hide agent sidebar", "Show agent sidebar"];

const browser = await launchBrowser();
const errors = [];
// Wide enough to keep the side-by-side layout, and worked by a finger: the
// screen this task is for, and the one where the docks give up their presses.
const context = await browser.newContext({
  viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript((lang) => {
  window.EventSource = class { constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 40); }
    addEventListener() {} close() {} };
  addEventListener("DOMContentLoaded", () =>
    document.documentElement.style.setProperty("--safe-right", "84px"));
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
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
  if (path === "/api/ci") return route.fulfill({ json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null } });
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
await page.waitForTimeout(800);

/** What is on screen, and what each entry says about itself. */
const state = () => page.evaluate(() => {
  const drawn = (el) => {
    if (!el) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rail = document.querySelector(".rail");
  const work = document.querySelector(".work-activity-entry");
  const index = document.querySelector(".conversation-index-entry");
  return {
    railHidden: document.querySelector(".app")?.classList.contains("rail-hidden") ?? null,
    railDrawn: drawn(rail),
    railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    // Which of the three the rail is showing.
    agents: drawn(document.querySelector(".agent-list")),
    workView: drawn(document.querySelector(".work-activity-column")),
    indexView: drawn(document.querySelector(".rail-turn-index")),
    workSays: work?.getAttribute("aria-expanded") ?? null,
    indexSays: index?.getAttribute("aria-expanded") ?? null,
    // Both entries must stay pressable by a finger throughout.
    workTarget: work ? (() => { const r = work.getBoundingClientRect();
      const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { w: Math.round(r.width), h: Math.round(r.height), own: !!at && (at === work || work.contains(at)) }; })() : null,
    indexTarget: index ? (() => { const r = index.getBoundingClientRect();
      const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { w: Math.round(r.width), h: Math.round(r.height), own: !!at && (at === index || index.contains(at)) }; })() : null,
  };
});

const before = await state();
console.log(`\n--- 951x669, a finger, the rail as it opens ---\n  ${JSON.stringify(before)}`);
check(before.railDrawn && before.agents, `the rail starts out showing the Agents (${before.railWidth}px)`);
for (const [what, t] of [["the work entry", before.workTarget], ["the reading index", before.indexTarget]])
  check(!!t && Math.min(t.w, t.h) >= 40 && t.own, `${what} is a finger's worth and takes its own press (${t ? `${t.w}x${t.h}, own ${t.own}` : "missing"})`);

// Put the rail away, the way a reader does: the toolbar's own toggle.
const toggle = page.locator(".toolbar .icon-button").first();
const toggleName = await toggle.getAttribute("aria-label");
check(RAIL_TOGGLE.includes(toggleName || ""),
  `the toolbar button these presses use is the rail's own ("${toggleName}")`);
await toggle.click();
await page.waitForTimeout(400);
const away = await state();
console.log(`\n--- the rail put away from the toolbar ---\n  ${JSON.stringify(away)}`);
check(away.railHidden === true && !away.railDrawn, `the rail is away (rail-hidden ${away.railHidden}, drawn ${away.railDrawn})`);
check(away.workSays !== "true" && away.indexSays !== "true",
  `and neither entry claims to be open (work ${away.workSays}, index ${away.indexSays})`);

// The press this finding is about: the work list, with the rail away.
await page.locator(".work-activity-entry").click();
await page.waitForTimeout(500);
const work = await state();
console.log(`\n--- the work entry pressed, from there ---\n  ${JSON.stringify(work)}`);
check(work.railDrawn, `the rail comes back (drawn ${work.railDrawn}, ${work.railWidth}px)`);
check(work.workView, `showing the work this conversation has (${work.workView})`);
check(!work.agents && !work.indexView, `and that view alone (agents ${work.agents}, index ${work.indexView})`);
check(work.workSays === "true", `the entry says it is open (${work.workSays})`);
check(work.indexSays !== "true", `and the index does not (${work.indexSays})`);

// And the Turn index, from the same place.
await page.locator(".conversation-index-entry").click();
await page.waitForTimeout(500);
const index = await state();
console.log(`\n--- the reading index pressed ---\n  ${JSON.stringify(index)}`);
check(index.railDrawn && index.indexView, `the rail shows where the reader is (drawn ${index.railDrawn}, index ${index.indexView})`);
check(!index.workView, `in place of the work view (${index.workView})`);
check(index.indexSays === "true", `the index says it is open (${index.indexSays})`);
check(index.workSays !== "true", `and the work entry does not (${index.workSays})`);

// Closing the view leaves the rail as it now is: it was opened for this, and
// putting it away again would be deciding something the reader did not ask.
await page.locator(".conversation-index-entry").click();
await page.waitForTimeout(500);
const shut = await state();
console.log(`\n--- the index pressed again ---\n  ${JSON.stringify(shut)}`);
check(shut.railDrawn, `the rail stays (drawn ${shut.railDrawn})`);
check(shut.agents && !shut.indexView && !shut.workView, `showing the Agents again (${shut.agents})`);
check(shut.indexSays !== "true", `and the index no longer says it is open (${shut.indexSays})`);

// What a reader is told must track what is drawn, in the other direction too:
// put the rail away while a view is open and nothing may still claim it.
await page.locator(".conversation-index-entry").click();
await page.waitForTimeout(400);
await toggle.click();
await page.waitForTimeout(400);
const hiddenAgain = await state();
console.log(`\n--- the rail put away while the index was open ---\n  ${JSON.stringify(hiddenAgain)}`);
check(!hiddenAgain.railDrawn, `the rail is away again (drawn ${hiddenAgain.railDrawn})`);
check(hiddenAgain.indexSays !== "true",
  `and the index does not say it is open while it cannot be seen (${hiddenAgain.indexSays})`);

// And the press has to answer what is on screen, not what was last asked
// for. A view left open behind a collapsed rail still said open, so the next
// press turned it off where nothing could be seen and a second was needed
// (#459 R2, P3-1). One press, from there.
for (const [what, entry, view] of [
  ["the work view", ".work-activity-entry", "workView"],
  ["the reading index", ".conversation-index-entry", "indexView"],
]) {
  await page.locator(entry).click();
  await page.waitForTimeout(400);
  const opened = await state();
  check(opened[view] && opened.railDrawn, `${what} opens with the rail there`);
  await toggle.click();
  await page.waitForTimeout(400);
  const put = await state();
  check(!put.railDrawn, `${what}: the rail is put away over it (drawn ${put.railDrawn})`);
  await page.locator(entry).click();
  await page.waitForTimeout(500);
  const back = await state();
  console.log(`\n--- one press on ${what} with the rail away over it ---\n  ${JSON.stringify(back)}`);
  check(back.railDrawn && back[view],
    `${what} comes back in one press, not two (drawn ${back.railDrawn}, view ${back[view]})`);
  // Leave it closed for the next pass.
  await page.locator(entry).click();
  await page.waitForTimeout(400);
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
