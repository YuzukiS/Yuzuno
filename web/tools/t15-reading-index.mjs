// The way into where the reader is (T-15). On a screen with a rail, the
// index takes the rail in place of the Agents and gives a way back; the Turn
// dock stays a scale on the conversation's edge. Choosing a Turn moves the
// conversation to it.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-reading-index.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

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
await page.addInitScript(() => {
  window.EventSource = class { close() {} };
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
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

const state = () => page.evaluate(() => {
  const el = (s) => document.querySelector(s);
  const shown = (n) => !!n && n.getBoundingClientRect().height > 0;
  const entry = el(".conversation-index-entry");
  const rows = [...document.querySelectorAll(".rail-turn-index-row")];
  const dock = el(".turn-dock");
  return {
    entry: shown(entry), entryHeight: entry ? Math.round(entry.getBoundingClientRect().height) : null,
    expanded: entry?.getAttribute("aria-expanded"),
    index: shown(el(".rail-turn-index")), agents: shown(el(".agent-list")),
    back: shown(el(".rail-turn-index-back")),
    rows: rows.length,
    smallest: rows.length ? Math.min(...rows.map((r) => Math.round(r.getBoundingClientRect().height))) : null,
    here: document.querySelectorAll(".rail-turn-index-row[data-here]").length,
    said: rows[0]?.querySelector(".rail-turn-index-said")?.textContent?.trim().slice(0, 28),
    dockThere: shown(dock),
    dockWidth: dock ? Math.round(dock.getBoundingClientRect().width) : null,
  };
});

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const shut = await state();
console.log("closed:", JSON.stringify(shut));
check(shut.entry, "the conversation offers a way into where the reader is");
check(shut.entryHeight >= 40, `a finger can reach it (${shut.entryHeight}px)`);
check(shut.agents && !shut.index, "the rail shows the Agents until it is asked");
console.log("geometry:", JSON.stringify(await page.evaluate(() => {
  const r = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.left), r: Math.round(b.right), y: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width) }; };
  const entry = document.querySelector(".conversation-index-entry");
  const box = entry?.getBoundingClientRect();
  const at = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
  return { heading: r(".conversation-heading"), title: r(".conversation-title"), actions: r(".conversation-actions"),
    entry: r(".conversation-index-entry"), work: r(".work-activity-entry"),
    hit: at ? `${at.tagName.toLowerCase()}.${(at.className||"").toString().split(" ")[0]}` : null };
})));

await page.locator(".conversation-index-entry").click();
await page.waitForTimeout(400);
const open = await state();
console.log("open:  ", JSON.stringify(open));
check(open.index && !open.agents, "the index takes the rail in place of the Agents");
check(open.back, "with a way back to them");
check(open.rows > 0, `every Turn is listed (${open.rows})`);
check(open.smallest >= 44, `each one is a finger's worth (${open.smallest}px)`);
check(open.here === 1, `exactly one row says where the reader is (${open.here})`);
check(!!open.said, `and each says what the Turn was about (${JSON.stringify(open.said)})`);
check(open.dockThere, "the Turn dock stays on the conversation's edge as its scale");
check(open.expanded === "true", "the entry says it is open");

// Choosing a Turn moves the conversation to it.
const before = await page.evaluate(() => document.querySelector(".conversation-scroll").scrollTop);
await page.locator(".rail-turn-index-row").nth(3).click();
await page.waitForTimeout(600);
const after = await page.evaluate(() => document.querySelector(".conversation-scroll").scrollTop);
check(after !== before, `choosing a Turn moves the conversation (${before} to ${after})`);

await page.locator(".rail-turn-index-back").click();
await page.waitForTimeout(400);
const backAgain = await state();
check(backAgain.agents && !backAgain.index, "going back returns the Agents");
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
