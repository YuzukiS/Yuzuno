// Two layout faults core.25 shipped with, both from #459 (YN-17).
//
// 1. The toolbar's Core status: two dots side by side, and "Core connected"
//    wrapped onto two lines over the settings and inspector icons. Measured
//    as the reader sees it: every small filled round box in the toolbar's
//    right-hand group is a dot, whatever class drew it; the label's text is
//    measured by its line boxes (a Range), not by its element, whose box can
//    be narrower than the words it holds.
// 2. The work dock's groups (Jobs, GitHub Actions, PR reviews): each group's
//    heading icon, first run's node and first text column must stand at the
//    same x as the other groups'.
//
// A desktop window with a mouse, in the desktop app's class (?shell=desktop),
// at the four sizes the user works at and two narrower tall ones, in both
// languages and both themes. The fixture is synthetic.
//   YUZUNO_UI_DIST=<isolated build> node tools/yn17-layout.mjs
// YN17_SHOTS=<dir> also writes a toolbar and a dock screenshot per case.
// YN17_VIEWS=1440x900,... and YN17_CASES=en-light,... narrow the matrix.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"), "Use an isolated build, not web/dist");
const shots = process.env.YN17_SHOTS ? resolve(process.env.YN17_SHOTS) : null;
if (shots) await mkdir(shots, { recursive: true });
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();

const views = (process.env.YN17_VIEWS || "1280x720,1440x900,1920x1080,951x669,1024x900,760x900").split(",").map((pair) => {
  const [width, height] = pair.split("x").map(Number);
  return { name: pair, width, height };
});
const cases = (process.env.YN17_CASES || "en-light,en-dark,zh-Hans-light,zh-Hans-dark").split(",").map((name) => {
  const theme = name.endsWith("-dark") ? "dark" : "light";
  return { name, lang: name.slice(0, -theme.length - 1), theme };
});

const agent = {
  id: "a", name: "Dev 4 · web", status: "idle", harness: "claude", cwd: "/work/example",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 5 · core" }];

const resources = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (i, status, name) => ({
  id: `j${i}`, name, status, reason: null, agentId: "a", agent: { name: agent.name }, taskRef: "T-7",
  cwd: "/work/example", machine: { name: "lab-host" }, resources, reservation: resources, exclusive: false,
  createdAt: iso(-600_000), startedAt: iso(-500_000), finishedAt: status === "running" ? null : iso(-100_000 + i * 1000),
  reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running", "web typecheck, build and tests"), job(1, "succeeded", "browser layout check")];
// A run's name as GitHub gives it is often a single short word.
const run = (i, status, conclusion) => ({
  id: `c${i}`, name: "CI", repository: "example/project", runId: `${1000 + i}`, attempt: "1",
  headSha: "0123456789abcdef0123456789abcdef01234567", status, rawStatus: status, conclusion,
  url: "https://example.invalid/", createdAt: iso(-400_000), startedAt: iso(-390_000),
  updatedAt: iso(-10_000 + i * 1000), observedAt: iso(-5_000), cursor: i, runWatched: status !== "completed",
});
const ci = { runs: [run(0, "in_progress", null), run(1, "completed", "success")], subscriptions: [], hasMore: false, nextBefore: null };
const review = (i, status, conclusion, findingsCount) => ({
  id: `rv${i}`, taskId: "task-1", taskRef: "T-7", taskTitle: "Example task", linkId: "l1",
  repository: "example/project", number: 42, url: null, round: i + 1, status, phase: null, conclusion,
  requestedHarness: null, requestedModel: null, actualHarness: null, actualModel: null,
  baseSha: null, headSha: "89abcdef0123456789abcdef0123456789abcdef", mergeBaseSha: null,
  createdAt: iso(-300_000), finishedAt: status === "completed" ? iso(-60_000 + i * 1000) : null, error: null,
  requestedBy: { kind: "agent", id: "a", name: agent.name }, findingsCount, outdated: false, cursor: i,
});
const reviews = { reviews: [review(1, "completed", "changes_requested", 2), review(0, "completed", "no_findings", 0)],
  hasMore: false, nextBefore: null };

const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 6 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `Turn ${i + 1}` }] },
      { id: `r${i}`, type: "agentMessage", text: "A paragraph to fill the conversation's width. ".repeat(6) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failed++;
};
const errors = [];
const browser = await launchBrowser();

async function open(view, c) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height }, hasTouch: false, isMobile: false, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(([lang, theme]) => {
    window.EventSource = class {
      constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 30); }
      addEventListener() {}
      close() { this.readyState = 2; }
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, [c.lang, c.theme]);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents,
        runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/machines") return route.fulfill({ json: { machines: [] } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: ci });
    if (path === "/api/reviews") return route.fulfill({ json: reviews });
    if (path === "/api/catchup")
      return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (error) => errors.push(`${view.name} ${c.name}: ${error.message}`));
  await page.goto("https://yn17.test/?shell=desktop");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".work-dock .work-dock-group").nth(2).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  return { context, page };
}

// The toolbar's right-hand group as it is drawn.
const toolbar = () => {
  const actions = document.querySelector(".toolbar-actions");
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && Number(st.opacity) > 0;
  };
  // A dot is a small filled round box, whichever rule drew it.
  const dots = [...actions.querySelectorAll("*")].filter((el) => {
    if (!shown(el)) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const radius = st.borderTopLeftRadius;
    const round = radius.endsWith("%") ? parseFloat(radius) >= 50 : parseFloat(radius) >= Math.min(r.width, r.height) / 2 - 0.5;
    const fill = st.backgroundColor;
    const filled = fill !== "transparent" && !/rgba\(.*,\s*0\)$/.test(fill);
    return round && filled && r.width <= 10 && r.height <= 10;
  }).map((el) => ({ cls: el.className || el.tagName, ...rect(el) }));
  // The words, by their line boxes.
  const labelEl = actions.querySelector(".connection-label");
  let label = null;
  if (labelEl && (labelEl.textContent || "").trim()) {
    const range = document.createRange();
    range.selectNodeContents(labelEl);
    const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (lines.length && shown(labelEl.parentElement)) {
      const box = range.getBoundingClientRect();
      label = { text: labelEl.textContent.trim(), lines: new Set(lines.map((r) => Math.round(r.top))).size,
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } };
    }
  }
  const icons = [...actions.querySelectorAll("button, a")].filter(shown).map((el) => ({
    name: el.getAttribute("aria-label") || el.getAttribute("title") || el.className, ...rect(el) }));
  const meet = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const entry = document.querySelector(".core-status-entry");
  return { dots, label, icons, hit: label ? icons.filter((i) => meet(label.box, i)).map((i) => i.name) : [],
    entry: !!entry && shown(entry), actions: rect(actions) };
};

// Each dock group's columns: heading icon, first run's node, text columns.
const dock = () => {
  const left = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? Math.round(r.left * 10) / 10 : null;
  };
  const el = document.querySelector(".work-dock");
  const r = el.getBoundingClientRect();
  return {
    width: Math.round(r.width), box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    groups: [...el.querySelectorAll(".work-dock-group")].map((g) => {
      const gr = g.getBoundingClientRect();
      const item = g.querySelector(".work-dock-item");
      return {
        name: g.getAttribute("aria-label"), left: Math.round(gr.left * 10) / 10, w: Math.round(gr.width * 10) / 10,
        icon: left(g.querySelector(".work-dock-heading .work-dock-node")),
        node: left(item?.querySelector(".work-dock-node")),
        heading: left(g.querySelector(".work-dock-heading .work-dock-label")),
        text: left(item?.querySelector(".work-dock-label")),
      };
    }),
  };
};
const spread = (values) => {
  const v = values.filter((x) => x !== null);
  return v.length < 2 ? 0 : Math.round((Math.max(...v) - Math.min(...v)) * 10) / 10;
};

for (const view of views) {
  for (const c of cases) {
    const at = `${view.name} ${c.name}`;
    const { context, page } = await open(view, c);
    try {
      const bar = await page.evaluate(toolbar);
      console.log(`\n--- ${at} ---`);
      console.log(`  toolbar: ${bar.dots.length} dot(s) ${JSON.stringify(bar.dots.map((d) => `${d.cls}@${Math.round(d.left)}`))}` +
        `, entry ${bar.entry ? "shown" : "not shown"}, label ${bar.label ? `"${bar.label.text}" ${bar.label.lines} line(s) ` +
        `${Math.round(bar.label.box.left)}-${Math.round(bar.label.box.right)}` : "not shown"}`);
      check(bar.dots.length === 1, `${at}: the toolbar shows exactly one Core status dot (${bar.dots.length})`);
      check(!bar.label || bar.label.lines === 1, `${at}: the Core label stays on one line (${bar.label?.lines ?? "hidden"})`);
      check(bar.hit.length === 0, `${at}: the Core label clears every toolbar icon (${bar.hit.join(", ") || "none"})`);
      if (!bar.entry)
        check(!!bar.label, `${at}: where there is no status entry, the toolbar still says Core's state in words`);

      // Pointed at, so the dock unfolds its names, as a reader sees it.
      const box = await page.locator(".work-dock").boundingBox();
      await page.mouse.move(box.x + 3, box.y + 3);
      await page.waitForTimeout(300);
      const d = await page.evaluate(dock);
      const wide = d.groups.some((g) => g.text !== null);
      console.log(`  dock ${d.width}px (${wide ? "names beside the nodes" : "nodes only"}): ` +
        d.groups.map((g) => `${g.name} group ${g.left}+${g.w} icon ${g.icon} node ${g.node} heading ${g.heading} text ${g.text}`).join(" | "));
      check(d.groups.length === 3, `${at}: the dock holds three groups (${d.groups.map((g) => g.name).join(", ")})`);
      check(spread(d.groups.map((g) => g.icon)) <= 1, `${at}: the groups' heading icons share one x (spread ${spread(d.groups.map((g) => g.icon))}px)`);
      check(spread(d.groups.map((g) => g.node)) <= 1, `${at}: the groups' first runs share one x (spread ${spread(d.groups.map((g) => g.node))}px)`);
      if (wide) {
        check(spread(d.groups.map((g) => g.heading)) <= 1,
          `${at}: the groups' heading names share one x (spread ${spread(d.groups.map((g) => g.heading))}px)`);
        check(spread(d.groups.map((g) => g.text)) <= 1,
          `${at}: the groups' first text columns share one x (spread ${spread(d.groups.map((g) => g.text))}px)`);
      }
      if (shots) {
        const name = `${view.name}-${c.name}`;
        const a = bar.actions;
        const x = Math.max(0, Math.floor(a.left) - 40);
        await page.screenshot({ path: join(shots, `${name}-toolbar.png`),
          clip: { x, y: 0, width: Math.min(view.width - x, Math.ceil(a.right - x) + 8), height: Math.min(view.height, Math.ceil(a.bottom) + 24) } });
        const dx = Math.max(0, Math.floor(d.box.left) - 4);
        const dy = Math.max(0, Math.floor(d.box.top) - 8);
        await page.screenshot({ path: join(shots, `${name}-dock.png`),
          clip: { x: dx, y: dy, width: Math.min(view.width - dx, 260), height: Math.min(view.height - dy, Math.ceil(d.box.bottom - dy) + 8) } });
      }
    } finally {
      await context.close();
    }
  }
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
