// The one entry for everything the conversation has running (T-15, V1).
// Jobs, CI runs and sub-agents each hand their work to the dock, and the
// entry beside the conversation's name says it once: what needs a look
// first, then what is going on, never a total across the three.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-work-entry.mjs
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
  id: "a", name: "Dev 8 · Mac / iOS", status: "working", harness: "claude", cwd: "/Users/yuzuki/work",
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
      // The third kind of work, beside jobs and CI runs. This one is asserted
      // below — a count of what is running, and a group of its own — so it is
      // always in the fixture: behind a variable, running this check the way
      // its own usage line says would have failed on a missing sub-agent
      // rather than on anything the product did.
      ...(i >= 34
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

const read = () => page.evaluate(() => {
  const el = document.querySelector(".work-activity-entry");
  if (!el) return { shown: false };
  const r = el.getBoundingClientRect();
  return { shown: r.width > 0 && r.height > 0, text: el.textContent?.trim(),
    label: el.getAttribute("aria-label"), needsLook: el.hasAttribute("data-needs-look"),
    height: Math.round(r.height), width: Math.round(r.width), inHead: !!el.closest(".conversation-heading"),
    // What a screen reader says and voice control listens for, computed from
    // what is inside rather than declared twice (T-15, Dev 7).
    name: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
    counts: el.querySelector(".work-activity-counts")?.textContent?.trim() ?? "",
    category: el.querySelector(".sr-only")?.textContent?.trim() ?? "" };
});

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const seen = await read();
console.log(JSON.stringify(seen, null, 1));

// The fixture: 7 jobs (2 running, 1 failed, 1 cancelled, 3 succeeded) and
// 3 CI runs (1 running, 1 success, 1 failure), each run a workflow of its own.
//
// Two need a look, not three: the Job the user cancelled is not a problem to
// go and see, so Work activity does not count it (#459 round 1, P2c;
// deviation row 14). The failed Job and the failed run are the two.
// t15-counting.mjs holds that rule on its own fixtures.
check(seen.shown, "the conversation says what it has running");
check(seen.inHead, "beside its name, where there is room to read it");
// By the numbers, not by English words: the same entry is read in Chinese.
check(/\b2\b/.test(seen.counts), `what needs a look is counted, the user's own cancel aside (${seen.counts})`);
check(seen.needsLook, "and the entry says so to the eye as well");
check(/\b4\b/.test(seen.counts), `and what is still going (${seen.counts})`);
// Never one number across the three kinds.
check(!/\b\d+ (succeeded|done|passed)\b/.test(seen.text || ""),
  "nothing claims a total of successes across the kinds");
check(seen.height >= 40, `a finger can reach it (${seen.height}px)`);

// V9: where there is a rail, pressing opens this Agent's work in it rather
// than the Jobs dialog, which could only ever show one of the three kinds
// the entry counts (t15-work-column.mjs). A phone still opens the dialog.
await page.locator(".work-activity-entry").click();
await page.waitForTimeout(400);
const column = await page.evaluate(() => !!document.querySelector(".work-activity-column"));
check(column, `pressing it opens this Agent's work in the rail (${column ? "shown" : "nothing"})`);
// The name must carry the words that are on the screen: a label of its own
// would hide the counts from a screen reader and from voice control, which
// listens for what a reader can see.
check(!seen.label, "no aria-label stands in front of what the button says");
check(seen.name.startsWith(seen.category.replace(/:$/, "")),
  `the name opens with what it is (${JSON.stringify(seen.name)})`);
check(seen.counts.length > 0 && seen.name.includes(seen.counts),
  `and carries the counts a reader can see (${JSON.stringify(seen.counts)})`);
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
