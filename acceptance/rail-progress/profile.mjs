// YN-234 A: what streamed progress costs the rail, before and after rows that
// are left alone when another Agent's progress arrives. The same replay of
// agent.progress events goes to each build of the real app, in Chromium,
// with every API answered here (no Core, no daily window or data):
//   - 1 row or 50 rows in two Projects, the rail beside a Project's page;
//   - quiet (no events), one Agent streaming, or five at once, each Agent's
//     entry 250–310 ms after its last, as Core sends at most every 250 ms
//     (core/src/events.rs), with the same fixed jitter for every build;
//   - per run: the rows React drew (a probe pass, through React's DevTools
//     hook), the renderer's main-thread time (CDP Performance metrics), the
//     renderer and GPU processes' CPU time (/proc), and how long a progress
//     entry took to show in its row (MutationObserver, then the next frame).
// The probe pass is separate from the timed runs: walking the fiber tree on
// each commit costs time of its own.
//   RAIL_DISTS=baseline=<dist>,candidate=<dist> RAIL_OUT=<dir> [RAIL_REPS=5] [RAIL_SECONDS=10] \
//     node acceptance/rail-progress/profile.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const builds = Object.fromEntries(
  (process.env.RAIL_DISTS || "").split(",").filter(Boolean).map((pair) => {
    const [name, dir] = pair.split("=");
    return [name, resolve(dir)];
  }),
);
assert.ok(Object.keys(builds).length >= 1, "RAIL_DISTS=name=<dist>,...");
assert.ok(process.env.RAIL_OUT, "RAIL_OUT=<dir>");
const out = resolve(process.env.RAIL_OUT);
const reps = Number(process.env.RAIL_REPS || 5);
const seconds = Number(process.env.RAIL_SECONDS || 10);
const browserBin = process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium";
const HOST = "yn234-rail.test";
const EVERY_MS = 250;
await mkdir(out, { recursive: true });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function distInfo(dir) {
  const index = await readFile(join(dir, "index.html"));
  const digest = JSON.parse(await readFile(join(dir, "source-digest.json"), "utf8"));
  const assets = (await readdir(join(dir, "assets"))).filter((f) => f.endsWith(".js")).sort();
  return { dir, indexSha256: sha256(index), sourceDigest: digest.sha256, jsFiles: assets.length };
}

const scenarios = [
  { name: "1-quiet", rows: 1, streaming: 0 },
  { name: "1-one", rows: 1, streaming: 1 },
  { name: "50-quiet", rows: 50, streaming: 0 },
  { name: "50-one", rows: 50, streaming: 1 },
  { name: "50-five", rows: 50, streaming: 5 },
];

const nameOf = (id) => `Agent ${id.slice(1)}`;
function fixture(rows) {
  const base = { harness: "codex", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "",
    unreadCount: 0, pendingCount: 0, reviewedSeq: 0, connectionState: "connected", lastSeq: 10, rev: 10 };
  const ids = Array.from({ length: rows }, (_, i) => `a${String(i + 1).padStart(2, "0")}`);
  const agents = ids.map((id, i) => ({
    ...base, id, name: nameOf(id), status: i % 5 === 0 ? "working" : "idle",
    projectId: i < Math.ceil(rows / 2) ? "p1" : "p2",
    workSummary: { text: `${nameOf(id)} is on step 0.`, kind: "progress", source: "agent", turnId: `t-${id}`, itemId: `m-${id}` },
  }));
  const projects = [
    { id: "p1", name: "Field notes", defaultDirs: {}, createdAt: "", updatedAt: "" },
    { id: "p2", name: "Site", defaultDirs: {}, createdAt: "", updatedAt: "" },
  ].filter((p) => agents.some((a) => a.projectId === p.id));
  const panel = (project) => ({
    project: { id: project.id, name: project.name },
    agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: agents.filter((a) => a.projectId === project.id).length },
    contentEditors: { version: 1, editorAgentIds: [] },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 1, history: [], sections: [] },
  });
  const home = { generatedAt: new Date(0).toISOString(), order: projects.map((p) => p.id), needsYou: [], projects: projects.map(panel) };
  return { ids, agents, projects, home };
}
// The streaming Agents: spread over both Projects.
const streamingIds = (ids, count) => (count === 1 ? [ids[Math.min(6, ids.length - 1)]] : ["a02", "a13", "a26", "a39", "a50"].slice(0, count));

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };
const empty = { jobs: [], liveJobs: [], hasMore: false, nextBefore: null };

/** Every process under the browser this run started, by role, and its CPU time in seconds. */
async function processCpu(marker) {
  const tick = 100; // Linux USER_HZ
  const procs = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Chromium retitles its children (one string, spaces between), so read it whole.
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").join(" ");
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      procs.set(Number(entry), { pid: Number(entry), ppid: Number(fields[1]), cpu: (Number(fields[11]) + Number(fields[12])) / tick, cmdline });
    } catch {
      /* gone */
    }
  }
  // The browser this run started (and a launcher before it, if any), and everything under it.
  const roots = new Set([...procs.values()].filter((p) => p.cmdline.includes(marker)).map((p) => p.pid));
  if (!roots.size) return null;
  const under = (p) => {
    for (let at = p; at; at = procs.get(at.ppid)) if (roots.has(at.pid)) return true;
    return false;
  };
  const byRole = {};
  for (const p of procs.values()) {
    if (!under(p)) continue;
    const type = /--type=([\w-]+)/.exec(p.cmdline)?.[1] ?? "browser";
    const role = type === "utility" ? "utility" : type;
    byRole[role] = (byRole[role] || 0) + p.cpu;
  }
  return byRole;
}

async function run(buildName, dist, scenario, { probe }) {
  const { ids, agents, projects, home } = fixture(scenario.rows);
  const streaming = scenario.streaming ? streamingIds(ids, scenario.streaming) : [];
  const marker = `--yn234-run=${randomUUID()}`;
  const browser = await chromium.launch({ headless: true, executablePath: browserBin, args: [marker] });
  const errors = [];
  const emptyAnswered = new Set();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.addInitScript(({ agents, probe }) => {
      if (window !== window.top) return;
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
      window.__agents = agents;
      window.EventSource = class {
        constructor(url) {
          this.url = url;
          this.readyState = 0;
          window.__stream = this;
        }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
      if (probe) {
        // See web/tools/rail-rows-ui.test.mjs: the rows React drew, by commit.
        const last = new Map();
        window.__drawn = [];
        const isRow = (f) => (f.tag === 0 || f.tag === 15) && typeof f.memoizedProps?.onSelect === "function"
          && typeof f.memoizedProps.statusLabel === "string" && typeof f.memoizedProps.agent?.id === "string";
        const walk = (start) => {
          const found = [];
          const stack = [start];
          while (stack.length) {
            const f = stack.pop();
            if (f.sibling) stack.push(f.sibling);
            if (isRow(f)) {
              const id = f.memoizedProps.agent.id;
              if (f !== last.get(id) && (f.flags & 1) === 1) found.push(id);
              last.set(id, f);
              continue;
            }
            if (f.child) stack.push(f.child);
          }
          return found;
        };
        window.__commits = 0;
        window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
          supportsFiber: true, isDisabled: false, renderers: new Map(),
          inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
          onScheduleFiberRoot() {},
          onCommitFiberRoot(_id, root) { window.__commits++; const rows = walk(root.current); if (rows.length) window.__drawn.push(...rows); },
          onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {}, checkDCE() {},
        };
      }
      // The replay: each streaming Agent's entry every `every` ms for `ms`,
      // spread over the interval; when each entry's text first shows in its
      // row, and the frame after.
      window.__replay = ({ ids, every, ms }) => new Promise((done) => {
        const send = (data) => window.__stream.onmessage?.({ data: JSON.stringify(data), lastEventId: "" });
        const sent = new Map(ids.map((id) => [id, []]));
        const shown = [];
        const superseded = [];
        const rev = new Map(ids.map((id) => [id, window.__agents.find((a) => a.id === id).rev]));
        const steps = new Map(ids.map((id) => [id, 0]));
        const list = document.querySelector(".agent-list");
        const observer = new MutationObserver(() => {
          const at = performance.now();
          for (const id of ids) {
            const waiting = sent.get(id);
            if (!waiting.length) continue;
            const row = list.querySelector(`.agent-row[data-agent-id="${id}"]`);
            const match = row && /is on step (\d+)\./.exec(row.textContent);
            if (!match) continue;
            const n = Number(match[1]);
            const due = waiting.filter((s) => s.n <= n);
            if (!due.length) continue;
            sent.set(id, waiting.filter((s) => s.n > n));
            for (const s of due) {
              if (s.n < n) superseded.push(s.n);
              else {
                const entry = { id, n, ms: at - s.at };
                shown.push(entry);
                requestAnimationFrame(() => (entry.frameMs = performance.now() - s.at));
              }
            }
          }
        });
        observer.observe(list, { subtree: true, childList: true, characterData: true });
        const started = performance.now();
        const timers = [];
        ids.forEach((id, index) => {
          const tick = () => {
            if (performance.now() - started >= ms) return;
            const n = steps.get(id) + 1;
            steps.set(id, n);
            const r = rev.get(id) + 1;
            rev.set(id, r);
            const { projectId, ...listed } = window.__agents.find((a) => a.id === id);
            const agent = { ...listed, rev: r, lastSeq: r, status: "working",
              workSummary: { text: `${listed.name} is on step ${n}.`, kind: "progress", source: "agent", turnId: `t-${id}`, itemId: `m-${id}` } };
            sent.get(id).push({ n, at: performance.now() });
            send({ type: "agent.progress", agentId: id, rev: r, lastSeq: r, agent });
            // Core sends an entry at most every 250 ms; when, after that, varies.
            // The same fixed jitter (0–60 ms) for every build, so arrivals do
            // not line up with the batch's own 250 ms wait.
            timers.push(setTimeout(tick, every + ((n * 7919 + index * 104729) % 61)));
          };
          timers.push(setTimeout(tick, (every * index) / Math.max(1, ids.length)));
        });
        setTimeout(() => {
          timers.forEach(clearTimeout);
          // The last batch: up to 250 ms and a frame.
          setTimeout(() => {
            observer.disconnect();
            const left = [...sent.values()].reduce((n, list) => n + list.length, 0);
            done({ sent: [...steps.values()].reduce((a, b) => a + b, 0), shown, superseded: superseded.length, unshown: left });
          }, 700);
        }, ms);
      });
    }, { agents, probe });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (url.host !== HOST) return route.abort();
      if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
      // No Codex plan usage here, as from a Core that has none to tell.
      if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path)) return route.fulfill({ status: 404, json: { error: "No usage" } });
      const detail = path.match(/^\/api\/agents\/(a\d\d)$/);
      if (detail) {
        const agent = agents.find((a) => a.id === detail[1]);
        return route.fulfill({ json: { agent, pending: [], artifacts: [], messageReceipts: [], turns: [] } });
      }
      const json = {
        "/api/workspace": { workspace: { id: "ws-rail" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
        "/api/home": home,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
        "/api/jobs": empty, "/api/jobs/live": { agents: {} }, "/api/ci": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
        "/api/ci/live": { agents: {} }, "/api/waits/live": { agents: {} }, "/api/reviews": { reviews: [], hasMore: false, nextBefore: null },
        "/api/machines": { machines: [] }, "/api/machine-live": { machines: [] }, "/api/merge-queue": { entries: [] },
        "/api/updates": { channel: "unmanaged" },
      }[path];
      if (json) return route.fulfill({ json });
      if (/^\/api\/projects\/[^/]+\/requests$/.test(path)) return route.fulfill({ json: { requests: [], hasMore: false } });
      if (path.startsWith("/api/")) {
        emptyAnswered.add(path);
        return route.fulfill({ json: {} });
      }
      const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
      assert.ok(file.startsWith(dist + "/"));
      try {
        await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
      } catch {
        await route.fulfill({ status: 404, body: "" });
      }
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    // The rail beside a Project's page, opened as its Home link opens it
    // (deep-link.ts): one Project has no heading in the rail to click.
    await page.goto(`http://${HOST}/#/home?w=ws-rail&p=p1`);
    await page.waitForFunction((n) => document.querySelectorAll(".agent-list .agent-row").length === n, scenario.rows, { timeout: 30_000 });
    await page.evaluate(() => {
      window.__stream.readyState = 1;
      window.__stream.onopen?.({});
      window.__stream.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "open" }), lastEventId: "" });
    });
    try {
      await page.locator('[data-project-home="p1"]').waitFor({ timeout: 30_000 });
    } catch (error) {
      const shown = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");
      throw new Error(`no project page (${error.message.split("\n")[0]}); errors: ${errors.join(" | ")}; answered {}: ${[...emptyAnswered].join(" ")}; shown: ${shown}`);
    }
    // Settled: reads after the reset, the page's own arrival.
    await page.waitForTimeout(2_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    if (probe) await page.evaluate(() => { window.__drawn = []; window.__commits = 0; });
    const before = { m: await metric(), cpu: await processCpu(marker), wall: performance.now() };
    const replay = await page.evaluate((args) => window.__replay(args), { ids: streaming, every: EVERY_MS, ms: seconds * 1000 });
    const after = { m: await metric(), cpu: await processCpu(marker), wall: performance.now() };
    const result = {
      build: buildName, scenario: scenario.name, rows: scenario.rows, streaming,
      wallSeconds: (after.wall - before.wall) / 1000,
      sent: replay.sent, shownEntries: replay.shown.length, superseded: replay.superseded, unshown: replay.unshown,
      latencyMs: replay.shown.map((s) => s.ms), frameMs: replay.shown.map((s) => s.frameMs).filter((v) => v != null),
      mainThread: Object.fromEntries(["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map((k) => [k, after.m[k] - before.m[k]])),
      processCpu: before.cpu && after.cpu ? Object.fromEntries(Object.keys(after.cpu).map((k) => [k, after.cpu[k] - (before.cpu[k] || 0)])) : null,
      errors,
      emptyAnswered: [...emptyAnswered],
    };
    if (probe) {
      const { drawn, commits } = await page.evaluate(() => ({ drawn: window.__drawn, commits: window.__commits }));
      const set = new Set(streaming);
      result.commits = commits;
      result.rowDraws = { changed: drawn.filter((id) => set.has(id)).length, unrelated: drawn.filter((id) => !set.has(id)).length,
        unrelatedRows: new Set(drawn.filter((id) => !set.has(id))).size };
    }
    return result;
  } finally {
    await browser.close();
  }
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
};
const report = {
  task: "YN-234 A",
  started: new Date().toISOString(),
  environment: {
    platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    node: process.version, browser: browserBin, seconds, reps, everyMs: EVERY_MS, viewport: "1440x1000", reducedMotion: true,
    jobCpuMillis: process.env.YUZUNO_JOB_CPU_MILLIS ?? null,
  },
  builds: Object.fromEntries(await Promise.all(Object.entries(builds).map(async ([name, dir]) => [name, await distInfo(dir)]))),
  probe: [],
  runs: [],
};
const save = () => writeFile(join(out, "rail-progress.json"), `${JSON.stringify(report, null, 2)}\n`);
let browserVersion = null;
{
  const b = await chromium.launch({ headless: true, executablePath: browserBin });
  browserVersion = b.version();
  await b.close();
}
report.environment.browserVersion = browserVersion;

// The probe pass: one run per build and scenario (the draws are counts, not times).
for (const scenario of scenarios)
  for (const [name, dir] of Object.entries(builds)) {
    const result = await run(name, dir, scenario, { probe: true });
    report.probe.push(result);
    console.log(`probe ${name} ${scenario.name}: draws changed ${result.rowDraws.changed}, unrelated ${result.rowDraws.unrelated} (${result.rowDraws.unrelatedRows} rows), commits ${result.commits}`);
    await save();
  }
// The timed runs: builds alternate, one order then the other (ABBA), each run a new browser.
const names = Object.keys(builds);
for (let rep = 0; rep < reps; rep++)
  for (const scenario of scenarios)
    for (const name of rep % 2 ? [...names].reverse() : names) {
      const result = await run(name, builds[name], scenario, { probe: false });
      result.rep = rep;
      report.runs.push(result);
      const lat = quantile(result.latencyMs, 0.5);
      console.log(`rep ${rep} ${name} ${scenario.name}: main ${(result.mainThread.TaskDuration * 1000).toFixed(0)} ms, renderer ${result.processCpu?.renderer?.toFixed(2)} s, p50 ${lat?.toFixed(0) ?? "-"} ms`);
      await save();
    }

// Summary per scenario and build: medians and ranges over the reps.
report.summary = [];
for (const scenario of scenarios)
  for (const name of names) {
    const runs = report.runs.filter((r) => r.scenario === scenario.name && r.build === name);
    const probe = report.probe.find((r) => r.scenario === scenario.name && r.build === name);
    const per = (pick) => {
      const values = runs.map(pick).filter((v) => v != null);
      return { median: quantile(values, 0.5), min: Math.min(...values), max: Math.max(...values), n: values.length };
    };
    const latencies = runs.flatMap((r) => r.latencyMs);
    const frames = runs.flatMap((r) => r.frameMs);
    report.summary.push({
      scenario: scenario.name, build: name,
      rowDraws: probe.rowDraws, commits: probe.commits,
      mainThreadMsPerSecond: per((r) => (r.mainThread.TaskDuration * 1000) / r.wallSeconds),
      scriptMsPerSecond: per((r) => (r.mainThread.ScriptDuration * 1000) / r.wallSeconds),
      rendererCpuPct: per((r) => (r.processCpu?.renderer != null ? (100 * r.processCpu.renderer) / r.wallSeconds : null)),
      gpuCpuPct: per((r) => (r.processCpu?.["gpu-process"] != null ? (100 * r.processCpu["gpu-process"]) / r.wallSeconds : null)),
      latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), n: latencies.length },
      frameMs: { p50: quantile(frames, 0.5), p95: quantile(frames, 0.95), n: frames.length },
      errors: runs.flatMap((r) => r.errors),
    });
  }
report.finished = new Date().toISOString();
await save();
for (const s of report.summary)
  console.log(`${s.scenario.padEnd(9)} ${s.build.padEnd(10)} draws unrelated ${String(s.rowDraws.unrelated).padStart(5)} | main ${s.mainThreadMsPerSecond.median?.toFixed(1)} ms/s [${s.mainThreadMsPerSecond.min?.toFixed(1)}–${s.mainThreadMsPerSecond.max?.toFixed(1)}] | renderer ${s.rendererCpuPct.median?.toFixed(2)}% [${s.rendererCpuPct.min?.toFixed(2)}–${s.rendererCpuPct.max?.toFixed(2)}] | latency p50 ${s.latencyMs.p50?.toFixed(0) ?? "-"} p95 ${s.latencyMs.p95?.toFixed(0) ?? "-"} ms`);
