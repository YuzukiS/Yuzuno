// A PR review on a touched screen wider than a phone (T-15, #459 R5, P2).
//
// On such a screen this task turns the whole work dock's presses off
// (`.app:not(.phone) .work-dock { pointer-events: none }`, work-dock.css):
// its group boxes reached 2px into the "+" beside the input area and took
// presses meant for it, and the premise was that the conversation's head —
// the Work activity entry, and the column it opens — is the way in there.
//
// Reviews were left out of that premise. `workKinds` named jobs, runs,
// sub-agents and background tasks; `ConversationReviews` drew its group into
// the same dock without registering anything. So on a tablet or an unfolded
// foldable a review was drawn, took no press, was absent from the column,
// and a conversation whose only work was reviews had no entry to press at
// all. By touch it had been reachable before this task.
//
// So this reads the reach a finger has: a conversation whose only dock work
// is reviews, on a coarse non-phone screen. The entry is there and says the
// count; the column lists the reviews under their own heading; a row opens
// the review it names; and the dock itself still takes no press, which is
// the rule this is making good on rather than undoing.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-review-reach.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
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

// The words the column and the entry are read by.
const words = lang === "zh-Hans"
  ? { reviews: "审查", attention: "需要注意", title: "工作活动" }
  : { reviews: "Reviews", attention: "Needs a look", title: "Work activity" };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const review = (id, cursor, patch) => ({
  id, taskId: "task-15", taskRef: "T-15", taskTitle: "Duo 与中屏工作台", linkId: "l",
  repository: "YuzukiS/Yuzuno", number: 459,
  url: "https://github.com/YuzukiS/Yuzuno/pull/459", round: 1,
  status: "completed", phase: "completed", conclusion: "no_findings",
  requestedHarness: "claude", requestedModel: "claude-opus-5",
  actualHarness: "claude", actualModel: "claude-opus-5",
  baseSha: "b".repeat(40), headSha: "a".repeat(40), mergeBaseSha: "c".repeat(40),
  createdAt: ago(5_000_000), finishedAt: ago(4_400_000), error: null,
  requestedBy: { kind: "agent", id: "a", name: agent.name },
  findingsCount: 0, outdated: false, cursor, ...patch,
});
// Reviews and nothing else: no Jobs, no runs, no sub-agents. One still
// running, one that asked for changes — the one that needs a look.
const reviewPage = {
  reviews: [
    review("rev-3", 3, { round: 3, status: "running", phase: "reviewing", conclusion: null, finishedAt: null, createdAt: ago(240_000) }),
    review("rev-2", 2, { round: 2, conclusion: "changes_requested", findingsCount: 2, createdAt: ago(3_000_000), finishedAt: ago(2_500_000) }),
    review("rev-1", 1, {}),
  ],
  hasMore: false,
  nextBefore: null,
};
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
const errors = [];
// Wide enough to keep the side-by-side layout, and worked by a finger: the
// screen where the dock gives up its presses.
const context = await browser.newContext({
  viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript((lang) => {
  window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 40); }
    addEventListener() {} close() {} };
  addEventListener("DOMContentLoaded", () =>
    document.documentElement.style.setProperty("--safe-right", "84px"));
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
}, lang);
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
  const drawn = (el) => {
    if (!el) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const entry = document.querySelector(".work-activity-entry");
  const rows = [...document.querySelectorAll(".work-dock-item.conversation-review")];
  const press = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { w: Math.round(r.width), h: Math.round(r.height), own: !!at && (at === el || el.contains(at)) };
  };
  return {
    coarse: matchMedia("(hover: none) and (pointer: coarse)").matches,
    phone: !!document.querySelector(".app.phone"),
    // Reviews are on the dock, and the dock takes no press there: the rule
    // this fix works with rather than against.
    dockReviews: rows.length,
    dockTakesPress: rows.length ? press(rows[0]).own : null,
    dockEvents: (() => { const d = document.querySelector(".work-dock"); return d ? getComputedStyle(d).pointerEvents : null; })(),
    entryThere: !!entry,
    entryDrawn: drawn(entry),
    entrySays: entry ? (entry.textContent || "").replace(/\s+/g, " ").trim() : null,
    entryNeedsLook: entry ? entry.hasAttribute("data-needs-look") : null,
    entryTarget: press(entry),
  };
});
console.log(`\n--- 951x669, a finger, reviews and nothing else ---\n  ${JSON.stringify(seen)}`);
check(seen.coarse && !seen.phone, `a touched screen that still keeps the side-by-side layout (coarse ${seen.coarse}, phone ${seen.phone})`);
check(seen.dockReviews > 0, `the reviews are on the dock (${seen.dockReviews})`);
check(seen.dockEvents === "none" && seen.dockTakesPress === false,
  `and the dock takes no press there, as this task decided (${seen.dockEvents}, row press ${seen.dockTakesPress})`);
check(seen.entryThere && seen.entryDrawn,
  `so the head carries the way in: the Work activity entry is there (${seen.entryDrawn})`);
check(!!seen.entryTarget && Math.min(seen.entryTarget.w, seen.entryTarget.h) >= 40 && seen.entryTarget.own,
  `a finger's worth and it takes its own press (${seen.entryTarget ? `${seen.entryTarget.w}x${seen.entryTarget.h}, own ${seen.entryTarget.own}` : "missing"})`);
check(!!seen.entrySays && /[1-9]/.test(seen.entrySays), `and it says what is going on (${JSON.stringify(seen.entrySays)})`);
check(seen.entryNeedsLook === true,
  `and marks itself, the review that asked for changes being one to look at (${seen.entryNeedsLook})`);

// The column it opens lists them under their own heading, and a row opens
// the review it names.
if (seen.entryThere) {
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(600);
  const column = await page.evaluate((reviewsLabel) => {
    const col = document.querySelector(".work-activity-column");
    if (!col) return { there: false };
    const sections = [...col.querySelectorAll("section")].map((s) => ({
      label: s.getAttribute("aria-label"),
      rows: [...s.querySelectorAll(".work-activity-row")].map((b) => ({
        name: (b.querySelector(".work-activity-row-name")?.textContent || "").trim(),
        says: (b.querySelector(".work-activity-row-says")?.textContent || "").trim(),
        disabled: b.disabled,
      })),
    }));
    const group = sections.find((s) => s.label === reviewsLabel);
    return { there: true, sections: sections.map((s) => s.label), group,
      attention: sections.find((s) => s.rows.length && s.label !== reviewsLabel)?.rows ?? [] };
  }, words.reviews);
  console.log(`  column: ${JSON.stringify(column)}`);
  check(column.there, `pressing it opens the column (${column.there})`);
  check(!!column.group && column.group.rows.length > 0,
    `which lists the reviews under their own heading (${words.reviews}: ${column.group?.rows.length ?? 0})`);
  check(!!column.group && column.group.rows.every((r) => !r.disabled),
    `each one openable, not a dead row (${JSON.stringify(column.group?.rows.map((r) => r.disabled))})`);
  check(column.sections.includes(words.attention),
    `and the one that asked for changes is under ${words.attention} (${JSON.stringify(column.sections)})`);
  check(column.attention.some((r) => /459/.test(r.name)),
    `that group holding the review itself, named (${JSON.stringify(column.attention.map((r) => r.name))})`);

  // Pressing a review's row reaches that review.
  const row = page.locator(".work-activity-column section .work-activity-row").first();
  await row.click();
  await page.waitForTimeout(700);
  const opened = await page.evaluate(() => ({
    reviewPanel: !!document.querySelector(".reviews-panel, .review-detail, [class*='review']:not(.conversation-review)"),
    dialog: !!document.querySelector("[role='dialog'], .modal-overlay"),
  }));
  console.log(`  pressed a row: ${JSON.stringify(opened)}`);
  check(opened.reviewPanel || opened.dialog, `and a row opens what it names (${JSON.stringify(opened)})`);
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
