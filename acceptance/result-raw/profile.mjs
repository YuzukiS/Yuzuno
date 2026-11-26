// YN-234 B: what published results' JSON costs the page, before and after it
// is made only when opened or copied. The same conversation goes to each
// build of the real app, in Chromium, with every API answered here (no Core,
// no daily window or data): 20 Turns with 3 published results each (Core's
// limit per Turn, RESULT_LIMITS.chainsPerTurn), each result's compact JSON
// just under 64,000 UTF-8 bytes (MAX_SPEC_BYTES), Chinese and English text in
// its two 100-row tables. Per run, a new browser:
//   opened   the conversation as it opens, at its latest Turns;
//   scrolled after scrolling to its first Turn and back, every result read;
//   away     another Agent's conversation shown instead;
//   back     this one again.
// At each: formatted copies made (the page's JSON.stringify with an indent of
// 2, given a spec), JSON text in the page's <pre>s, JS heap after two forced
// garbage collections (CDP), and the renderer's private memory (/proc
// smaps_rollup). Then View JSON on one result, timed from the click to the
// frame after its JSON shows, and Copy, checked against
// JSON.stringify(spec, null, 2) made here.
//   RAW_DISTS=baseline=<dist>,candidate=<dist> RAW_OUT=<dir> [RAW_REPS=5] \
//     node acceptance/result-raw/profile.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const builds = Object.fromEntries(
  (process.env.RAW_DISTS || "").split(",").filter(Boolean).map((pair) => {
    const [name, dir] = pair.split("=");
    return [name, resolve(dir)];
  }),
);
assert.ok(Object.keys(builds).length >= 1, "RAW_DISTS=name=<dist>,...");
assert.ok(process.env.RAW_OUT, "RAW_OUT=<dir>");
const out = resolve(process.env.RAW_OUT);
const reps = Number(process.env.RAW_REPS || 5);
const browserBin = process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium";
const HOST = "yn234-raw.test";
const TURNS = 20;
const PER_TURN = 3;
const MAX_SPEC_BYTES = 64_000;
await mkdir(out, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A result's spec: two 100-row tables, rows cut until its compact JSON fits. */
function makeSpec(n) {
  const columns = Array.from({ length: 8 }, (_, c) => ({ key: `c${c}`, label: c % 2 ? `指标 ${c}` : `Measure ${c}` }));
  const table = (t, rows) => ({
    type: "Table",
    props: {
      id: `t${t}`, title: t === 1 ? "各阶段对照" : "Runs by stage", selectable: true, columns,
      rows: Array.from({ length: rows }, (_, r) => ({
        id: `r${r}`,
        cells: Object.fromEntries(columns.map((col, c) => [col.key,
          c === 0 ? `第 ${r + 1} 行 · 结果 ${n}` : c === 7 ? (r * 37 + c * 11 + n) % 997 : `${t}.${r}.${c} sample ${String((r * 131 + c * 17 + n) % 10007).padStart(5, "0")}`])),
      })),
    },
  });
  const spec = (rows) => ({
    root: "result",
    elements: {
      result: { type: "Result", props: { title: `结果 ${n} · Result ${n}`, summary: `合成数据，仅用于比较内存。Synthetic data for result ${n}.` }, children: ["t1", "t2"] },
      t1: table(1, rows.t1),
      t2: table(2, rows.t2),
    },
  });
  const rows = { t1: 100, t2: 100 };
  while (Buffer.byteLength(JSON.stringify(spec(rows))) > MAX_SPEC_BYTES - 200) rows[rows.t2 > rows.t1 - 1 ? "t2" : "t1"]--;
  return spec(rows);
}

const base = { harness: "codex", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, reviewedSeq: 0, lastSeq: 10, rev: 10, status: "idle" };
const agents = [{ ...base, id: "a", name: "Mori" }, { ...base, id: "b", name: "Hana" }];
const ids = [];
const specs = new Map();
const turns = Array.from({ length: TURNS }, (_, t) => {
  const results = Array.from({ length: PER_TURN }, (_, k) => {
    const id = `r${String(t + 1).padStart(2, "0")}-${k + 1}`;
    ids.push(id);
    specs.set(id, makeSpec(t * PER_TURN + k + 1));
    return { id, chainId: id, version: 1, createdAt: "2026-11-20T00:00:00Z" };
  });
  return {
    id: `t${t + 1}`, status: "completed", _yuzunoResults: results,
    items: [
      { id: `u${t + 1}`, type: "userMessage", content: [{ type: "text", text: `Compare the runs for stage ${t + 1}.` }] },
      { id: `m${t + 1}`, type: "agentMessage", text: `Stage ${t + 1}: three results follow.` },
    ],
  };
});
const detail = (id) => id === "a"
  ? { agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns }
  : { agent: agents[1], pending: [], artifacts: [], messageReceipts: [], turns: [{ id: "tb", status: "completed", items: [
    { id: "ub", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
    { id: "mb", type: "agentMessage", text: "Nothing published here." },
  ] }] };
const compactBytes = ids.map((id) => Buffer.byteLength(JSON.stringify(specs.get(id))));
const prettyChars = ids.map((id) => JSON.stringify(specs.get(id), null, 2).length);

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

async function rendererMemory(marker) {
  const procs = new Map();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Chromium retitles its children (one string, spaces between), so read it whole.
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").join(" ");
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      procs.set(Number(entry), { pid: Number(entry), ppid: Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]), cmdline });
    } catch {
      /* gone */
    }
  }
  const roots = new Set([...procs.values()].filter((p) => p.cmdline.includes(marker)).map((p) => p.pid));
  if (!roots.size) return null;
  const under = (p) => {
    for (let at = p; at; at = procs.get(at.ppid)) if (roots.has(at.pid)) return true;
    return false;
  };
  const renderers = [...procs.values()].filter((p) => under(p) && p.cmdline.includes("--type=renderer"));
  let best = null;
  for (const p of renderers) {
    try {
      const rollup = await readFile(`/proc/${p.pid}/smaps_rollup`, "utf8");
      const kb = (name) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(rollup)?.[1] ?? NaN);
      const value = { pid: p.pid, privateKiB: kb("Private_Clean") + kb("Private_Dirty"), rssKiB: kb("Rss"), anonKiB: kb("Anonymous") };
      // The page's renderer is the largest one.
      if (!best || value.privateKiB > best.privateKiB) best = value;
    } catch {
      /* gone */
    }
  }
  return best;
}

async function run(buildName, dist) {
  const marker = `--yn234-run=${randomUUID()}`;
  const browser = await chromium.launch({ headless: true, executablePath: browserBin, args: [marker, "--js-flags=--expose-gc"] });
  const errors = [];
  const reads = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
      localStorage.setItem("yuzuno.selected.ws-raw", JSON.stringify("a"));
      window.EventSource = class {
        constructor() { this.readyState = 0; window.__stream = this; }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
      window.__pretty = 0;
      const stringify = JSON.stringify;
      JSON.stringify = function (value, replacer, space) {
        if (space === 2 && value && typeof value === "object" && "root" in value && "elements" in value) window.__pretty++;
        return stringify.call(this, value, replacer, space);
      };
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => void window.__copied.push(text), write: async () => { throw new Error("text only"); } } });
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (url.host !== HOST) return route.abort();
      if (request.method() !== "GET") return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
      const result = path.match(/^\/api\/agents\/a\/results\/([\w-]+)$/);
      if (result) {
        reads.push(result[1]);
        const spec = specs.get(result[1]);
        if (!spec) return route.fulfill({ status: 404, json: { error: "No such result", code: "result_not_found" } });
        return route.fulfill({ json: { id: result[1], agentId: "a", chainId: result[1], version: 1, turnId: "t", schemaVersion: 1, spec, defaults: [] } });
      }
      if (/^\/api\/agents\/[^/]+\/codex\/usage$/.test(path)) return route.fulfill({ status: 404, json: { error: "No usage" } });
      const agent = path.match(/^\/api\/agents\/([ab])$/);
      if (agent) return route.fulfill({ json: detail(agent[1]) });
      const json = {
        "/api/workspace": { workspace: { id: "ws-raw" }, agents, projects: [], runtime: { connected: true }, defaultCwd: "/w" },
        "/api/home": { generatedAt: new Date(0).toISOString(), order: [], needsYou: [], projects: [] },
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
        "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null }, "/api/jobs/live": { agents: {} },
        "/api/ci": { runs: [], subscriptions: [], hasMore: false, nextBefore: null }, "/api/ci/live": { agents: {} },
        "/api/waits/live": { agents: {} }, "/api/reviews": { reviews: [], hasMore: false, nextBefore: null },
        "/api/machines": { machines: [] }, "/api/machine-live": { machines: [] }, "/api/merge-queue": { entries: [] },
      }[path];
      if (json) return route.fulfill({ json });
      if (path.startsWith("/api/")) return route.fulfill({ json: {} });
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
    const cdp = await context.newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await page.goto(`http://${HOST}/`);
    await page.locator(".turn-results .interactive-result .result-content").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const measure = async (phase) => {
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(200);
      await cdp.send("HeapProfiler.collectGarbage");
      const heap = await cdp.send("Runtime.getHeapUsage");
      const shown = await page.evaluate(() => ({
        pretty: window.__pretty,
        cards: document.querySelectorAll(".turn-results .interactive-result").length,
        preChars: [...document.querySelectorAll(".turn-results pre")].reduce((n, pre) => n + pre.textContent.length, 0),
        pres: document.querySelectorAll(".turn-results pre").length,
      }));
      return { phase, reads: reads.length, distinctReads: new Set(reads).size, heapUsedMiB: heap.usedSize / 2 ** 20, renderer: await rendererMemory(marker), ...shown };
    };
    const phases = [await measure("opened")];
    // To the first Turn and back, each result read as its Turn is drawn. A
    // Turn here is some 27,000 px tall and the window draws whole Turns near
    // the view (ConversationWindow.tsx), so 4,000 px steps skip none.
    const scrollBy = async (direction) => {
      for (let step = 0; step < 1000; step++) {
        const at = await page.evaluate((direction) => {
          const pane = [...document.querySelectorAll("*")].find((el) => el.querySelector?.("[data-window]") && el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
          if (!pane) return null;
          pane.scrollTop += direction * 4000;
          return { top: pane.scrollTop, end: pane.scrollHeight - pane.clientHeight };
        }, direction);
        if (!at) throw new Error("no conversation pane");
        await page.waitForTimeout(150);
        if (direction < 0 ? at.top <= 0 : at.top >= at.end - 2) break;
      }
    };
    await scrollBy(-1);
    try {
      await page.waitForFunction(() => document.querySelector('.turn-results .interactive-result[data-result-id="r01-1"] .result-content'), null, { timeout: 30_000 });
    } catch (error) {
      const seen = await page.evaluate(() => {
        const pane = [...document.querySelectorAll("*")].find((el) => el.querySelector?.("[data-window]") && el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY));
        return {
          scroll: pane && { top: pane.scrollTop, height: pane.scrollHeight, client: pane.clientHeight },
          turns: [...document.querySelectorAll("[data-turn-id]")].map((el) => el.dataset.turnId).slice(0, 8),
          cards: [...document.querySelectorAll(".turn-results > *")].slice(0, 6).map((el) => `${el.className}:${el.dataset.resultId ?? el.dataset.resultState ?? ""}`),
          first: document.querySelector('.turn-results')?.textContent.slice(0, 200),
        };
      });
      throw new Error(`r01-1 not drawn: ${JSON.stringify(seen)}; reads ${reads.length} (${new Set(reads).size}); errors ${errors.join(" | ")}`);
    }
    await scrollBy(1);
    await page.waitForTimeout(1_000);
    phases.push(await measure("scrolled"));
    await page.locator('.agent-row[data-agent-id="b"] .agent-select').click();
    await page.locator('[data-item-id="mb"]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    phases.push(await measure("away"));
    await page.locator('.agent-row[data-agent-id="a"] .agent-select').click();
    await page.locator(".turn-results .interactive-result .result-content").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_000);
    phases.push(await measure("back"));

    // View JSON on the last result drawn (the conversation reopens where it
    // was left, T-166), then Copy.
    const opened = await page.evaluate(async () => {
      const card = [...document.querySelectorAll(".turn-results .interactive-result[data-result-id]")].filter((el) => el.querySelector(".result-content")).at(-1);
      const id = card.dataset.resultId;
      const details = card.querySelector(".result-original");
      card.scrollIntoView({ block: "center" });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const before = window.__pretty;
      const start = performance.now();
      details.querySelector("summary").click();
      const shownAt = await new Promise((done) => {
        const check = () => {
          const pre = details.querySelector("pre");
          if (details.open && pre && pre.offsetHeight > 0 && pre.textContent.length > 0) done(performance.now());
          else requestAnimationFrame(check);
        };
        check();
      });
      await new Promise((r) => requestAnimationFrame(r));
      const frame = performance.now();
      return { id, shownMs: shownAt - start, frameMs: frame - start, made: window.__pretty - before, preChars: details.querySelector("pre").textContent.length };
    });
    const target = opened.id;
    await page.locator(`.turn-results .interactive-result[data-result-id="${target}"] .result-original button.copy-button`).click();
    await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 10_000 });
    const copied = await page.evaluate(() => window.__copied.at(-1));
    const expected = JSON.stringify(specs.get(target), null, 2);
    return {
      build: buildName, phases, open: opened,
      copy: { equal: copied === expected, chars: copied.length, sha256: sha256(copied), expectedSha256: sha256(expected) },
      errors,
    };
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
async function distInfo(dir) {
  const index = await readFile(join(dir, "index.html"));
  const digest = JSON.parse(await readFile(join(dir, "source-digest.json"), "utf8"));
  return { dir, indexSha256: sha256(index), sourceDigest: digest.sha256 };
}
const probe = await chromium.launch({ headless: true, executablePath: browserBin });
const report = {
  task: "YN-234 B",
  started: new Date().toISOString(),
  environment: { platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, node: process.version,
    browser: browserBin, browserVersion: probe.version(), viewport: "1440x1000", reducedMotion: true, reps, jobCpuMillis: process.env.YUZUNO_JOB_CPU_MILLIS ?? null },
  workload: { turns: TURNS, perTurn: PER_TURN, results: ids.length,
    compactBytes: { min: Math.min(...compactBytes), max: Math.max(...compactBytes), total: compactBytes.reduce((a, b) => a + b, 0) },
    prettyChars: { min: Math.min(...prettyChars), max: Math.max(...prettyChars), total: prettyChars.reduce((a, b) => a + b, 0) } },
  builds: Object.fromEntries(await Promise.all(Object.entries(builds).map(async ([name, dir]) => [name, await distInfo(dir)]))),
  runs: [],
};
await probe.close();
const save = () => writeFile(join(out, "result-raw.json"), `${JSON.stringify(report, null, 2)}\n`);
const names = Object.keys(builds);
for (let rep = 0; rep < reps; rep++)
  for (const name of rep % 2 ? [...names].reverse() : names) {
    const result = await run(name, builds[name]);
    result.rep = rep;
    report.runs.push(result);
    const at = Object.fromEntries(result.phases.map((p) => [p.phase, p]));
    console.log(`rep ${rep} ${name}: pretty ${result.phases.map((p) => p.pretty).join("/")}, heap ${result.phases.map((p) => p.heapUsedMiB.toFixed(1)).join("/")} MiB, private ${result.phases.map((p) => ((p.renderer?.privateKiB ?? NaN) / 1024).toFixed(1)).join("/")} MiB, open ${result.open.frameMs.toFixed(1)} ms, copy ${result.copy.equal}, reads ${at.scrolled.distinctReads}`);
    await save();
  }
report.summary = [];
for (const name of names) {
  const runs = report.runs.filter((r) => r.build === name);
  const row = { build: name, phases: {} };
  for (const phase of ["opened", "scrolled", "away", "back"]) {
    const of = (pick) => {
      const values = runs.map((r) => pick(r.phases.find((p) => p.phase === phase))).filter((v) => Number.isFinite(v));
      return { median: quantile(values, 0.5), min: Math.min(...values), max: Math.max(...values), n: values.length };
    };
    row.phases[phase] = {
      pretty: of((p) => p.pretty), preChars: of((p) => p.preChars), cards: of((p) => p.cards),
      heapUsedMiB: of((p) => p.heapUsedMiB), rendererPrivateMiB: of((p) => (p.renderer?.privateKiB ?? NaN) / 1024),
    };
  }
  const opens = runs.map((r) => r.open.frameMs);
  row.openFrameMs = { median: quantile(opens, 0.5), min: Math.min(...opens), max: Math.max(...opens), n: opens.length };
  row.copyEqual = runs.every((r) => r.copy.equal);
  row.errors = runs.flatMap((r) => r.errors);
  report.summary.push(row);
}
report.finished = new Date().toISOString();
await save();
for (const s of report.summary) {
  const p = s.phases;
  console.log(`${s.build.padEnd(10)} pretty opened ${p.opened.pretty.median} scrolled ${p.scrolled.pretty.median} | pre chars scrolled ${p.scrolled.preChars.median} | heap scrolled ${p.scrolled.heapUsedMiB.median?.toFixed(1)} [${p.scrolled.heapUsedMiB.min?.toFixed(1)}–${p.scrolled.heapUsedMiB.max?.toFixed(1)}] away ${p.away.heapUsedMiB.median?.toFixed(1)} MiB | private scrolled ${p.scrolled.rendererPrivateMiB.median?.toFixed(1)} [${p.scrolled.rendererPrivateMiB.min?.toFixed(1)}–${p.scrolled.rendererPrivateMiB.max?.toFixed(1)}] away ${p.away.rendererPrivateMiB.median?.toFixed(1)} MiB | open ${s.openFrameMs.median?.toFixed(1)} ms | copy equal ${s.copyEqual}`);
}
