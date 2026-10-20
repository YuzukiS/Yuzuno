// Bounded isolated Chromium profile. Daily mode is a GET-only proxy; every
// write is refused. Fixtures and traces contain no copied conversation prose.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, extname } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(process.env.T46_OUT || resolve(root, "target/t46"));
const label = process.argv[2] || "daily";
const daily = process.argv.includes("--daily");
const switchOnly = process.argv.includes("--switch-only");
const cpuRate = Number(process.env.T46_CPU_RATE || 1);
const contention = process.env.T46_CONTENTION === "1";
if (switchOnly) {
  assert.ok(process.env.T46_WEB, "switch-only requires explicit built assets");
  assert.ok(process.env.T46_FIXTURE_SHA256, "switch-only requires a pinned fixture");
  assert.ok(process.env.T46_ASSET_MANIFEST, "switch-only requires an asset manifest");
  assert.equal(daily || contention || cpuRate !== 1, false);
}
const web = resolve(
  process.env.T46_WEB ||
    (process.env.HOME + '/.local/share/yuzuno/managed-core/releases/core-20261015-304db2d/web'),
);
const fixtureBytes = await readFile(resolve(out, "fixture.json"));
const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
if (process.env.T46_FIXTURE_SHA256)
  assert.equal(fixtureSha256, process.env.T46_FIXTURE_SHA256);
const fixture = JSON.parse(fixtureBytes);
const assets = process.env.T46_ASSET_MANIFEST
  ? JSON.parse(await readFile(process.env.T46_ASSET_MANIFEST, "utf8"))
  : null;
if (assets) {
  assert.equal(assets.web, web);
  for (const [file, hash] of Object.entries(assets.sha256))
    assert.equal(createHash("sha256").update(await readFile(resolve(web, file))).digest("hex"), hash, file);
}
const ids = daily
  ? [
      "bcdae810-6a52-4d30-ac58-08fc293b2351",
      "472db31d-3e33-4d2e-a0d3-01a413d96e4e",
    ]
  : ["a", "b"];
if (!daily) fixture.details.b.turns = fixture.details.b.turns.slice(-2);
const requests = [],
  blockedWrites = [],
  errors = [];
await mkdir(out, { recursive: true });
const send = (res, data) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};
const allowed = new Set([
  "/api/health",
  "/api/workspace",
  ...ids.map((id) => `/api/agents/${id}`),
]);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (req.method !== "GET") {
    blockedWrites.push({ path: pathname, method: req.method });
    res.writeHead(403);
    return res.end('{"error":"Read-only acceptance window"}');
  }
  if (pathname.startsWith("/api/")) {
    if (daily && allowed.has(pathname)) {
      const record = { path: pathname, at: performance.now(), bytes: 0 };
      requests.push(record);
      const up = http.get(
        { host: "127.0.0.1", port: 4317, path: req.url },
        (response) => {
          record.ttfbMs = performance.now() - record.at;
          res.writeHead(response.statusCode, response.headers);
          response.on("data", (chunk) => {
            record.bytes += chunk.length;
          });
          response.on("end", () => {
            record.totalMs = performance.now() - record.at;
          });
          response.pipe(res);
        },
      );
      up.setTimeout(10000, () => up.destroy());
      up.on("error", () => {
        res.writeHead(502);
        res.end("{}");
      });
      res.on("close", () => up.destroy());
      return;
    }
    if (!daily && pathname === "/api/workspace")
      return send(res, {
        agents: Object.values(fixture.details).map((d) => d.agent),
        workspace: { id: "t46" },
        runtime: { connected: true },
        defaultCwd: "/fixture",
        projects: [],
        projectUsage: {},
      });
    if (!daily && /^\/api\/agents\/[ab]$/.test(pathname)) {
      const d = fixture.details[pathname.at(-1)],
        body = JSON.stringify(d);
      requests.push({
        path: pathname,
        at: performance.now(),
        bytes: Buffer.byteLength(body),
        ttfbMs: 0,
        totalMs: 0,
      });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(body);
    }
    if (pathname === "/api/machines") return send(res, { machines: [] });
    if (pathname === "/api/catchup")
      return send(res, { items: [], agents: [] });
    if (pathname === "/api/models") return send(res, { models: [] });
    return send(res, {});
  }
  const file = resolve(web, pathname === "/" ? "index.html" : "." + pathname);
  if (!file.startsWith(web + "/")) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type":
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".png": "image/png",
          ".woff2": "font/woff2",
        }[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(switchOnly ? 0 : 4498, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

function instrument(initial) {
  const S = (window.t46 = {
    fetches: [],
    commits: [],
    long: [],
    events: [],
    observers: {},
    rects: { count: 0, ms: 0, slow: [] },
    snapshots: {},
    sources: [],
    seq: 0,
  });
  localStorage.setItem("yuzuno.selected", JSON.stringify(initial));
  localStorage.removeItem("yuzuno.scope");
  const now = () => performance.now();
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".agent-select"))
      S.clickAt = now();
  }, true);
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(r) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, r);
      return id;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot() {
      S.commits.push(now());
    },
  };
  new PerformanceObserver((list) =>
    S.long.push(
      ...list.getEntries().map((e) => ({ at: e.startTime, ms: e.duration })),
    ),
  ).observe({ type: "longtask" });
  new PerformanceObserver((list) =>
    S.events.push(
      ...list
        .getEntries()
        .map((e) => ({
          name: e.name,
          at: e.startTime,
          ms: e.duration,
          processing: e.processingEnd - e.processingStart,
        })),
    ),
  ).observe({ type: "event", durationThreshold: 16 });
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const record = { path: String(args[0]), start: now() };
    const r = await originalFetch(...args);
    record.headers = now();
    const json = r.json.bind(r);
    r.json = async () => {
      record.bodyStart = now();
      const d = await json();
      record.done = now();
      S.fetches.push(record);
      if (d.agent && d.turns) S.snapshots[d.agent.id] = d;
      return d;
    };
    return r;
  };
  for (const kind of ["MutationObserver", "ResizeObserver"]) {
    const Original = window[kind];
    window[kind] = class extends Original {
      constructor(callback) {
        const key = kind + ":" + Object.keys(S.observers).length;
        S.observers[key] = {
          count: 0,
          ms: 0,
          stack: new Error().stack?.split("\n").slice(2, 5).join("\n"),
        };
        super((...args) => {
          const start = now();
          try {
            return callback(...args);
          } finally {
            S.observers[key].count++;
            S.observers[key].ms += now() - start;
          }
        });
      }
    };
  }
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const start = now();
    const r = rect.call(this);
    const ms = now() - start;
    S.rects.count++;
    S.rects.ms += ms;
    if (ms > 2 && S.rects.slow.length < 25)
      S.rects.slow.push({
        ms,
        stack: new Error().stack?.split("\n").slice(2, 5).join("\n"),
      });
    return r;
  };
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      S.sources.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({
          data: '{"type":"resumed"}',
          lastEventId: "fixture-0",
        });
      }, 20);
    }
    addEventListener() {}
    close() {
      this.readyState = 2;
    }
  };
  S.emit = (data) => {
    for (const s of S.sources)
      if (s.readyState === 1)
        s.onmessage?.({
          data: JSON.stringify(data),
          lastEventId: "fixture-" + ++S.seq,
        });
  };
  S.streaming = (id, on) => {
    clearInterval(S.timer);
    if (!on) return;
    const d = S.snapshots[id],
      turn = d.turns.at(-1);
    let rev = (d.agent.rev || 0) + 1;
    S.emit({
      type: "agent.item",
      agentId: id,
      turnId: turn.id,
      rev: rev++,
      item: {
        id: "t46-stream",
        type: "agentMessage",
        text: "Measured stream\n",
      },
    });
    S.timer = setInterval(
      () =>
        S.emit({
          type: "agent.delta",
          agentId: id,
          turnId: turn.id,
          itemId: "t46-stream",
          rev: rev++,
          op: "append",
          field: "text",
          text: " measured output",
        }),
      100,
    );
  };
  S.reset = () => {
    S.t0 = now();
    S.clickAt = null;
    S.commits = [];
    S.long = [];
    S.events = [];
    S.rects = { count: 0, ms: 0, slow: [] };
    for (const o of Object.values(S.observers)) {
      o.count = 0;
      o.ms = 0;
    }
  };
  S.collect = () => ({
    at: now(),
    clickAt: S.clickAt,
    seconds: (now() - S.t0) / 1000,
    commits: S.commits.length,
    commitTimes: S.commits,
    long: S.long,
    events: S.events,
    rects: S.rects,
    observers: S.observers,
    fetches: S.fetches,
    turns: document.querySelectorAll(".turn").length,
    nodes: document.getElementsByTagName("*").length,
    closedToolNodes: [
      ...document.querySelectorAll(
        ".tool-activity:not([open]) .execution-items",
      ),
    ].reduce((n, e) => n + e.getElementsByTagName("*").length, 0),
  });
}
const host = () => ({
  at: Date.now(),
  load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3),
  memory: readFileSync("/proc/meminfo", "utf8")
    .split("\n")
    .filter((l) => /^(MemAvailable|SwapFree|SwapTotal):/.test(l)),
  pressure: readFileSync("/proc/pressure/cpu", "utf8"),
  swap: readFileSync("/proc/vmstat", "utf8")
    .split("\n")
    .filter((l) => /^pswp/.test(l)),
  cpuTicks: readFileSync("/proc/stat", "utf8")
    .split("\n")
    .filter((l) => /^cpu/.test(l)),
});
const affinity = readFileSync("/proc/self/status", "utf8").match(
  /Cpus_allowed_list:\s+(\S+)/,
)?.[1];
const cgroup = () => {
  try {
    const path = readFileSync("/proc/self/cgroup", "utf8").trim().split("::")[1];
    return Object.fromEntries(["pids.max", "pids.peak", "pids.events", "memory.events", "cpu.max"].map((name) => {
      try { return [name, readFileSync(resolve("/sys/fs/cgroup", "." + path, name), "utf8").trim()]; }
      catch { return [name, null]; }
    }));
  } catch { return null; }
};
const report = {
  label,
  daily,
  switchOnly,
  fixtureSha256,
  assets,
  fixtureTurns: Object.fromEntries(Object.entries(fixture.details).map(([id, d]) => [id, d.turns.length])),
  web,
  cpuRate,
  cpuRateMeaning:
    "CDP renderer slowdown, not a measurement of whole-host contention",
  contention,
  affinity,
  node: process.version,
  profileSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"),
  lpNumThreads: process.env.LP_NUM_THREADS ?? null,
  cgroupBefore: cgroup(),
  hostBefore: host(),
  requests,
  blockedWrites,
  errors,
  phases: {},
};
let browser, burner;
try {
  if (contention) {
    assert.match(
      affinity,
      /^\d+$/,
      "contention run must be pinned to one CPU with taskset",
    );
    // Own short-lived process only: half of one CPU, no allocation or IO.
    // The entire acceptance scope (including Chromium) shares that CPU.
    burner = spawn(
      "python3",
      [
        "-c",
        `import time\nend=time.monotonic()+90\nwhile time.monotonic()<end:\n stop=time.monotonic()+0.05\n while time.monotonic()<stop: pass\n time.sleep(0.05)`,
      ],
      { stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      burner.once("spawn", resolve);
      burner.once("error", reject);
    });
  }
  browser = await chromium.launch({
    executablePath: "/usr/sbin/chromium",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.addInitScript(instrument, ids[1]);
  const cdp = await page.context().newCDPSession(page);
  const browserCdp = await browser.newBrowserCDPSession();
  const processMetrics = async () => {
    const { processInfo } = await browserCdp.send("SystemInfo.getProcessInfo");
    return processInfo
      .filter((p) => p.type === "renderer")
      .map((p) => {
        let rssKiB = null;
        try {
          rssKiB = Number(
            readFileSync(`/proc/${p.id}/status`, "utf8").match(
              /VmRSS:\s+(\d+)/,
            )?.[1],
          );
        } catch {}
        return { id: p.id, cpuTime: p.cpuTime, rssKiB };
      });
  };
  await cdp.send("Performance.enable");
  if (cpuRate !== 1)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
  await page.goto(origin + "/?shell=desktop");
  await page.locator("[data-composer-input]").waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => !document.querySelector(".conversation-scroll .loading-state"),
    { timeout: 20000 },
  );
  await page.waitForTimeout(700);
  const phase = async (name, act) => {
    await page.evaluate(() => t46.reset());
    const before = await metrics();
    const cpuBefore = await processMetrics();
    const wall = performance.now();
    const extra = await act();
    const paintOpportunityAt = await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))),
        ),
    );
    const after = await metrics();
    const raw = await page.evaluate(() => t46.collect());
    const cpuAfter = await processMetrics();
    report.phases[name] = {
      ...raw,
      ...extra,
      clickToMountedAnd2FramesMs: raw.clickAt === null ? null : paintOpportunityAt - raw.clickAt,
      wallMs: performance.now() - wall,
      rendererBefore: cpuBefore,
      rendererAfter: cpuAfter,
      metrics: Object.fromEntries(
        [
          "TaskDuration",
          "ScriptDuration",
          "LayoutDuration",
          "RecalcStyleDuration",
          "LayoutCount",
          "RecalcStyleCount",
        ].map((k) => [k, after[k] - before[k]]),
      ),
      heapMiB: after.JSHeapUsedSize / 1048576,
    };
    await writeFile(
      resolve(out, label + ".json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      name,
      JSON.stringify({
        wallMs: report.phases[name].wallMs,
        ...report.phases[name].metrics,
        nodes: raw.nodes,
      }),
    );
  };
  await browser.startTracing(page, {
    path: resolve(out, label + "-trace.json"),
    categories: [
      "devtools.timeline",
      "v8",
      "blink.user_timing",
      "disabled-by-default-v8.cpu_profiler",
    ],
  });
  await phase("switch-long", async () => {
    await page.locator(`[data-agent-id="${ids[0]}"] .agent-select`).click();
    await page.waitForFunction(
      (id) => {
        const d = t46.snapshots[id];
        return (
          d &&
          document.querySelector(".agent-row.selected")?.dataset.agentId ===
            id &&
          !document.querySelector(".conversation-scroll .loading-state") &&
          !!document.querySelector(`[data-turn-id="${d.turns.at(-1).id}"]`)
        );
      },
      ids[0],
      { timeout: 20000 },
    );
  });
  const composer = page.locator("[data-composer-input]");
  if (switchOnly) {
    await composer.fill("saved draft A");
    for (const [name, id] of [["switch-short", ids[1]], ["return-long", ids[0]]]) {
      await phase(name, async () => {
        await page.locator(`[data-agent-id="${id}"] .agent-select`).click();
        await page.waitForFunction((id) => {
          const d = t46.snapshots[id];
          return d && document.querySelector(".agent-row.selected")?.dataset.agentId === id &&
            !document.querySelector(".conversation-scroll .loading-state") &&
            document.querySelectorAll(".turn").length === d.turns.length &&
            !!document.querySelector(`[data-turn-id="${d.turns.at(-1).id}"]`);
        }, id, { timeout: 20000 });
      });
      if (id === ids[1]) await composer.fill("saved draft B");
    }
    assert.equal(await composer.textContent(), "saved draft A");
    assert.equal(await page.locator(".turn").count(), fixture.details.a.turns.length);
    report.switchIsolation = { allLoadedTurns: true, draftA: true };
  } else {
  await phase("quiet", () => page.waitForTimeout(2500));
  await composer.fill("x".repeat(200));
  const backspace = async () => {
    const start = performance.now();
    let n = 0;
    while (n < 45 && performance.now() - start < 5000) {
      await page.keyboard.press("Backspace");
      n++;
      await page.waitForTimeout(33);
    }
    assert.equal(await composer.textContent(), "x".repeat(200 - n));
    return { keys: n };
  };
  await phase("backspace", backspace);
  await phase("scroll", async () => {
    await page.locator(".conversation-scroll").hover();
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(150);
    }
  });
  await page.evaluate((id) => t46.streaming(id, true), ids[0]);
  await phase("stream", () => page.waitForTimeout(2500));
  await composer.fill("x".repeat(200));
  await phase("stream-backspace", backspace);
  await page.evaluate((id) => t46.streaming(id, false), ids[0]);
  }
  await browser.stopTracing();
  const trace = JSON.parse(
    await readFile(resolve(out, label + "-trace.json"), "utf8"),
  ).traceEvents;
  const counts = {};
  for (const e of trace) {
    if (e.ph === "X" && e.dur)
      counts[e.name] = (counts[e.name] || 0) + e.dur / 1000;
  }
  report.trace = Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 22),
  );
  report.chrome = browser.version();
  report.measurementLimit = "Click event to mounted view plus two animation frames is a paint opportunity, not physical presentation. Chromium fixture sample, not a deployed Windows measurement.";
  report.hostAfter = host();
  if (process.argv.includes("--acceptance")) {
    assert.equal(
      daily,
      false,
      "functional interactions require the masked fixture",
    );
    report.acceptance = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) =>
          localStorage.setItem(
            "yuzuno.appearance",
            JSON.stringify({ theme, fontSize: 20 }),
          ),
        theme,
      );
      await page.reload();
      await page.locator("[data-composer-input]").waitFor();
      await page.locator('[data-agent-id="a"] .agent-select').click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".turn").length ===
          t46.snapshots.a?.turns.length,
      );
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        theme,
      );
      assert.equal(
        await page.locator("html").getAttribute("data-font-size"),
        "20",
      );
      await composer.fill("saved draft A");
      const choices = page.locator("[data-turn-choice]");
      await choices.first().focus();
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("data-turn-id") ===
          t46.snapshots.a.turns[0].id,
      );
      assert.equal(await composer.textContent(), "saved draft A");
      await page.locator('[data-agent-id="b"] .agent-select').click();
      await page.waitForFunction(
        () => document.querySelectorAll(".turn").length === 2,
      );
      await composer.fill("saved draft B");
      // Separate click tasks let React process each selection while the detail
      // fetches overlap. The final view must match A, including its draft.
      for (const id of ["a", "b", "a"])
        await page.evaluate(
          (id) =>
            document
              .querySelector(`[data-agent-id="${id}"] .agent-select`)
              .click(),
          id,
        );
      await page.waitForFunction(
        () =>
          document.querySelectorAll(".turn").length ===
            t46.snapshots.a.turns.length &&
          document.querySelector("[data-composer-input]")?.textContent ===
            "saved draft A",
      );
      assert.equal(
        await page.locator(".turn").first().getAttribute("data-turn-id"),
        fixture.details.a.turns[0].id,
      );
      const box = await composer.boundingBox();
      assert.ok(
        box.width > 100 &&
          box.height > 10 &&
          box.x >= 0 &&
          box.x + box.width <= 1440,
      );
      report.acceptance.push({
        theme,
        fontSize: 20,
        allLoadedTurns: true,
        firstTurnJump: true,
        draftAndRapidSwitch: true,
        composerUsable: true,
      });
    }
  }
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  report.cgroupAfter = cgroup();
  burner?.kill("SIGTERM");
  await browser?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await writeFile(
    resolve(out, label + ".json"),
    JSON.stringify(report, null, 2),
  );
}
assert.equal(errors.length, 0, errors.join("\n"));
assert.equal(blockedWrites.length, 0, "unexpected write attempts");
