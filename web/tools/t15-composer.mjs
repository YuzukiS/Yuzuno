// The input area, and what T-15's layout must not break in it (T-15, V2).
//
// How far a draft grows is T-44's rule, not this task's: the editor stops at
// `min(12 * 1.75em + 21px, 40dvh)` and scrolls inside (pasted-text.css), and
// from three rows it offers to expand (composer-shape.ts EXPAND_FROM_ROWS).
// d6 asked for four rows; T-44 was approved later and it stands. What is
// checked here is that this task's layout leaves all of that working, and
// that the input area, the head and the rail keep out of each other.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-composer.mjs
// With an Agent at work, so Interrupt is there to press:
//   T15_WORKING=1 YUZUNO_UI_DIST=<isolated build> node tools/t15-composer.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

const VIEWS_UNUSED = process.env.T15_VIEWS
  ? process.env.T15_VIEWS.split(",").map((pair) => {
      const [width, height] = pair.split("x").map(Number);
      return { name: `${width}x${height}`, width, height };
    })
  : [
      { name: "folded-320", width: 320, height: 844 },
      { name: "short-594", width: 594, height: 500 },
      { name: "inner-669", width: 669, height: 844 },
      { name: "unfolded-951", width: 951, height: 844 },
    ];

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: process.env.T15_WORKING ? "working" : "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }, { ...agent, id: "c", name: "Dev Lead" }];

// Seven jobs so five show with a "+2 more", the tallest the group gets.
const resources = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (i, status) => ({
  id: `j${i}`, name: `web-check-${i} 跨设备布局量测`, status, reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/work", machine: { name: "owl-mac" },
  resources, reservation: resources, exclusive: false, createdAt: iso(-600_000),
  startedAt: iso(-500_000), finishedAt: status === "running" ? null : iso(-100_000 + i * 1000),
  reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running"), job(1, "running"), job(2, "succeeded"), job(3, "failed"),
  job(4, "succeeded"), job(5, "succeeded"), job(6, "cancelled")];

const run = (i, status, conclusion) => ({
  id: `c${i}`, name: `CI · web (${i})`, repository: "YuzukiS/yuzuno-public", runId: `${1000 + i}`,
  attempt: "1", headSha: "f8b8a0b47f9fd0ec72a1794d1777dcd62a0bc05e", status, rawStatus: status,
  conclusion, url: "https://example.invalid/", createdAt: iso(-400_000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000 + i * 1000), observedAt: iso(-5_000), cursor: i, runWatched: status === "running",
});
const ci = { runs: [run(0, "running", null), run(1, "completed", "success"), run(2, "completed", "failure")],
  subscriptions: [], hasMore: false, nextBefore: null };

const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：展开态阅读区还剩多少。` }] },
      { id: `sh${i}`, type: "commandExecution", command: "npm test", status: "completed", exitCode: 0 },
      { id: `r${i}`, type: "agentMessage", text: "这一段用来占据正文宽度，看看两侧的轴与索引各自吃掉多少空间。".repeat(3) },
      // The third kind of work the left dock lists, beside jobs and CI runs.
      ...(process.env.T15_SUBAGENTS && i >= 34
        ? [{ id: `sa${i}`, type: "claudeToolUse", name: "Task", status: i === 39 ? "inProgress" : "completed",
            subAgent: { taskId: `st${i}`, runId: `sr${i}`, type: "Explore",
              description: `中屏布局量测 ${i}`, prompt: "量测两侧轴占用" } }]
        : []),
    ],
  })),
};

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const browser = await launchBrowser();
const errors = [];

const view = { name: "mid", width: 951, height: 669 };
const context = await browser.newContext({ viewport: { width: view.width, height: view.height },
  hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript((lang) => {
  window.EventSource = class { close() {} };
  if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
}, process.env.T15_LANG || "en");
let opened = null;
await page.exposeFunction("__jobsOpened", (detail) => { opened = detail; });
await page.addInitScript(() => {
  window.addEventListener("yuzuno:open-job", (e) => window.__jobsOpened(JSON.stringify(e.detail)));
});
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
  if (path === "/api/workspace")
    return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
  if (/^\/api\/agents\/[abc]$/.test(path)) return route.fulfill({ json: detail });
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
page.on("pageerror", (error) => errors.push(error.message));
await page.goto("https://t15.test/");
await page.locator(".app").waitFor({ timeout: 10_000 });
await page.waitForTimeout(900);

const W = Number(process.env.T15_W || 951);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const editor = page.locator(".composer .cm-content").first();
const shape = () => page.evaluate(() => {
  const el = (s) => document.querySelector(s);
  const r = (s) => { const n = el(s); return n ? n.getBoundingClientRect() : null; };
  const scroller = el(".composer .cm-scroller");
  const cap = scroller ? parseFloat(getComputedStyle(scroller).maxHeight) : null;
  const over = (a, b) => !!(a && b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const area = r(".composer-area"), head = r(".conversation-header"), rail = r(".rail"), pill = r(".jump-latest");
  return {
    area: area ? Math.round(area.height) : null, areaTop: area ? Math.round(area.top) : null,
    scroller: scroller ? Math.round(scroller.getBoundingClientRect().height) : null,
    cap: cap ? Math.round(cap) : null,
    scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : false,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    // The real control, not anything that happens to carry aria-expanded:
    // the head's name button has one too (App.tsx composer-expand).
    expand: !!el(".composer .composer-expand"),
    expandState: el(".composer")?.getAttribute("data-expand") ?? null,
    overlapHead: over(area, head), overlapRail: over(area, rail),
    pillRidesEdge: !!(pill && area && pill.bottom >= area.top - 1 && pill.top <= area.top + area.height),
    reading: Math.round((r(".conversation-scroll")?.height) || 0),
  };
});
const typeLines = async (n) => {
  await page.evaluate(() => { const el = document.querySelector(".composer .cm-content"); el.textContent = ""; });
  await editor.click();
  await editor.type(Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n"), { delay: 1 });
  await page.waitForTimeout(350);
};

await typeLines(1);
const one = await shape();
await typeLines(3);
const three = await shape();
await typeLines(40);
const many = await shape();
console.log(JSON.stringify({ W, one, three, many }, null, 1));

// T-44's cap, read from the rule rather than from a number measured once.
check(many.cap !== null, `the editor has T-44's cap (max-height ${many.cap}px)`);
check(many.scroller <= many.cap + 1, `it stops there rather than growing (${many.scroller} <= ${many.cap})`);
check(many.scrolls, "and scrolls inside once the draft is longer");
await page.evaluate(() => { document.querySelector(".composer .cm-scroller").scrollTop = 0; });
await page.waitForTimeout(200);
check((await shape()).scrollTop === 0, "the first line can be reached again");
// Offered from the third row (EXPAND_FROM_ROWS), not before.
check(!one.expand && three.expand,
  `expanding is offered from the third row, not the first (1 row: ${one.expandState}, 3 rows: ${three.expandState})`);
// This task's own business: the areas keep out of each other.
check(!many.overlapHead, "the input area never reaches the conversation's head");
check(!many.overlapRail, "nor the rail");
check(many.reading > 0, `the conversation keeps reading height when the draft is capped (${many.reading}px)`);
console.log(`note: with the draft capped, the conversation has ${many.reading}px of reading height at ${W}x669.`);

// Interrupt is pressable while working, by hit test rather than by sight.
await page.evaluate(() => { const el = document.querySelector(".composer .cm-content"); el.textContent = ""; });
await page.waitForTimeout(200);
// Interrupt only stands while an Agent is working, so it is checked in the
// working pass (T15_WORKING=1); the draft measurements above need an idle one.
const interrupt = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".composer button, .composer-area button")]
    .find((b) => /interrupt|中断/i.test(b.textContent || b.getAttribute("aria-label") || ""));
  if (!el) return { there: false };
  const r = el.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { there: true, pressable: at === el || el.contains(at), size: `${Math.round(r.width)}x${Math.round(r.height)}` };
});
console.log("interrupt:", JSON.stringify(interrupt));
if (process.env.T15_WORKING) {
  check(interrupt.there, "Interrupt stands while the Agent is working");
  check(interrupt.pressable, `and the press lands on it, not on something over it (${interrupt.size})`);
} else {
  console.log("note: Interrupt is not checked here; this pass needs an idle Agent for the draft. Run with T15_WORKING=1.");
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
