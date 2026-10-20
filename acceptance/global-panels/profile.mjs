// T-68: a bounded, same-build comparison of global panels over long/short history.
// Only an isolated loopback fixture is served. No daily Core or native window access.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, extname } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import sourceMap from "../../web/node_modules/source-map-js/source-map.js";

const manifestPath = resolve(process.env.T68_ASSETS || "target/t68/baseline-assets.json");
const out = resolve(process.env.T68_OUT || "target/t68/baseline-profile");
const mode = process.env.T68_MODE || "baseline";
assert.ok(["baseline", "modal-diagnostic"].includes(mode));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = JSON.parse(await readFile(manifestPath, "utf8"));
for (const [file, hash] of Object.entries(assets.sha256))
  assert.equal(sha(await readFile(resolve(assets.web, file))), hash, file);
const fixtureBytes = await readFile(assets.fixture);
assert.equal(sha(fixtureBytes), assets.fixtureSha256);
assert.equal(assets.fixtureSha256, "b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d");
const long = JSON.parse(fixtureBytes).details.a;
assert.equal(long.turns.length, 157);
assert.equal(long.agent.id, "a");
assert.equal(long.agent.unreadCount, 0);
assert.equal(long.pending.length, 0);
// Same identity, metadata and final turns; only the retained history differs.
const short = { ...long, turns: long.turns.slice(-2) };
const resultIds = new Set(long.turns.flatMap(turn => (turn._yuzunoResults || []).map(result => result.id)));
let detail = long;
const requests = [], blockedWrites = [], externalRequests = [], errors = [];
const release = {
  releaseId: "t68-fixed-fixture", version: "2026.10.15", gitSha: assets.sourceCommit,
  builtAt: "2026-10-15T00:00:00Z", platform: "linux-x86_64", protocol: 1,
  schema: { writes: 2, readsMin: 2, readsMax: 2 },
  records: { writes: 1, readsMin: 0, readsMax: 1 },
  notes: "Isolated performance fixture", bytes: 12000000,
};
const updates = {
  managed: true, current: release, candidates: [], blockers: [], acceptingWork: true,
  storage: { releaseBytes: 12000000, backupBytes: 0, retainedReleases: 1, keepReleases: 3 },
};
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method !== "GET") {
      blockedWrites.push({ path, method: req.method });
      res.writeHead(403);
      return res.end('{"error":"Isolated read-only fixture"}');
    }
    if (path.startsWith("/api/")) {
      const at = performance.now();
      let data;
      if (path === "/api/workspace") data = {
        agents: [detail.agent], workspace: { id: "t68" }, runtime: { connected: true },
        defaultCwd: "/fixture", projects: [], projectUsage: {},
      };
      else if (path === "/api/agents/a") data = detail;
      else if (path === "/api/updates") data = updates;
      else if (path === "/api/pr-reviews/settings") data = { harness: "codex", model: "gpt-6.1-sol" };
      else if (path === "/api/machines") data = { machines: [] };
      else if (path === "/api/catchup") data = { items: [], agents: [] };
      else if (path === "/api/models") data = { models: [] };
      else if (path === "/api/health") data = { ok: true };
      else if (path === "/api/jobs") data = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };
      else if (path === "/api/ci") data = { runs: [], subscriptions: [], hasMore: false, nextBefore: null };
      else if (path === "/api/backlog") data = { observedAt: "2026-10-15T00:00:00Z", agents: {} };
      else if (path === "/api/jobs/budget") data = {
        machine: { name: "T68 fixture", memoryAvailableMiB: 3072, scope: "Isolated mock data" },
        budget: { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 },
        reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 }, activeCount: 0, queuedCount: 0,
      };
      else if (path.startsWith("/api/agents/a/results/") && resultIds.has(path.split("/").at(-1))) data = {
        id: path.split("/").at(-1),
        spec: { root: "result", elements: {
          result: { type: "Result", props: { title: "Fixture result", summary: "Synthetic acceptance content" }, children: ["text"] },
          text: { type: "Text", props: { text: "Published result payloads were not copied into this masked fixture." } },
        } },
      };
      else {
        errors.push(`Unimplemented fixture GET ${path}`);
        res.writeHead(404);
        return res.end("{}");
      }
      const body = JSON.stringify(data);
      requests.push({ path, at, prepareMs: performance.now() - at, bytes: Buffer.byteLength(body) });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }
    const file = resolve(assets.web, path === "/" ? "index.html" : "." + path);
    if (!file.startsWith(assets.web + "/")) {
      res.writeHead(403);
      return res.end();
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": {
      ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml",
    }[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch (e) {
    if (!req.url.includes("favicon")) errors.push(`Fixture server: ${e.message}`);
    res.writeHead(404);
    res.end();
  }
});

function instrument() {
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  localStorage.removeItem("yuzuno.scope");
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }));
  const S = window.t68 = { commits: [], longTasks: [], fetches: [], sources: [], seq: 0, deltas: 0 };
  const now = () => performance.now();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot() { S.commits.push(now()); },
  };
  new PerformanceObserver((list) => S.longTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration }))))
    .observe({ type: "longtask" });
  const fetch = window.fetch;
  window.fetch = async (...args) => {
    const record = { path: String(args[0]), start: now() };
    const response = await fetch(...args);
    record.headers = now();
    const json = response.json.bind(response);
    response.json = async () => {
      record.bodyStart = now();
      const data = await json();
      record.done = now();
      S.fetches.push(record);
      if (data.agent && data.turns) S.detail = data;
      return data;
    };
    return response;
  };
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      S.sources.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: '{"type":"resumed"}', lastEventId: "fixture-0" });
      }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  S.emit = (data) => {
    for (const source of S.sources) if (source.readyState === 1)
      source.onmessage?.({ data: JSON.stringify(data), lastEventId: "fixture-" + ++S.seq });
  };
  S.streaming = (on) => {
    clearInterval(S.timer);
    if (!on) return;
    const d = S.detail, turnId = d.turns.at(-1).id;
    let rev = (d.agent.rev || 0) + 1;
    S.emit({ type: "agent.item", agentId: "a", turnId, rev: rev++,
      item: { id: "t68-stream", type: "agentMessage", text: "T68 synthetic stream\n" } });
    S.timer = setInterval(() => {
      S.deltas++;
      S.emit({ type: "agent.delta", agentId: "a", turnId, itemId: "t68-stream", rev: rev++,
        op: "append", field: "text", text: ` t68-delta-${S.deltas}` });
    }, 100);
  };
  S.reset = (button) => {
    S.sample = { button, armedAt: now() };
    S.commits = []; S.longTasks = []; S.fetches = [];
  };
  document.addEventListener("click", (event) => {
    const s = S.sample;
    if (!s || s.clickAt || !(event.target instanceof Element) ||
        event.target.closest("button")?.getAttribute("aria-label") !== s.button) return;
    s.clickAt = now();
    performance.mark("t68.click");
    const observe = () => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog && dialog.getBoundingClientRect().width > 0) {
        s.dialogObservedAt ??= now();
        if (dialog.contains(document.activeElement)) s.focusObservedAt ??= now();
        if (s.focusObservedAt && !s.framesQueued) {
          s.framesQueued = true;
          requestAnimationFrame(() => requestAnimationFrame(() => {
            s.dialogAndFocus2RafAt = now();
            performance.mark("t68.open-ready");
          }));
        }
      }
      if (!s.dialogAndFocus2RafAt && now() - s.clickAt < 15000) requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && S.sample?.dialogAndFocus2RafAt) {
      S.sample.escapeAt = now();
      performance.mark("t68.escape");
    }
  }, true);
  S.collect = () => ({
    sample: { ...S.sample }, at: now(), commits: S.commits, longTasks: S.longTasks,
    fetches: S.fetches, streamDeltas: S.deltas,
  });
}

const maybeRead = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
const host = () => ({
  at: Date.now(), load: maybeRead("/proc/loadavg"), cpuPressure: maybeRead("/proc/pressure/cpu"),
  memory: maybeRead("/proc/meminfo")?.split("\n").filter(l => /^(MemAvailable|SwapFree|SwapTotal):/.test(l)),
  swap: maybeRead("/proc/vmstat")?.split("\n").filter(l => /^pswp/.test(l)),
});
const cgroup = () => {
  const path = maybeRead("/proc/self/cgroup")?.split("::")[1];
  return path ? Object.fromEntries(["pids.max", "pids.peak", "pids.events", "memory.events", "cpu.max"]
    .map(name => [name, maybeRead(resolve("/sys/fs/cgroup", "." + path, name))])) : null;
};
const metricDelta = (a, b) => Object.fromEntries([
  "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount",
].map(name => [name, b[name] - a[name]]));
const report = {
  task: "T-68", mode, assets, scriptSha256: sha(readFileSync(import.meta.filename)),
  fixtureSha256: sha(fixtureBytes), viewport: { width: 1440, height: 1000 },
  appearance: { theme: "light", fontSize: 20, palette: "garden" }, cpuThrottle: 1,
  histories: Object.fromEntries(Object.entries({ long, short }).map(([name, d]) => [name, {
    turns: d.turns.length, items: d.turns.reduce((n, t) => n + t.items.length, 0),
  }])),
  node: process.version, affinity: maybeRead("/proc/self/status")?.match(/Cpus_allowed_list:\s+(\S+)/)?.[1],
  lpNumThreads: process.env.LP_NUM_THREADS, hostBefore: host(), cgroupBefore: cgroup(),
  samples: [], requests, blockedWrites, externalRequests, errors,
  limitations: [
    "One bounded long/short pair, four actions per history; not a statistically stable latency estimate.",
    "Fresh isolated Linux headless Chromium, production assets; not the Windows WebView or daily deployed source.",
    "Click to dialog/focus plus two RAF callbacks is a paint opportunity proxy, not physical presentation latency.",
    "React hook records root commit times only, not component render counts or full-history rerenders.",
    "Synthetic GET responses and 10Hz SSE stream do not establish real Core/network performance.",
    "CPU sampling and tracing add overhead equally; trace complete-event durations can nest and must not be summed as wall time.",
    "CDP metric windows surround automation calls; trace/CPU opening windows use in-page click and ready marks.",
    "Published result references receive the same small synthetic Text result; original result bodies are absent from the masked fixture.",
  ],
};
const diagnosticCases = [
  { history: "long-control", data: long, css: "/* Same isolated assets, unchanged behavior. */" },
  { history: "long-stable-body", data: long, css: `body {
      position: relative; overflow: hidden; overscroll-behavior: contain;
      padding: 0; margin: 0; --removed-body-scroll-bar-size: 0px;
    }` },
  { history: "long-no-blur", data: long, css: ".modal-overlay { backdrop-filter: none !important; }" },
  // Deliberately NOT a proposed fix: this relaxes inherited pointer blocking.
  // Only used in an isolated page to attribute the invalidation cost.
  { history: "long-pointer-boundary", data: long, css: "#root { pointer-events: auto; }" },
];
if (mode === "modal-diagnostic") {
  report.diagnosticCases = diagnosticCases.map(({ history, css }) => ({ history, css }));
  report.limitations.push("Four isolated long-history Settings openings with one CSS change each. Pointer-boundary variant is attribution-only and is not behaviorally safe as a production fix.");
}
function bodyStyles() {
  const body = getComputedStyle(document.body), root = getComputedStyle(document.getElementById("root"));
  return { position: body.position, overflow: body.overflow, margin: body.margin, padding: body.padding,
    scrollbarSize: body.getPropertyValue("--removed-body-scroll-bar-size"),
    bodyPointerEvents: body.pointerEvents, rootPointerEvents: root.pointerEvents,
    scrollLock: document.body.getAttribute("data-scroll-locked") };
}

const maps = new Map();
async function mapFrame(frame) {
  if (!frame.url.startsWith(origin + "/assets/")) return frame;
  const path = new URL(frame.url).pathname;
  const mapPath = resolve(assets.web, "." + path + ".map");
  if (!maps.has(mapPath)) {
    try { maps.set(mapPath, new sourceMap.SourceMapConsumer(JSON.parse(await readFile(mapPath, "utf8")))); }
    catch { maps.set(mapPath, null); }
  }
  const original = maps.get(mapPath)?.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
  return original?.source ? { ...frame, original } : frame;
}
async function summarizeCPU(profile, start, end) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const totals = new Map();
  let at = profile.startTime;
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const delta = profile.timeDeltas[i];
    at += delta;
    if (at < start || at > end) continue;
    const id = profile.samples[i];
    totals.set(id, (totals.get(id) || 0) + delta / 1000);
  }
  return Promise.all([...totals].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(async ([id, sampledMs]) => ({ sampledMs, frame: await mapFrame(nodes.get(id).callFrame) })));
}
function summarizeTrace(trace, start, end, thread) {
  const names = new Set(["RunTask", "FunctionCall", "EventDispatch", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "CompositeLayers", "Commit"]);
  const stats = {};
  for (const e of trace.traceEvents) {
    if (e.pid !== thread.pid || e.tid !== thread.tid || e.ph !== "X" || !names.has(e.name) ||
        e.ts + (e.dur || 0) < start || e.ts > end) continue;
    const row = stats[e.name] ||= { count: 0, totalMs: 0, maxMs: 0 };
    const ms = Math.max(0, Math.min(end, e.ts + (e.dur || 0)) - Math.max(start, e.ts)) / 1000;
    row.count++; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms);
    if (e.name === "Layout") {
      row.maxTotalObjects = Math.max(row.maxTotalObjects || 0, e.args?.beginData?.totalObjects || 0);
      row.maxDirtyObjects = Math.max(row.maxDirtyObjects || 0, e.args?.beginData?.dirtyObjects || 0);
    }
  }
  return stats;
}

await mkdir(out, { recursive: true });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true });
  report.chromium = browser.version();
  // Both histories get the same warm-up and action order; fresh contexts avoid visited-tool leakage.
  const cases = mode === "modal-diagnostic" ? diagnosticCases :
    Object.entries({ long, short }).map(([history, data]) => ({ history, data, css: null }));
  for (const { history, data, css } of cases) {
    detail = data;
    const page = await browser.newPage({ viewport: report.viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(instrument);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
    await page.goto(origin + "/?shell=desktop");
    if (css) await page.addStyleTag({ content: css });
    await page.locator("[data-composer-input]").waitFor();
    await page.waitForFunction(n => document.querySelectorAll(".turn").length === n, data.turns.length);
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`.interactive-result[data-result-id="${CSS.escape(id)}"]`)),
      data.turns.flatMap(turn => (turn._yuzunoResults || []).map(result => result.id)));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(700);
    assert.deepEqual(errors, [], "Fixture preflight must pass before sampling");
    const domBefore = await page.evaluate(() => ({
      nodes: document.getElementsByTagName("*").length,
      turns: document.querySelectorAll(".turn").length,
      closedToolNodes: [...document.querySelectorAll(".tool-activity:not([open]) .execution-items")]
        .reduce((n, e) => n + e.getElementsByTagName("*").length, 0),
    }));
    const stylesBefore = await page.evaluate(bodyStyles);
    const actions = mode === "modal-diagnostic" ? [
      { name: "settings-first", button: "Settings and updates", title: "Settings", hold: 100 },
    ] : [
      { name: "settings-first", button: "Settings and updates", title: "Settings", hold: 1900 },
      { name: "settings-reopen", button: "Settings and updates", title: "Settings", hold: 100 },
      { name: "appearance", button: "Appearance settings", title: "Make yourself comfortable", hold: 100 },
      { name: "settings-streaming", button: "Settings and updates", title: "Settings", hold: 1900, stream: true },
    ];
    for (const action of actions) {
      const name = `${history}-${action.name}`;
      const tracePath = resolve(out, `${name}.trace.json`);
      if (action.stream) {
        await page.evaluate(() => t68.streaming(true));
        await page.waitForTimeout(250);
      }
      await page.getByRole("button", { name: action.button, exact: true }).waitFor();
      await browser.startTracing(page, { path: tracePath,
        categories: ["devtools.timeline", "v8", "blink.user_timing", "disabled-by-default-devtools.timeline"] });
      await cdp.send("Profiler.start");
      await page.evaluate(button => t68.reset(button), action.button);
      const before = await metrics();
      await page.getByRole("button", { name: action.button, exact: true }).click();
      await page.waitForFunction(() => !!t68.sample.dialogAndFocus2RafAt);
      await page.getByRole("dialog", { name: action.title, exact: true }).waitFor();
      const open = await metrics();
      const opened = await page.evaluate(() => t68.collect());
      const stylesOpened = await page.evaluate(bodyStyles);
      await page.waitForTimeout(action.hold);
      const held = await metrics();
      const hold = await page.evaluate(() => { performance.mark("t68.hold-end"); return t68.collect(); });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      const close = await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
        performance.mark("t68.close-ready");
        r({ at: performance.now(), focusLabel: document.activeElement?.getAttribute("aria-label"), escapeAt: t68.sample.escapeAt });
      }))));
      const closed = await metrics();
      const { profile } = await cdp.send("Profiler.stop");
      await browser.stopTracing();
      await writeFile(resolve(out, `${name}.cpu.json`), JSON.stringify(profile));
      const raw = await page.evaluate(() => t68.collect());
      let streamVisible = null;
      if (action.stream) {
        await page.evaluate(() => t68.streaming(false));
        const emitted = await page.evaluate(() => t68.deltas);
        await page.waitForFunction(n => document.querySelector('[data-item-id="t68-stream"]')?.textContent?.includes(`t68-delta-${n}`), emitted);
        streamVisible = emitted;
      }
      const trace = JSON.parse(await readFile(tracePath, "utf8"));
      const clickMark = trace.traceEvents.find(e => e.name === "t68.click");
      const mark = name => trace.traceEvents.find(e => e.name === name)?.ts;
      const clickAt = mark("t68.click"), openAt = mark("t68.open-ready"), holdAt = mark("t68.hold-end"), closeAt = mark("t68.close-ready");
      assert.ok(clickAt && openAt && holdAt && closeAt, "All trace measurement marks must exist");
      report.samples.push({ name, history, action, domBefore, stylesBefore, stylesOpened, opened, hold, raw, close,
        focusReturnedToOpener: close.focusLabel === action.button,
        clickToDialogMs: opened.sample.dialogObservedAt - opened.sample.clickAt,
        clickToFocusMs: opened.sample.focusObservedAt - opened.sample.clickAt,
        clickToDialogFocus2RafMs: opened.sample.dialogAndFocus2RafAt - opened.sample.clickAt,
        escapeToClosed2RafMs: close.at - close.escapeAt,
        metrics: { opening: metricDelta(before, open), held: metricDelta(open, held), closing: metricDelta(held, closed),
          heapBefore: before.JSHeapUsedSize, heapAfter: closed.JSHeapUsedSize, nodesBefore: before.Nodes, nodesAfter: closed.Nodes },
        cpu: { opening: await summarizeCPU(profile, clickAt, openAt), held: await summarizeCPU(profile, openAt, holdAt) },
        timeline: { opening: summarizeTrace(trace, clickAt, openAt, clickMark), held: summarizeTrace(trace, openAt, holdAt, clickMark), closing: summarizeTrace(trace, holdAt, closeAt, clickMark) },
        streamVisible, traceFile: tracePath, cpuFile: resolve(out, `${name}.cpu.json`),
      });
      console.log(JSON.stringify({ name, clickToDialogFocus2RafMs: report.samples.at(-1).clickToDialogFocus2RafMs,
        openScriptMs: (open.ScriptDuration - before.ScriptDuration) * 1000, domBefore, streamVisible }));
      await page.waitForTimeout(250);
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedWrites, []);
  assert.deepEqual(externalRequests, []);
  report.passed = true;
} catch (e) {
  report.failure = e.stack;
  throw e;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  report.hostAfter = host(); report.cgroupAfter = cgroup();
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
