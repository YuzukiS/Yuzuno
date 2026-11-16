// Capture the real production UI with isolated, entirely synthetic API data.
// Run in a Yuzuno Job when working in a connected workspace. After building:
// YUZUNO_UI_DIST=/absolute/path/to/dist node web/tools/readme-screenshots.mjs
// Optional: YUZUNO_BROWSER_BIN, YUZUNO_PLAYWRIGHT_MODULE (installed package path).
// No Core, model, account, external network, preview UI, or injected UI styling.
// The sample world: three Projects (Fieldnotes, Thesis data, Garden site), their
// leads Mori, Ren and Hana, one executor (FN-12) and four Jobs (YN-115). Home's
// Ask reply and the Thesis data page attach sketches the browser draws and a
// sample log, which the script answers for as the Project's saved attachments.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  noCiRuns,
  noConversationInputs,
  noLiveCi,
  noLiveJobs,
  noReviews,
  unmanagedUpdates,
} from "./browser-fixtures.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.YUZUNO_PLAYWRIGHT_MODULE || "playwright-core",
);
assert.ok(
  process.env.YUZUNO_UI_DIST,
  "Set YUZUNO_UI_DIST to a production build",
);
const dist = resolve(process.env.YUZUNO_UI_DIST);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.env.YUZUNO_SCREENSHOT_OUT || resolve(root, "docs/images"));
await mkdir(output, { recursive: true });
const HOST = "yuzuno-readme.test";
const now = Date.now();
const ago = (seconds) => new Date(now - seconds * 1000).toISOString();

const base = {
  createdAt: ago(86400), updatedAt: ago(120), closedAt: null, status: "idle", connectionState: "connected",
  unreadCount: 0, pendingCount: 0, lastSeq: 8, reviewedSeq: 8, goal: "",
  settings: { reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write" },
};
const agents = [
  { ...base, id: "mori", name: "Mori", kind: "lead", harness: "codex", model: "gpt-5.4", color: "sage", projectId: "p-notes", cwd: "/workspace/fieldnotes",
    threadId: "sample-codex-session", status: "idle",
    workSummary: { kind: "result", source: "agent", text: "The first-run screen is ready to review.", turnId: "onboarding", itemId: "reply" } },
  { ...base, id: "kai", name: "FN-12 · build", kind: "executor", harness: "claude", model: "sonnet", color: "sky", projectId: "p-notes", cwd: "/workspace/fieldnotes",
    status: "working", claudeSessionId: "sample-claude-a",
    executor: { state: "running", task: { id: "FN-12", title: "Browser checks for the first-run screen", shortName: "Browser checks" } } },
  { ...base, id: "hana", name: "Hana", kind: "lead", harness: "claude", model: "sonnet", color: "rose", projectId: "p-site", cwd: "/workspace/garden-site",
    claudeSessionId: "sample-claude-b",
    workSummary: { kind: "result", source: "agent", text: "The photo gallery loads twice as fast." } },
  { ...base, id: "ren", name: "Ren", kind: "lead", harness: "codex", model: "gpt-5.4", color: "amber", projectId: "p-thesis", cwd: "/workspace/thesis",
    threadId: "sample-codex-ren", status: "idle",
    workSummary: { kind: "result", source: "agent", text: "Chapter 3 figures regenerated from the new runs." } },
];
const projects = [
  { id: "p-notes", name: "Fieldnotes", defaultDirs: { local: "/workspace/fieldnotes" }, createdAt: ago(9 * 86400), updatedAt: ago(300) },
  { id: "p-thesis", name: "Thesis data", defaultDirs: { local: "/workspace/thesis" }, createdAt: ago(20 * 86400), updatedAt: ago(900) },
  { id: "p-site", name: "Garden site", defaultDirs: { local: "/workspace/garden-site" }, createdAt: ago(30 * 86400), updatedAt: ago(3000) },
];
const owner = (agent) => ({ agentId: agent.id, name: agent.name, state: "active" });
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements, summary) =>
  ({ root: "body", elements: { body: node("BriefBody", summary ? { summary } : {}, top), ...elements } });
let nextId = 300;
const section = (key, kind, title, agent, body, extra = {}) => ({
  id: nextId++, key, kind, title, version: 2, owner: owner(agent), updatedAt: ago(600), updatedTurnId: "t1",
  body, attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const [mori, kai, hana, ren] = agents;
/** A report its lead refreshes every morning (YN-113): the schedule as GET /api/home reads it. */
function dailyRefresh() {
  const next = new Date(now);
  next.setUTCHours(7, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  const last = new Date(next.getTime() - 86400 * 1000).toISOString();
  return {
    version: 1, cadence: { every: "day", at: "07:00" }, zone: "UTC", utcOffset: "+00:00",
    instruction: "Run the browser checks and summarise them.", enabled: true, pausedReason: null, weeklyRuns: 7,
    nextAt: next.toISOString(), lastSlot: last,
    run: { slot: last, missed: 0, state: "refreshed", agentId: "mori", sentAt: last, endedAt: last },
    recent: [{ slot: last, state: "refreshed", missed: 0 }], failures: 0, waiting: null, versions: 9,
    createdAt: ago(9 * 86400), createdBy: "mori", updatedAt: ago(9 * 86400),
  };
}
const notesSections = [
  section("copy", "ask", "Choose the welcome message", mori, spec(["q"], { q: md("Both fit the new empty state. The first is warmer; the second says what to do.") }), {
    updatedAt: ago(240),
    ask: { question: "Which welcome message should the first-run screen use?", state: "open",
      reply: { options: [{ id: "warm", label: "A space for your next idea" }, { id: "direct", label: "Create your first note" }], freeText: true } },
  }),
  section("onboarding", "report", "A welcoming first run", mori, spec(["a", "m"], {
    a: md("One clear action replaces the empty list, keyboard focus is visible from the start, and the layout holds on a phone."),
    m: node("Metrics", { items: [{ label: "Checks passed", value: 24 }, { label: "Screens reviewed", value: 3 }, { label: "Open findings", value: 0 }] }),
  }), { updatedAt: ago(420) }),
  section("week", "status", "This week", mori, spec(["p"], {
    p: node("Plan", { steps: [
      { id: "s1", text: "First-run screen", state: "done" },
      { id: "s2", text: "Browser checks on desktop and phone", state: "doing" },
      { id: "s3", text: "Welcome message", state: "blocked" },
      { id: "s4", text: "Search across notebooks", state: "todo" },
    ] }),
  }), { status: { asOf: ago(300), validFor: 86400, stale: false }, updatedAt: ago(300) }),
  section("search", "report", "Search: two designs compared", mori, spec(["a", "t"], {
    a: md("Searching as you type keeps the list in place; a search page shows more context."),
    t: node("Table", { id: "t", columns: [{ key: "d", label: "Design" }, { key: "speed", label: "First result" }, { key: "fit", label: "Fits a phone" }],
      rows: [{ id: "r1", cells: { d: "As you type", speed: "40 ms", fit: "Yes" } }, { id: "r2", cells: { d: "Search page", speed: "120 ms", fit: "Yes" } }] }),
  }), { updatedAt: ago(5400), seen: { version: 2, at: ago(3000) } }),
];
// Its reports are unread: a report read at its version folds into Done on the Project's page (project-deck.ts).
const thesisSections = [
  section("figures", "report", "Chapter 3 figures regenerated", ren, spec(["a", "m"], {
    a: md("All twelve figures now come from the runs of this week; two changed visibly."),
    m: node("Metrics", { items: [{ label: "Figures", value: 12 }, { label: "Changed", value: 2 }, { label: "GPU hours", value: 6.5 }] }),
  }, { lead: "a", visual: "m", size: "small" }), { updatedAt: ago(1800) }),
  section("week", "status", "This week", ren, spec(["a", "c"], {
    a: md("The baseline run is training; the ablation table comes next."),
    c: node("Checklist", { items: [
      { id: "c1", text: "Regenerate chapter 3 figures", done: true },
      { id: "c2", text: "Baseline training run", done: false },
      { id: "c3", text: "Ablation table", done: false },
    ] }),
  }, { lead: "a", conditions: "c", size: "small" }), { status: { asOf: ago(1200), validFor: 86400, stale: false }, updatedAt: ago(1200), seen: { version: 2, at: ago(900) } }),
  section("nightly", "report", "Nightly evaluation", ren, spec(["a", "m"], {
    a: md("Last night's checkpoint on the held-out set."),
    m: node("Metrics", { items: [{ label: "Accuracy", value: "91.4", unit: "%", previous: "90.8" }, { label: "Loss", value: 0.27, previous: 0.31 }] }),
  }, { lead: "a", visual: "m", size: "small" }), { updatedAt: ago(4 * 3600), refresh: dailyRefresh() }),
  section("runs", "report", "Runs compared", ren, spec(["a", "t"], {
    a: md("Wider layers gain 0.6 points for 45 more minutes."),
    t: node("Table", { id: "t", columns: [{ key: "run", label: "Run" }, { key: "acc", label: "Accuracy" }, { key: "time", label: "Time" }],
      rows: [
        { id: "r1", cells: { run: "Baseline", acc: "90.8 %", time: "3 h 10 min" } },
        { id: "r2", cells: { run: "Wider layers", acc: "91.4 %", time: "3 h 55 min" } },
        { id: "r3", cells: { run: "Smaller batch", acc: "90.1 %", time: "4 h 20 min" } },
      ] }),
  }, { lead: "a", visual: "t", size: "wide" }), { updatedAt: ago(7200) }),
  section("draft", "status", "Before the draft goes out", ren, spec(["a", "c"], {
    a: md("Two items left before the chapter goes to the advisor."),
    c: node("Checklist", { items: [
      { id: "c1", text: "Figures from this week's runs", done: true },
      { id: "c2", text: "Ablation table", done: false },
      { id: "c3", text: "Captions checked", done: false },
    ] }),
  }, { lead: "a", conditions: "c", size: "small" }), { status: { asOf: ago(2400), validFor: 86400, stale: false }, updatedAt: ago(2400), seen: { version: 2, at: ago(2000) } }),
  section("gpu", "report", "GPU time this month", ren, spec(["a", "m"], {
    a: md("On track for the month's 100 hours."),
    m: node("Metrics", { items: [{ label: "Used", value: 41, unit: "h" }, { label: "Left", value: 59, unit: "h" }] }),
  }, { lead: "a", visual: "m", size: "small" }), { updatedAt: ago(10800) }),
];
const siteSections = [
  section("gallery", "report", "Photo gallery loads twice as fast", hana, spec(["a"], { a: md("Images are resized when they are added.") }), {
    updatedAt: ago(2 * 86400), seen: { version: 2, at: ago(86400) } }),
];
const resources = { cpuMillis: 2000, memoryMiB: 3072, swapMiB: 0 };
const jobBase = {
  agentId: "kai", agent: { name: "FN-12 · build" }, machine: { name: "Core host" }, resources,
  reservation: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 }, cwd: "/workspace/fieldnotes", env: {},
  argv: ["npm", "run", "check"], requestId: "sample-job", usage: null, outputs: [], guardGit: true, timeoutSeconds: 900,
};
const jobs = [
  { ...jobBase, id: "sample-browser", name: "Browser screenshots", taskRef: "FN-12", status: "running", reserved: true,
    reason: "Running within its reservation", createdAt: ago(200), startedAt: ago(125), finishedAt: null, cursor: 4,
    argv: ["npm", "run", "screenshots"], usage: { MemoryCurrent: String(512 * 1048576), MemoryPeak: String(700 * 1048576), TasksMax: "512" } },
  { ...jobBase, id: "sample-train", name: "Baseline training run", taskRef: "TD-7", agentId: "ren", agent: { name: "Ren" }, status: "queued",
    reserved: false, reason: "Waiting for shared machine capacity", createdAt: ago(60), startedAt: null, finishedAt: null, cursor: 5,
    cwd: "/workspace/thesis", argv: ["python", "train.py", "--config", "baseline.yaml"],
    resources: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, reservation: { cpuMillis: 4100, memoryMiB: 8256, swapMiB: 0 } },
  { ...jobBase, id: "sample-checks", name: "Typecheck & unit tests", taskRef: "FN-12", status: "succeeded", reserved: false,
    reason: "success", createdAt: ago(700), startedAt: ago(690), finishedAt: ago(610), cursor: 3, outputs: ["reports/checks.json"] },
  { ...jobBase, id: "sample-figures", name: "Regenerate figures", taskRef: "TD-6", agentId: "ren", agent: { name: "Ren" }, status: "succeeded",
    reserved: false, reason: "success", createdAt: ago(2600), startedAt: ago(2590), finishedAt: ago(1900), cursor: 2,
    cwd: "/workspace/thesis", argv: ["python", "figures.py", "--chapter", "3"] },
];
const homeJobs = (projectId) => jobs.filter((job) => ["running", "queued"].includes(job.status))
  .filter((job) => agents.find((a) => a.id === job.agentId)?.projectId === projectId)
  .map((job) => ({ id: job.id, name: job.name, status: job.status, agentId: job.agentId, agentName: job.agent.name, taskRef: job.taskRef }));
const panel = (project, counts, editors, sections, extra = {}) => ({
  project: { id: project.id, name: project.name }, agents: counts, contentEditors: { version: 1, editorAgentIds: editors },
  errors: [], pending: [], jobs: homeJobs(project.id), unseen: 0, missing: [], brief: { version: 4, history: [], sections }, ...extra,
});
const counts = (working, idle, total) => ({ working, idle, waiting: 0, error: 0, offline: 0, total });
const approval = { id: "r-1", agentId: "kai", agentName: "FN-12 · build", method: "item/commandExecution/requestApproval",
  params: { command: "npm run screenshots", reason: "Capture the first-run screen on desktop and phone" }, createdAt: ago(90) };
const home = () => ({
  generatedAt: ago(0),
  order: ["p-notes", "p-thesis", "p-site"],
  needsYou: [
    { kind: "ask", projectId: "p-notes", agentId: "mori", agentName: "Mori", sectionKey: "copy", title: "Choose the welcome message", since: ago(240) },
    { kind: "approval", projectId: "p-notes", agentId: "kai", agentName: "FN-12 · build", requestId: "r-1", title: "Capture the first-run screen on desktop and phone", since: ago(90) },
  ],
  projects: [
    panel(projects[0], counts(1, 1, 2), ["mori"], notesSections, { pending: [approval] }),
    panel(projects[1], counts(0, 1, 1), ["ren"], thesisSections),
    panel(projects[2], counts(0, 1, 1), ["hana"], siteSections),
  ],
});
const withUnseen = (value) => {
  for (const p of value.projects)
    p.unseen = p.brief.sections.filter((s) => Math.max(s.seen?.version ?? 0, s.opened?.version ?? 0) < s.version).length;
  return value;
};
const currentTurn = {
  id: "onboarding", status: "completed",
  items: [
    { id: "request", type: "userMessage", content: [{ type: "text", text: "Make the first-run experience feel welcoming. Add a useful empty state, keep keyboard navigation clear, and check the layout on a phone." }] },
    { id: "plan", type: "agentMessage", phase: "commentary", text: "I’ll add one clear starting action, then hand the browser checks to an executor." },
    { id: "edit", type: "fileChange", status: "completed", changes: [{ path: "/workspace/fieldnotes/src/Welcome.tsx", kind: { type: "update" },
      diff: "+<h1>A little space for your next idea.</h1>\n+<button>Create your first note</button>" }] },
    { id: "checks", type: "commandExecution", command: "npm run check", cwd: "/workspace/fieldnotes", status: "completed", exitCode: 0,
      aggregatedOutput: "TypeScript: no errors\n24 tests passed\nKeyboard navigation: passed\nMobile layout: passed\n" },
    { id: "reply", type: "agentMessage", phase: "final_answer",
      text: "The first-run screen is ready for a look.\n\n### A quieter starting point\n\n- A single **Create your first note** action replaces the empty list.\n- The layout stays comfortable on narrow screens.\n- Keyboard focus is visible from the first interaction.\n\n**24 checks passed.** FN-12 is capturing screenshots as a Job; its result will come back here. One question is on Home: which welcome message to use.\n\n[Implementation](src/Welcome.tsx:1) · [Review notes](docs/onboarding.md)" },
  ],
};
const detail = (agent) => ({
  agent, pending: agent.id === "kai" ? [approval] : [], messageReceipts: [],
  artifacts: agent.id === "mori" ? [
    { name: "Welcome.tsx", path: "/workspace/fieldnotes/src/Welcome.tsx", kind: "text", sourceItemId: "edit" },
    { name: "onboarding.md", path: "/workspace/fieldnotes/docs/onboarding.md", kind: "text", sourceItemId: "reply" },
  ] : [],
  turns: agent.id === "mori" ? [currentTurn] : [{ id: "x", status: "completed", items: [{ id: "x1", type: "agentMessage", text: agent.workSummary?.text ?? "Working." }] }],
});
const budget = {
  machine: { name: "Core host", memoryAvailableMiB: 20000, scope: "Sample data", logicalCpus: 16, memoryTotalMiB: 32768, swapTotalMiB: 8192,
    hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 } },
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
  budget: { cpuMillis: 8000, memoryMiB: 16384, swapMiB: 0 },
  reserved: { cpuMillis: 2100, memoryMiB: 3136, swapMiB: 0 }, queuedCount: 1, activeCount: 1,
};
const machineLoad = {
  at: ago(0),
  cpu: { cores: 16, totalPct: 28, jobsPct: 12, agentsPct: 6, otherPct: 10 },
  memory: { totalMiB: 32768, usedMiB: 11264, availableMiB: 21504, jobsMiB: 700, agentsMiB: 2400 },
  gpus: null,
  jobs: [{ id: "sample-browser", name: "Browser screenshots", agentId: "kai", agentName: "FN-12 · build", projectId: "p-notes", cpuPct: 12, memMiB: 700 }],
};
const codexUsage = {
  revision: 1, status: "ready", account: { type: "chatgpt", label: "Sample account", planType: null }, accountId: "sample-account",
  source: { generation: "sample", label: "Core host", machineId: "local", runtimeId: null },
  checkedAt: ago(0), observedAt: ago(0), ordinaryUsageAllowed: true, error: null,
  buckets: [{ limitId: "codex", limitName: "Codex", planType: null, observedAt: ago(0), credits: null,
    primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 7200, observedAt: ago(0) },
    secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 259200, observedAt: ago(0) } }],
};
const codexMcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const state = { home: home() };
const responses = () => ({
  "/api/workspace": { workspace: { id: "ws-readme", name: "Personal workspace" }, agents, projects, runtime: { connected: true }, defaultCwd: "/workspace" },
  "/api/home": withUnseen(state.home),
  "/api/machine-load": machineLoad,
  "/api/machine-live": { machines: [] },
  "/api/machines": { machines: [] },
  "/api/updates": unmanagedUpdates,
  "/api/jobs/budget": budget,
  "/api/jobs": { jobs, liveJobs: [], hasMore: false, nextBefore: null },
  "/api/jobs/live": noLiveJobs,
  "/api/ci": noCiRuns,
  "/api/ci/live": noLiveCi,
  "/api/reviews": noReviews,
  "/api/jobs/runs": { runs: [], hasMore: false },
  "/api/waits/live": { agents: {} },
  "/api/executors/live": { executors: {} },
  "/api/backlog": { observedAt: ago(0), agents: {} },
  "/api/models": { models: [] },
  ...Object.fromEntries(agents.map((agent) => [`/api/agents/${agent.id}`, detail(agent)])),
  ...Object.fromEntries(agents.map((agent) => [`/api/agents/${agent.id}/codex/usage`, codexUsage])),
  ...Object.fromEntries(agents.map((agent) => [`/api/agents/${agent.id}/codex/mcp`, codexMcp])),
  ...Object.fromEntries(agents.map((agent) => [`/api/agents/${agent.id}/conversation/inputs`, noConversationInputs])),
  ...Object.fromEntries(jobs.map((job) => [`/api/jobs/${job.id}`, job])),
  ...Object.fromEntries(projects.map((p) => [`/api/projects/${p.id}/front-desk`, { version: 1, agentId: null, effectiveAgentId: p.id === "p-notes" ? "mori" : p.id === "p-site" ? "hana" : "ren" }])),
  ...Object.fromEntries(projects.map((p) => [`/api/projects/${p.id}/requests`, { requests: [], hasMore: false }])),
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const errors = [];
const unexpected = [];
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  locale: "en-US",
  timezoneId: "UTC",
  reducedMotion: "reduce",
  deviceScaleFactor: 1,
});
await context.addInitScript(() => {
  if (window !== window.top) return;
  window.EventSource = class {
    constructor() {
      setTimeout(() => this.onopen?.(), 0);
    }
    close() {}
  };
  localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  localStorage.setItem(
    "yuzuno.appearance",
    JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }),
  );
  localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
});
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const path = url.pathname;
  if (url.hostname !== HOST) {
    unexpected.push("External request blocked");
    return route.abort();
  }
  if (method !== "GET") {
    // Attachments Home saves to the Project (home-images.ts, home-files.ts): the sample ones only.
    if (method === "POST" && /^\/api\/projects\/p-[a-z]+\/images$/.test(path)) {
      const sent = createHash("sha256").update(request.postDataBuffer() ?? Buffer.alloc(0)).digest("hex");
      const image = sketches.find((one) => one.id === `${sent}.png`);
      assert.ok(image, "Only the drawn sample sketches are attached");
      return route.fulfill({ json: { id: image.id, width: image.width, height: image.height, bytes: image.bytes.length } });
    }
    if (method === "POST" && /^\/api\/projects\/p-[a-z]+\/files$/.test(path)) {
      const name = url.searchParams.get("name");
      assert.equal(name, sampleLog.name, "Only the sample log is attached");
      return route.fulfill({ json: { id: sampleLog.id, name, bytes: sampleLog.bytes.length } });
    }
    // Linked repositories are read with a POST (home-api.ts): none here.
    if (path === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    // Read receipts the UI sends while it is looked at.
    if (/\/(read|seen|opened|review)$/.test(path))
      return route.fulfill({ json: { ok: true, recorded: true } });
  } else {
    const json = responses()[path];
    if (json) return route.fulfill({ json });
    const image = sketches.find((one) => /^\/api\/projects\/p-[a-z]+\/images\//.test(path) && path.endsWith(`/${one.id}`));
    if (image) return route.fulfill({ body: image.bytes, contentType: "image/png" });
    if (/^\/api\/jobs\/sample-[a-z]+\/logs$/.test(path)) {
      const text =
        "Sample data — browser capture\n✓ Desktop viewport ready\n✓ Phone layout checked\nCapturing final screenshots…\n";
      return route.fulfill({
        json: {
          text,
          offset: 0,
          nextOffset: text.length,
          oldestOffset: 0,
          totalBytes: text.length,
          truncated: false,
        },
      });
    }
    if (!path.startsWith("/api/")) {
      const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
      assert.ok(file.startsWith(`${dist}/`));
      return route.fulfill({
        body: await readFile(file),
        contentType: types[extname(file)] || "application/octet-stream",
      });
    }
  }
  unexpected.push(`${method} ${path}`);
  return route.fulfill({
    status: 404,
    json: { error: "Not in the sample fixture" },
  });
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
/** A sample file and its content-addressed reference, as Core would name it. */
const sample = (name, bytes) => ({ name, bytes, id: createHash("sha256").update(bytes).digest("hex") });
const sampleLog = sample("baseline-run.log", Buffer.from(
  "Sample data — baseline training run\nepoch 1  loss 0.92  accuracy 71.0 %\nepoch 2  loss 0.61  accuracy 84.2 %\nepoch 3  loss 0.31  accuracy 90.8 %\n",
));
/** Marked-up sketches the browser draws below (drawSketch): no captured screen or real image. */
const sketches = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
async function capture(name, height = 1000) {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(1598, height - 2);
  assert.deepEqual(errors, [], "No UI exceptions");
  assert.deepEqual(
    unexpected,
    [],
    "All requests stay within the explicit fixture",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal page overflow",
  );
  await page.screenshot({
    path: resolve(output, `${name}.png`),
    animations: "disabled",
  });
  console.log(
    `Captured ${name}.png (1600 × ${height}, synthetic sample data)`,
  );
}
/** Types into a composer (a CodeMirror editor, PastedTextComposer.tsx) as a person would. */
async function typeInto(editor, text) {
  await editor.click();
  await page.keyboard.type(text);
}
/** Draws a sample sketch in the page's own canvas, with a red circle on it as markup: "phone", the first-run
 * screen on a phone; "plot", two training curves. */
async function drawSketch(kind) {
  const [width, height] = kind === "phone" ? [360, 480] : [480, 320];
  const data = await page.evaluate(({ kind, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    g.fillStyle = "#f4f1e8";
    g.fillRect(0, 0, width, height);
    g.lineWidth = 4;
    g.strokeStyle = "#57534e";
    if (kind === "phone") {
      g.fillStyle = "#ffffff";
      g.beginPath();
      g.roundRect(90, 40, 180, 400, 26);
      g.fill();
      g.stroke();
      g.fillStyle = "#44403c";
      g.font = "bold 17px sans-serif";
      g.fillText("A space for", 112, 190);
      g.fillText("your next", 112, 214);
      g.fillText("idea", 112, 238);
      g.fillStyle = "#c8a13a";
      g.beginPath();
      g.roundRect(112, 270, 136, 34, 10);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(50, 30);
      g.lineTo(50, 270);
      g.lineTo(450, 270);
      g.stroke();
      const curve = (colour, top) => {
        g.strokeStyle = colour;
        g.beginPath();
        for (let x = 0; x <= 380; x += 10) g.lineTo(60 + x, 260 - (top * (1 - Math.exp(-x / 90))));
        g.stroke();
      };
      curve("#6b8f71", 190);
      curve("#c8a13a", 205);
    }
    g.strokeStyle = "#dc2626";
    g.lineWidth = 5;
    g.beginPath();
    if (kind === "phone") g.ellipse(160, 212, 92, 52, -0.08, 0, Math.PI * 2);
    else g.ellipse(380, 70, 70, 34, 0, 0, Math.PI * 2);
    g.stroke();
    return canvas.toDataURL("image/png");
  }, { kind, width, height });
  const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
  const id = `${createHash("sha256").update(bytes).digest("hex")}.png`;
  return { name: kind === "phone" ? "first-run-sketch.png" : "figure-sketch.png", bytes, id, width, height };
}
try {
  await page.goto(`https://${HOST}/`);
  await page.locator("[data-composer-input]").waitFor();
  await page.locator(".catchup-nav:not(.collab-nav)").first().click();
  await page.locator('[data-glance-project="p-notes"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-needs-you]").length === 2);
  const phone = await drawSketch("phone");
  const plot = await drawSketch("plot");
  sketches.push(phone, plot);
  // Answer the Ask in words, with the marked-up sketch attached (YN-134).
  const ask = page.locator("[data-needs-you]").first();
  await typeInto(ask.locator(".home-composer [data-composer-input]"), "The first, but shorter: it wraps on a phone. See the circled line.");
  await ask.locator('input[type="file"][aria-label="Choose images"]').setInputFiles(
    { name: phone.name, mimeType: "image/png", buffer: phone.bytes });
  await ask.locator(".home-composer img").first().waitFor();
  await page.evaluate(() => document.activeElement?.blur?.());
  await capture("home");
  // A Project's own page, taller than the others so that its cards show below the talk box (480 px,
  // project-talk.css): the cards in columns, and a request with an image and a file attached (YN-145).
  await page.setViewportSize({ width: 1600, height: 1430 });
  await page.locator('[data-glance-project="p-thesis"] .project-glance-open').click();
  const projectPage = page.locator('[data-project-home="p-thesis"]');
  await projectPage.locator(".home-brief .home-summary-card").nth(5).waitFor();
  const talk = projectPage.locator(".project-talk .home-composer");
  await typeInto(talk.locator("[data-composer-input]"), "Add the wider-layers run to chapter 3, drawn like this sketch. Its log is attached.");
  await talk.locator('input[type="file"][aria-label="Choose images"]').setInputFiles(
    { name: plot.name, mimeType: "image/png", buffer: plot.bytes });
  await talk.locator('input[type="file"][aria-label="Choose files"]').setInputFiles(
    { name: sampleLog.name, mimeType: "text/plain", buffer: sampleLog.bytes });
  await talk.locator("img").first().waitFor();
  await talk.getByText(sampleLog.name).first().waitFor();
  await page.evaluate(() => document.activeElement?.blur?.());
  await capture("project", 1430);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator(".agent-rail-row, .agent-select").filter({ hasText: "Mori" }).first().click();
  await page.locator("[data-composer-input]").waitFor();
  await page.locator(".conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await capture("conversation");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page
    .locator(".job-row")
    .filter({ hasText: "Typecheck & unit tests" })
    .waitFor();
  await page
    .locator(".job-row")
    .filter({ hasText: "Browser screenshots" })
    .click();
  await page.locator(".job-log").waitFor();
  await capture("jobs");
  console.log(
    "PASS: 4 actual UI screenshots; no external requests or UI exceptions.",
  );
} finally {
  await browser.close();
}
