// Does the left dock reach the composer (T-15, item 2)? The first harness
// left both docks empty, so it could not answer: jobs come from /api/jobs and
// CI from /api/ci (not /api/ci/runs). Here both are full to the limits
// Appearance allows by default (jobs 5, actions 2), which is the tallest the
// dock gets, and the measurement is geometry only.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-docks.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

const VIEWS = process.env.T15_VIEWS
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

for (const view of VIEWS) {
  // T15_POINTER=fine asks for a mouse instead: hover:hover and pointer:fine,
  // which is what a wide window with a trackpad reports.
  const coarse = (process.env.T15_POINTER || "coarse") !== "fine";
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height }, hasTouch: coarse, isMobile: coarse, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((right) => {
    window.EventSource = class { close() {} };
    // What a side system control area gives the page, without a device.
    if (right)
      addEventListener("DOMContentLoaded", () =>
        document.documentElement.style.setProperty("--safe-right", `${right}px`));
    // Set once, so a reload for another theme keeps what the run chose.
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, Number(process.env.T15_INSET_RIGHT || 0));
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
  page.on("pageerror", (error) => errors.push(`${view.name}: ${error.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  const out = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
        bottom: Math.round(r.bottom), empty: el.children.length === 0 };
    };
    const work = box(".work-dock"), turn = box(".turn-dock"), app = box(".app"), main = box(".main-panel");
    const composer = box(".composer") || box("form.composer") || box(".conversation-composer");
    const inner = box(".conversation-inner"), body = box(".conversation-body");
    const style = inner && getComputedStyle(document.querySelector(".conversation-inner"));
    const gap = (dock) => (dock && composer ? composer.top - dock.bottom : null);
    return { work, turn, composer, body, inner, app, main,
      gutter: style?.getPropertyValue("--gutter").trim(), column: style?.getPropertyValue("--column").trim(),
      workGap: gap(work), turnGap: gap(turn),
      nodes: [...document.querySelectorAll(".work-dock-item, .work-dock-heading, .work-dock-more")]
        .map((el) => { const r = el.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })
        .filter((n) => n > 0),
      pointer: { coarse: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches },
      // Each Turn row as drawn, and whether anything above it cuts the row
      // short: a 44px row that its container clips is not a 44px target.
      rows: [...document.querySelectorAll(".turn-dock-stop")].map((el) => {
        const r = el.getBoundingClientRect();
        const row = el.parentElement;
        const rowRect = row?.getBoundingClientRect();
        let clip = null;
        for (let p = row; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflow;
          if (o !== "visible") {
            const pr = p.getBoundingClientRect();
            const cut = Math.max(0, pr.top - r.top) + Math.max(0, r.bottom - pr.bottom);
            if (cut > 0) clip = { by: p.className?.toString?.().slice(0, 24), cut: Math.round(cut) };
            break;
          }
        }
        return { kind: el.querySelector(".turn-dock-chip") ? "number" : "bar",
          h: Math.round(r.height), rowH: Math.round(rowRect?.height || 0), clip };
      }),
      // Every clickable thing smaller than 44px in its short side, named.
      small: [...document.querySelectorAll("button, a[href], [role=button], input, select, summary")]
        .map((el) => { const r = el.getBoundingClientRect();
          return { cls: el.className?.toString?.().slice(0, 34) || el.tagName,
            w: Math.round(r.width), h: Math.round(r.height), min: Math.round(Math.min(r.width, r.height)) }; })
        .filter((e) => e.min > 0 && e.min < 44)
        .sort((a, b) => a.min - b.min).slice(0, 8),
    };
  });
  const w = out.work, t = out.turn, c = out.composer;
  console.log(`\n--- ${view.name} (${view.width}x${view.height}) ---`);
  console.log(`  work-dock ${w ? `${w.w}x${w.h} top ${w.top} bottom ${w.bottom} empty=${w.empty}` : "absent"}`);
  console.log(`  turn-dock ${t ? `${t.w}x${t.h} top ${t.top} bottom ${t.bottom}` : "absent"}`);
  console.log(`  composer  ${c ? `top ${c.top} h ${c.h}` : "absent"}`);
  console.log(`  gap work→composer ${out.workGap}   turn→composer ${out.turnGap}`);
  console.log(`  app ${out.app?.w}  main-panel ${out.main?.w}`);
  console.log(`  body ${out.body?.w} → reading ${out.inner?.w}  (spend ${out.body && out.inner ? out.body.w - out.inner.w : "?"})`);
  console.log(`  --gutter '${out.gutter}'  --column '${out.column}'`);
  console.log(`  smallest dock node ${out.nodes.length ? Math.min(...out.nodes) : "n/a"}px  (${out.nodes.length} nodes)`);
  {
    const n = out.rows.filter((r) => r.kind === "number"), b = out.rows.filter((r) => r.kind === "bar");
    const hs = (a) => [...new Set(a.map((r) => r.h))].join("/") || "-";
    const clipped = out.rows.filter((r) => r.clip);
    console.log(`  pointer coarse=${out.pointer.coarse} hover=${out.pointer.hover}`);
    console.log(`  rows: ${n.length} number @${hs(n)}px, ${b.length} bar @${hs(b)}px; clipped ${clipped.length}${clipped.length ? ` (${clipped[0].clip.by} cuts ${clipped[0].clip.cut}px)` : ""}`);
  }
  console.log(`  under 44px: ${out.small.map((e) => `${e.cls} ${e.w}x${e.h}`).join(" | ") || "none"}`);
  if (process.env.T15_SHOT) {
    const dir = resolve(process.env.T15_SHOT);
    await mkdir(dir, { recursive: true });
    for (const theme of ["light", "dark"]) {
      // Appearance is read once at start-up, so the theme needs a reload.
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate((t) => {
        localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: t, fontSize: 16, palette: "garden" }));
      }, theme);
      await page.reload();
      await page.locator(".app").waitFor({ timeout: 10_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(dir, `${view.name}-${theme}.png`) });
    }
  }
  await context.close();
}
await browser.close();
console.log(`\npage errors: ${errors.length}${errors.length ? `\n  ${errors.join("\n  ")}` : ""}`);
