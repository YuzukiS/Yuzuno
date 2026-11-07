// The work activity entry on a narrow screen (T-15, Dev 7's final d6 check,
// change 1).
//
// On the phone layout the entry called `openJobs`, which opens the Jobs
// dialog at one source — its Local tab — so the failed CI run and the failed
// sub-agent the entry had just counted were nowhere to be seen. d6 D asks for
// a drawer with the same content. The entry now opens the phone's own work
// drawer, which carries all three kinds, the way the reading index entry
// opens the turns drawer.
//
// Opening the conversation first is the part Dev 7's own check could not do:
// the phone layout starts on the Agent list, which covers the conversation,
// so the Agent row is pressed before anything else here.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-phone-work.mjs
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
// One of each kind, and one of each failed: the counted three.
const jobs = [
  { id: "j1", name: "web-check-1 跨设备布局量测", status: "failed", reason: null, agentId: "a",
    agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
    resources: res, reservation: res, exclusive: false, createdAt: iso(-600_000),
    startedAt: iso(-500_000), finishedAt: iso(-100_000), reserved: false, cursor: 1, requestId: "r1" },
  { id: "j2", name: "web-check-2 跨设备布局量测", status: "running", reason: null, agentId: "a",
    agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
    resources: res, reservation: res, exclusive: false, createdAt: iso(-300_000),
    startedAt: iso(-200_000), finishedAt: null, reserved: false, cursor: 2, requestId: "r2" },
];
const ci = { runs: [
  { id: "c1", name: "CI · web", repository: "YuzukiS/yuzuno-public", runId: "1001", attempt: "1",
    headSha: "f8b8a0b47f9fd0ec72a1794d1777dcd62a0bc05e", status: "completed", rawStatus: "completed",
    conclusion: "failure", url: "https://example.invalid/", createdAt: iso(-400_000),
    startedAt: iso(-390_000), updatedAt: iso(-10_000), observedAt: iso(-5_000), cursor: 1, runWatched: false },
], subscriptions: [], hasMore: false, nextBefore: null };
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 800 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：问题` }] },
      { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回答。`.repeat(6) },
      ...(i === 7
        ? [{ id: "sa", type: "claudeToolUse", name: "Task", status: "failed",
            subAgent: { taskId: "st", runId: "sr", type: "Explore",
              description: "子 Agent 的中屏量测", prompt: "量测" } }]
        : []),
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

for (const width of [480, 382]) {
  const context = await browser.newContext({
    viewport: { width, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, process.env.T15_LANG || "en");
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
  page.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);

  console.log(`\n--- ${width}x844, phone layout ---`);
  // The list covers the conversation here; press the Agent to open it.
  check(await page.evaluate(() => !!document.querySelector(".app.phone")), `the phone layout applies (${width})`);
  await page.locator(".agent-select").first().click();
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    list: !!document.querySelector(".app.phone-list"),
    head: !!document.querySelector(".conversation-header"),
    entry: (() => {
      const el = document.querySelector(".work-activity-entry");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
        counts: (el.querySelector(".work-activity-counts")?.textContent || "").trim() };
    })(),
  }));
  console.log(`  conversation open: list=${opened.list} head=${opened.head}  entry ${JSON.stringify(opened.entry)}`);
  check(!opened.list && opened.head, "pressing the Agent opens the conversation over the list");
  check(!!opened.entry && opened.entry.w > 0, `the work activity entry is there to press (${opened.entry?.w}x${opened.entry?.h})`);

  // Press it: the drawer, not the Jobs dialog at one source.
  await page.locator(".work-activity-entry").click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const dock = document.querySelector(".work-dock");
    const items = [...document.querySelectorAll(".work-dock-item")].map((el) => ({
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 44),
      state: [...el.classList].find((c) => c.startsWith("state-")) || "",
      w: Math.round(el.getBoundingClientRect().width),
    }));
    const headings = [...document.querySelectorAll(".work-dock-heading")]
      .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40));
    return {
      drawer: document.querySelector(".conversation-body")?.getAttribute("data-phone-dock") || null,
      dockWidth: dock ? Math.round(dock.getBoundingClientRect().width) : 0,
      // The Jobs dialog is what this used to open instead.
      jobsDialog: !!document.querySelector('[role="dialog"] .jobs-panel, .jobs-panel'),
      items, headings,
    };
  });
  console.log(`  drawer=${after.drawer} dock ${after.dockWidth}px  jobs dialog=${after.jobsDialog}`);
  console.log(`  groups: ${after.headings.join(" | ")}`);
  for (const i of after.items) console.log(`    ${i.state.padEnd(18)} ${i.w}px  ${i.label}`);

  check(after.drawer === "work", `the entry opens the work drawer (data-phone-dock=${after.drawer})`);
  check(!after.jobsDialog, "and not the Jobs dialog, which shows one source at a time");
  check(after.dockWidth > 0, `the drawer is drawn (${after.dockWidth}px)`);
  // All three kinds, and the counted failures among them.
  check(after.headings.length >= 3, `all three kinds have a group (${after.headings.length}: ${after.headings.join(", ")})`);
  const failedOnes = after.items.filter((i) => /state-(failed|cancelled)/.test(i.state));
  check(failedOnes.length >= 1, `the failed Job is in it (${failedOnes.map((i) => i.label).join("; ") || "none"})`);
  const ciItem = after.items.find((i) => /CI|web \(|Actions/i.test(i.label));
  check(!!ciItem, `the failed CI run is in it (${ciItem?.label || "absent"})`);
  const subItem = after.items.find((i) => /子 Agent|Explore|sub/i.test(i.label));
  check(!!subItem, `the failed sub-agent is in it (${subItem?.label || "absent"})`);
  // Each one can be pressed where it is.
  check(after.items.every((i) => i.w > 0), `every item in the drawer is drawn (${after.items.length})`);
  // The count the entry showed is the attention the drawer holds.
  check(/\d/.test(opened.entry?.counts || ""), `the entry counted something to go and see ("${opened.entry?.counts}")`);

  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
