#!/usr/bin/env node
// perf-sse acceptance. Two Agents stream at once on an isolated Core with the
// scripted runtimes from acceptance/turn-cost (Codex A, Claude B) while
// Chromium shows one of them. Everything the GUI requests goes through a small
// proxy here, which counts requests and bytes, reads the event stream, and can
// cut the live connection. Reports the GUI's detail reads, its main-thread
// time, Core CPU, whether the streamed reply on screen was always a correct
// prefix (nothing lost, nothing twice), and how the cut connection came back.
//
//   node acceptance/perf-sse/browser.mjs --label cand-codex --core BIN --web DIST --show codex
//
// Data and results stay under target/perf-sse/runs/<label> (never 4317).
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdir, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]);
    return pairs;
  }, []),
);
const label = args.label || "run";
const core = resolve(args.core || `${ROOT}/target/debug/yuzuno-workspace`);
const web = resolve(args.web || `${ROOT}/web/dist`);
const port = Number(args.port || 4451);
const proxyPort = Number(args["proxy-port"] || 4452);
const show = args.show || "codex";
const warmup = args.warmup || "40:150";
const [deltas, outputs, approvals, rate] = (args.run || "600:60:0:30").split(":").map(Number);
const killAt = args["kill-at"] === undefined ? 0.4 : Number(args["kill-at"]);
const run = `${ROOT}/target/perf-sse/runs/${label}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 100; // USER_HZ on this host

if (port === 4317 || proxyPort === 4317) throw new Error("never 4317");
await rm(run, { recursive: true, force: true });
for (const sub of ["data", "task", "timeline"]) await mkdir(`${run}/${sub}`, { recursive: true });

// ---- Core with scripted runtimes -------------------------------------------
const coreLog = [];
const coreProcess = spawn(core, ["--port", String(port), "--data-dir", `${run}/data`, "--web-dir", web,
  "--cwd", `${run}/task`, "--codex", `${ROOT}/acceptance/turn-cost/fake_codex.py`], {
  env: { ...process.env, YUZUNO_NODE: "python3", YUZUNO_CLAUDE_BRIDGE: `${ROOT}/acceptance/turn-cost/fake_claude.py`,
    T9_TIMELINE: `${run}/timeline` },
  stdio: ["ignore", "pipe", "pipe"],
});
// Never leave the isolated Core running, whatever happens here.
process.on("exit", () => coreProcess.kill("SIGKILL"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
process.on("unhandledRejection", (error) => { console.error(error); process.exit(1); });
coreProcess.stdout.on("data", (d) => coreLog.push(String(d)));
coreProcess.stderr.on("data", (d) => coreLog.push(String(d)));
const direct = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};
for (let i = 0; ; i++) {
  try { await direct("GET", "/api/health"); break; } catch (e) { if (i > 100) throw e; await sleep(100); }
}
const cpu = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return (Number(stat[11]) + Number(stat[12])) / TICK;
  } catch { return 0; }
};

const agents = {};
agents.codex = (await direct("POST", "/api/agents", { name: "codex-a", cwd: `${run}/task`, harness: "codex", model: "bench-model" })).id;
agents.claude = (await direct("POST", "/api/agents", { name: "claude-b", cwd: `${run}/task`, harness: "claude", model: "bench" })).id;
await direct("POST", `/api/agents/${agents.claude}/reconnect`);
const listed = async () => Object.fromEntries((await direct("GET", "/api/workspace")).agents.map((a) => [a.id, a]));
for (let i = 0; ; i++) {
  const all = await listed();
  if (Object.values(agents).every((id) => all[id].connectionState === "connected")) break;
  if (i > 100) throw new Error("Agents did not connect");
  await sleep(200);
}
const send = (which, text) => which === "codex"
  ? direct("POST", `/api/agents/${agents.codex}/messages`, { clientMessageId: crypto.randomUUID(), text })
  : direct("POST", `/api/agents/${agents.claude}/turns`, { text });
// Completed Turns per Agent, from the journal (read-only, like bench.py).
const completions = () => new Promise((resolve, reject) => {
  const py = spawn("python3", ["-c", `import sqlite3,json
c=sqlite3.connect('file:${run}/data/workspace.sqlite?mode=ro', uri=True, timeout=30)
print(json.dumps(dict(c.execute("SELECT agent_id, COUNT(*) FROM journal WHERE kind='turn/completed' GROUP BY agent_id").fetchall())))`]);
  let out = "";
  py.stdout.on("data", (d) => { out += d; });
  py.on("exit", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error("journal read failed")));
});
async function turn(text, timeoutMs) {
  const before = await completions();
  await Promise.all(["codex", "claude"].map((w) => send(w, text)));
  const started = Date.now();
  for (;;) {
    const done = await completions();
    if (Object.values(agents).every((id) => (done[id] || 0) > (before[id] || 0))) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`Turn did not finish: ${JSON.stringify(done)}`);
    await sleep(250);
  }
}
const warmupMs = await turn(`warmup:${warmup}`, 600_000);

// ---- The proxy the GUI talks to ----------------------------------------------
const stats = { requests: [], streams: [], reviews: [], seen: {} };
const live = new Set();
const noteSeq = (agentId, seq, at) => {
  if (!agentId || !Number.isSafeInteger(seq)) return;
  stats.seen[agentId] = stats.seen[agentId] || [];
  stats.seen[agentId].push([at, seq]);
};
const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
  const path = req.url.split("?")[0];
  const record = { method: req.method, path, url: req.url, at: Date.now(), bytes: 0, status: 0,
    lastEventId: req.headers["last-event-id"] || null };
  const isStream = path === "/api/events";
  let requestBody = "";
  const upstream = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, (up) => {
    record.status = up.statusCode;
    res.writeHead(up.statusCode, up.headers);
    let head = "";
    let readSeq = null;
    let buffer = "";
    up.on("data", (chunk) => {
      record.bytes += chunk.length;
      if (isStream) {
        buffer += chunk.toString("utf8");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const frame = { at: Date.now(), id: null, event: null, data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) frame.id = line.slice(3).trim();
            else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.data += line.slice(5).replace(/^ /, "");
          }
          if (!frame.data) continue;
          let data = null;
          try { data = JSON.parse(frame.data); } catch { /* old notices are JSON too */ }
          record.frames = record.frames || [];
          record.frames.push({ at: frame.at, id: frame.id, event: frame.event, type: data?.type || null,
            agentId: data?.agentId || null, bytes: frame.data.length });
        }
      } else if (readSeq === null && head.length < 4 << 20) {
        // The Agent's own lastSeq comes first in a detail (after its last
        // message, which can be long).
        head += chunk.toString("utf8");
        const seq = head.match(/"lastSeq":(\d+)[,}]/);
        if (seq) readSeq = Number(seq[1]);
      }
      res.write(chunk);
    });
    up.on("end", () => {
      record.ms = Date.now() - record.at;
      // A detail read holds every change up to its lastSeq; a read receipt
      // must never go past what the GUI has read.
      const agentRead = path.match(/^\/api\/agents\/([^/]+)$/);
      if (agentRead && req.method === "GET" && readSeq !== null) noteSeq(agentRead[1], readSeq, Date.now());
      res.end();
    });
    up.on("error", () => res.destroy());
  });
  upstream.on("error", () => res.destroy());
  req.on("data", (chunk) => { requestBody += chunk; upstream.write(chunk); });
  req.on("end", () => {
    upstream.end();
    const review = path.match(/^\/api\/agents\/([^/]+)\/review$/);
    if (review) {
      const seen = (stats.seen[review[1]] || []).filter(([at]) => at <= Date.now()).map(([, s]) => s);
      stats.reviews.push({ at: Date.now(), agentId: review[1], throughSeq: JSON.parse(requestBody || "{}").throughSeq,
        maxReceived: seen.length ? Math.max(...seen) : null });
    }
  });
  if (isStream) {
    const entry = { record, req, res, upstream };
    live.add(entry);
    res.on("close", () => live.delete(entry));
    stats.streams.push(record);
  } else stats.requests.push(record);
});
await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));
const cut = () => {
  const cutAt = Date.now();
  for (const { upstream, res } of live) { upstream.destroy(); res.socket?.destroy(); }
  return cutAt;
};

// ---- Chromium showing one Agent -------------------------------------------------
const chromiumBefore = new Set((await readdir("/proc")).filter((p) => /^\d+$/.test(p)));
const browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true });
const ours = async () => (await readdir("/proc")).filter((p) => /^\d+$/.test(p) && !chromiumBefore.has(p)).filter((p) => {
  try { return readFileSync(`/proc/${p}/cmdline`, "utf8").includes("chromium"); } catch { return false; }
});
const browserCpu = async () => (await ours()).reduce((sum, p) => sum + cpu(p), 0);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const shown = agents[show];
await context.addInitScript((id) => {
  localStorage.setItem("yuzuno.selected", JSON.stringify(id));
}, shown);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
// Headless pages are never focused; the GUI reads (and sends read receipts
// for) only a focused, visible conversation.
await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
await page.goto(`http://127.0.0.1:${proxyPort}/`);
await page.bringToFront();
await page.waitForFunction(() => document.querySelector(".conversation-scroll [data-item-id]") && !document.querySelector(".conversation-scroll .loading-state"), null, { timeout: 120_000 });
await sleep(4_000);

// ---- The measured run ------------------------------------------------------------
const expected = Array.from({ length: deltas }, (_, n) => `Streaming chunk ${n} of a long answer.`).join(" ");
const shownText = () => page.evaluate(() => {
  const turns = document.querySelectorAll(".conversation-scroll .turn");
  const last = turns[turns.length - 1];
  const message = last && [...last.querySelectorAll('[data-item-id^="msg-"]')].find((e) => /Streaming chunk/.test(e.textContent));
  // The reply's own text, without the controls shown beside it.
  const prose = message && (message.querySelector(".prose") || message);
  return prose ? prose.textContent.replace(/\s+/g, " ").trim() : "";
});
const checkPrefix = (text) => {
  const numbers = [...text.matchAll(/Streaming chunk (\d+) of a long answer\./g)].map((m) => Number(m[1]));
  const rest = text.replace(/Streaming chunk \d+ of a long answer\./g, "").trim();
  const ordered = numbers.every((n, i) => n === i);
  return { chunks: numbers.length, ok: ordered && rest === "", duplicates: numbers.length - new Set(numbers).size };
};
const startRequests = stats.requests.length;
const startFrames = stats.streams.reduce((n, s) => n + (s.frames?.length || 0), 0);
const m0 = await metrics();
const coreCpu0 = cpu(coreProcess.pid);
const browserCpu0 = await browserCpu();
const t0 = Date.now();
const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const text = await shownText().catch(() => "");
    samples.push({ at: Date.now() - t0, ...checkPrefix(text) });
    await sleep(150);
  }
})();
const expectedStreamMs = (deltas + outputs) / (rate || 1000) * 1000;
let cutAt = null;
const cutTimer = killAt > 0 ? setTimeout(() => { cutAt = cut(); }, expectedStreamMs * killAt) : null;
const runMs = await turn(`run:${deltas}:${outputs}:${approvals}:${rate}`, 900_000);
clearTimeout(cutTimer);
await sleep(3_000);
sampling = false;
await sampler;
const t1 = Date.now();
const m1 = await metrics();
const coreCpu1 = cpu(coreProcess.pid);
const browserCpu1 = await browserCpu();
const finalText = await shownText();

// What Core itself holds for the shown reply.
const detail = await direct("GET", `/api/agents/${shown}`);
const lastTurn = detail.turns.at(-1);
const coreMessage = lastTurn.items.find((i) => typeof i.text === "string" && i.text.includes("Streaming chunk"));
const coreText = (coreMessage?.text || "").replace(/\s+/g, " ").trim();

// ---- Report ----------------------------------------------------------------------
const window = stats.requests.slice(startRequests);
const group = (filter) => {
  const list = window.filter(filter);
  return { count: list.length, MiB: +(list.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(2),
    p50ms: list.length ? list.map((r) => r.ms ?? 0).sort((a, b) => a - b)[Math.floor(list.length / 2)] : null };
};
const frames = stats.streams.flatMap((s) => s.frames || []).filter((f) => f.at >= t0);
const types = {};
for (const f of frames) types[f.type || f.event || "untyped"] = (types[f.type || f.event || "untyped"] || 0) + 1;
const reconnect = cutAt === null ? null : (() => {
  const next = stats.streams.find((s) => s.at > cutAt);
  return next && {
    afterMs: next.at - cutAt, lastEventId: next.lastEventId, url: next.url,
    first: next.frames?.[0]?.type || null,
    // Resumed from exactly the id the browser held: nothing skipped.
    firstIdAfter: next.frames?.find((f) => f.id)?.id || null,
    idsContiguous: (() => {
      const n = (id) => Number(String(id).split("-").pop());
      const ids = (next.frames || []).filter((f) => f.id && f.type !== "reset").map((f) => n(f.id));
      return ids.length > 0 && ids[0] === n(next.lastEventId) + 1 && ids.every((v, i) => i === 0 || v === ids[i - 1] + 1);
    })(),
    detailReadsAfterCut: window.filter((r) => r.at > cutAt && r.path === `/api/agents/${shown}` && r.method === "GET").length,
  };
})();
const wallS = (t1 - t0) / 1000;
const badSamples = samples.filter((s) => !s.ok);
const result = {
  label, core, web, show, warmup, run: { deltas, outputs, approvals, rate }, warmupMs, runMs,
  wallS,
  gui: {
    shownDetail: group((r) => r.path === `/api/agents/${shown}` && r.method === "GET"),
    otherDetail: group((r) => r.path === `/api/agents/${agents[show === "codex" ? "claude" : "codex"]}` && r.method === "GET"),
    workspace: group((r) => r.path === "/api/workspace"),
    catchup: group((r) => r.path === "/api/catchup"),
    all: group(() => true),
    reviews: stats.reviews.filter((r) => r.at >= t0),
    sse: { frames: frames.length, MiB: +(frames.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(2), types },
    mainThreadS: +(m1.TaskDuration - m0.TaskDuration).toFixed(2),
    scriptS: +(m1.ScriptDuration - m0.ScriptDuration).toFixed(2),
    layoutS: +(m1.LayoutDuration - m0.LayoutDuration).toFixed(2),
    styleS: +(m1.RecalcStyleDuration - m0.RecalcStyleDuration).toFixed(2),
    mainThreadPct: +((m1.TaskDuration - m0.TaskDuration) / wallS * 100).toFixed(1),
    chromiumCpuS: +(browserCpu1 - browserCpu0).toFixed(2),
    heapMiB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
  },
  coreCpuS: +(coreCpu1 - coreCpu0).toFixed(2),
  text: {
    samples: samples.length,
    badSamples: badSamples.length,
    firstBad: badSamples[0] || null,
    maxChunksDuringRun: Math.max(0, ...samples.map((s) => s.chunks)),
    finalOk: finalText === expected,
    finalChunks: checkPrefix(finalText).chunks,
    coreMatches: coreText === expected,
  },
  cut: cutAt === null ? null : { atMs: cutAt - t0, reconnect },
  pageErrors,
};
result.detailMiB = +(JSON.stringify(detail).length / 1048576).toFixed(2);
await writeFile(`${run}/result.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
proxy.close();
coreProcess.kill("SIGINT");
await new Promise((r) => { const t = setTimeout(() => { coreProcess.kill("SIGKILL"); r(); }, 15_000); coreProcess.on("exit", () => { clearTimeout(t); r(); }); });
await writeFile(`${run}/core.log`, coreLog.join(""));
process.exit(0);
