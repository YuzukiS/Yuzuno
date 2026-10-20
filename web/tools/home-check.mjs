// Home (T-85 slice 1): what needs you, this machine's load, then one panel
// per Project in Project Priority, each with its Core widgets and Brief.
// - Opens by default when the remembered Agent is outside the remembered
//   project, and from the toolbar.
// - Every Brief component draws in a section; previews and chart data
//   arriving never move the cards.
// - Seen sends exactly the versions shown; a newer version is updated again.
// - Replies (an option, free text), Defer and approvals post what Core
//   expects; a replied ask waits for its owner.
// - New content and Project Priority changes keep the cards where they were;
//   a panel's fold is remembered.
// - Unknown machine figures stay unknown; light, dark and 390 px fit.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/home");
await mkdir(output, { recursive: true });
// https, so the page is a secure context (replies use crypto.randomUUID).
const HOST = "yuzuno-home.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], screenshots: [], observations: [] };
let page;
/** One numbered check: PASS, or FAIL with a screenshot, and the next goes on. */
async function step(name, run) {
  try {
    const extra = (await run()) || {};
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    const file = `fail-${report.failures.length + 1}.png`;
    report.failures.push({ name, error: error.stack || String(error), screenshot: file });
    console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
    await page?.screenshot({ path: resolve(output, file) }).catch(() => {});
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A small PNG (a 4 × 3 grid of samples), served as an image snapshot.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const gridImage = png(320, 180, (x, y) => {
  const tile = Math.floor(x / 80) + 4 * Math.floor(y / 60);
  const edge = x % 80 < 2 || y % 60 < 2;
  return edge ? [250, 250, 245] : [60 + tile * 15, 120 + ((tile * 37) % 100), 200 - tile * 12];
});
const metricsCsv = ["epoch,loss,accuracy", ...Array.from({ length: 30 }, (_, i) => `${i + 1},${(1.2 / (i + 1)).toFixed(4)},${(0.6 + i / 80).toFixed(3)}`)].join("\n") + "\n";
const trainLog = Array.from({ length: 300 }, (_, i) => `[epoch ${Math.floor(i / 10) + 1}] step ${i + 1}: loss ${(2 / (i + 1)).toFixed(5)} · line ${i + 1}`).join("\n") + "\n";
const curve = (shift) => Array.from({ length: 400 }, (_, i) => [i * 30, Number((2.4 * Math.exp(-i / 90) + shift + 0.03 * Math.sin(i / 5)).toFixed(4))]);

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const baseAgent = {
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  color: "sage",
  createdAt: "",
  updatedAt: "",
  status: "idle",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  closedAt: null,
};
const agents = [
  { ...baseAgent, id: "mori", name: "Mori", projectId: "p1", status: "waiting", pendingCount: 1 },
  { ...baseAgent, id: "kumo", name: "Kumo", projectId: "p1", harness: "claude", model: "sonnet" },
  { ...baseAgent, id: "hana", name: "Hana", projectId: "p2", status: "error", error: "Claude CLI exited: rate limited" },
  { ...baseAgent, id: "yuki", name: "Yuki", projectId: null },
];
const projects = [
  { id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Paper notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
];
const approval = {
  id: "req-1",
  agentId: "mori",
  method: "item/commandExecution/requestApproval",
  params: {
    command: "npm run migrate -- --dry-run",
    cwd: "/fixture/app",
    reason: "Run the database migration as a dry run",
    itemId: "cmd-1",
    turnId: "mori-t1",
    availableDecisions: ["accept", "decline", "cancel"],
  },
  createdAt: iso(-14 * MIN),
};
const detail = (agent) => ({
  agent,
  pending: agent.id === "mori" && f.pending.length ? [approval] : [],
  messageReceipts: [],
  artifacts: [],
  turns: [
    {
      id: `${agent.id}-t1`,
      status: "completed",
      items: [
        { id: `${agent.id}-u`, type: "userMessage", content: [{ type: "text", text: "看一下进度" }] },
        { id: `${agent.id}-r`, type: "agentMessage", text: `${agent.name} 在这里。` },
      ],
    },
  ],
});
const owner = (id) => ({ agentId: id, name: agents.find((a) => a.id === id).name, state: "active" });
const spec = (children, extra = {}) => ({
  root: "body",
  elements: { body: { type: "BriefBody", props: {}, children: children.map(([key]) => key) }, ...Object.fromEntries(children), ...extra },
});
const node = (type, props, children = []) => ({ type, props, children });
const markdown = (text) => node("Markdown", { text });
const section = (fields) => ({
  updatedTurnId: null,
  updatedAt: iso(-20 * MIN),
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...fields,
});
const csvAttachment = (name, size, extra = {}) => ({ name, kind: "data", mime: "text/csv", size, snapshot: true, mayChange: false, takenAt: iso(-30 * MIN), ...extra });

const buildBody = spec(
  [
    ["summary", markdown("Main is green again after the **cache fix**. The flaky test was a race on the store reopen; see the log excerpt.\n\n> Store reopen tests race under parallel threads.\n\n```rust\nfn main() {\n    println!(\"cargo test -j2 -- --test-threads=1\");\n}\n```\n\n```text\ntest project_brief::tests::seen_marks_the_shown_version ... ok\ntest result: ok. 412 passed; 0 failed\n```")],
    ["formula", node("Math", { tex: "\\Delta t = \\frac{1}{n}\\sum_{i=1}^{n} (t_i - \\bar t)^2", display: true })],
    ["checks", node("Group", { title: "Checks" }, ["list", "plan"])],
    ["findings", node("Findings", { title: "Review findings", items: [
      { id: "f1", source: "https://github.com/example/yuzuno-next/pull/71", severity: "high", text: "The reply path loses the client id after a reload." },
      { id: "f2", source: "web/src/home/Home.tsx:120", severity: "medium", text: "The order is saved before the panels settle." },
      { id: "f3", source: "CI", severity: "info", text: "Lint is clean." },
    ] })],
    ["metrics", node("Metrics", { items: [
      { label: "Test pass rate", value: 0.93, previous: 0.91 },
      { label: "Build time", value: 212, unit: "s", previous: 245 },
      { label: "Bundle", value: 1.84, unit: "MB", previous: 1.84 },
      { label: "Status", value: "green", previous: "red" },
    ] })],
    ["timings", node("Table", { id: "timings", title: "Build timings", columns: [{ key: "step", label: "Step" }, { key: "seconds", label: "Seconds" }, { key: "cached", label: "Cached" }], rows: [
      { id: "r1", cells: { step: "tsc -b", seconds: 31, cached: false } },
      { id: "r2", cells: { step: "vite build", seconds: 48, cached: true } },
      { id: "r3", cells: { step: "cargo test", seconds: 133, cached: false }, sourceIds: ["log"] },
    ] })],
    ["sources", node("Sources", { items: [{ id: "log", label: "CI log", href: "https://github.com/example/yuzuno-next/actions/runs/900" }] })],
  ],
  {
    list: node("Checklist", { title: "Release checklist", items: [
      { id: "c1", text: "Typecheck", done: true },
      { id: "c2", text: "Browser checks", done: false },
      { id: "c3", text: "Lab Core with real Agents", done: false },
    ] }),
    plan: node("Plan", { title: "Plan", steps: [
      { id: "s1", text: "Fix the flaky test", state: "done" },
      { id: "s2", text: "Re-run CI", state: "doing" },
      { id: "s3", text: "Publish core.8", state: "todo" },
      { id: "s4", text: "Remote snapshots", state: "blocked" },
    ] }),
  },
);
const refsBody = spec([
  ["refs", node("LiveRefs", { items: [
    { kind: "task", id: "T-85", label: "Home V1" },
    { kind: "pr", id: "example/yuzuno-next#71" },
    { kind: "ci", id: "github:1:900:1", label: "CI on main" },
    { kind: "job", id: "job-1" },
    { kind: "review", id: "rv-1" },
    { kind: "agent", id: "kumo" },
    { kind: "machine", id: "local", label: "Core host" },
    { kind: "task", id: "T-999" },
  ] })],
]);
const refStates = {
  "task:T-85": { kind: "task", id: "T-85", found: true, title: "Home V1 slice 1", state: "doing", tone: "active", observedAt: iso(-MIN) },
  "pr:example/yuzuno-next#71": { kind: "pr", id: "example/yuzuno-next#71", found: true, title: "Home V1", state: "open", tone: "neutral", url: "https://github.com/example/yuzuno-next/pull/71" },
  "ci:github:1:900:1": { kind: "ci", id: "github:1:900:1", found: true, state: "failed", tone: "attention", url: "https://github.com/example/yuzuno-next/actions/runs/900" },
  "job:job-1": { kind: "job", id: "job-1", found: true, title: "cargo test -j2", state: "running", tone: "active" },
  "review:rv-1": { kind: "review", id: "rv-1", found: true, title: "Review round 1", state: "passed", tone: "ok", taskId: "task-85" },
  "agent:kumo": { kind: "agent", id: "kumo", found: true, title: "Kumo", state: "idle", tone: "neutral" },
  "machine:local": { kind: "machine", id: "local", found: true, title: "Core host", state: "reachable", tone: "ok" },
  "task:T-999": { kind: "task", id: "T-999", found: false },
};
const resultsBody = spec([
  ["inline", node("LineChart", { id: "inline", title: "Validation accuracy", x: { label: "Epoch" }, y: { label: "Accuracy", unit: "%" }, series: [
    { name: "baseline", points: Array.from({ length: 20 }, (_, i) => [i + 1, Number((60 + i * 1.4).toFixed(1))]) },
    { name: "ours", points: Array.from({ length: 20 }, (_, i) => [i + 1, Number((62 + i * 1.7).toFixed(1))]) },
  ] })],
  ["curve", node("LineChart", { id: "curve", title: "Training loss (from curve.csv)", x: { label: "Step" }, y: { label: "Loss" }, data: { attachment: "curve.csv", x: "step", series: [{ name: "train", column: "train" }, { name: "val", column: "val" }] } })],
  ["scatter", node("ScatterChart", { id: "scatter", title: "Size vs. score", x: { label: "Parameters", unit: "M" }, y: { label: "Score" }, series: [
    { name: "runs", points: [[12, 61.2], [24, 66.8], [48, 70.1], [96, 73.5], [190, 75.2], [380, 77.9]] },
  ] })],
  ["bars", node("BarChart", { id: "bars", title: "Wall time per stage", x: { label: "Stage" }, y: { label: "Time", unit: "min" }, series: [
    { name: "this run", points: [["prep", 4], ["train", 38], ["eval", 9], ["export", 2]] },
  ] })],
]);
const filesBody = spec([
  ["files", node("Attachments", { items: [
    { name: "grid.png", caption: "Samples at epoch 40" },
    { name: "metrics.csv" },
    { name: "train.log" },
    { name: "epoch-40.safetensors", caption: "Checkpoint, too large to keep" },
  ] })],
]);

/** What Core reports, changed step by step below. */
const f = {
  order: ["p1", "p2"],
  pending: [{ ...approval, agentName: "Mori" }],
  sections: {
    p1: [
      section({
        key: "release",
        kind: "ask",
        title: "Ship the onboarding copy today?",
        version: 2,
        owner: owner("kumo"),
        body: spec([["text", markdown("The copy review is done. Two strings still mention the old menu.")]]),
        ask: { question: "Ship today with the two strings fixed, or wait for the menu change?", reply: { options: [{ id: "ship", label: "Ship today" }, { id: "wait", label: "Wait for the menu" }], freeText: true }, state: "open" },
      }),
      section({ key: "build", kind: "report", title: "Build health", version: 3, owner: owner("mori"), body: buildBody, seen: { version: 2, at: iso(-60 * MIN) } }),
      section({ key: "build/review", kind: "report", title: "Review notes", version: 1, owner: owner("kumo"), body: spec([["text", markdown("Two findings left; both are in the reply path.")]]), seen: { version: 1, at: iso(-60 * MIN) } }),
      section({
        key: "naming",
        kind: "ask",
        title: "Name for the brief tool",
        version: 1,
        owner: owner("mori"),
        body: spec([["text", markdown("Agents call it every turn, so the name should be short.")]]),
        ask: {
          question: "Which name should the tool use?",
          reply: { choice: { a: { id: "brief", label: "brief_update", detail: "Matches the design document." }, b: { id: "report", label: "report_update", detail: "Shorter in logs." } }, freeText: { prompt: "Or suggest another name…" } },
          state: "open",
        },
        time: { due: iso(26 * 60 * MIN) },
      }),
      section({ key: "refs", kind: "status", title: "Where things stand", version: 5, owner: owner("mori"), body: refsBody, refs: refStates, seen: { version: 5, at: iso(-MIN) }, status: { asOf: iso(-10 * MIN), validFor: 3600, stale: false }, time: { nextUpdate: iso(20 * MIN) } }),
    ],
    p2: [
      section({ key: "results", kind: "report", title: "Experiment 12 results", version: 2, owner: owner("hana"), body: resultsBody, attachments: [csvAttachment("curve.csv", 48_210)] }),
      section({
        key: "files",
        kind: "report",
        title: "Run artefacts",
        version: 1,
        owner: owner("hana"),
        body: filesBody,
        attachments: [
          { name: "grid.png", kind: "image", mime: "image/png", size: gridImage.length, snapshot: true, mayChange: false, takenAt: iso(-30 * MIN) },
          csvAttachment("metrics.csv", metricsCsv.length),
          { name: "train.log", kind: "text", mime: "text/plain", size: trainLog.length, snapshot: true, mayChange: false, takenAt: iso(-30 * MIN) },
          { name: "epoch-40.safetensors", kind: "data", mime: "application/octet-stream", size: 3_400_000_000, snapshot: false, mayChange: true, takenAt: iso(-30 * MIN), path: "/data/runs/exp-12/checkpoints/epoch-40.safetensors" },
        ],
      }),
      section({ key: "queue", kind: "status", title: "GPU queue", version: 1, owner: owner("hana"), body: spec([["text", markdown("Two runs queued behind exp-12.")]]), status: { asOf: iso(-3 * 60 * MIN), validFor: 3600, stale: true }, seen: { version: 1, at: iso(-60 * MIN) } }),
    ],
  },
  history: {
    p1: [],
    p2: [section({ key: "baseline", kind: "report", title: "Baseline numbers", version: 3, owner: owner("hana"), body: spec([["text", markdown("Baseline reproduced within 0.2 points.")]]), seen: { version: 3, at: iso(-2 * 86400_000) }, history: true })],
  },
  version: { p1: 14, p2: 6 },
};
const sectionByKey = (pid, key) => f.sections[pid].find((s) => s.key === key);
const needsYou = () => [
  ...f.pending.map((r) => ({ kind: "approval", projectId: "p1", agentId: r.agentId, agentName: r.agentName, requestId: r.id, title: r.params.reason, since: r.createdAt })),
  ...["p1", "p2"].flatMap((pid) =>
    f.sections[pid]
      .filter((s) => s.kind === "ask" && s.ask.state === "open" && !(s.ask.deferredUntil && Date.parse(s.ask.deferredUntil) > Date.now()))
      .map((s) => ({ kind: "ask", projectId: pid, agentId: s.owner.agentId, agentName: s.owner.name, sectionKey: s.key, title: s.title, since: s.updatedAt })),
  ),
];
const unseen = (pid) => f.sections[pid].filter((s) => !s.seen || s.seen.version < s.version).length;
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: f.order,
  needsYou: needsYou(),
  projects: projects.map((p) => ({
    project: { id: p.id, name: p.name },
    agents: p.id === "p1" ? { working: 0, idle: 1, waiting: 1, error: 0, offline: 0, total: 2 } : { working: 0, idle: 0, waiting: 0, error: 1, offline: 0, total: 1 },
    errors: p.id === "p2" ? [{ agentId: "hana", agentName: "Hana", message: "Claude CLI exited: rate limited", at: iso(-8 * MIN) }] : [],
    pending: p.id === "p1" ? f.pending : [],
    jobs: p.id === "p1"
      ? [{ id: "job-1", name: "cargo test -j2", status: "running", agentId: "mori", agentName: "Mori", taskRef: "T-85" }]
      : [{ id: "job-2", name: "train exp-12", status: "queued", agentId: "hana", agentName: "Hana", taskRef: null }],
    brief: { version: f.version[p.id], sections: f.sections[p.id], history: f.history[p.id] },
    unseen: unseen(p.id),
    missing: p.id === "p1" ? [{ agentId: "kumo", agentName: "Kumo", turnId: "kumo-t9", at: iso(-40 * MIN), outcome: "reminded" }] : [],
  })),
});
const machineLoad = () => ({
  at: new Date().toISOString(),
  cpu: { cores: 32, totalPct: 41, jobsPct: 12, agentsPct: null, otherPct: null },
  memory: { totalMiB: 40107, usedMiB: 17229, availableMiB: 22878, jobsMiB: 4160, agentsMiB: null },
  gpus: [{ name: "NVIDIA GeForce RTX 5090", utilPct: 63, memUsedMiB: 12034, memTotalMiB: 32607, attribution: "unknown" }],
  jobs: [{ id: "job-1", name: "cargo test -j2", agentId: "mori", agentName: "Mori", projectId: "p1", cpuPct: null, memMiB: 2048 }],
});
const github = "https://github.com/example/yuzuno-next";
const repoActivity = () => ({
  observedAt: iso(-2 * MIN),
  repositories: [
    {
      id: 1,
      fullName: "example/yuzuno-next",
      url: github,
      defaultBranch: "main",
      observedAt: iso(-2 * MIN),
      stale: false,
      commits: [
        { sha: "c40b8361d2a7e5f4b3c2a1908f7e6d5c4b3a2918", title: "Merge T-82 UI refine 5", author: "example", at: iso(-90 * MIN), url: `${github}/commit/c40b8361d2a7e5f4b3c2a1908f7e6d5c4b3a2918` },
        { sha: "eed00f7a1b2c3d4e5f60718293a4b5c6d7e8f901", title: "Accept a Claude review alias only through that review's own resolution", author: "example", at: iso(-5 * 60 * MIN), url: `${github}/commit/eed00f7a1b2c3d4e5f60718293a4b5c6d7e8f901` },
      ],
      pulls: [{ number: 71, title: "Home V1 slice 1", author: "example", url: `${github}/pull/71`, draft: false, ci: { state: "failure" } }],
      pullsTotal: 1,
      runs: [
        { id: 900, name: "CI", branch: "main", status: "completed", conclusion: "failure", at: iso(-30 * MIN), url: `${github}/actions/runs/900` },
        { id: 901, name: "CI", branch: "feat/t85-home-v1", status: "in_progress", conclusion: null, at: iso(-3 * MIN), url: `${github}/actions/runs/901` },
      ],
    },
  ],
});
// Chart data and attachment bytes wait behind this until released, so the
// check sees the cards before and after they arrive.
let releaseData;
let dataGate = new Promise((done) => (releaseData = done));
// The first machine reading is held back, as Core's first sample takes a second.
let releaseMachine;
const machineGate = new Promise((done) => (releaseMachine = done));

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const writes = report.writes;
const writesTo = (pattern) => writes.filter((w) => pattern.test(w.path));
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  const method = request.method();
  if (method !== "GET" && path.startsWith("/api/")) {
    const body = request.postDataJSON();
    // A read that happens to be a POST: the project's linked repositories.
    if (path === "/api/collaboration/github_repositories")
      return route.fulfill({
        json: body?.projectId === "p1"
          ? { repositories: [{ id: 1, fullName: "example/yuzuno-next", url: "https://github.com/example/yuzuno-next", syncedAt: iso(-3 * MIN), error: null }], links: [] }
          : { repositories: [], links: [] },
      });
    writes.push({ method, path, body, at: Date.now() });
    let match;
    if ((match = /^\/api\/projects\/(p[12])\/brief\/seen$/.exec(path))) {
      const marks = body.all ? f.sections[match[1]].map((s) => ({ key: s.key, version: s.version })) : body.sections;
      for (const mark of marks) {
        const s = sectionByKey(match[1], mark.key);
        if (s && (!s.seen || s.seen.version < mark.version)) s.seen = { version: mark.version, at: new Date().toISOString() };
      }
      return route.fulfill({ json: { ok: true } });
    }
    if ((match = /^\/api\/projects\/(p[12])\/brief\/reply$/.exec(path))) {
      const s = body.key && sectionByKey(match[1], body.key);
      if (s?.ask) s.ask = { ...s.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: body.text };
      return route.fulfill({ json: { input: { text: body.text, clientMessageId: body.clientMessageId }, status: "accepted", turnId: `${body.agentId}-t2`, error: null } });
    }
    if ((match = /^\/api\/projects\/(p[12])\/brief\/defer$/.exec(path))) {
      const s = sectionByKey(match[1], body.key);
      s.ask = { ...s.ask, deferredUntil: body.until };
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/home/order") {
      f.order = body.projectIds;
      return route.fulfill({ json: { order: f.order } });
    }
    if (path === "/api/requests/req-1/respond") {
      f.pending = [];
      agents[0] = { ...agents[0], pendingCount: 0, status: "working" };
      return route.fulfill({ json: { ok: true } });
    }
    report.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const agent = agents.find((a) => path === `/api/agents/${a.id}`);
  if (agent) return route.fulfill({ json: detail(agent) });
  if (path === "/api/machine-load") {
    await machineGate;
    return route.fulfill({ json: machineLoad() });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 2, tasks: 1 }, p2: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/projects/p1/repo-activity": repoActivity,
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    // The Agent list reads which Agents wait on CI (T-122); none here.
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path === "/api/projects/p2/brief/chart/results/curve") {
    await dataGate;
    const series = [
      { name: "train", points: curve(0.1) },
      { name: "val", points: curve(0.25) },
    ];
    return route.fulfill({ json: { series, downsampled: true, sourcePoints: 12000 } });
  }
  const attachment = /^\/api\/projects\/p2\/brief\/attachments\/files\/(.+)$/.exec(path);
  if (attachment) {
    await dataGate;
    const name = decodeURIComponent(attachment[1]);
    if (name === "grid.png") return route.fulfill({ body: gridImage, contentType: "image/png" });
    if (name === "metrics.csv") return route.fulfill({ body: metricsCsv, contentType: "text/csv" });
    if (name === "train.log") return route.fulfill({ body: trainLog, contentType: "text/plain" });
  }
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType:
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" }[extname(file)] ||
      "application/octet-stream",
  });
}

const viewOf = (pid) => page.locator(`.home-view #home-project-${pid}`);
const card = (pid, key) => viewOf(pid).locator(`[data-section-key="${key}"]`);
const homeButton = () => page.locator(".toolbar-nav .catchup-nav").first();
/** Core says the Brief changed: the same notice Home refreshes on. */
const briefChanged = () =>
  page.evaluate(() =>
    window.__homeEvents?.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: "" }),
  );
/** Every card's place: in the scrolled content, and from its panel's top. */
const layout = () =>
  page.evaluate(() => {
    const panels = [...document.querySelectorAll(".home-view .home-panel")];
    // The nearest scroll container by style, the same one whether or not it
    // overflows yet.
    let scroller = document.scrollingElement;
    for (let el = panels[0]?.parentElement; el && el !== document.body; el = el.parentElement)
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        scroller = el;
        break;
      }
    const origin = scroller === document.scrollingElement ? -window.scrollY : scroller.getBoundingClientRect().top - scroller.scrollTop;
    const round = (n) => Math.round(n * 10) / 10;
    return {
      order: panels.map((p) => p.dataset.homeProject),
      panels: Object.fromEntries(
        panels.map((p) => {
          const box = p.getBoundingClientRect();
          return [
            p.dataset.homeProject,
            {
              top: round(box.top - origin),
              height: round(box.height),
              cards: Object.fromEntries(
                [...p.querySelectorAll("[data-section-key]")].map((c) => {
                  const r = c.getBoundingClientRect();
                  return [c.dataset.sectionKey, { top: round(r.top - origin), inPanel: round(r.top - box.top), height: round(r.height), version: Number(c.dataset.sectionVersion) }];
                }),
              ),
            },
          ];
        }),
      ),
    };
  });
/** The layout once two reads 200 ms apart agree. */
async function settled() {
  let last = JSON.stringify(await layout());
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const now = JSON.stringify(await layout());
    if (now === last) return JSON.parse(now);
    last = now;
  }
  throw new Error("Home kept moving");
}
const moved = (before, after, keys, field = "top") =>
  keys.map((key) => ({ key, by: Math.abs(after[key][field] - before[key][field]) })).filter((m) => m.by > 1);
const shot = async (name, locator) => {
  if (locator) await locator.screenshot({ path: resolve(output, name), animations: "disabled" });
  else await page.screenshot({ path: resolve(output, name), animations: "disabled" });
  report.screenshots.push(name);
};
const setTheme = async (theme) => {
  await page.evaluate((theme) => {
    const saved = JSON.parse(localStorage.getItem("yuzuno.appearance"));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ ...saved, theme }));
    window.dispatchEvent(new StorageEvent("storage", { key: "yuzuno.appearance" }));
  }, theme);
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
};
const scrollHomeTo = (selector) =>
  page.evaluate((selector) => {
    const target = selector ? document.querySelector(selector) : null;
    if (target) target.scrollIntoView({ block: "start", behavior: "instant" });
    else for (const el of [document.querySelector(".home-view"), document.querySelector(".main-panel")]) el?.scrollTo({ top: 0, behavior: "instant" });
  }, selector);

/** Readable and inside the window: no horizontal overflow, headers with contrast. */
const fit = () =>
  page.evaluate(() => {
    const view = document.querySelector(".home-view");
    const needs = document.querySelector(".home-needs-you").getBoundingClientRect();
    // rgb() and color(srgb …), which color-mix() computes to.
    const parse = (color) => {
      const rgb = color.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const [r, g, b, a = 1] = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r, g, b, a };
      }
      const srgb = color.match(/color\(srgb ([^)]+)\)/);
      if (srgb) {
        const [r, g, b, a = 1] = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
        return { r: r * 255, g: g * 255, b: b * 255, a };
      }
      return null;
    };
    const lum = ({ r, g, b }) => {
      const c = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    // The backgrounds behind the text up to the first opaque one, blended.
    const background = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      let out = { r: 255, g: 255, b: 255 };
      for (const c of layers.reverse()) out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) };
      return out;
    };
    const contrast = (el) => {
      const fg = parse(getComputedStyle(el).color);
      if (!fg) throw new Error(`unread text colour ${getComputedStyle(el).color}`);
      const [a, b] = [lum(fg), lum(background(el))].sort((x, y) => y - x);
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
    };
    const viewRight = view.getBoundingClientRect().right;
    const headers = [...view.querySelectorAll("h1, h2, h3, h4, .home-kind, .home-needs-text strong, .home-needs-source")]
      .filter((h) => h.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(h).fontSize) > 0)
      .map((h) => {
        // Needs-you chips scroll sideways and end in an ellipsis by design.
        const chip = !!h.closest(".home-needs-list");
        return {
          text: h.textContent.trim().slice(0, 40),
          size: parseFloat(getComputedStyle(h).fontSize),
          contrast: contrast(h),
          clipped: !chip && h.scrollWidth > h.clientWidth + 1,
          outside: !chip && h.getBoundingClientRect().right > viewRight + 1,
        };
      });
    const wide = [...view.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.right > viewRight + 1 &&
          s.visibility !== "hidden" &&
          !el.closest(".home-needs-list, .result-table-scroll, .brief-preview-frame, .katex-display, pre, .sr-only, .katex-mathml, .recharts-tooltip-wrapper")
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} right ${Math.round(el.getBoundingClientRect().right)}`);
    return {
      width: innerWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      viewOverflow: view.scrollWidth > view.clientWidth + 1,
      viewBox: [Math.round(view.getBoundingClientRect().left), Math.round(viewRight)],
      wide,
      needsInside: needs.left >= 0 && needs.right <= innerWidth && needs.top >= 0 && needs.bottom <= innerHeight,
      headers,
    };
  });
/** Coloured left borders wider than 2 px, and main cards with uneven sides. */
const sideTabs = () =>
  page.evaluate(() => {
    const coloured = (color) => {
      const m = color.match(/(?:rgba?|color)\(([^)]+)\)/);
      const parts = m ? m[1].replace(/^srgb\s+/, "").split(/[\s,/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0];
      return (parts[3] ?? 1) > 0;
    };
    const tabs = [...document.querySelectorAll(".home-view *")]
      .map((el) => ({ el, s: getComputedStyle(el) }))
      .filter(({ s }) => parseFloat(s.borderLeftWidth) > 2 && !["none", "hidden"].includes(s.borderLeftStyle) && coloured(s.borderLeftColor))
      .map(({ el, s }) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} ${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`);
    const cards = [".home-needs-you", ".home-needs-item", ".home-machines", ".home-panel", ".home-section", ".home-choice", ".home-approval", ".pending-card", ".brief-chart", ".brief-attachment", ".home-job"].flatMap((selector) =>
      [...document.querySelectorAll(`.home-view ${selector}`)].slice(0, 3).map((el) => {
        const s = getComputedStyle(el);
        return { selector, left: s.borderLeftWidth, right: s.borderRightWidth, leftColor: s.borderLeftColor, rightColor: s.borderRightColor, boxShadow: s.boxShadow };
      }),
    );
    const uneven = cards.filter((c) => c.left !== c.right || c.leftColor !== c.rightColor || parseFloat(c.left) > 2 || /inset/.test(c.boxShadow));
    return { tabs, cards, uneven };
  });
const ensureHome = async () => {
  if (!(await page.locator(".home-view").isVisible())) await homeButton().click();
  await page.locator(".home-view .home-panel").first().waitFor();
};
const needsShown = () => page.locator(".home-needs-item").evaluateAll((items) => items.map((i) => i.dataset.needsYou));

try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    // Live updates open, as with a healthy Core; the check sends the notices.
    window.EventSource = class {
      constructor() {
        window.__homeEvents = this;
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    if (!localStorage.getItem("home-fixture")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
      // The remembered Agent has no project; the remembered scope is one project.
      localStorage.setItem("yuzuno.selected", JSON.stringify("yuki"));
      localStorage.setItem("yuzuno.projectScope.ws", JSON.stringify("project:p1"));
      localStorage.setItem("home-fixture", "seeded");
    }
  });
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`console: ${message.text()}`);
  });
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  const p1 = viewOf("p1");
  const build = card("p1", "build");

  await step("1 Home opens by default for an out-of-scope remembered Agent and from the toolbar: needs-you (approval + asks), Machines (its first reading moves no panel), panels in order", async () => {
    await page.locator(".home-view .home-panel").first().waitFor();
    assert.equal(await homeButton().getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".conversation-header").count(), 0, "no conversation is opened into view");
    const needs = await needsShown();
    assert.deepEqual(needs, ["approval:req-1", "ask:p1:release", "ask:p1:naming"]);
    assert.match(await page.locator(".home-needs-you h2").innerText(), /Needs you\s*3/);
    // Until the first reading the widget already has its height.
    await page.locator('.home-machines .home-machine[aria-busy="true"]').waitFor();
    const reading = await settled();
    releaseMachine();
    await page.locator(".home-machines .home-machine:not([aria-busy])").waitFor();
    const shown = await settled();
    const moved = Object.keys(reading.panels).map((pid) => ({ pid, by: Math.abs(shown.panels[pid].top - reading.panels[pid].top) })).filter((m) => m.by > 1);
    assert.deepEqual(moved, [], "the first machine reading moves no panel");
    assert.deepEqual(shown.order, f.order, "panels in Project Priority");
    for (const pid of ["p1", "p2"]) assert.equal(await viewOf(pid).locator(".home-panel-toggle").getAttribute("aria-expanded"), "true", pid);
    await page.getByRole("button", { name: "Open Mori", exact: true }).click();
    await page.locator(".conversation-header h1", { hasText: "Mori" }).waitFor();
    assert.equal(await page.locator(".home-view").count(), 0);
    await homeButton().click();
    await page.locator(".home-view .home-panel").first().waitFor();
    assert.equal(await homeButton().getAttribute("aria-current"), "page");
    return { needs, order: shown.order };
  });

  await step("2 every Brief component draws (Markdown with code and log, KaTeX, checklist, plan, findings, metric deltas, table, sources; inline, attachment, scatter and bar charts; live refs with states; image, CSV, text tail and referenced attachments) with no console errors; data arriving moves no card", async () => {
    await page.setViewportSize({ width: 1440, height: 2400 });
    await card("p2", "files").locator(".brief-image").scrollIntoViewIfNeeded();
    const beforeData = await settled();
    assert.ok(await viewOf("p2").getByText("Loading chart data…").count(), "the attachment chart waits for its data");
    releaseData();
    await until("chart data", () => viewOf("p2").getByText("Downsampled from 12,000 points").count());
    await until("the image", () => card("p2", "files").locator(".brief-image img").evaluate((img) => img.complete && img.naturalWidth === 320));
    await until("the previews", async () => (await card("p2", "files").locator(".brief-preview table tbody tr").count()) === 20 && (await card("p2", "files").locator(".brief-tail").count()) === 1);
    const afterData = await settled();
    const problems = [];
    for (const pid of ["p1", "p2"]) {
      const keys = Object.keys(beforeData.panels[pid].cards);
      const shifts = [...moved(beforeData.panels[pid].cards, afterData.panels[pid].cards, keys), ...moved(beforeData.panels[pid].cards, afterData.panels[pid].cards, keys, "height").map((m) => ({ ...m, height: true }))];
      if (shifts.length)
        problems.push(`${pid}: data arriving moved or resized cards ${JSON.stringify(shifts)}; heights ${JSON.stringify(Object.fromEntries(keys.map((k) => [k, [beforeData.panels[pid].cards[k].height, afterData.panels[pid].cards[k].height]])))}`);
    }
    const expect = async (what, test) => {
      try {
        await test();
      } catch (error) {
        problems.push(`${what}: ${String(error.message).split("\n")[0]}`);
      }
    };
    await expect("code block", async () => assert.match(await build.locator(".brief-markdown pre code").first().innerText(), /fn main\(\)/));
    await expect("log excerpt", async () => assert.match(await build.locator(".brief-markdown pre code").nth(1).innerText(), /412 passed/));
    await expect("blockquote", async () => assert.equal(await build.locator(".brief-markdown blockquote").count(), 1));
    await expect("KaTeX", async () => assert.equal(await build.locator(".brief-math.is-display .katex-display .katex").count(), 1));
    await expect("KaTeX errors", async () => assert.equal(await page.locator(".home-view .katex-error").count(), 0));
    await expect("group", async () => assert.equal(await build.locator(".brief-group > h4").innerText(), "Checks"));
    await expect("checklist", async () => assert.match(await build.locator('.brief-list[aria-label="Release checklist"] header').innerText(), /1 of 3 done/));
    await expect("plan", async () => assert.deepEqual(await build.locator('.brief-list[aria-label="Plan"] .brief-chip').allInnerTexts(), ["Done", "Doing", "To do", "Blocked"]));
    await expect("findings", async () => assert.deepEqual(await build.locator(".brief-findings .brief-chip").evaluateAll((els) => els.map((e) => e.dataset.severity)), ["high", "medium", "info"]));
    await expect("finding link", async () => assert.equal(await build.locator('.brief-findings a[href="https://github.com/example/yuzuno-next/pull/71"]').count(), 1));
    await expect("metric deltas", async () =>
      assert.deepEqual(
        await build.locator(".brief-metrics > div").evaluateAll((items) => items.map((i) => i.querySelector(".brief-delta")?.textContent.replace(/\s*since the previous version/, "").trim() ?? null)),
        ["+0.02", "−33 s", "±0 MB", "Previously red"],
      ));
    await expect("table", async () => assert.equal(await build.locator(".result-table-section tbody tr").count(), 3));
    await expect("sources", async () => assert.equal(await build.locator(".result-source-list a, .result-source-list button").count(), 1));
    await expect("sub-topic", async () => {
      assert.equal(await card("p1", "build/review").locator("xpath=..").getAttribute("class"), "home-subs");
      assert.match(await card("p1", "build/review").locator(".home-owner").innerText(), /^by Kumo$/);
    });
    const refs = card("p1", "refs");
    await expect("live refs", async () =>
      assert.deepEqual(
        await refs.locator(".brief-ref").evaluateAll((els) => els.map((e) => [e.dataset.kind, e.dataset.tone, e.querySelector(".brief-ref-state")?.textContent || null])),
        [["task", "active", "doing"], ["pr", "neutral", "open"], ["ci", "attention", "failed"], ["job", "active", "running"], ["review", "ok", "passed"], ["agent", "neutral", "idle"], ["machine", "ok", "reachable"], ["task", "missing", "not found"]],
      ));
    await expect("PR link", async () => assert.equal(await refs.locator('a.brief-ref[href="https://github.com/example/yuzuno-next/pull/71"]').count(), 1));
    await expect("status time", async () => assert.match(await refs.locator(".home-section-time").innerText(), /Data as of .*Next update in (19|20) min/s));
    const results = card("p2", "results");
    await expect("charts", async () => {
      assert.equal(await results.locator(".brief-chart").count(), 4);
      assert.equal(await results.locator(".brief-chart .recharts-surface").count(), 4);
    });
    await expect("inline line chart", async () => assert.equal(await results.locator('.brief-chart[aria-label="Validation accuracy"] .recharts-line').count(), 2));
    await expect("attachment line chart", async () => {
      assert.equal(await results.locator('.brief-chart[aria-label="Training loss (from curve.csv)"] .recharts-line').count(), 2);
      const foot = results.locator('.brief-chart[aria-label="Training loss (from curve.csv)"] .brief-chart-foot');
      assert.match(await foot.innerText(), /Data: curve\.csv · snapshot \S/);
      assert.equal(await foot.locator(".brief-chart-points").innerText(), "Downsampled from 12,000 points");
    });
    await expect("scatter", async () => assert.equal(await results.locator('.brief-chart[aria-label="Size vs. score"] .recharts-scatter-symbol').count(), 6));
    await expect("bars", async () => assert.equal(await results.locator('.brief-chart[aria-label="Wall time per stage"] .recharts-bar-rectangle').count(), 4));
    const files = card("p2", "files");
    await expect("CSV preview", async () => assert.match(await files.locator('.brief-attachment[data-kind="data"]').first().locator(".brief-preview small").innerText(), /First 20 rows/));
    await expect("text tail", async () => {
      assert.match(await files.locator(".brief-tail").innerText(), /line 300$/);
      assert.match(await files.locator('.brief-attachment[data-kind="text"] .brief-preview small').innerText(), /Last 200 lines/);
      assert.ok(await files.locator(".brief-tail").evaluate((el) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2), "the tail starts at its end");
    });
    await expect("referenced file", async () => {
      const referenced = files.locator(".brief-attachment").nth(3);
      assert.equal(await referenced.locator('.brief-chip[data-state="changed"]').innerText(), "May have changed");
      assert.equal(await referenced.locator(".brief-path").getAttribute("title"), "/data/runs/exp-12/checkpoints/epoch-40.safetensors");
      assert.match(await referenced.innerText(), /Referenced/);
      assert.equal(await referenced.locator("img, .brief-preview").count(), 0, "a referenced file is never previewed");
    });
    await expect("stale status", async () => {
      assert.match(await card("p2", "queue").getAttribute("class"), /\bis-stale\b/);
      assert.match(await card("p2", "queue").locator(".home-stale").innerText(), /older than its 1 h validity/);
    });
    // Team details (counts, errors, missed updates, history) start folded;
    // opened, everything is there, and opening them tells Core nothing.
    const teamDetails = (pid) => viewOf(pid).locator("details.home-team-details");
    await expect("team details folded", async () => {
      for (const pid of ["p1", "p2"]) assert.equal(await teamDetails(pid).evaluate((el) => el.open), false, pid);
    });
    const writesBeforeDetails = writes.length;
    for (const pid of ["p1", "p2"]) await teamDetails(pid).locator(":scope > summary").click();
    await expect("history", async () => assert.match(await viewOf("p2").locator(".home-history > summary").innerText(), /History \(30 days\) · 1/));
    await expect("missing update", async () => assert.match(await p1.locator(".home-missing").innerText(), /Kumo ended a turn without updating the Brief; Yuzuno sent one reminder/));
    await expect("opening team details writes nothing", async () => assert.deepEqual(writes.slice(writesBeforeDetails), []));
    // Folded again, as the rest of this check expects Home.
    for (const pid of ["p1", "p2"]) await teamDetails(pid).locator(":scope > summary").click();
    await expect("repositories", async () => {
      await until("repository activity", () => p1.locator(".home-repos .repo-activity").getByText("Home V1 slice 1").count());
      assert.match(await p1.locator(".home-repos").innerText(), /example\/yuzuno-next/);
    });
    await expect("no failed part", async () => assert.equal(await page.locator(".home-view .result-part-error").count(), 0));
    // A state chip and an attention reference are tinted by their state
    // colour in the default palette, as the To do chip is by its own.
    await expect("state tints", async () => {
      const tints = await build.locator(".brief-chip").evaluateAll((chips) =>
        chips.map((chip) => {
          const s = getComputedStyle(chip);
          return [chip.dataset.state || chip.dataset.severity, s.borderTopStyle, s.backgroundColor];
        }),
      );
      const flat = tints.filter(([, border, background]) => border === "none" || background === "rgba(0, 0, 0, 0)");
      assert.deepEqual(flat, [], `chips without their tint: ${JSON.stringify(tints)}`);
    });
    for (const [pid, key] of [["p1", "release"], ["p1", "build"], ["p1", "naming"], ["p1", "refs"], ["p2", "results"], ["p2", "files"], ["p2", "queue"]])
      await shot(`section-${pid}-${key.replace("/", "-")}.png`, card(pid, key));
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(problems, [], "components");
    assert.deepEqual(report.errors, [], "no console errors while drawing");
  });

  await step("8 Machines: a null metric shows unknown (no meter segment), the GPU reads as use and memory bars with attribution unknown in its tip, a Job names its project and Agent", async () => {
    const cpu = page.locator(".home-machines .home-load").first();
    assert.deepEqual(
      await cpu.locator(".home-fact").evaluateAll((els) => els.map((e) => [e.dataset.fact, e.querySelector("strong").textContent, e.classList.contains("is-unknown")])),
      [["Jobs", "12%", false], ["Agents", "unknown", true], ["Other", "unknown", true]],
    );
    assert.equal(await cpu.locator(".home-meter > span").count(), 1, "unknown shares draw no segment");
    assert.equal(await page.locator(".home-machines .home-load").nth(1).locator('[data-fact="Agents"] strong').textContent(), "unknown");
    const gpu = page.locator(".home-gpus li");
    assert.match(await gpu.textContent(), /NVIDIA GeForce RTX 5090.*Use 63%.*Memory/is);
    assert.equal(await gpu.locator(".home-meter").count(), 2, "a bar for use and one for memory");
    assert.match(await gpu.getAttribute("title"), /other programs included; not split by Agent or Job/);
    const job = page.locator(".home-machine-jobs li");
    assert.match(await job.textContent(), /cargo test -j2.*Yuzuno app · Mori/);
    assert.equal(await job.locator('[data-fact="CPU"] strong').textContent(), "unknown");
    assert.equal(await job.locator('[data-fact="Memory"] strong').textContent(), "2.0 GiB");
  });

  const looks = {};
  await step("9 light and dark at 1440 and 390 px: no horizontal overflow, headers readable (contrast ≥ 4.5, ≥ 11 px, not cut), the needs-you bar inside the viewport", async () => {
    const problems = [];
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await ensureHome();
        await scrollHomeTo(null);
        await sleep(250);
        const shown = await fit();
        const name = `${theme}-${width}`;
        looks[name] = { ...shown, sides: await sideTabs() };
        if (shown.pageOverflow || shown.viewOverflow || shown.wide.length) problems.push(`${name}: horizontal overflow ${JSON.stringify({ page: shown.pageOverflow, view: shown.viewOverflow, wide: shown.wide })}`);
        if (!shown.needsInside) problems.push(`${name}: needs-you bar outside the viewport`);
        const unreadable = shown.headers.filter((h) => h.contrast < 4.5 || h.size < 11 || h.clipped || h.outside);
        if (unreadable.length) problems.push(`${name}: headers ${JSON.stringify(unreadable)}`);
        await shot(`home-${name}-top.png`);
        for (const target of ["#home-project-p1", "#home-section-p1-build", "#home-section-p1-refs", "#home-project-p2", "#home-section-p2-files"]) {
          await scrollHomeTo(target);
          await sleep(150);
          await shot(`home-${name}-${target.replace(/^#home-(project|section)-/, "")}.png`);
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme("light");
    await ensureHome();
    await scrollHomeTo(null);
    assert.deepEqual(problems, []);
    return Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, { headers: v.headers.length, minContrast: Math.min(...v.headers.map((h) => h.contrast)), view: v.viewBox }]));
  });

  await step("10 no element in Home has a coloured left border wider than 2 px; the main cards' borders are even on both sides", async () => {
    const problems = Object.entries(looks).flatMap(([name, v]) => [...v.sides.tabs.map((t) => `${name}: ${t}`), ...v.sides.uneven.map((c) => `${name}: uneven ${JSON.stringify(c)}`)]);
    assert.ok(Object.keys(looks).length === 4, "measured in both themes and widths");
    assert.deepEqual(problems, []);
    return { cards: looks["light-1440"].sides.cards.length };
  });

  await step("the needs-you row jumps to and focuses the ask; the panel order stays", async () => {
    await page.locator('[data-needs-you="ask:p1:naming"]').click();
    await page.waitForFunction(() => document.activeElement?.id === "home-section-p1-naming");
    assert.equal(await card("p1", "naming").getAttribute("data-home-highlight"), "");
    assert.deepEqual((await layout()).order, ["p1", "p2"]);
  });

  await step("3a Seen posts exactly the shown {key, version}; Core's next version shows as Updated again and is not marked; only its changed blocks carry a mark", async () => {
    await scrollHomeTo(null);
    assert.equal(await build.locator(".home-changed").innerText(), "Updated");
    assert.equal(await build.getAttribute("data-section-version"), "3");
    // Version 3 was never marked seen on this device: no block is marked, only the card.
    assert.equal(await build.locator(".brief-change").count(), 0);
    const plain = await card("p1", "refs").evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor]);
    assert.deepEqual(await build.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor]), plain, "a changed card looks like any other");
    await build.getByRole("button", { name: "Mark “Build health” seen" }).click();
    const write = await until("the seen mark", () => writesTo(/\/brief\/seen$/)[0]);
    assert.equal(write.path, "/api/projects/p1/brief/seen");
    assert.deepEqual(write.body, { sections: [{ key: "build", version: 3 }] });
    await until("the mark to show", async () => (await build.locator(".home-changed").count()) === 0);
    assert.equal(await build.getByRole("button", { name: /seen/ }).count(), 0);
    // Version 4 edits one block and adds one; every other block is as it was.
    const shown = sectionByKey("p1", "build");
    const body = structuredClone(shown.body);
    body.elements.metrics.props.items[1].value = 198;
    body.elements.added = markdown("The cache key now includes the lockfile.");
    body.elements.body.children.splice(1, 0, "added");
    Object.assign(shown, { version: 4, body, updatedAt: new Date().toISOString() });
    f.version.p1 += 1;
    await briefChanged();
    await until("version 4", async () => (await build.getAttribute("data-section-version")) === "4");
    assert.equal(await build.locator(".home-changed").innerText(), "Updated");
    assert.match(await build.getAttribute("class"), /\bis-changed\b/);
    const marks = await build.locator(".brief-change").evaluateAll((els) => els.map((el) => ({
      change: el.dataset.change,
      mark: el.querySelector(":scope > .brief-change-mark")?.textContent,
      block: [...(el.querySelector(":scope > :not(.brief-change-mark)")?.classList ?? [])].find((name) => name.startsWith("brief-")),
      text: el.textContent.slice(0, 60),
    })));
    assert.deepEqual(marks.map(({ change, mark, block }) => [change, mark, block]), [
      ["new", "New", "brief-markdown"],
      ["updated", "Updated", "brief-metrics"],
    ]);
    assert.match(marks[0].text, /lockfile/);
    assert.equal(writesTo(/\/brief\/seen$/).length, 1, "nothing marked by itself");
    return { body: write.body, marks };
  });

  await step("4 an option posts its id as choice and the ask then shows in short as Replied · waiting; Defer on an open ask posts {key, until}; free text posts the text", async () => {
    const release = card("p1", "release");
    await release.getByRole("button", { name: "Ship today", exact: true }).click();
    const option = await until("the option reply", () => writesTo(/\/brief\/reply$/)[0]);
    assert.equal(option.path, "/api/projects/p1/brief/reply");
    assert.deepEqual({ ...option.body, clientMessageId: typeof option.body.clientMessageId }, { key: "release", agentId: "kumo", text: "", choice: "ship", clientMessageId: "string" });
    await release.locator(".home-ask-replied").waitFor();
    assert.match(await release.locator(".home-ask-replied").innerText(), /Replied · waiting for Kumo\s*Ship today/);
    // T-132: answered, it is Kumo's to act on: in short, no Defer, the question folded away.
    await until("the replied card in short", async () => /\bis-replied\b/.test(await release.getAttribute("class")));
    assert.equal(await release.locator(".home-kind").innerText(), "REPLIED");
    assert.equal(await release.getByRole("button", { name: "Defer", exact: true }).count(), 0);
    assert.equal(await release.locator(".home-replied-details").getAttribute("open"), null);
    assert.equal(await release.locator(".home-replied-details .home-question").isVisible(), false);
    const naming = card("p1", "naming");
    await naming.getByRole("button", { name: "Defer", exact: true }).click();
    const before = Date.now();
    await naming.getByRole("button", { name: "1 hour", exact: true }).click();
    const defer = await until("the deferral", () => writesTo(/\/brief\/defer$/)[0]);
    assert.equal(defer.path, "/api/projects/p1/brief/defer");
    assert.deepEqual(Object.keys(defer.body).sort(), ["key", "until"]);
    assert.equal(defer.body.key, "naming");
    assert.ok(Math.abs(Date.parse(defer.body.until) - (before + 3_600_000)) < 60_000, `an hour from now: ${defer.body.until}`);
    await until("the deferral to show", () => naming.getByText(/Deferred until/).count());
    await naming.getByRole("textbox", { name: "Reply to Name for the brief tool" }).fill("Call it brief_write.");
    await naming.getByRole("button", { name: "Send", exact: true }).click();
    const text = await until("the text reply", () => writesTo(/\/brief\/reply$/)[1]);
    assert.deepEqual({ ...text.body, clientMessageId: typeof text.body.clientMessageId }, { key: "naming", agentId: "mori", text: "Call it brief_write.", clientMessageId: "string" });
    assert.notEqual(text.body.clientMessageId, option.body.clientMessageId);
    await naming.locator(".home-ask-replied").waitFor();
    await until("the deferral note to go once replied", async () => (await naming.getByText(/Deferred until/).count()) === 0);
    assert.equal(await naming.getByRole("button", { name: "Defer", exact: true }).count(), 0);
    await until("needs-you to drop the replied asks", async () => JSON.stringify(await needsShown()) === JSON.stringify(["approval:req-1"]));
    await scrollHomeTo("#home-section-p1-naming");
    await sleep(150);
    await shot("asks-replied-naming.png");
    await scrollHomeTo("#home-section-p1-release");
    await sleep(150);
    await shot("asks-replied-release.png");
    return { option: option.body.choice, until: defer.body.until };
  });

  await step("5 Allow once on Home posts /api/requests/req-1/respond {response:{decision:accept}}; the approval leaves the panel and needs-you", async () => {
    await p1.locator(".home-approval").getByRole("button", { name: "Allow once", exact: true }).click();
    const respond = await until("the approval", () => writesTo(/\/respond$/)[0]);
    assert.equal(respond.path, "/api/requests/req-1/respond");
    assert.deepEqual(respond.body, { response: { decision: "accept" } });
    await until("the approval to leave", async () => (await p1.locator(".home-approval").count()) === 0 && (await page.locator(".home-needs-item").count()) === 0);
    return { body: respond.body };
  });

  await step("6a a section appended by Core leaves every existing card where it was (≤ 1 px); a shorter new version keeps its card's height", async () => {
    await scrollHomeTo(null);
    const before = await settled();
    f.sections.p1.push(
      section({ key: "deploy", kind: "report", title: "Deploy notes", version: 1, owner: owner("mori"), updatedAt: new Date().toISOString(), body: spec([["text", markdown("core.8 is staged on the lab port; nothing is on the daily Core.")]]) }),
    );
    f.version.p1 += 1;
    await briefChanged();
    await card("p1", "deploy").waitFor();
    const after = await settled();
    const keys = Object.keys(before.panels.p1.cards);
    assert.deepEqual(moved(before.panels.p1.cards, after.panels.p1.cards, keys), [], "an appended section moved the cards before it");
    assert.ok(after.panels.p1.cards.deploy.top > Math.max(...keys.map((k) => after.panels.p1.cards[k].top)), "appended at the end");
    // A shorter new version keeps its card's height: the cards below stay.
    const build = sectionByKey("p1", "build");
    const buildVersion = build.version + 1;
    Object.assign(build, { version: buildVersion, updatedAt: new Date().toISOString(), body: spec([["text", markdown("All green.")]]) });
    f.version.p1 += 1;
    await briefChanged();
    await until("the shorter version", async () => (await card("p1", "build").getAttribute("data-section-version")) === String(buildVersion));
    const shorter = await settled();
    assert.deepEqual(moved(after.panels.p1.cards, shorter.panels.p1.cards, [...keys.filter((k) => k !== "build"), "deploy"]), [], "a shorter new version pulled the cards below up");
    // T-132: the replied ask shows in short, so its resolved version may be taller;
    // the reserved height still never pulls the cards below up.
    const release = sectionByKey("p1", "release");
    Object.assign(release, { version: 3, updatedAt: new Date().toISOString(), body: spec([["text", markdown("Shipped.")]]), ask: { ...release.ask, state: "resolved" } });
    f.version.p1 += 1;
    await briefChanged();
    await until("the resolved version", async () => (await card("p1", "release").getAttribute("data-section-version")) === "3");
    const resolved = await settled();
    const below = [...keys.filter((k) => k !== "release" && k !== "build"), "deploy"];
    const pulledUp = below.map((key) => ({ key, by: resolved.panels.p1.cards[key].top - shorter.panels.p1.cards[key].top })).filter((m) => m.by < -1);
    assert.deepEqual(pulledUp, [], "resolving the replied ask pulled the cards below up");
    return {
      appendedAt: after.panels.p1.cards.deploy.top,
      buildHeight: [after.panels.p1.cards.build.height, shorter.panels.p1.cards.build.height],
      releaseHeight: [shorter.panels.p1.cards.release.height, resolved.panels.p1.cards.release.height],
      belowMovedBy: below.map((key) => resolved.panels.p1.cards[key].top - shorter.panels.p1.cards[key].top),
    };
  });

  await step("6b Move up posts /api/home/order {projectIds:[p2,p1]}; after Core's read the panels swap and every card keeps its place inside its panel", async () => {
    await page.getByRole("button", { name: "Reorder", exact: true }).click();
    await page.getByRole("button", { name: "Move Paper notes up", exact: true }).waitFor();
    const before = await settled();
    await page.getByRole("button", { name: "Move Paper notes up", exact: true }).click();
    const order = await until("the order", () => writesTo(/\/home\/order$/)[0]);
    assert.deepEqual(order.body, { projectIds: ["p2", "p1"] });
    await until("Core's order", async () => JSON.stringify(f.order) === '["p2","p1"]' && (await layout()).order.join() === "p2,p1");
    await sleep(500);
    const after = await settled();
    assert.deepEqual(after.order, ["p2", "p1"]);
    for (const pid of ["p1", "p2"]) {
      const keys = Object.keys(before.panels[pid].cards);
      assert.deepEqual(moved(before.panels[pid].cards, after.panels[pid].cards, keys, "inPanel"), [], `${pid}: cards moved inside the panel`);
      assert.ok(Math.abs(after.panels[pid].height - before.panels[pid].height) <= 1, `${pid}: the panel kept its size`);
    }
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await scrollHomeTo(null);
    await shot("reordered-1440.png");
    return { order: after.order };
  });

  await step("7 a collapsed panel stays collapsed after a reload and expands again", async () => {
    const toggle = viewOf("p2").locator(".home-panel-toggle");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => localStorage.getItem('yuzuno.home-panel.v1:["ws","p2"]')), '"collapsed"');
    await page.reload();
    await homeButton().waitFor();
    await ensureHome();
    await viewOf("p2").waitFor();
    assert.equal(await viewOf("p2").locator(".home-panel-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await viewOf("p2").locator(".home-panel-content").count(), 0);
    await shot("p2-collapsed-after-reload.png", viewOf("p2"));
    await viewOf("p2").locator(".home-panel-toggle").click();
    await card("p2", "results").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('yuzuno.home-panel.v1:["ws","p2"]')), '"expanded"');
  });

  await step("3b Seen all posts every displayed {key, version} and nothing else", async () => {
    const shown = await p1.locator("[data-section-key]").evaluateAll((els) => els.map((e) => ({ key: e.dataset.sectionKey, version: Number(e.dataset.sectionVersion) })));
    const p2Top = (await settled()).panels.p2.top;
    await p1.getByRole("button", { name: "Seen all", exact: true }).click();
    const all = await until("seen all", () => writesTo(/\/brief\/seen$/)[1]);
    const byKey = (a, b) => a.key.localeCompare(b.key);
    assert.equal(all.path, "/api/projects/p1/brief/seen");
    assert.deepEqual(Object.keys(all.body), ["sections"]);
    assert.deepEqual([...all.body.sections].sort(byKey), [...shown].sort(byKey));
    await until("all seen", async () => (await p1.locator(".home-changed").count()) === 0 || (await p1.locator(".home-panel-content").count()) === 0);
    const after = await settled();
    const folded = (await p1.locator(".home-panel-toggle").getAttribute("aria-expanded")) === "false";
    report.observations.push({ what: "Seen all on a project with nothing else waiting", folded, otherPanelMovedBy: Math.round(after.panels.p2.top - p2Top) });
    await shot("after-seen-all.png");
    return { sections: all.body.sections.length, folded };
  });

  await step("no console or page errors, and every request was in the fixture", async () => {
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unexpected, []);
  });
  report.status = report.failures.length ? "failed" : "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (report.status !== "passed") process.exitCode = 1;
  console.log(`${report.status} (${report.checks.length} passed, ${report.failures.length} failed): ${resolve(output, "report.json")}`);
  if (report.observations.length) console.log(`observations: ${JSON.stringify(report.observations)}`);
  if (report.error) console.error(report.error);
}
