// Work activity counts every review the conversation has, not the ones the
// dock has room for (T-15, #459 R7, P3).
//
// R5 made reviews part of Work activity, so that on a touched screen wider
// than a phone — where the dock takes no presses — the head's entry and its
// column are the way in to them (t15-review-reach.mjs). But it registered
// what the dock drew: the dock's slice, as many as Settings allows. Jobs and
// sub-agents register everything they read. So:
//
//  - with the dock's two, an older review that asked for changes, behind a
//    running one and a newer one, was neither counted nor listed: the entry
//    said nothing needed a look;
//  - with the dock's reviews at 0, the component was never mounted, and
//    reviews were gone from Work activity altogether — no entry, no column
//    group, no "Open Reviews".
//
// This reads both through the screen, on the screen where it matters: a
// conversation whose only work is five reviews — one running, two passed,
// one cancelled by the reader, and the oldest asking for changes — on a
// coarse 951x669 screen with the dock at 2, then at 0.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-review-count.mjs
// T15_LANG=zh-Hans reads the same screens in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// The words the column and the entry are read by, and a review's name.
const words = lang === "zh-Hans"
  ? { reviews: "审查", attention: "需要注意", openReviews: "打开审查", needsLook: "1 个待查看", running: "1 个在进行",
      name: (round) => `PR #459 · 第 ${round} 轮` }
  : { reviews: "Reviews", attention: "Needs a look", openReviews: "Open Reviews", needsLook: "1 need a look", running: "1 running",
      name: (round) => `PR #459 · round ${round}` };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const review = (round, patch) => ({
  id: `rev-${round}`, taskId: "task-15", taskRef: "T-15", taskTitle: "Duo 与中屏工作台", linkId: "l",
  repository: "YuzukiS/Yuzuno", number: 459,
  url: "https://github.com/YuzukiS/Yuzuno/pull/459", round,
  status: "completed", phase: "completed", conclusion: "no_findings",
  requestedHarness: "claude", requestedModel: "claude-opus-5",
  actualHarness: "claude", actualModel: "claude-opus-5",
  baseSha: "b".repeat(40), headSha: "a".repeat(40), mergeBaseSha: "c".repeat(40),
  createdAt: ago(6_000_000 - round * 1_000_000), finishedAt: ago(5_000_000 - round * 1_000_000), error: null,
  requestedBy: { kind: "agent", id: "a", name: agent.name },
  findingsCount: 0, outdated: false, cursor: round, ...patch,
});
// Newest first, as Core pages them. The dock sorts what runs first, then
// the latest ended, so with its two it draws round 5 and round 4; the
// review that asked for changes is the oldest, last in that order.
const reviewPage = {
  reviews: [
    review(5, { status: "running", phase: "reviewing", conclusion: null, finishedAt: null, createdAt: ago(240_000) }),
    review(4, {}),
    review(3, { status: "cancelled", phase: "cancelled", conclusion: null }),
    review(2, {}),
    review(1, { conclusion: "changes_requested", findingsCount: 2 }),
  ],
  hasMore: false,
  nextBefore: null,
};
// What Work activity should hold whatever the dock draws: every review but
// the cancelled one; the one that asked for changes apart, under its own
// heading; the rest under Reviews.
const counted = { attention: [words.name(1)], reviews: [words.name(5), words.name(4), words.name(2)] };
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文内容".repeat(16) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();

/** One screen with the dock's reviews at `limit`: what the dock draws, what the head says, what its column lists. */
async function look(limit) {
  const errors = [];
  // Wide enough to keep the side-by-side layout, and worked by a finger:
  // the screen where the dock gives up its presses.
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ lang, limit }) => {
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 40); }
      addEventListener() {} close() {} };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden",
      dock: { jobs: 5, actions: 2, reviews: limit, subAgents: 5 } }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    // What a press asked to open: reviews open the Jobs panel on their own
    // tab through this event, so it says exactly which review, or which list.
    window.__opened = [];
    addEventListener("yuzuno:open-job", (event) => window.__opened.push(event.detail));
  }, { lang, limit });
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
    if (path === "/api/reviews") return route.fulfill({ json: reviewPage });
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
  await page.waitForTimeout(900);

  const seen = await page.evaluate(() => {
    const entry = document.querySelector(".work-activity-entry");
    const dock = document.querySelector(".work-dock");
    return {
      coarse: matchMedia("(hover: none) and (pointer: coarse)").matches,
      phone: !!document.querySelector(".app.phone"),
      dockRows: [...document.querySelectorAll(".work-dock .conversation-review")].map((el) =>
        (el.querySelector(".work-dock-label strong")?.textContent || "").trim()),
      dockMore: document.querySelectorAll(".work-dock .work-dock-more").length,
      dockShown: !!dock && getComputedStyle(dock).display !== "none",
      entryThere: !!entry,
      entrySays: entry ? (entry.textContent || "").replace(/\s+/g, " ").trim() : null,
      entryNeedsLook: entry ? entry.hasAttribute("data-needs-look") : null,
    };
  });
  let column = { there: false, groups: {} };
  if (seen.entryThere) {
    await page.locator(".work-activity-entry").click();
    await page.waitForTimeout(600);
    column = await page.evaluate(() => {
      const col = document.querySelector(".work-activity-column");
      if (!col) return { there: false, groups: {} };
      const groups = {};
      for (const section of col.querySelectorAll("section"))
        groups[section.getAttribute("aria-label")] = [...section.querySelectorAll(".work-activity-row")].map((b) => ({
          name: (b.querySelector(".work-activity-row-name")?.textContent || "").trim(),
          list: b.classList.contains("work-activity-row-list"),
          disabled: b.disabled,
        }));
      return { there: true, groups };
    });
  }
  return { page, context, errors, seen, column };
}
const named = (rows) => (rows || []).filter((r) => !r.list).map((r) => r.name);
const opened = (page) => page.evaluate(() => window.__opened.map((d) => ({ ...d })));

// --- the dock at 2: an older review is past what it draws ---
{
  const { page, context, errors, seen, column } = await look(2);
  console.log(`\n--- 951x669, a finger, the dock's reviews at 2 ---\n  ${JSON.stringify(seen)}\n  column: ${JSON.stringify(column)}`);
  check(seen.coarse && !seen.phone, `a touched screen that still keeps the side-by-side layout (coarse ${seen.coarse}, phone ${seen.phone})`);
  check(seen.dockRows.length === 2 && seen.dockRows[0] === words.name(5) && seen.dockRows[1] === words.name(4),
    `the dock still draws its two, the running one and the newest (${JSON.stringify(seen.dockRows)})`);
  check(seen.dockMore === 1, `with the rest behind its "+N more" (${seen.dockMore})`);
  check(seen.entryNeedsLook === true && !!seen.entrySays?.includes(words.needsLook),
    `the entry counts the review past the dock's two that asked for changes (${JSON.stringify(seen.entrySays)}, marked ${seen.entryNeedsLook})`);
  check(!!seen.entrySays?.includes(words.running), `and the one running (${JSON.stringify(seen.entrySays)})`);
  check(column.there, `the entry opens the column (${column.there})`);
  check(JSON.stringify(named(column.groups[words.attention])) === JSON.stringify(counted.attention),
    `which lists that review under ${words.attention} (${JSON.stringify(named(column.groups[words.attention]))})`);
  check(JSON.stringify(named(column.groups[words.reviews])) === JSON.stringify(counted.reviews),
    `and every other review under ${words.reviews}, not only the dock's two (${JSON.stringify(named(column.groups[words.reviews]))})`);
  const all = Object.values(column.groups).flatMap(named);
  check(!all.includes(words.name(3)), `the one the reader cancelled counted by nobody (${JSON.stringify(all)})`);
  // The review past the dock's two opens itself.
  if (column.there && named(column.groups[words.attention]).length) {
    await page.locator(".work-activity-column section .work-activity-row", { hasText: words.name(1) }).first().click();
    await page.waitForTimeout(500);
    const asked = await opened(page);
    console.log(`  pressed ${words.name(1)}: ${JSON.stringify(asked)}`);
    check(asked.length === 1 && asked[0].reviewId === "rev-1" && asked[0].source === "reviews",
      `and its row opens that review (${JSON.stringify(asked)})`);
  } else check(false, "and its row opens that review (no row to press)");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

// --- the dock at 0: none drawn, all still counted ---
{
  const { page, context, errors, seen, column } = await look(0);
  console.log(`\n--- 951x669, a finger, the dock's reviews at 0 ---\n  ${JSON.stringify(seen)}\n  column: ${JSON.stringify(column)}`);
  check(seen.dockRows.length === 0 && seen.dockMore === 0,
    `at 0 the dock draws no review (${seen.dockRows.length} drawn, ${seen.dockMore} more)`);
  check(!seen.dockShown, `and, with nothing else on it, no dock at all (${seen.dockShown})`);
  check(seen.entryThere, `but the entry is there for them (${seen.entryThere})`);
  check(seen.entryNeedsLook === true && !!seen.entrySays?.includes(words.needsLook) && !!seen.entrySays?.includes(words.running),
    `saying what it said with the dock at 2 (${JSON.stringify(seen.entrySays)}, marked ${seen.entryNeedsLook})`);
  check(JSON.stringify(named(column.groups[words.attention])) === JSON.stringify(counted.attention)
    && JSON.stringify(named(column.groups[words.reviews])) === JSON.stringify(counted.reviews),
    `and its column lists the same reviews (${JSON.stringify(Object.fromEntries(Object.entries(column.groups).map(([k, v]) => [k, named(v)])))})`);
  const list = (column.groups[words.reviews] || []).find((r) => r.list);
  check(!!list && list.name === words.openReviews && !list.disabled,
    `with the way into the whole list, "${words.openReviews}" (${JSON.stringify(list)})`);
  if (list) {
    await page.locator(".work-activity-column .work-activity-row-list", { hasText: words.openReviews }).click();
    await page.waitForTimeout(500);
    const asked = await opened(page);
    console.log(`  pressed ${words.openReviews}: ${JSON.stringify(asked)}`);
    check(asked.length === 1 && asked[0].involving === "a" && asked[0].source === "reviews" && !asked[0].reviewId,
      `which opens this Agent's reviews (${JSON.stringify(asked)})`);
  } else check(false, "which opens this Agent's reviews (nothing to press)");
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
