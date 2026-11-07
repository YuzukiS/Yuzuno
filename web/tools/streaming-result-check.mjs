// YN-15: how soon a reply's result shows while its block is streamed, in Chromium on a production build
// of the app with a synthetic Workspace and a stand-in event stream this check speaks for Core (no Core,
// no Agent, no model). A running Turn's reply arrives as `agent.delta` appends, as Core sends Claude's
// and Codex's text: a sentence, then a yuzuno-ui block of 2-space JSON, its root first and its elements
// in display order, at a fixed synthetic pace (CHUNK characters every TICK ms).
// For each sample result (a table; metrics and a chart; a comparison) and each run, it records in
// animation frames, from the moment the block's opening line arrived:
// - card: the result's frame and title first show;
// - part: the first part of the result under its title (a table, metrics, a chart, text, sources) shows;
// - complete: the whole result shows, checked and usable (nothing still placeholder, not live);
// - close: when the block's closing line arrived;
// - layoutShift: the sum of layout-shift values in that time (no input, so all of them count).
// The same script measures any build: run it on main's and on a branch's, and compare.
// Report only: it fails when a run cannot finish, a page error occurs, or anything but the app's own
// reading saves is written. The pace decides most of the times; this is not a model's own pacing, a real
// network, Safari, or OpenCode's refetch path.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> [YUZUNO_STREAM_LABEL=main] [YUZUNO_STREAM_RUNS=5]
//   node tools/streaming-result-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/streaming-result");
await mkdir(output, { recursive: true });
const label = process.env.YUZUNO_STREAM_LABEL || "build";
const RUNS = Number(process.env.YUZUNO_STREAM_RUNS || 5);
const CHUNK = 12;
const TICK = 50;

const row = (i) => ({ id: `r${i}`, cells: { run: `Run ${i + 1}`, ms: 180 + ((i * 37) % 90), state: i % 4 ? "passed" : "slow", host: `host-${(i % 3) + 1}` } });
const samples = {
  table: {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "Twenty synthetic runs", summary: "Illustrative data: four of twenty runs were slow." }, children: ["runs"] },
      runs: { type: "Table", props: { id: "runs", title: "Runs", columns: [{ key: "run", label: "Run" }, { key: "ms", label: "Time (ms)" },
        { key: "state", label: "State" }, { key: "host", label: "Host" }], rows: Array.from({ length: 20 }, (_, i) => row(i)) } },
    },
  },
  "metrics+chart": {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "Where the wait goes", summary: "Illustrative data: the snapshot read is the largest stage." }, children: ["metrics", "chart", "note"] },
      metrics: { type: "Metrics", props: { items: [{ label: "Sample", value: "12 updates" }, { label: "Median", value: "210 ms" },
        { label: "p90", value: "380 ms" }, { label: "Slowest", value: "Snapshot", detail: "Illustrative values, not telemetry" }] } },
      chart: { type: "BarChart", props: { id: "stages", title: "Time by stage", unit: "ms", data: Array.from({ length: 12 }, (_, i) =>
        ({ id: `s${i}`, label: `Stage ${i + 1}`, value: 20 + ((i * 53) % 140) })) } },
      note: { type: "Text", props: { text: "Synthetic values for this check only." } },
    },
  },
  comparison: {
    root: "result",
    elements: {
      result: { type: "Result", props: { title: "Three layouts", summary: "Illustrative comparison: pick one to explore." }, children: ["options", "sources"] },
      options: { type: "Table", props: { id: "options", title: "Options", selectable: true, columns: [{ key: "name", label: "Option" },
        { key: "strength", label: "Strength" }, { key: "tradeoff", label: "Trade-off" }], rows: [
        { id: "dock", cells: { name: "Side dock", strength: "Follows the reading position", tradeoff: "A slim side column" }, sourceIds: ["notes"] },
        { id: "outline", cells: { name: "Outline", strength: "Descriptive titles", tradeoff: "More width" }, sourceIds: ["notes"] },
        { id: "markers", cells: { name: "Markers", strength: "A quiet page", tradeoff: "Less detail" } },
        { id: "tabs", cells: { name: "Tabs", strength: "Familiar", tradeoff: "Hides the rest" }, sourceIds: ["survey"] },
        { id: "none", cells: { name: "Nothing", strength: "No work", tradeoff: "No help" } },
      ] } },
      sources: { type: "Sources", props: { items: [{ id: "notes", label: "Design notes", href: "docs/example-notes.md:12" },
        { id: "survey", label: "Survey summary", href: "https://example.com/survey" }, { id: "spec", label: "Layout spec", href: "docs/example-spec.md" }] } },
    },
  },
};
const replyOf = (spec) => `Here is what I found.\n\n\`\`\`yuzuno-ui\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nTell me which to look at next.`;

const report = { label, chunk: CHUNK, tickMs: TICK, runs: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: [] };
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "working", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, rev: 1, projectId: "p", harness: "codex", connectionState: "connected", threadId: "th-a" };
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const turns = [{ id: "t1", status: "inProgress", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "What did you find?" }] },
  { id: "m1", type: "agentMessage", text: "" }] }];
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": mcp,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns, messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/home": { generatedAt: "2026-11-07T12:00:00Z", order: ["p"], needsYou: [], projects: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) {
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const known = gets[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/agents\/[^/]+\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page from its first script: the event stream, spoken for Core by this check (a fresh
 * connection starts with `reset`, as events.rs does); the reply's text streamed as Core appends it;
 * and in each animation frame, what of the result shows. */
function pageHelpers() {
  let id = 0;
  const streams = [];
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      streams.push(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  const marks = { open: null, close: null, card: null, part: null, complete: null, sent: 0 };
  window.__marks = marks;
  let shift = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (marks.open !== null && !entry.hadRecentInput && entry.startTime >= marks.open) shift += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
  window.__drive = (text, chunk, tick) => new Promise((done) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    const opener = text.indexOf("```yuzuno-ui\n") + "```yuzuno-ui\n".length;
    const closer = text.indexOf("\n```", opener) + "\n```".length;
    let at = 0;
    let rev = 1;
    const step = () => {
      const part = text.slice(at, at + chunk);
      at += part.length;
      stream.onmessage?.({ data: JSON.stringify({ type: "agent.delta", agentId: "a", rev: ++rev, turnId: "t1", itemId: "m1", op: "append", field: "text", text: part }),
        lastEventId: String(++id) });
      marks.sent = at;
      const now = performance.now();
      if (marks.open === null && at >= opener) marks.open = now;
      if (marks.close === null && at >= closer) marks.close = now;
      if (at < text.length) setTimeout(step, tick);
      else done();
    };
    step();
  });
  const frame = () => {
    if (marks.open !== null && marks.complete === null) {
      const now = performance.now();
      const card = document.querySelector(".interactive-result");
      const content = card?.querySelector(".result-content");
      if (content?.querySelector("header h3")?.textContent && marks.card === null) marks.card = now;
      if (content?.querySelector(":scope > :not(header):not(.result-pending)") && marks.part === null) marks.part = now;
      if (content && !card.hasAttribute("data-live") && !content.querySelector(".result-pending")) {
        marks.complete = now;
        marks.layoutShift = shift;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const browser = await launchBrowser();
report.browser = browser.version();
for (const [name, spec] of Object.entries(samples)) {
  const text = replyOf(spec);
  for (let run = 1; run <= RUNS; run++) {
    const tag = `${name} #${run}`;
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference", locale: "en-US" });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(pageHelpers);
    try {
      await page.goto("http://127.0.0.1:4321/");
      await page.locator(".agent-row").first().waitFor({ timeout: 10_000 });
      if (!(await page.getByText("What did you find?").first().isVisible())) await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
      await page.getByText("What did you find?").first().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await page.evaluate(([t, c, k]) => window.__drive(t, c, k), [text, CHUNK, TICK]);
      await page.waitForFunction(() => window.__marks.complete !== null, null, { timeout: 15_000 });
      const marks = await page.evaluate(() => window.__marks);
      const since = (at) => (at === null ? null : Math.round(at - marks.open));
      report.runs.push({ sample: name, run, bytes: text.length, card: since(marks.card), part: since(marks.part), complete: since(marks.complete),
        close: since(marks.close), layoutShift: Math.round(marks.layoutShift * 10000) / 10000 });
      console.log(`${label} ${tag}: card ${since(marks.card)} ms, part ${since(marks.part)} ms, complete ${since(marks.complete)} ms (closed at ${since(marks.close)} ms)`);
      if (run === 1) await page.screenshot({ path: join(output, `${label}-${name.replace("+", "-")}.png`) });
    } catch (error) {
      report.failures.push(`${tag}: ${String(error).slice(0, 400)}`);
      await page.screenshot({ path: join(output, `${label}-${name.replace("+", "-")}-error.png`) }).catch(() => {});
    }
    await context.close();
  }
}
await browser.close();
if (report.writes.length) report.failures.push(`written: ${report.writes.join(", ")}`);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, `streaming-result-${label}.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ label, passed: report.passed, runs: report.runs.length, failures: report.failures, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
