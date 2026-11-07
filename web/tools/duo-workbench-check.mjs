// What the workbench actually spends its space on (T-15), measured in a real
// browser at the widths a folding phone and a split window give it. It reads
// geometry only: no design is applied here, and nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> node tools/duo-workbench-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/t15-duo-workbench");
await mkdir(output, { recursive: true });
const report = { task: "T-15", at: new Date().toISOString(), views: [], errors: [] };

// A folding phone's widths, a short touch window, and the sizes a split
// window lands on. Height 844 unless the case is the short one.
const VIEWS = [
  { name: "folded-320", width: 320, height: 844, touch: true },
  { name: "outer-382", width: 382, height: 844, touch: true },
  { name: "split-385", width: 385, height: 844, touch: true },
  { name: "short-594", width: 594, height: 500, touch: true },
  { name: "inner-669", width: 669, height: 844, touch: true },
  { name: "unfolded-951", width: 951, height: 844, touch: true },
];
// The system control area of a folded phone's outer screen reaches the page
// as a side inset. The app reads --safe-* rather than env() directly, so the
// case is reproducible here.
const INSETS = [
  { name: "no-inset", left: 0, right: 0 },
  { name: "right-inset", left: 0, right: 62 },
];

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work", model: "claude-opus-5",
  color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 9, reviewedSeq: 9,
  connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent,
  { ...agent, id: "b", name: "Dev 3 · public", status: "working" },
  { ...agent, id: "c", name: "Dev Lead", status: "waiting" }];
const text = (id, body) => ({ id, type: "userMessage", content: [{ type: "text", text: body }] });
const reply = (id, body) => ({ id, type: "agentMessage", text: body });
const turns = Array.from({ length: 8 }, (_, i) => ({
  id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 600 + i * 60,
  items: [
    text(`u${i}`, `第 ${i + 1} 轮：请看看展开态下阅读区还剩多少。`),
    { id: `sh${i}`, type: "commandExecution", command: "npm test", status: "completed", exitCode: 0 },
    reply(`r${i}`, `这一段用来占据正文宽度，看看两侧的轴与索引各自吃掉多少空间。` .repeat(3)),
  ],
}));
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const browser = await launchBrowser();

async function open({ width, height, touch }, inset) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([left, right]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    addEventListener("DOMContentLoaded", () => {
      // What a side system area gives the page, without a device.
      document.documentElement.style.setProperty("--safe-left", `${left}px`);
      document.documentElement.style.setProperty("--safe-right", `${right}px`);
    });
  }, [inset.left, inset.right]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/[abc]$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: noJobs });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    // The conversation asks for /api/ci, not /api/ci/runs (CiJobs.tsx): a
    // route that never matches leaves the left dock empty whatever it serves.
    if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page };
}

/** Geometry only: what each part of the workbench takes, and what overlaps. */
const measure = (page) =>
  page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shown: r.width > 0 && r.height > 0 };
    };
    const all = (selector) => [...document.querySelectorAll(selector)].map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim().slice(0, 40),
        shown: r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" };
    });
    const app = document.querySelector(".app");
    const appStyle = app && getComputedStyle(app);
    const overlap = (a, b) => (!a || !b ? null : Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)));
    const inner = box(".conversation-inner");
    const body = box(".conversation-body");
    const composer = box(".composer-area");
    const workDock = box(".work-dock");
    const turnDock = box(".turn-dock");
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      app: app ? { clientW: app.clientWidth, padLeft: appStyle.paddingLeft, padRight: appStyle.paddingRight,
        columns: appStyle.gridTemplateColumns } : null,
      rail: box(".app > .rail"),
      toolbars: { toolbar: box(".toolbar"), conversationHeader: box(".conversation-header"), statusbar: box(".status-bar") },
      body, inner, composer, workDock, turnDock,
      // Claim 1: does a dock reach into the composer?
      dockIntoComposer: { work: overlap(workDock, composer), turn: overlap(turnDock, composer) },
      // Claim 3: how many ways back to latest are on screen at once.
      backToLatest: all(".jump-latest, .inline-link").filter((n) => /latest|最新/i.test(n.text)),
      // Claim 2: is an agent's name readable, or cut?
      agentNames: [...document.querySelectorAll(".agent-row .agent-identity, .agent-row .agent-name")].map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent || "").trim().slice(0, 30), w: Math.round(r.width), cut: el.scrollWidth > el.clientWidth + 1 };
      }),
      // Claim 5: touch targets and the idle composer's height.
      touchTargets: all(".toolbar .icon-button, .work-dock button, .turn-dock button")
        .filter((n) => n.shown).map((n) => ({ w: n.w, h: n.h })),
      reading: inner && body ? { columnW: inner.w, bodyW: body.w, sideSpend: body.w - inner.w } : null,
    };
  });

try {
  for (const view of VIEWS) {
    for (const inset of INSETS) {
      const { context, page } = await open(view, inset);
      const where = `${view.name} ${inset.name}`;
      try {
        const seen = await measure(page);
        report.views.push({ where, viewport: view, inset, ...seen });
        const shot = `${output}/${view.name}-${inset.name}.png`;
        await page.screenshot({ path: shot });
        console.log(`${where.padEnd(26)} window ${seen.window.w}×${seen.window.h} | app ${seen.app?.clientW} pad ${seen.app?.padLeft}/${seen.app?.padRight}`);
        console.log(`${"".padEnd(26)} reading column ${seen.reading?.columnW} of body ${seen.reading?.bodyW} (sides spend ${seen.reading?.sideSpend})`);
        console.log(`${"".padEnd(26)} dock→composer overlap work=${seen.dockIntoComposer.work} turn=${seen.dockIntoComposer.turn} | back-to-latest shown ${seen.backToLatest.filter((b) => b.shown).length}`);
        const cut = seen.agentNames.filter((n) => n.cut).length;
        console.log(`${"".padEnd(26)} agent names cut ${cut}/${seen.agentNames.length} | composer h ${seen.composer?.h} | smallest touch ${Math.min(...seen.touchTargets.map((t) => Math.min(t.w, t.h)), 999)}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/measurements.json`, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`\n${report.views.length} views measured, ${report.errors.length} page errors; ${output}`);
