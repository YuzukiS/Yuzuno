// Work that Work activity does not count is still reachable by touch (T-15,
// #459 R8, P3).
//
// Some of what the dock draws is left out of the count on purpose (deviation
// row 14): a Job the reader cancelled, a CI run that was skipped, a review
// the reader cancelled. Nothing about them needs a look, and counting them
// held them against the conversation for good.
//
// But on a touched screen wider than a phone the dock takes no press at all
// (`.app:not(.phone) .work-dock { pointer-events: none }`), and the head's
// entry and its column are the way in. A kind registered only what it
// counted, and an empty registration removed the kind altogether — its "Open
// …" row with it. So a conversation whose only work was of that sort had it
// drawn on the dock, untouchable, with no entry to press: before this task
// those dock items took a finger.
//
// So this reads three such conversations at 951x669 with a coarse pointer:
// only a cancelled Job, only a skipped CI run, only a cancelled review. Each
// is drawn on the dock, which still takes no press; the entry is there and
// counts nothing; its column offers the kind's list, and only that; and
// pressing it opens that list.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-uncounted-reach.mjs
// T15_LANG=zh-Hans reads the same screens in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is the
// one way these checks can come back green without having run.
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

const words = lang === "zh-Hans"
  ? { quiet: "没有在进行的工作", attention: "需要注意", job: "Jobs", run: "CI", review: "审查", open: (what) => `打开${what}` }
  : { quiet: "nothing running", attention: "Needs a look", job: "Jobs", run: "CI", review: "Reviews", open: (what) => `Open ${what}` };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const resources = { cpuMillis: 2000, memoryMiB: 2048 };
const cancelledJob = {
  id: "j1", name: "web-check 跨设备布局量测", status: "cancelled", reason: "Cancelled by the user", agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/work", machine: { name: "owl-mac" },
  resources, reservation: resources, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: iso(-100_000), reserved: false, cursor: 1, requestId: "r1",
};
const skippedRun = {
  id: "c1", name: "Docs (local links)", repository: "YuzukiS/Yuzuno", runId: "1001",
  attempt: "1", headSha: "f8b8a0b47f9fd0ec72a1794d1777dcd62a0bc05e", status: "skipped", rawStatus: "completed",
  conclusion: "skipped", url: "https://example.invalid/", createdAt: iso(-400_000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000), observedAt: iso(-5_000), cursor: 1, runWatched: false,
};
const cancelledReview = {
  id: "rev-1", taskId: "task-15", taskRef: "T-15", taskTitle: "Duo 与中屏工作台", linkId: "l",
  repository: "YuzukiS/Yuzuno", number: 459, url: "https://github.com/YuzukiS/Yuzuno/pull/459", round: 1,
  status: "cancelled", phase: "cancelled", conclusion: null,
  requestedHarness: "claude", requestedModel: "claude-opus-5", actualHarness: "claude", actualModel: "claude-opus-5",
  baseSha: "b".repeat(40), headSha: "a".repeat(40), mergeBaseSha: "c".repeat(40),
  createdAt: iso(-5_000_000), finishedAt: iso(-4_400_000), error: null,
  requestedBy: { kind: "agent", id: "a", name: agent.name }, findingsCount: 0, outdated: false, cursor: 1,
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

async function look({ name, jobs = noJobs, ci = noCiRuns, reviews = noReviews, kind, opens }) {
  const errors = [];
  // Wide enough to keep the side-by-side layout, and worked by a finger.
  const context = await browser.newContext({
    viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 40); }
      addEventListener() {} close() {} };
    addEventListener("DOMContentLoaded", () =>
      document.documentElement.style.setProperty("--safe-right", "84px"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    window.__opened = [];
    addEventListener("yuzuno:open-job", (event) => window.__opened.push(event.detail));
  }, lang);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: jobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: ci });
    if (path === "/api/reviews") return route.fulfill({ json: reviews });
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
    const item = document.querySelector(".work-dock .work-dock-item");
    const press = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!at && (at === el || el.contains(at));
    };
    return {
      coarse: matchMedia("(hover: none) and (pointer: coarse)").matches,
      phone: !!document.querySelector(".app.phone"),
      drawn: document.querySelectorAll(".work-dock .work-dock-item").length,
      dockEvents: dock ? getComputedStyle(dock).pointerEvents : null,
      itemTakesPress: press(item),
      entryThere: !!entry && entry.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
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
        }));
      return { there: true, groups };
    });
  }
  console.log(`\n--- 951x669, a finger, ${name} ---\n  ${JSON.stringify(seen)}\n  column: ${JSON.stringify(column)}`);
  check(seen.coarse && !seen.phone, `${name}: a touched screen that keeps the side-by-side layout (coarse ${seen.coarse}, phone ${seen.phone})`);
  check(seen.drawn > 0, `${name}: it is drawn on the dock (${seen.drawn})`);
  check(seen.dockEvents === "none" && seen.itemTakesPress === false,
    `${name}: and the dock takes no press there, as this task decided (${seen.dockEvents}, item press ${seen.itemTakesPress})`);
  check(seen.entryThere, `${name}: so the head's entry is there for it (${seen.entryThere})`);
  check(seen.entryNeedsLook === false && !!seen.entrySays?.includes(words.quiet),
    `${name}: counting nothing — it needs no look (${JSON.stringify(seen.entrySays)}, marked ${seen.entryNeedsLook})`);
  const group = column.groups[words[kind]];
  check(column.there && !!group && group.length === 1 && group[0].list && group[0].name === words.open(words[kind]),
    `${name}: its column offers the way into its list, "${words.open(words[kind])}", and only that (${JSON.stringify(column.groups)})`);
  check(!column.groups[words.attention], `${name}: with nothing under ${words.attention} (${JSON.stringify(Object.keys(column.groups))})`);
  if (group?.length) {
    await page.locator(".work-activity-column .work-activity-row-list").first().click();
    await page.waitForTimeout(500);
    const asked = await page.evaluate(() => window.__opened.map((d) => ({ ...d })));
    console.log(`  pressed it: ${JSON.stringify(asked)}`);
    check(asked.length === 1 && Object.entries(opens).every(([k, v]) => asked[0][k] === v),
      `${name}: which opens that list (${JSON.stringify(asked)})`);
  } else check(false, `${name}: which opens that list (nothing to press)`);
  check(errors.length === 0, `${name}: no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

await look({ name: "only a cancelled Job", kind: "job", jobs: { ...noJobs, jobs: [cancelledJob] }, opens: { agentId: "a" } });
await look({ name: "only a skipped CI run", kind: "run", ci: { ...noCiRuns, runs: [skippedRun] }, opens: { agentId: "a", source: "github_actions" } });
await look({ name: "only a cancelled review", kind: "review", reviews: { ...noReviews, reviews: [cancelledReview] }, opens: { involving: "a", source: "reviews" } });

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
