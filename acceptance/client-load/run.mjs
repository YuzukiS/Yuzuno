#!/usr/bin/env node
// acceptance/client-load (YN-211): what a client costs, apart from Core, from a
// cold or a warm start to its first usable action, and while it is in the
// foreground, minimized and restored. A lab Core (its own port and data, never
// 4317) runs scripted Codex runtimes (acceptance/turn-cost/fake_codex.py) on a
// fixed workload. The client is Chromium on Linux, or on Windows the desktop
// app's lab copy (its own identity) in a real WebView2, driven from here
// through WSL interop (windows.ps1) and raw CDP.
//
//   node acceptance/client-load/run.mjs --platform linux|windows --core BIN --web DIST --out DIR
//        [--desktop 'C:\…\lab.exe' --lab-root 'C:\…\yn211-lab'] [--pairs 5] [--window 30]
//        [--rounds 3] [--long 360] [--smoke]
//
// Nothing here reads or changes the user's Core, its data or the installed app.
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => {
  if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1] === undefined || all[i + 1].startsWith("--") ? "1" : all[i + 1]]);
  return pairs;
}, []));
const ROOT = resolve(args.root || resolve(HERE, "../.."));
const platform = args.platform;
if (!["linux", "windows"].includes(platform)) throw new Error("--platform linux|windows");
const smoke = args.smoke === "1";
const PAIRS = Number(args.pairs || (smoke ? 1 : 5));
const WINDOW = Number(args.window || (smoke ? 5 : 30));
const ROUNDS = Number(args.rounds || (smoke ? 1 : 3));
const LONG = Number(args.long ?? (smoke ? 0 : 360));
const SETTLE = smoke ? 3 : 10;
const PORT = 4461, PROXY = 4462, CDP = platform === "windows" ? 9361 : 9362;
const AGENTS = 12, STREAMING = 4, RATE = 10;
const out = resolve(args.out);
const core = resolve(args.core);
const web = resolve(args.web);
const TICK = 100; // USER_HZ
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
for (const port of [PORT, PROXY, CDP]) if (port === 4317) throw new Error("never 4317");

await mkdir(`${out}/data`, { recursive: true });
await mkdir(`${out}/task`, { recursive: true });
await mkdir(`${out}/timeline`, { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const raw = (name, value) => appendFile(`${out}/${name}.jsonl`, JSON.stringify(value) + "\n");

async function free(port) {
  return new Promise((r) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); r(false); });
    s.on("error", () => r(true));
  });
}
for (const port of [PORT, PROXY, CDP]) if (!(await free(port))) throw new Error(`port ${port} is in use`);

// ---- Linux processes ------------------------------------------------------------
const stat = (pid) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return { ppid: Number(f[1]), cpu: (Number(f[11]) + Number(f[12])) / TICK, rssMiB: Number(f[21]) * 4096 / 2 ** 20 };
  } catch { return null; }
};
const descendants = (root) => {
  const parent = new Map();
  for (const p of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    const s = stat(p);
    if (s) parent.set(Number(p), s.ppid);
  }
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!found.has(pid) && found.has(ppid)) { found.add(pid); grew = true; }
  }
  found.delete(root);
  return [...found];
};
const roleOf = (pid) => {
  try {
    // A zygote's children rewrite theirs as one space-joined string.
    const line = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    const type = line.match(/--type=([a-z-]+)/)?.[1];
    if (!type) return "browser";
    const sub = line.match(/--utility-sub-type=([A-Za-z.]+)/)?.[1];
    return type === "utility" && sub ? `utility:${sub}` : type;
  } catch { return "gone"; }
};
const hostTicks = () => {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4] };
};

// ---- Lab Core with scripted runtimes ---------------------------------------------
const coreLog = [];
const coreProcess = spawn(core, ["--port", String(PORT), "--data-dir", `${out}/data`, "--web-dir", web,
  "--cwd", `${out}/task`, "--codex", `${ROOT}/acceptance/turn-cost/fake_codex.py`], {
  env: { ...process.env, T9_TIMELINE: `${out}/timeline` }, stdio: ["ignore", "pipe", "pipe"],
});
const cleanups = [() => coreProcess.kill("SIGKILL")];
process.on("exit", () => { for (const c of cleanups.reverse()) try { c(); } catch { /* best effort */ } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
process.on("unhandledRejection", (error) => { console.error(error); process.exit(1); });
coreProcess.stdout.on("data", (d) => coreLog.push(String(d)));
coreProcess.stderr.on("data", (d) => coreLog.push(String(d)));
const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-yuzuno-client": "desktop" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};
for (let i = 0; ; i++) {
  try { await api("GET", "/api/health"); break; } catch (e) { if (i > 200) throw e; await sleep(100); }
}
const coreCpu = () => stat(coreProcess.pid)?.cpu ?? NaN;
const runtimeCpu = () => descendants(coreProcess.pid).reduce((sum, p) => sum + (stat(p)?.cpu || 0), 0);

// ---- The fixed workload (F12) ---------------------------------------------------
const completions = () => JSON.parse(execFileSync("python3", ["-c", `import sqlite3,json
c=sqlite3.connect('file:${out}/data/workspace.sqlite?mode=ro', uri=True, timeout=30)
print(json.dumps(dict(c.execute("SELECT agent_id, COUNT(*) FROM journal WHERE kind='turn/completed' GROUP BY agent_id").fetchall())))`]).toString());
const send = (id, text) => api("POST", `/api/agents/${id}/messages`, { clientMessageId: crypto.randomUUID(), text });
async function turns(texts, timeoutMs = 900_000) {
  const before = completions();
  await Promise.all(Object.entries(texts).map(([id, text]) => send(id, text)));
  return () => (async () => {
    const started = now();
    for (;;) {
      const done = completions();
      if (Object.keys(texts).every((id) => (done[id] || 0) > (before[id] || 0))) return now() - started;
      if (now() - started > timeoutMs) throw new Error(`turns did not finish: ${JSON.stringify(done)}`);
      await sleep(250);
    }
  })();
}
const ids = [];
for (let i = 1; i <= AGENTS; i++) {
  ids.push((await api("POST", "/api/agents", { name: `A${i}`, cwd: `${out}/task`, harness: "codex", model: "bench-model" })).id);
}
for (let i = 0; ; i++) {
  const listed = (await api("GET", "/api/workspace")).agents;
  if (ids.every((id) => listed.find((a) => a.id === id)?.connectionState === "connected")) break;
  if (i > 200) throw new Error("the Agents did not connect");
  await sleep(200);
}
const A1 = ids[0];
await (await turns({ [A1]: "warmup:40:20" }))();
for (let r = 0; r < 3; r++) await (await turns(Object.fromEntries(ids.map((id) => [id, "run:20:0:0:0"]))))();
for (let r = 0; r < 3; r++) await (await turns({ [A1]: "run:20:0:0:0" }))();
const sizes = {};
for (const [name, path] of [["workspace", "/api/workspace"], ["a1Detail", `/api/agents/${A1}`]]) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { "x-yuzuno-client": "desktop" } });
  sizes[name] = (await response.arrayBuffer()).byteLength;
}
const MIN_TURNS = 3;
log("fixture ready", JSON.stringify(sizes));

// ---- The proxy the client talks to --------------------------------------------
const proxyState = { run: null, requests: [], hold: false, held: [], seq: 0, chunk: null, cacheable: false };
const proxy = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  const record = { run: proxyState.run, method: req.method, path, at: now(), status: 0, bytes: 0 };
  proxyState.requests.push(record);
  const forward = () => {
    const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${PORT}`;
    const up = http.request({ host: "127.0.0.1", port: PORT, method: req.method, path: req.url, headers }, (u) => {
      record.status = u.statusCode;
      // The simulated variant only: hashed assets as cacheable, which Core's
      // own answers (no-store, server.rs harden) are not.
      const headers = proxyState.cacheable && path.startsWith("/assets/")
        ? { ...u.headers, "cache-control": "public, max-age=31536000, immutable" } : u.headers;
      res.writeHead(u.statusCode, headers);
      let buffer = "";
      u.on("data", (chunk) => {
        record.bytes += chunk.length;
        if (path === "/api/events") {
          buffer += chunk.toString("utf8");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            // Core's event IDs are "<epoch>-<n>" (events.rs); n orders them.
            const id = block.split("\n").find((l) => l.startsWith("id:"))?.slice(3).trim();
            const n = id ? Number(id.split("-").pop()) : NaN;
            if (n > proxyState.seq) proxyState.seq = n;
            if (block.includes(A1)) {
              // The newest chunk of A1's streamed reply, as Core sent it (a new Turn counts from 0).
              for (const m of block.matchAll(/Streaming chunk (\d+) /g)) proxyState.chunk = Number(m[1]);
            }
          }
        }
        res.write(chunk);
      });
      u.on("end", () => res.end());
      u.on("error", () => res.destroy());
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  };
  // The desktop's connection page waits for this before it opens the
  // workspace, which lets the probe be in place first (`release`).
  if (proxyState.hold && path === "/api/health") proxyState.held.push({ at: now(), forward });
  else forward();
});
await new Promise((r) => proxy.listen(PROXY, "127.0.0.1", r));
const release = () => {
  proxyState.hold = false;
  const held = proxyState.held.splice(0);
  const at = now();
  for (const h of held) h.forward();
  return held.length ? { heldMs: at - held[0].at, held: held.length } : { heldMs: 0, held: 0 };
};
const ORIGIN = `http://127.0.0.1:${PROXY}`;

// ---- Raw CDP --------------------------------------------------------------------
class Cdp {
  static async connect(port, timeoutMs = 20_000) {
    const deadline = now() + timeoutMs;
    for (;;) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === "page");
        if (page) return await new Cdp(page.webSocketDebuggerUrl).opened();
      } catch { /* not listening yet */ }
      if (now() > deadline) throw new Error(`no CDP page on ${port}`);
      await sleep(25);
    }
  }
  constructor(url) {
    this.next = 1; this.waiting = new Map(); this.listeners = new Map();
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { ok, fail } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
      } else if (msg.method) for (const f of this.listeners.get(msg.method) || []) f(msg.params);
    };
  }
  opened() { return new Promise((ok, fail) => { this.ws.onopen = () => ok(this); this.ws.onerror = fail; }); }
  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.waiting.set(id, { ok, fail }));
  }
  on(method, f) { this.listeners.set(method, [...(this.listeners.get(method) || []), f]); }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

// In every document from its start; acts in the workspace's only. Records when
// the rail is ready, clicks A1 then, and when its conversation is mounted with a
// composer that takes input (+2 frames): the first usable action. Counts the
// events the page's EventSource hands it, with their highest ID.
const probe = `(() => {
  if (location.origin !== ${JSON.stringify(ORIGIN)}) return;
  const s = window.__yn211 = { timeOrigin: performance.timeOrigin, seq: 0, events: 0, marks: {}, selectedAtStart: null, longTasks: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true }); } catch {}
  const ES = window.EventSource;
  window.EventSource = class extends ES {
    constructor(...a) { super(...a); this.addEventListener("message", (e) => { s.events++; const n = Number(String(e.lastEventId).split("-").pop()); if (n > s.seq) s.seq = n; }); }
  };
  const A1 = ${JSON.stringify(A1)};
  const tick = () => {
    const t = performance.now();
    if (!s.marks.rail) {
      const row = document.querySelector('.agent-row[data-agent-id="' + A1 + '"] button.agent-select');
      if (row && document.querySelectorAll(".agent-row[data-agent-id]").length >= ${AGENTS}) {
        s.marks.rail = t;
        s.selectedAtStart = row.getAttribute("aria-current") === "true";
        s.marks.click = performance.now();
        row.click();
      }
    } else if (!s.marks.mounted) {
      const selected = document.querySelector('.agent-row.selected[data-agent-id="' + A1 + '"]');
      const turns = document.querySelectorAll(".turn[data-turn-id]").length;
      const box = document.querySelector(".composer");
      const editor = box && box.querySelector('textarea:not([disabled]), [contenteditable="true"]');
      if (selected && turns >= ${MIN_TURNS} && editor) {
        s.marks.mounted = t;
        requestAnimationFrame(() => requestAnimationFrame(() => { s.marks.usable = performance.now(); }));
        return;
      }
    }
    setTimeout(tick, 10);
  };
  tick();
})();`;

const pageReport = `(() => {
  const s = window.__yn211;
  const nav = performance.getEntriesByType("navigation")[0];
  const res = performance.getEntriesByType("resource").filter((r) => new URL(r.name).pathname.startsWith("/assets/"))
    .map((r) => ({ path: new URL(r.name).pathname, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize,
      decodedBodySize: r.decodedBodySize, deliveryType: r.deliveryType ?? null, start: r.startTime, end: r.responseEnd }));
  const paint = Object.fromEntries(performance.getEntriesByType("paint").map((p) => [p.name, p.startTime]));
  return JSON.stringify({ ...s, nav: nav && { domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd,
    transferSize: nav.transferSize, type: nav.type }, resources: res, paint,
    longTaskMs: s.longTasks.reduce((a, [, d]) => a + d, 0), longTasks: s.longTasks.length,
    domNodes: document.getElementsByTagName("*").length, visibility: document.visibilityState });
})()`;

async function usable(cdp, label, timeoutMs = 60_000) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const done = await cdp.eval("!!(window.__yn211 && window.__yn211.marks.usable)");
      if (done) return JSON.parse(await cdp.eval(pageReport));
    } catch { /* a navigation in between */ }
    if (now() > deadline) {
      // What the client shows instead, for the report.
      let seen = null;
      try {
        seen = await cdp.eval(`JSON.stringify({ href: location.href, title: document.title,
          text: (document.body && document.body.innerText || "").slice(0, 1200), probe: window.__yn211 || null })`);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        await writeFile(`${out}/${label}-timeout.png`, Buffer.from(shot.data, "base64"));
      } catch (error) { seen = seen || String(error); }
      await writeFile(`${out}/${label}-timeout.json`, seen || "null");
      throw new Error(`the first usable action did not come (${label}): ${seen}`);
    }
    await sleep(50);
  }
}

// ---- Clients ----------------------------------------------------------------------
const toWindows = (p) => execFileSync("wslpath", ["-w", p]).toString().trim();
const PS1 = platform === "windows" ? toWindows(`${HERE}/windows.ps1`) : null;
const ps = (action, params = {}) => {
  const argv = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Action", action];
  // `-File` takes one value per parameter: a list goes as one, joined by ';'.
  for (const [k, v] of Object.entries(params)) argv.push(`-${k}`, Array.isArray(v) ? v.join(";") : String(v));
  const text = execFileSync("powershell.exe", argv, { cwd: "/mnt/c/Windows", timeout: 60_000 }).toString().trim();
  // One JSON line per answer (a sample may print a second one).
  const first = text.split(/\r?\n/).find((l) => l.trim());
  return first ? JSON.parse(first) : null;
};
const LAB = args["lab-root"];
const DESKTOP = args.desktop;
if (platform === "windows" && (!LAB || !DESKTOP)) throw new Error("--desktop and --lab-root on windows");

/** One client process tree: start, its CPU and memory by role, stop. */
async function launch(profile) {
  if (platform === "linux") {
    const startAtMs = now();
    const child = spawn("/usr/sbin/chromium", ["--headless", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
      "--window-size=1440,1000", "--no-first-run", "--no-default-browser-check", "--disable-component-update",
      // As Playwright starts it by default: a Job's unit allows no sandbox.
      "--password-store=basic", "--no-sandbox", "about:blank"], {
      stdio: ["ignore", "ignore", "pipe"],
      // Its singleton socket must fit a Unix socket path (108 bytes).
      env: { ...process.env, ...(args["chromium-tmp"] ? { TMPDIR: args["chromium-tmp"] } : {}) } });
    const errors = [];
    child.stderr.on("data", (d) => errors.push(String(d)));
    cleanups.push(() => child.kill("SIGKILL"));
    return { startAtMs, pid: child.pid, child, errors,
      tree: () => [child.pid, ...descendants(child.pid)].map((pid) => ({ pid, role: pid === child.pid ? "browser" : roleOf(pid), ...stat(pid) })) };
  }
  const started = ps("launch", { Exe: DESKTOP, Udf: profile, Port: CDP, CoreUrl: ORIGIN });
  const app = { startAtMs: started.startUnixMs, pid: started.pid, start: started.start };
  cleanups.push(() => { try { ps("stop", { Id: app.pid, Start: app.start, Exe: DESKTOP }); } catch { /* ended */ } });
  return app;
}
async function stop(app, cdp) {
  if (platform === "linux") {
    try { await Promise.race([cdp.send("Browser.close"), sleep(5000)]); } catch { /* closing */ }
    cdp.close();
    for (let i = 0; i < 100 && stat(app.pid); i++) await sleep(100);
    if (stat(app.pid)) app.child.kill("SIGKILL");
    return { stopped: "closed" };
  }
  cdp.close();
  return ps("stop", { Id: app.pid, Start: app.start, Exe: DESKTOP });
}
/** CPU seconds and memory by role, now, for the client's tree. */
function clientNow(app) {
  if (platform === "linux") {
    const byRole = {};
    for (const p of app.tree()) {
      const r = (byRole[p.role] ||= { cpu: 0, rssMiB: 0, processes: 0 });
      r.cpu += p.cpu || 0; r.rssMiB += p.rssMiB || 0; r.processes++;
    }
    return { atMs: now(), byRole };
  }
  const line = ps("sample", { Id: app.pid, Start: app.start, IntervalMs: 1000, MaxSeconds: 1 });
  return windowsLine(line);
}
function windowsLine(line) {
  const byRole = {};
  for (const p of line.procs || []) {
    const r = (byRole[p.role] ||= { cpu: 0, workingSetMiB: 0, privateMiB: 0, processes: 0 });
    r.cpu += p.cpuMs / 1000; r.workingSetMiB += p.workingSetMiB; r.privateMiB += p.privateMiB; r.processes++;
  }
  return { atMs: line.atMs, byRole, iconic: line.iconic, systemTicks: line.systemTicks };
}

// ---- M1: cold and warm starts to the first usable action ------------------------
const runs = [];
const profileOf = (pair) => platform === "linux" ? `${out}/profiles/p${pair}` : `${LAB}\\udf-${pair}`;
async function startRun(label, kind, pair, variant = "shipped") {
  proxyState.run = label;
  proxyState.cacheable = variant === "cacheable-simulated";
  proxyState.hold = platform === "windows";
  const core0 = coreCpu();
  const app = await launch(profileOf(pair));
  const cdp = await Cdp.connect(CDP).catch((error) => {
    throw new Error(`${error.message}; client stderr: ${(app.errors || []).join("").slice(-1500)}`);
  });
  const attachedAtMs = now();
  const network = [];
  cdp.on("Network.responseReceived", (p) => network.push({ url: p.response.url, status: p.response.status,
    fromDiskCache: !!p.response.fromDiskCache, fromServiceWorker: !!p.response.fromServiceWorker,
    fromPrefetchCache: !!p.response.fromPrefetchCache, encodedDataLength: p.response.encodedDataLength }));
  const servedFromCache = new Set();
  cdp.on("Network.requestServedFromCache", (p) => servedFromCache.add(p.requestId));
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: probe });
  let held = { heldMs: 0, held: 0 };
  if (platform === "windows") held = release();
  else await cdp.send("Page.navigate", { url: `${ORIGIN}/` });
  const page = await usable(cdp, label);
  const client = clientNow(app);
  const core1 = coreCpu();
  await cdp.send("Network.disable");
  await cdp.send("Page.disable");
  const reached = proxyState.requests.filter((r) => r.run === label);
  const at = (mark) => Math.round(page.timeOrigin + page.marks[mark] - app.startAtMs - held.heldMs);
  const run = {
    label, kind, pair, platform, variant,
    msFromProcessStart: { cdp: attachedAtMs - app.startAtMs, navigation: Math.round(page.timeOrigin - app.startAtMs - held.heldMs),
      rail: at("rail"), mounted: at("mounted"), usable: at("usable") },
    msFromNavigation: { rail: page.marks.rail, clickToMounted: page.marks.mounted - page.marks.click, usable: page.marks.usable,
      domContentLoaded: page.nav?.domContentLoaded, firstContentfulPaint: page.paint["first-contentful-paint"] ?? null },
    probeHeldMs: held.heldMs, selectedAtStart: page.selectedAtStart,
    assets: page.resources.map((r) => ({ ...r, reachedCore: reached.some((q) => q.path === r.path),
      cdp: network.find((n) => new URL(n.url).pathname === r.path) || null })),
    servedFromCache: servedFromCache.size,
    reachedCore: { requests: reached.length, assets: reached.filter((r) => r.path.startsWith("/assets/")).length,
      api: reached.filter((r) => r.path.startsWith("/api/")).length, bytes: reached.reduce((a, r) => a + r.bytes, 0) },
    longTasks: page.longTasks, longTaskMs: Math.round(page.longTaskMs), domNodes: page.domNodes,
    clientCpuSecondsSinceStart: client.byRole, coreCpuSeconds: +(core1 - core0).toFixed(3),
  };
  log(label, JSON.stringify(run.msFromProcessStart), "core", run.coreCpuSeconds);
  return { run, app, cdp };
}

const environment = { platform, base: args.base || null, coreSha256: execFileSync("sha256sum", [core]).toString().split(" ")[0],
  web: readdirSync(`${web}/assets`).filter((f) => /^index-.*\.(js|css)$/.test(f)), fixture: { agents: AGENTS, sizes },
  load: { streaming: STREAMING, eventsPerSecondEach: RATE }, pairs: PAIRS, windowSeconds: WINDOW, rounds: ROUNDS, longSeconds: LONG,
  host: { cpus: readFileSync("/proc/cpuinfo", "utf8").match(/^processor/gm).length, kernel: readFileSync("/proc/version", "utf8").trim() } };
if (platform === "linux") environment.chromium = execFileSync("/usr/sbin/chromium", ["--version"]).toString().trim();
const isolation = {};
if (platform === "windows") {
  const local = "C:\\Users\\" + execFileSync("cmd.exe", ["/c", "echo %USERNAME%"], { cwd: "/mnt/c/Windows" }).toString().trim();
  // The lab identity's own folders only; the installed app's are not read.
  const folders = [`${local}\\AppData\\Local\\dev.yuzuno.workspace.yn211lab`, `${local}\\AppData\\Roaming\\dev.yuzuno.workspace.yn211lab`, LAB];
  isolation.before = ps("info", { Folders: folders });
  isolation.aside = ps("aside", { Folders: `${local}\\AppData\\Roaming\\dev.yuzuno.workspace.yn211lab\\core.json` });
  isolation.folders = folders;
  environment.windows = { webview2: isolation.before.webview2, os: isolation.before.os, cpu: isolation.before.cpu,
    logicalCpus: isolation.before.logicalCpus, memoryGiB: isolation.before.memoryGiB, desktop: DESKTOP };
}
await writeFile(`${out}/environment.json`, JSON.stringify(environment, null, 1));

// Core warm: one start that is not counted.
{
  const { app, cdp } = await startRun("discarded", "warmup", "w0");
  if (platform === "windows") isolation.tree = ps("tree", { Id: app.pid, Start: app.start });
  await stop(app, cdp);
}
// As shipped (Core's no-store), then with hashed assets cacheable as the
// proxy simulates it: each pair a new profile (cold), then it again (warm).
for (const variant of ["shipped", "cacheable-simulated"]) {
  for (let pair = 1; pair <= PAIRS; pair++) {
    for (const kind of ["cold", "warm"]) {
      const tag = variant === "shipped" ? "s" : "c";
      const { run, app, cdp } = await startRun(`${kind}-${tag}${pair}`, kind, `${tag}${pair}`, variant);
      runs.push(run);
      await raw("runs", run);
      await stop(app, cdp);
      await sleep(1000);
    }
  }
}

// ---- M2: foreground, minimized and restored -------------------------------------
const windows = [], catchUps = [];
const { app, cdp } = await startRun("cpu-session", "warm", "s1");
let samples = [];
let sampler = null;
if (platform === "windows") {
  sampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Action", "sample",
    "-Id", String(app.pid), "-Start", app.start, "-IntervalMs", "1000", "-MaxSeconds", "7200"], { cwd: "/mnt/c/Windows", stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  sampler.stdout.on("data", (d) => {
    buffer += d;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      samples.push(value);
      raw("samples", value);
    }
  });
  cleanups.push(() => sampler.kill("SIGKILL"));
  for (let i = 0; i < 100 && samples.length < 2; i++) await sleep(100);
}
const pageState = async () => JSON.parse(await cdp.eval(`JSON.stringify({ visibility: document.visibilityState,
  seq: window.__yn211.seq, events: window.__yn211.events, at: performance.timeOrigin + performance.now() })`));
function clientDelta(t0, t1) {
  if (platform === "linux") return null;
  const inside = samples.filter((s) => s.atMs >= t0 - 1500 && s.atMs <= t1 + 1500);
  const first = inside.find((s) => s.atMs >= t0) || inside[0];
  const last = [...inside].reverse().find((s) => s.atMs <= t1) || inside.at(-1);
  if (!first || !last || first === last) return null;
  const a = windowsLine(first), b = windowsLine(last);
  const seconds = (b.atMs - a.atMs) / 1000;
  const byRole = {};
  for (const role of new Set([...Object.keys(a.byRole), ...Object.keys(b.byRole)])) {
    byRole[role] = { cores: +(((b.byRole[role]?.cpu || 0) - (a.byRole[role]?.cpu || 0)) / seconds).toFixed(4),
      workingSetMiB: b.byRole[role]?.workingSetMiB ?? null, privateMiB: b.byRole[role]?.privateMiB ?? null };
  }
  const span = inside.filter((s) => s.atMs >= t0 && s.atMs <= t1);
  const st0 = first.systemTicks, st1 = last.systemTicks;
  const total = (st1.kernel + st1.user) - (st0.kernel + st0.user);
  return { seconds, byRole, cores: +Object.values(byRole).reduce((x, r) => x + r.cores, 0).toFixed(4),
    iconicSamples: span.filter((s) => s.iconic).length, samples: span.length,
    windowsBusy: total > 0 ? +(1 - (st1.idle - st0.idle) / total).toFixed(4) : null };
}
async function measure(load, state, round, seconds, bucket = seconds) {
  const begin = await pageState();
  const t0 = now(), c0 = coreCpu(), r0 = runtimeCpu(), h0 = hostTicks(), s0 = proxyState.seq;
  const l0 = platform === "linux" ? clientNow(app) : null;
  const buckets = [];
  let tb = t0, cb = c0;
  for (let left = seconds; left > 0; left -= bucket) {
    await sleep(Math.min(bucket, left) * 1000);
    const t = now(), c = coreCpu();
    buckets.push({ fromS: (tb - t0) / 1000, toS: (t - t0) / 1000, coreCores: +((c - cb) / ((t - tb) / 1000)).toFixed(4),
      client: clientDelta(tb, t) });
    tb = t; cb = c;
  }
  const t1 = now(), c1 = coreCpu(), r1 = runtimeCpu(), h1 = hostTicks(), s1 = proxyState.seq;
  const end = await pageState();
  const secs = (t1 - t0) / 1000;
  let client = clientDelta(t0, t1);
  if (platform === "linux") {
    const l1 = clientNow(app);
    const byRole = {};
    for (const role of new Set([...Object.keys(l0.byRole), ...Object.keys(l1.byRole)])) {
      byRole[role] = { cores: +(((l1.byRole[role]?.cpu || 0) - (l0.byRole[role]?.cpu || 0)) / secs).toFixed(4), rssMiB: l1.byRole[role]?.rssMiB ?? null };
    }
    client = { seconds: secs, byRole, cores: +Object.values(byRole).reduce((x, r) => x + r.cores, 0).toFixed(4) };
  }
  const w = { load, state, round, seconds: secs, coreCores: +((c1 - c0) / secs).toFixed(4), runtimeCores: +((r1 - r0) / secs).toFixed(4),
    hostBusy: +(1 - (h1.idle - h0.idle) / (h1.total - h0.total)).toFixed(4), client,
    page: { begin, end, eventsHandled: end.events - begin.events }, coreEventIds: s1 - s0, buckets: buckets.length > 1 ? buckets : undefined };
  const iconic = client?.samples ? client.iconicSamples / client.samples : null;
  w.pure = platform === "linux" ? true
    : state === "minimized" ? iconic === 1 && begin.visibility === "hidden" && end.visibility === "hidden"
      : iconic === 0 && begin.visibility === "visible" && end.visibility === "visible";
  windows.push(w);
  await raw("windows", w);
  log(load, state, round, "core", w.coreCores, "client", w.client?.cores, "pure", w.pure);
  return w;
}
async function show(how) { return ps("show", { Id: app.pid, Start: app.start, How: how }); }
// Armed while the page is still hidden, before the restore: it starts on the
// page's own visibilitychange, so the restore call's latency is not in it.
// Caught up = the page handled the event ID Core had sent by then, and A1's
// last Turn shows the newest streamed chunk, then two frames.
const catchUpScript = (target, chunk) => `new Promise((done) => {
  const s = window.__yn211; const marks = {};
  const at = () => performance.timeOrigin + performance.now();
  const tick = () => {
    const t = at();
    if (!marks.seq && s.seq >= ${target}) marks.seq = t;
    const last = [...document.querySelectorAll(".turn[data-turn-id]")].pop();
    if (!marks.text && (${chunk === null} || (last && last.innerText.includes("Streaming chunk ${chunk} ")))) marks.text = t;
    if (marks.seq && marks.text) {
      requestAnimationFrame(() => requestAnimationFrame(() => { marks.painted = at(); done(JSON.stringify(marks)); }));
      return;
    }
    if (t - marks.visible > 20000) { done(JSON.stringify({ ...marks, timedOut: true })); return; }
    setTimeout(tick, 10);
  };
  const start = () => { if (marks.visible) return; marks.visible = at(); tick(); };
  if (document.visibilityState === "visible") start();
  else document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") start(); });
})`;
async function restoreAndCatchUp(load, round) {
  const target = proxyState.seq, chunk = proxyState.chunk;
  const pending = cdp.eval(catchUpScript(target, chunk), true);
  await sleep(100);
  // ShowWindow's time (beforeMs) and the page's are both this PC's clock.
  const shown = await show("restore");
  const marks = JSON.parse(await pending);
  const from = (m) => (m ? Math.round(m - shown.beforeMs) : null);
  const c = { load, round, targetSeq: target, chunk, showCallMs: shown.atMs - shown.beforeMs,
    visibleMs: from(marks.visible), seqMs: from(marks.seq), textMs: from(marks.text), paintedMs: from(marks.painted),
    timedOut: !!marks.timedOut };
  catchUps.push(c);
  await raw("catchups", c);
  return c;
}
async function streams(seconds) {
  const deltas = Math.ceil(RATE * seconds);
  return turns(Object.fromEntries(ids.slice(0, STREAMING).map((id) => [id, `run:${deltas}:0:0:${RATE}`])), (seconds + 120) * 1000);
}
for (const load of ["L0", "L4"]) {
  const span = SETTLE + ROUNDS * (platform === "windows" ? 3 : 1) * (WINDOW + 5) + 30;
  const finished = load === "L4" ? await streams(span) : null;
  await sleep(SETTLE * 1000);
  for (let round = 1; round <= ROUNDS; round++) {
    await measure(load, "visible", round, WINDOW);
    if (platform === "windows") {
      await show("minimize");
      await measure(load, "minimized", round, WINDOW);
      await restoreAndCatchUp(load, round);
      await measure(load, "restored", round, WINDOW);
    }
  }
  if (finished) await finished();
  if (platform === "windows" && LONG > 0) {
    const longFinished = load === "L4" ? await streams(SETTLE + LONG + 30) : null;
    await sleep(SETTLE * 1000);
    await show("minimize");
    await measure(load, "minimized", "long", LONG, 30);
    await restoreAndCatchUp(load, "long");
    if (longFinished) await longFinished();
  }
}
if (sampler) sampler.kill("SIGKILL");
const stopped = await stop(app, cdp);
if (platform === "windows") {
  isolation.after = ps("info", { Folders: isolation.folders });
  isolation.labDataDirs = [...new Set((isolation.tree || []).map((p) => p.userDataDir).filter(Boolean))];
  isolation.labPaths = [...new Set((isolation.tree || []).map((p) => p.path))];
}
const summary = { environment, isolation, runs, windows, catchUps, stopped,
  coreRequests: proxyState.requests.length, coreLogTail: coreLog.join("").slice(-2000) };
await writeFile(`${out}/summary.json`, JSON.stringify(summary, null, 1));
log("done", `${out}/summary.json`);
process.exit(0);
