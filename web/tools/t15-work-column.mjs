// The entry counts what the column shows, and the column opens what the
// entry counted (T-15, V9). Jobs, CI runs and sub-agents are three kinds in
// one count, so the view it opens has to be able to show all three: the
// Jobs dialog shows only its own source, which is what this replaces.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-work-column.mjs
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

const seen = await page.evaluate(() => {
  const entry = document.querySelector(".work-activity-entry");
  return { counts: entry?.querySelector(".work-activity-counts")?.textContent?.trim() ?? null };
});
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
check(!!seen.counts, `the entry says what there is (${seen.counts})`);

await page.locator(".work-activity-entry").click();
await page.waitForTimeout(400);
const column = await page.evaluate(() => {
  const root = document.querySelector(".work-activity-column");
  if (!root) return { shown: false };
  const groups = [...root.querySelectorAll("section")].map((s) => ({
    label: s.querySelector("h3")?.textContent?.trim(),
    attention: s.querySelector("h3")?.hasAttribute("data-attention") ?? false,
    rows: [...s.querySelectorAll(".work-activity-row")].map((r) => ({
      name: r.querySelector(".work-activity-row-name")?.textContent?.trim(),
      says: r.querySelector(".work-activity-row-says")?.textContent?.trim(),
      state: r.getAttribute("data-state"),
      height: Math.round(r.getBoundingClientRect().height),
      openable: !r.disabled,
    })),
  }));
  return { shown: true, title: root.querySelector(".work-activity-column-title")?.textContent?.trim(),
    back: !!root.querySelector(".work-activity-column-back"),
    agents: !!document.querySelector(".agent-list"), groups,
    total: groups.reduce((n, g) => n + g.rows.length, 0) };
});
console.log(JSON.stringify(column, null, 1));

check(column.shown && !column.agents, "it takes the rail in place of the Agents");
check(/Work activity|工作活动/.test(column.title || ""), `headed with what it is (${column.title})`);
check(column.back, "with a way back to the Agents");
check(column.groups[0]?.attention === true, `what needs a look comes first (${column.groups[0]?.label})`);
// The three kinds are all here, which the Jobs dialog alone could not do.
const labels = column.groups.map((g) => g.label).join(" ");
check(/Jobs/.test(labels) && /CI/.test(labels) && /Sub-agents|子 Agent/.test(labels),
  `Jobs, CI and sub-agents are all in it (${labels})`);
// Every count on the entry is an item that can be opened here.
const exceptions = column.groups.filter((g) => g.attention).reduce((n, g) => n + g.rows.length, 0);
const said = Number((seen.counts.match(/(\d+)/) || [])[1]);
check(exceptions === said, `the entry's "needs a look" count is what the column lists (${said} vs ${exceptions})`);
check(column.groups.every((g) => g.rows.every((r) => r.openable)),
  "every item opens the detail it already has");
check(column.groups.every((g) => g.rows.every((r) => r.height >= 44)),
  `each row is a finger's worth (${Math.min(...column.groups.flatMap((g) => g.rows.map((r) => r.height)))}px)`);

await page.locator(".work-activity-column-back").click();
await page.waitForTimeout(300);
check(await page.evaluate(() => !!document.querySelector(".agent-list") && !document.querySelector(".work-activity-column")),
  "going back returns the Agents");
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
