// T-77: paired baseline/candidate runs with identical timing, fixture and environment.
// Derived from profile.mjs; historical phase-one measurements remain untouched.
// Only an isolated loopback fixture is served. No daily Core or native window access.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, extname } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";
import sourceMap from "../../web/node_modules/source-map-js/source-map.js";

const manifestPath = resolve(process.env.T77_ASSETS || "target/t77/baseline-assets.json");
const out = resolve(process.env.T77_OUT || "target/t77/baseline-profile");
const mode = process.env.T77_MODE || "baseline";
assert.ok(["baseline", "window"].includes(mode));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = JSON.parse(await readFile(manifestPath, "utf8"));
if (mode === "baseline") assert.equal(assets.sourceCommit, "8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b");
for (const [file, hash] of Object.entries(assets.sha256))
  assert.equal(sha(await readFile(resolve(assets.web, file))), hash, file);
const fixtureBytes = await readFile(assets.fixture);
assert.equal(sha(fixtureBytes), assets.fixtureSha256);
assert.equal(assets.fixtureSha256, "b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d");
const original = JSON.parse(fixtureBytes).details.a;
const long = { ...original, agent: { ...original.agent, name: "T77 Long" } };
assert.equal(long.turns.length, 157);
assert.equal(long.agent.id, "a");
assert.equal(long.agent.unreadCount, 0);
assert.equal(long.pending.length, 0);
// Same metadata and final turns; a distinct synthetic identity enables switches.
const short = { ...long, agent: { ...long.agent, id: "b", name: "T77 Short" }, turns: long.turns.slice(-2).map(turn => ({...turn, id:`short-${turn.id}`})) };
// Separate synthetic short-turn IDs prevent an old long-body commit from
// accidentally satisfying switch readiness (the two fixtures share item text).
const apiBytes = await readFile(process.env.T77_API_OUTPUT);
assert.equal(sha(apiBytes), process.env.T77_API_SHA);
const apiFixture = JSON.parse(apiBytes);
const windowLong = {...apiFixture.replies["/api/agents/a"], agent:long.agent};
const servedLong = mode === "window" ? windowLong : long;
const resultIds = new Set(long.turns.flatMap(turn => (turn._yuzunoResults || []).map(result => result.id)));

const requests = [], blockedWrites = [], externalRequests = [], errors = [];
const release = {
  releaseId: "t77-fixed-fixture", version: "2026.10.16-core.5", gitSha: assets.sourceCommit,
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
        agents: [long.agent, short.agent], workspace: { id: "t77" }, runtime: { connected: true },
        defaultCwd: "/fixture", projects: [], projectUsage: {},
      };
      else if (path === "/api/agents/a") data = servedLong;
      else if (path === "/api/agents/b") data = short;
      else if (path === "/api/updates") data = updates;
      else if (path === "/api/pr-reviews/settings") data = { harness: "codex", model: "gpt-6.1-sol" };
      else if (path === "/api/machines") data = { machines: [] };
      else if (path === "/api/catchup") data = { items: [], agents: [] };
      else if (path === "/api/models") data = { models: [] };
      else if (path === "/api/health") data = { ok: true };
      else if (path === "/api/jobs") data = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };
      else if (path === "/api/jobs/live") data = { agents: {} };
      else if (path === "/api/ci") data = { runs: [], subscriptions: [], hasMore: false, nextBefore: null };
      else if (path === "/api/backlog") data = { observedAt: "2026-10-15T00:00:00Z", agents: {} };
      else if (path === "/api/jobs/budget") data = {
        machine: { name: "T77 fixture", memoryAvailableMiB: 3072, scope: "Isolated mock data" },
        budget: { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 },
        reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 }, activeCount: 0, queuedCount: 0,
      };
      else if (/^\/api\/agents\/[ab]\/results\//.test(path) && resultIds.has(path.split("/").at(-1))) data = {
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

function instrument(initialAgent) {
  localStorage.setItem("yuzuno.selected", JSON.stringify(initialAgent));
  localStorage.removeItem("yuzuno.scope");
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }));
  const S = window.t77 = { commits: [], longTasks: [], fetches: [], observers: [], rectReads: 0, roCurrent: null };
  const now = () => performance.now();
  // Root commit timestamps do not count component renders. No profiling build.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    checkDCE() {}, onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot() { S.commits.push(now()); queueMicrotask(() => S.checkReady?.()); },
  };
  new PerformanceObserver(list => S.longTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration }))))
    .observe({ type: "longtask" });
  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const record = { path: String(args[0]), start: now() };
    const response = await nativeFetch(...args);
    record.headers = now();
    const json = response.json.bind(response);
    response.json = async () => {
      record.bodyStart = now();
      const data = await json();
      record.done = now();
      S.fetches.push(record);
      if (data.agent && data.turns) S.detail = { agentId: data.agent.id, turns: data.turns.length };
      return data;
    };
    return response;
  };
  // Native JSON/body processing is left intact; ResourceTiming separates the
  // transport window. Post-responseEnd -> json completion includes scheduling.
  const NativeRO = window.ResizeObserver;
  window.ResizeObserver = class extends NativeRO {
    constructor(callback) {
      super((entries, observer) => {
        const record = { at: now(), targets: entries.map(e => e.target.className), rectReads: 0, turnRectReads: 0, rectMs: 0 };
        const previous = S.roCurrent;
        S.roCurrent = record;
        try { callback(entries, observer); }
        finally { record.ms = now() - record.at; S.roCurrent = previous; if (S.sample?.clickAt) S.observers.push(record); }
      });
    }
  };
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function(...args) {
    if (!S.sample?.clickAt) return rect.apply(this, args);
    S.rectReads++;
    const record = S.roCurrent;
    if (!record) return rect.apply(this, args);
    const at = now();
    const result = rect.apply(this, args);
    record.rectMs += now() - at;
    record.rectReads++;
    if (this.classList.contains("turn")) record.turnRectReads++;
    return result;
  };
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: '{"type":"resumed"}', lastEventId: "fixture-0" });
      }, 20);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  S.reset = action => {
    S.sample = { action, armedAt: now() };
    S.commits = []; S.longTasks = []; S.fetches = []; S.observers = []; S.rectReads = 0;
    performance.clearResourceTimings();
  };
  S.checkReady = () => {
    const s = S.sample;
    if (!s?.clickAt || s.framesQueued) return;
    const a = s.action, app = document.querySelector(".app");
    if (!app || app.classList.contains("rail-hidden") !== a.railHidden || app.classList.contains("with-inspector") !== a.inspector) return;
    if (a.target && (S.detail?.agentId !== a.target ||
        !document.querySelector(`.agent-row[data-agent-id="${a.target}"] .agent-select[aria-current="true"]`) ||
        !document.querySelector(`[data-turn-id="${CSS.escape(a.tailTurn)}"]`) ||
        document.querySelectorAll(".turn").length < 1 ||
        document.querySelectorAll(".turn").length > a.maxTurns)) return;
    s.domCommittedAt = now(); s.framesQueued = true;
    performance.mark("t77.dom-committed");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      s.readyAt = now(); performance.mark("t77.ready");
    }));
  };
  document.addEventListener("click", event => {
    const s = S.sample;
    if (!s || s.clickAt || !(event.target instanceof Element) || !event.target.closest(s.action.selector)) return;
    s.clickAt = now(); performance.mark("t77.click");
  }, true);
  S.collect = () => ({
    sample: { ...S.sample }, at: now(), commits: S.commits, longTasks: S.longTasks,
    fetches: S.fetches, observers: S.observers, rectReads: S.rectReads,
    resources: performance.getEntriesByType("resource").filter(e => e.name.includes("/api/")).map(e => ({
      path: new URL(e.name).pathname, start: e.startTime, requestStart: e.requestStart,
      responseStart: e.responseStart, responseEnd: e.responseEnd,
      transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize,
    })),
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
  apiFixtureSha256: sha(apiBytes),
  responseMode: mode === "window" ? "real Core projected long body; two-turn short compatibility response" : "legacy full long/short bodies",
  task: "T-77", mode, assets, scriptSha256: sha(readFileSync(import.meta.filename)),
  fixtureSha256: sha(fixtureBytes), viewport: { width: 1440, height: 1000 },
  appearance: { theme: "light", fontSize: 20, palette: "garden" }, cpuThrottle: 1,
  histories: Object.fromEntries(Object.entries({ long, short }).map(([name, d]) => [name, {
    turns: d.turns.length, items: d.turns.reduce((n, t) => n + t.items.length, 0), jsonBytes: Buffer.byteLength(JSON.stringify(d)),
    previewItems: d.turns.reduce((n, t) => n + t.items.filter(i => i._yuzunoTruncated).length, 0),
  }])),
  node: process.version, affinity: maybeRead("/proc/self/status")?.match(/Cpus_allowed_list:\s+(\S+)/)?.[1],
  lpNumThreads: process.env.LP_NUM_THREADS, hostBefore: host(), cgroupBefore: cgroup(),
  samples: [], requests, blockedWrites, externalRequests, errors,
  limitations: [
    "One long/short pair, four long toggles and two switches per build; not statistical latency estimates.",
    "Isolated Linux headless Chromium and verified production assets; not Windows WebView2 measurements.",
    "DOM commit plus two RAF callbacks is a presentation-opportunity proxy, not physical screen latency.",
    "React hook records root commits only; it does not count component renders or prove full-history rerenders.",
    "Response.json is unchanged. ResourceTiming + fetch/body completion separates transport from a scheduling/JSON upper bound, not pure JSON CPU.",
    "Synthetic loopback responses do not establish actual Core/database or WAN performance.",
    "Tracing, CPU sampling and observer/rect wrappers add overhead. Nested trace durations cannot be summed as wall time.",
    "Original published-result bodies are absent; referenced results receive identical small synthetic Text results.",
    "Collapsed tools are initially unvisited. Separate browser checks cover disclosure removal, source, selection and growth.",
    "Toggles start at latest in a quiet conversation. Reading-middle, active streaming and accessibility behavior are not fully exercised here.",
  ],
};

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
  const names = new Set(["RunTask", "FunctionCall", "EventDispatch", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "CompositeLayers", "Commit", "V8.ParseJson", "ParseJSON", "FireAnimationFrame", "FireIdleCallback"]);
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
    if (e.name === "UpdateLayoutTree") row.maxElementCount = Math.max(row.maxElementCount || 0, e.args?.elementCount || 0);
  }
  return stats;
}

await mkdir(out, { recursive: true });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, activePage;
try {
  browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true });
  report.chromium = browser.version();
  // Identical workspace and build in every fresh context; only the initial
  // selected detail varies. The switch pair returns to a previously opened
  // Agent, making the absence/presence of a detail cache directly observable.
  const cases = [
    { history: "long", initial: "a", data: servedLong },
    { history: "switch", initial: "a", data: servedLong },
  ];
  report.cases = cases.map(({ data, ...c }) => c);
  for (const { history, initial, data, css } of cases) {
    const page = await browser.newPage({ viewport: report.viewport, reducedMotion: "reduce" });
    activePage = page;
    page.setDefaultTimeout(20000);
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      externalRequests.push(route.request().url());
      return route.abort();
    });
    await page.addInitScript(instrument, initial);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
    const dom = () => page.evaluate(() => {
      const pane = document.querySelector(".conversation-inner")?.parentElement;
      return {
        nodes: document.getElementsByTagName("*").length,
        turns: document.querySelectorAll(".turn").length,
        turnNodes: [...document.querySelectorAll(".turn")].reduce((n, e) => n + 1 + e.getElementsByTagName("*").length, 0),
        closedToolNodes: [...document.querySelectorAll(".tool-activity:not([open]) .execution-items")]
          .reduce((n, e) => n + e.getElementsByTagName("*").length, 0),
        pane: pane && { width: pane.clientWidth, height: pane.clientHeight, scrollHeight: pane.scrollHeight, scrollTop: pane.scrollTop },
        appClass: document.querySelector(".app")?.className,
      };
    });
    await page.goto(origin + "/?shell=desktop");
    await page.locator("[data-composer-input]").waitFor();
    await page.waitForFunction(id => !!document.querySelector(`[data-turn-id="${CSS.escape(id)}"]`), data.turns.at(-1).id);
    await page.waitForFunction(turns => turns.every(turn => {
      const mounted = document.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`);
      return !mounted || turn.results.every(id => mounted.querySelector(`.interactive-result[data-result-id="${CSS.escape(id)}"]`));
    }), data.turns.map(turn => ({id:turn.id,results:(turn._yuzunoResults || []).map(result => result.id)})));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(700);
    // Initial asynchronous mount/font/result settling can leave a fresh fixture
    // at either end. Explicitly align both conditions outside measured windows.
    await page.locator(".conversation-scroll").evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
    await page.waitForTimeout(150);
    assert.deepEqual(errors, [], "Fixture preflight must pass before sampling");
    const initialClasses = await page.locator(".app").getAttribute("class");
    assert.ok(initialClasses.includes("with-inspector") && !initialClasses.includes("rail-hidden"), "Both sidebars initially open in core.5");
    const actions = history === "switch" ? [
      { name: "long-to-short", selector: '.agent-row[data-agent-id="b"] .agent-select', target: "b", maxTurns: 2, tailTurn:short.turns.at(-1).id, railHidden: false, inspector: true },
      { name: "short-to-long", selector: '.agent-row[data-agent-id="a"] .agent-select', target: "a", maxTurns: servedLong.turns.length, tailTurn:servedLong.turns.at(-1).id, railHidden: false, inspector: true },
    ] : [
      { name: "left-close", selector: 'button[aria-label="Hide agent sidebar"]', railHidden: true, inspector: true },
      { name: "left-open", selector: 'button[aria-label="Show agent sidebar"]', railHidden: false, inspector: true },
      { name: "right-close", selector: 'button[aria-label="Toggle context panel"]', railHidden: false, inspector: false },
      { name: "right-open", selector: 'button[aria-label="Toggle context panel"]', railHidden: false, inspector: true },
    ];
    report.initialLoads ||= {};
    report.initialLoads[history] = await page.evaluate(() => t77.collect());
    for (const action of actions) {
      const name = `${history}-${action.name}`;
      const tracePath = resolve(out, `${name}.trace.json`);
      const cpuPath = resolve(out, `${name}.cpu.json`);
      await page.locator(action.selector).waitFor();
      const domBefore = await dom(), requestStart = requests.length;
      assert.ok(Math.abs(domBefore.pane.scrollHeight - domBefore.pane.height - domBefore.pane.scrollTop) < 2, "Every sample starts at latest");
      await browser.startTracing(page, { path: tracePath,
        categories: ["devtools.timeline", "v8", "blink.user_timing", "disabled-by-default-devtools.timeline"] });
      await cdp.send("Profiler.start");
      await page.evaluate(a => t77.reset(a), action);
      const before = await metrics();
      await page.locator(action.selector).click();
      await page.waitForFunction(() => !!t77.sample.readyAt);
      const readyMetrics = await metrics();
      await page.waitForTimeout(150);
      const raw = await page.evaluate(() => { performance.mark("t77.settled"); return t77.collect(); });
      const after = await metrics();
      const { profile } = await cdp.send("Profiler.stop");
      await browser.stopTracing();
      await writeFile(cpuPath, JSON.stringify(profile));
      const domAfter = await dom();
      assert.ok(Math.abs(domAfter.pane.scrollHeight - domAfter.pane.height - domAfter.pane.scrollTop) < 2, "Latest remains visible after sampled action");
      const trace = JSON.parse(await readFile(tracePath, "utf8"));
      const clickMark = trace.traceEvents.find(e => e.name === "t77.click");
      const mark = name => trace.traceEvents.find(e => e.name === name)?.ts;
      const clickAt = mark("t77.click"), readyAt = mark("t77.ready"), settledAt = mark("t77.settled"), commitAt = mark("t77.dom-committed");
      assert.ok(clickAt && commitAt && readyAt && settledAt, "All measurement marks must exist");
      const sampleRequests = requests.slice(requestStart);
      if (history !== "switch") assert.ok(!sampleRequests.some(r => /^\/api\/agents\/[ab]$/.test(r.path)), "Toggle must not fetch conversation detail");
      else assert.equal(sampleRequests.filter(r => r.path === `/api/agents/${action.target}`).length, 1);
      report.samples.push({ name, history, action, domBefore, domAfter, raw, requests: sampleRequests,
        clickToCommitMs: raw.sample.domCommittedAt - raw.sample.clickAt,
        clickToReadyMs: raw.sample.readyAt - raw.sample.clickAt,
        commitToReadyMs: raw.sample.readyAt - raw.sample.domCommittedAt,
        metrics: { ready: metricDelta(before, readyMetrics), settling: metricDelta(readyMetrics, after),
          heapBefore: before.JSHeapUsedSize, heapAfter: after.JSHeapUsedSize, nodesBefore: before.Nodes, nodesAfter: after.Nodes },
        cpu: { toReady: await summarizeCPU(profile, clickAt, readyAt), settling: await summarizeCPU(profile, readyAt, settledAt) },
        timeline: { toCommit: summarizeTrace(trace, clickAt, commitAt, clickMark),
          toReady: summarizeTrace(trace, clickAt, readyAt, clickMark), settling: summarizeTrace(trace, readyAt, settledAt, clickMark) },
        traceFile: tracePath, cpuFile: cpuPath,
      });
      console.log(JSON.stringify({ name, clickToReadyMs: report.samples.at(-1).clickToReadyMs, domBefore, domAfter,
        observerCalls: raw.observers.length, turnRectReads: raw.observers.reduce((n, r) => n + r.turnRectReads, 0), requests: sampleRequests.length }));
      await writeFile(resolve(out, "progress.json"), JSON.stringify(report, null, 2) + "\n");
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
  report.failureState = await activePage?.evaluate(() => ({ ...t77.collect(),
    appClass: document.querySelector(".app")?.className, turns: document.querySelectorAll(".turn").length,
  })).catch(() => null);
  try { await browser?.stopTracing(); } catch { /* May fail before tracing starts. */ }
  throw e;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  report.hostAfter = host(); report.cgroupAfter = cgroup();
  await writeFile(resolve(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
