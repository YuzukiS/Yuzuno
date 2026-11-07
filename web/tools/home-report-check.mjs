// A section's report over Home (T-18), in a browser: the production bundle
// with an explicit API fixture (synthetic sections, no Core, daily window or
// real Agent). Checks what JSDOM can't: the page's layout on a 1440 px
// desktop and a 390 px phone (the rail, or Contents and "Sources &
// attachments" after the body; type sizes; nothing sideways), the author's
// summary, conditions and figure with its data file, sources and an image
// visible without a click, the named detail folded by real visibility, a
// research desk still interactive on the page, Home's scroll place and
// focus after Back, the browser's Back and Forward, Escape, a reload, a
// link in the address and one in a conversation, a version notice, and
// reduced motion. Reads only: nothing is written. Screenshots and
// report.json go to YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-report.test";
const WS = "ws-report";
const report = { task: "T-18", checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], refreshes: [], shots: [],
  limits: ["Chromium only: not iOS Safari, not a real iPhone, not the native desktop window."] };
let page;
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
  } finally {
    await page?.context().close().catch(() => {});
    page = undefined;
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
async function shot(name, selector) {
  const path = resolve(output, name);
  await (selector ? page.locator(selector).screenshot({ path }) : page.screenshot({ path }));
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "a", name: "Mori", state: "active" };
const linkHref = (version, sectionId = 7) => `https://${HOST}/#/report?w=${WS}&p=p1&k=eval&v=${version}&s=${sectionId}`;
const turns = [{ id: "t1", status: "completed", completedAt: Math.floor((now - 3 * MIN) / 1000), items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Where is the eval write-up?" }] },
  { id: "r1", type: "agentMessage", text: `It is on Home: [Synthetic eval: model B vs A](${linkHref(3)}).` },
] }];
const longText = Array.from({ length: 30 }, (_, i) => `Note ${i + 1}: the seeds, data order and evaluation split are the same in both arms.`).join("\n\n");
// The author names the summary (conclusion, conditions, one figure) and the
// part that starts folded on the root, by the blocks' ids (T-18 contract).
const evalBody = { root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "answer", visual: "curve", conditions: "holds", size: "wide" }, details: ["method"] },
    children: ["answer", "holds", "curve", "evidence", "method", "long", "next", "sources", "shots"] },
  answer: { type: "Markdown", props: { text: "Model B lowers validation loss by 4% on the synthetic set, within the noise of three seeds." } },
  holds: { type: "Checklist", props: { items: [{ id: "def", text: "Scoring definition v2", done: true }, { id: "data", text: "Synthetic data, 100 items per arm", done: true },
    { id: "int", text: "Illustrative interval, not a statistical one", done: true }] } },
  curve: { type: "LineChart", props: { id: "curve", title: "Validation loss by step", x: { label: "Step" }, y: { label: "Loss" },
    data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }, { name: "B", column: "b" }] } } },
  evidence: { type: "Group", props: { title: "Evidence" }, children: ["loss", "results"] },
  loss: { type: "Metrics", props: { items: [{ label: "Validation loss (B)", value: 0.412, previous: 0.429 }, { label: "Seeds", value: 3 }] } },
  results: { type: "Table", props: { id: "results", title: "Results", columns: [{ key: "model", label: "Model" }, { key: "loss", label: "Validation loss" }],
    rows: [{ id: "a", cells: { model: "A", loss: 0.429 }, sourceIds: ["run-a"] }, { id: "b", cells: { model: "B", loss: 0.412 }, sourceIds: ["run-b"] }] } },
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": { type: "Markdown", props: { text: "Three seeds per arm. Same data order, same evaluation split.\n\nScoring v1 matched keywords; v2 reads the whole answer, blind to the arm. The conclusion uses v2; v1 is kept only for comparison.\n\nThe interval is illustrative, built by hand to show the layout; it is not a statistical interval." } },
  long: { type: "Markdown", props: { text: longText } },
  next: { type: "Plan", props: { title: "Next steps", steps: [{ id: "s1", text: "Record the scoring definition", state: "done" }, { id: "s2", text: "Grow the long sample to 1,000", state: "todo" }] } },
  sources: { type: "Sources", props: { items: [{ id: "run-a", label: "Run A log", href: "https://example.test/run-a" }, { id: "run-b", label: "Run B log", href: "https://example.test/run-b" }] } },
  shots: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Loss by subset" }] } },
} };
const evalFiles = [
  { name: "loss.csv", kind: "data", mime: "text/csv", size: 1180, snapshot: true, mayChange: false, takenAt: iso(-60 * MIN) },
  { name: "shot.png", kind: "image", mime: "image/png", size: 1600, snapshot: true, mayChange: false, takenAt: iso(-60 * MIN), caption: "Loss by subset" },
];
// A small synthetic image (six bars) and the chart's points, as Core reads them from the snapshots.
const PNG = (() => {
  const [width, height] = [240, 140];
  const crc = (bytes) => { let c = ~0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3, 0xf7);
    for (let x = 0; x < width; x++) {
      const bar = Math.floor(x / 40), level = [50, 80, 110, 70, 95, 40][bar];
      if (x % 40 > 8 && x % 40 < 32 && height - y < level) row.set(bar === 2 ? [0xe0, 0x9a, 0x2b] : [0xc9, 0xbf, 0xae], 1 + x * 3);
    }
    row[0] = 0;
    rows.push(row);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
})();
const chartData = { series: [{ name: "A", points: [[0, 0.61], [100, 0.5], [200, 0.43]] }, { name: "B", points: [[0, 0.6], [100, 0.47], [200, 0.41]] }],
  downsampled: false, sourcePoints: 6 };
const section = (key, id, version, extra = {}) => ({ id, key, kind: "report", title: `Notes ${key}`, version, owner, body: evalBody, attachments: [], refs: {},
  seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN), ...extra });
const markdown = (text) => ({ root: "b", elements: { b: { type: "BriefBody", props: {}, children: ["t"] }, t: { type: "Markdown", props: { text } } } });
// Cards above the report, so Home has a scroll place to keep.
const fillers = ["setup", "data", "baseline"].map((key, i) => section(key, 20 + i, 1, { title: `Notes on ${key}`,
  body: markdown(Array.from({ length: 6 }, (_, n) => `Paragraph ${n + 1} about the ${key}.`).join("\n\n")) }));
let evalVersion = 3;
// Summary cards of every shape the deck draws (T-18 PR-B): many conditions,
// an image figure, a table figure.
const summaryBody = (lead, extra, summary) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary }, children: Object.keys(extra).concat("lead").sort((a, b) => (a === "lead" ? -1 : b === "lead" ? 1 : 0)) },
  lead: { type: "Markdown", props: { text: lead } },
  ...extra,
} });
// The batches' versions, each as its author writes it (T-18, Lead 2457, 2473): 1 and 2 a table, wide; 3 two Metrics,
// small; 4 a table again with no size, as a summary kept from before sizes (its figure's: wide). The refresh step
// reads 2 and 3 while Home stays open; the widget step reads 3 and 4 on a card pinned to the widgets.
let batchesVersion = 1;
// The batches written again under its key, another section (Home's id 52), for the widget step.
let batchesId = 32;
// A pinned card whose summary goes and comes back (Lead 2604): 1 and 3 with a summary, 2 without.
let pulseVersion = 1;
const pulseBody = () => pulseVersion === 2
  ? markdown("The pulse report, written again without a summary.")
  : summaryBody(`Pulse ${pulseVersion}: the queue is steady.`, {}, { lead: "lead", size: pulseVersion === 1 ? "wide" : "large" });
// Home's read failing on purpose, for the widget step.
let homeFails = false;
const batchesSize = () => (batchesVersion < 3 ? { size: "wide" } : batchesVersion === 3 ? { size: "small" } : {});
const batchesFigure = () => batchesVersion !== 3
  ? { table: { type: "Table", props: { id: "batches", title: "Drops by batch", columns: ["batch", "dupes", "dates", "amounts", "regions", "other"].map((key) => ({ key, label: key })),
      rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((id, i) => ({ id, cells: { batch: id, dupes: `${2 + i / 10}%`, dates: "0.4%", amounts: "0.1%", regions: "0.2%", other: "0%" } })) } } }
  : { table: { type: "Metrics", props: { items: [{ label: "Dropped", value: 2.4, unit: "%" }, { label: "Batches", value: 9 }] } } };
const deck = () => [
  section("audit", 30, 2, { title: "Fewer LLM round trips: three-stage static audit", body: summaryBody(
    "Found fixed hand-offs worth trying; not yet shown that most development calls can go to programs.",
    { holds: { type: "Checklist", props: { items: ["Read-only stored records", "Three-stage flow", "304 model replies", "Rule pre-screen", "Item-by-item audit", "One reviewer", "No live traffic", "Synthetic prompts"].map((text, i) => ({ id: `c${i}`, text, done: true })) } },
      funnel: { type: "Metrics", props: { items: [{ label: "Model replies", value: 304 }, { label: "Pre-screened", value: 52 }, { label: "Kept", value: 29 }] } } },
    { lead: "lead", visual: "funnel", conditions: "holds", size: "wide" }) }),
  section("screens", 31, 1, { title: "Home layout screenshots", attachments: [evalFiles[1]], body: summaryBody(
    "The deck adds a column as the pane widens and stacks on a phone.",
    { shot: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Loss by subset" }] } } },
    { lead: "lead", visual: "shot", size: "large" }) }),
  // An Ask: it always takes its row, at its own height (Dev 7's v12, 2396), and Organize does not list it.
  section("pages", 35, 1, { kind: "ask", title: "Rows per export page", body: markdown("The export page will show its table in pages."),
    ask: { question: "How many rows should one export page show?", reply: { options: [{ id: "50", label: "50 rows" }, { id: "100", label: "100 rows" }], freeText: true }, state: "open" } }),
  section("batches", batchesId, batchesVersion, { title: "Why batches were dropped", body: summaryBody(
    `All three batches stay under the ${batchesVersion === 1 ? 5 : 6}% stop line; duplicates are the largest cause.`,
    { why: { type: "Markdown", props: { text: "Only synthetic batches A to C were measured; real imports may differ. Dates and amounts were checked against the synthetic ledger alone, regions were not checked at all, and every other cause is counted together under other, so its share says nothing about any one of them." } },
      ...batchesFigure() },
    { lead: "lead", visual: "table", conditions: "why", ...batchesSize() }) }),
  // A summary kept from before sizes: no size, so its figure's (two Metrics values: small, the first value large).
  section("uptime", 33, 1, { title: "Synthetic service uptime", body: summaryBody(
    "Both synthetic services held their target this week.",
    { nums: { type: "Metrics", props: { items: [{ label: "Uptime", value: 99.2, unit: "%" }, { label: "Incidents", value: 1 }] } } },
    { lead: "lead", visual: "nums" }) }),
  section("pulse", 36, pulseVersion, { title: "Queue pulse", body: pulseBody() }),
  // A sub-topic of the audit: it says so in its head (Dev 7, 2399). Its author makes it wide, though a lead alone
  // would be small: the author's size, not Home's guess.
  section("audit/notes", 34, 1, { title: "Audit notes", body: summaryBody("The sample is the stored records of one week.", {}, { lead: "lead", size: "wide" }) }),
];
const sections = () => [...fillers, section("eval", 7, evalVersion, { title: "Synthetic eval: model B vs A", attachments: evalFiles }),
  { ...section("dose-study", 8, 3), title: doseStudy.title, body: doseStudy.body }, ...deck()];
const pointer = (document, at) => at.split("/").slice(1).reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), document);
/** Core's research read of the desk, from the fixture files, as research.rs answers it. */
function research(version) {
  const desk = doseStudy.body.elements.desk.props;
  const values = {};
  for (const plot of desk.plots)
    for (const row of plot.rows)
      for (const [id, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (!number || typeof number !== "object") continue;
          const found = pointer(fixtureFiles[number.from], number.pointer);
          values[`${id}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
        }
  const sources = Object.fromEntries(desk.sources.filter((source) => source.snapshot).map((source) => [source.id, {
    attachment: source.snapshot, takenAt: iso(-60 * MIN), size: 1200, sha256: "5f3c".padEnd(64, "0"), available: true }]));
  return { key: doseStudy.key, version, elementId: "desk", values, sources };
}
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: sections(), history: [] }, unseen: 1, missing: [] }] });
// The project's one repository (synthetic), for its line on Home (T-18).
const linkedRepo = { id: 1, fullName: "example/atlas-notes", url: "https://github.com/example/atlas-notes", syncedAt: iso(-MIN), error: null };
const repoActivity = () => ({ ...linkedRepo, defaultBranch: "main", observedAt: iso(-MIN), stale: false, pullsTotal: 2,
  commits: [{ sha: "b2eaeea5b9270debca8421ebfc94b2fc0bb13f5c", title: "Merge the synthetic loader fix", author: "mori", at: iso(-16 * 60 * MIN), url: "https://github.com/example/atlas-notes/commit/b2eaeea" }],
  pulls: [{ number: 12, title: "Dose study notes", author: "mori", draft: false, url: "https://github.com/example/atlas-notes/pull/12" }],
  runs: [{ id: 7, name: "CI", branch: "main", status: "completed", conclusion: "success", at: iso(-15 * 60 * MIN), url: "https://github.com/example/atlas-notes/actions/runs/7" }] });
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 32, totalPct: 20, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 40107, usedMiB: 12000, availableMiB: 28107, jobsMiB: 0, agentsMiB: null }, gpus: [],
  // One running Job with a long synthetic name: the Jobs here stay one line, cut with an ellipsis.
  jobs: [{ id: "job-1", name: "synthetic dose study: bootstrap intervals for every arm and seed", agentId: "a", agentName: "Mori", projectId: "p1", cpuPct: 12, memMiB: 512 }] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (path === "/api/agents/a/reading") return route.fulfill({ json: request.method() === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    // A list read (home-api.ts): it starts no GitHub sync.
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [linkedRepo], links: [] } });
    // The links, once Repository details show them, ask Core to refresh them (as before T-18): a read, counted apart.
    if (path === "/api/collaboration/github_refresh") {
      report.refreshes.push(path);
      return route.fulfill({ json: { repositories: [linkedRepo], links: [] } });
    }
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/projects/p1/brief/chart/eval/curve") {
    report.reads.push(`${path}?${url.searchParams}`);
    return route.fulfill({ json: chartData });
  }
  if (/^\/api\/projects\/p1\/brief\/attachments\/(eval|screens)\/shot\.png$/.test(path)) {
    report.reads.push(`${path}?${url.searchParams}`);
    return route.fulfill({ body: PNG, contentType: "image/png" });
  }
  // This Agent's Codex account, tools and queued inputs: none here.
  if (["/api/agents/a/codex/usage", "/api/agents/a/codex/mcp", "/api/agents/a/conversation/inputs"].includes(path))
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  if (path === "/api/projects/p1/brief/research/dose-study/desk") {
    report.reads.push(`${path}?${url.searchParams}`);
    return route.fulfill({ json: research(Number(url.searchParams.get("version"))) });
  }
  if (path === "/api/home" && homeFails) return route.fulfill({ status: 500, json: { error: "synthetic failure" } });
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [repoActivity()] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  try {
    return await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ status: 404, body: "" });
  }
}

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function open(width, height, { motion = "reduce", at = "/" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: motion, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        // The last one opened, so a step can say what Core says when a Brief changes.
        window.__events = this;
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${width}: pageerror: ${error.message}`));
  // The fixture answers this Agent's Codex account, tools and queued inputs with 404 on purpose.
  const answered404 = (message) => /\/api\/agents\/a\/(codex\/usage|codex\/mcp|conversation\/inputs)\b/.test(message.location()?.url ?? "")
    // Home's read made to fail on purpose (the widget step).
    || (homeFails && /\/api\/home\b/.test(message.location()?.url ?? ""));
  page.on("console", (message) => message.type() === "error" && !answered404(message) && report.errors.push(`${width}: console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}${at}`);
}
async function toHome() {
  const nav = page.locator(".toolbar-nav .catchup-nav").first();
  await nav.waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await nav.click();
  await card("eval").waitFor({ timeout: 10_000 });
}
const card = (key) => page.locator(`.home-view [data-section-key="${key}"]`);
const opener = (key) => card(key).locator(".home-report-open");
const reportPage = () => page.locator(".home-report");
async function openReport(key) {
  await opener(key).scrollIntoViewIfNeeded();
  await opener(key).click();
  await reportPage().locator(".report-head h1").waitFor();
  await sleep(150);
}
/** The page's layout: sizes, what shows, and whether anything scrolls sideways. */
const layout = () => page.evaluate(() => {
  const root = document.querySelector(".home-report");
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const px = (selector) => { const el = root.querySelector(selector); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
  const sideways = [root, ...root.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && !["visible", "hidden", "clip"].includes(getComputedStyle(el).overflowX)
    && !el.closest(".result-table-scroll, pre, .research-desk")).map((el) => el.className || el.tagName).slice(0, 5);
  const scroller = document.scrollingElement;
  return {
    root: box(root), bar: box(root.querySelector(".report-bar")), main: box(root.querySelector(".report-main")), hero: box(root.querySelector(".report-hero")),
    lead: box(root.querySelector(".report-lead")), firstBlock: box(root.querySelector(".report-main > .report-block")),
    rail: root.querySelector(".report-rail nav")?.checkVisibility() ?? null, contents: root.querySelector(".report-contents")?.checkVisibility() ?? null,
    contentsHeight: box(root.querySelector(".report-contents > summary"))?.height ?? null,
    railBox: box(root.querySelector(".report-rail")), railHeading: root.querySelector(".report-rail-heading")?.checkVisibility() ?? null,
    sources: root.querySelector(".report-rail a[href='https://example.test/run-a']")?.checkVisibility() ?? null,
    image: (() => { const img = root.querySelector(".report-rail img"); return img ? { visible: img.checkVisibility(), loaded: img.complete && img.naturalWidth > 0 } : null; })(),
    conditions: root.querySelector(".report-conditions")?.checkVisibility() ?? null,
    dataLine: root.querySelector(".report-hero")?.innerText.match(/loss\.csv/g)?.length ?? 0,
    h1: px(".report-head h1"), leadSize: px(".report-lead .brief-markdown"),
    page: scroller.scrollWidth > scroller.clientWidth, sideways,
  };
});

/**
 * Text contrast on the report, from computed styles (WCAG, 4.5:1 for text):
 * each element's colour over its opaque background, composited from the
 * root down, in every palette and theme. The lowest per selector.
 */
const contrast = (selectors) => page.evaluate((selectors) => {
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const paint = (colors) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#fff";
    probe.fillRect(0, 0, 1, 1);
    for (const color of colors) {
      probe.fillStyle = "#000";
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
    }
    return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
  };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const html = document.documentElement;
  const kept = [html.dataset.palette, html.dataset.theme];
  const out = {};
  for (const palette of ["garden", "yuzu", "graphite", "pine", "sunroom"])
    for (const theme of ["light", "dark"]) {
      html.dataset.palette = palette;
      html.dataset.theme = theme;
      for (const selector of selectors)
        for (const el of document.querySelectorAll(selector)) {
          if (!el.checkVisibility() || !el.textContent.trim()) continue;
          const chain = [];
          for (let n = el; n; n = n.parentElement) chain.unshift(getComputedStyle(n).backgroundColor);
          const background = paint(chain);
          const text = paint([`rgb(${background.join(",")})`, getComputedStyle(el).color]);
          const value = ratio(text, background);
          if (!out[selector] || value < out[selector].ratio) out[selector] = { ratio: value, palette, theme, text: el.textContent.trim().slice(0, 30) };
        }
    }
  [html.dataset.palette, html.dataset.theme] = kept;
  return out;
}, selectors);
const TEXT = [".report-back", ".report-crumb > span", ".report-actions button", ".report-kicker > span", ".report-meta > span", ".report-conditions-label",
  ".report-rail h2", ".report-outline button", ".report-files span", ".report-files strong", ".report-notice p", ".report-notice button"];
const lowContrast = (found) => Object.entries(found).filter(([, value]) => value.ratio < 4.5);

try {
  await step("desktop 1440: Open report over Home; the author's summary first, once; sources and an image in the rail, unfolded; only the named detail folds; Back keeps Home's place and focus", async () => {
    await open(1440, 900);
    await toHome();
    // Where Home is when the button is clicked: the click scrolls the button into view first.
    await opener("eval").scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => document.querySelector(".home-view").scrollTop);
    assert.ok(before > 0, `Home scrolled (${before})`);
    await openReport("eval");
    await until("the figure's points", async () => (await reportPage().locator(".report-hero svg").count()) > 0);
    await until("the image", async () => (await layout()).image?.loaded);
    const shown = await layout();
    assert.ok(shown.rail === true && shown.contents === false && shown.railHeading === false, JSON.stringify(shown));
    assert.ok(shown.sources === true && shown.image?.visible === true, `sources and the image show without a click: ${JSON.stringify(shown)}`);
    assert.ok(shown.railBox.left >= shown.main.left + shown.main.width, "the rail beside the body");
    assert.equal(shown.conditions, true);
    assert.equal(shown.dataLine, 1, "the figure names its data file once, itself");
    assert.equal(shown.h1, 30);
    assert.equal(shown.leadSize, 18);
    assert.ok(shown.lead.top < shown.hero.top && shown.hero.top < shown.firstBlock.top, "the conclusion, then the figure, then the rest");
    assert.ok(shown.main.width >= 640 && shown.main.width <= 960, `main column ${shown.main.width}px`);
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    assert.equal(await page.evaluate(() => document.activeElement?.matches(".report-head h1")), true, "the title has focus");
    const under = await page.evaluate(() => { const v = document.querySelector(".home-view"); return { inert: v.inert, hidden: getComputedStyle(v).visibility }; });
    assert.deepEqual(under, { inert: true, hidden: "hidden" });
    // The page's own text, its actions included, at 4.5:1 or more in every palette and theme.
    const readable = await contrast(TEXT);
    assert.deepEqual(lowContrast(readable), [], JSON.stringify(readable));
    // Each summary block once in the page's body (the rail names figures to go to).
    const once = await page.evaluate(() => ["Model B lowers validation loss", "Scoring definition v2", "Validation loss by step"]
      .map((text) => document.querySelector(".report-main").innerText.split(text).length - 1));
    assert.deepEqual(once, [1, 1, 1]);
    assert.equal(page.url(), `https://${HOST}/#/report?w=${WS}&p=p1&k=eval&v=3&s=7`, "the report's link is the address while it is open");
    await shot("desktop-report.png");
    // Long text is whole; only the named detail folds, two lines showing until opened.
    const long = await reportPage().locator("#report-block-long").evaluate((el) => ({ toggle: !!el.querySelector("button"), last: el.innerText.includes("Note 30:") }));
    assert.deepEqual(long, { toggle: false, last: true });
    const method = reportPage().locator("#report-block-method");
    await method.scrollIntoViewIfNeeded();
    const closed = await method.evaluate((el) => { const body = el.querySelector(".report-detail-body"); return { client: body.clientHeight, scroll: body.scrollHeight, inert: body.inert }; });
    assert.ok(closed.client < closed.scroll && closed.client > 0 && closed.inert, JSON.stringify(closed));
    await shot("desktop-method-closed.png", "#report-block-method");
    await method.getByRole("button", { name: "Show “Method”" }).click();
    const opened = await method.evaluate((el) => { const body = el.querySelector(".report-detail-body"); return { client: body.clientHeight, scroll: body.scrollHeight, inert: body.inert }; });
    assert.ok(opened.client >= opened.scroll - 1 && !opened.inert, JSON.stringify(opened));
    await shot("desktop-method-open.png", "#report-block-method");
    // The outline goes to a part, below the sticky bar, and adds no history entry.
    const length = await page.evaluate(() => history.length);
    await reportPage().locator("nav.report-rail-part button", { hasText: "Evidence" }).click();
    await sleep(150);
    const placed = await page.evaluate(() => ({
      bar: document.querySelector(".report-bar").getBoundingClientRect().bottom,
      block: document.querySelector("#report-block-evidence").getBoundingClientRect().top,
      length: history.length, hash: location.hash,
    }));
    assert.ok(placed.block >= placed.bar - 1 && placed.block <= placed.bar + 80 && placed.length === length && placed.hash.startsWith("#/report?"), JSON.stringify(placed));
    await shot("desktop-evidence.png");
    // Back: Home as it was, focus on the button that opened the report.
    await reportPage().locator(".report-back").click();
    await until("the report closed", async () => !(await reportPage().count()));
    const after = await page.evaluate(() => ({
      top: document.querySelector(".home-view").scrollTop,
      focus: document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false,
      ring: document.querySelector('.home-view [data-section-key="eval"]').hasAttribute("data-report-return"),
      hash: location.hash,
    }));
    assert.ok(Math.abs(after.top - before) <= 1 && after.focus && after.ring && after.hash === "", JSON.stringify({ before, ...after }));
    return { before, after, layout: shown, closed, opened, placed, contrast: readable };
  });

  await step("desktop: a research desk on the report is the interactive one, reading its numbers at the version shown", async () => {
    await open(1440, 900);
    await toHome();
    await openReport("dose-study");
    const desk = reportPage().locator(".research-desk");
    await until("the snapshot numbers", async () => (await desk.innerText()).includes("−2.04"));
    await desk.locator('[role="radiogroup"][aria-label="Show"] [role="radio"]', { hasText: "Each arm's own mean" }).click();
    await until("the parts", async () => (await desk.locator(".research-caption").innerText().catch(() => "")) === "High dose");
    assert.ok(report.reads.some((read) => read.endsWith("version=3")), JSON.stringify(report.reads));
    const shown = await layout();
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    await shot("desktop-research.png");
  });

  await step("the browser's Back and Forward, a reload and Escape: one entry for the report, none added by going back and forth", async () => {
    await open(1440, 900);
    await toHome();
    const start = await page.evaluate(() => history.length);
    await openReport("eval");
    await reportPage().getByRole("button", { name: "Copy link" }).click();
    const copied = await until("the copied link", () => page.evaluate(() => navigator.clipboard.readText()));
    assert.equal(copied, linkHref(3));
    assert.equal(await page.evaluate(() => history.length), start + 1, "one entry for the report");
    await page.goBack();
    await until("closed by the browser's Back", async () => !(await reportPage().count()));
    assert.equal(page.url(), `https://${HOST}/`, "Home's address, the page itself stayed");
    await page.goForward();
    await reportPage().locator(".report-head h1").waitFor();
    assert.equal(page.url(), linkHref(3));
    await page.goBack();
    await until("closed again", async () => !(await reportPage().count()));
    await page.goForward();
    await reportPage().locator(".report-head h1").waitFor();
    assert.equal(await page.evaluate(() => history.length), start + 1, "Back and Forward add no entry");
    // A reload opens the same report again, in the same entry.
    await page.reload();
    await reportPage().locator(".report-head h1").waitFor({ timeout: 15_000 });
    assert.equal(page.url(), linkHref(3));
    assert.equal(await page.evaluate(() => history.length), start + 1, "the reload adds no entry");
    await page.goBack();
    await until("closed after the reload", async () => !(await reportPage().count()));
    await toHome();
    await openReport("eval");
    await page.keyboard.press("Escape");
    await until("closed by Escape", async () => !(await reportPage().count()));
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false), true);
    return { copied, start };
  });

  await step("a report link in the address opens it over Home in that entry; a version not kept is said, with the versions there are; Back stays in Yuzuno", async () => {
    evalVersion = 4;
    await open(1440, 900, { at: `/#/report?w=${WS}&p=p1&k=eval&v=3&s=7` });
    const length = await page.evaluate(() => history.length);
    const notice = await until("the notice", async () => (await reportPage().locator(".report-notice").count()) && reportPage().locator(".report-notice p").innerText());
    assert.equal(notice, "Version 3 of this report is not on Home: Home keeps a report's newest version and the versions in its History.");
    assert.equal(await reportPage().locator(".report-article").count(), 0);
    // Its one action is the filled one, and reads at 4.5:1 or more everywhere.
    assert.equal(await reportPage().locator(".report-notice .report-notice-main").innerText(), "Open version 4 (current)");
    const readable = await contrast([".report-notice p", ".report-notice button", ".report-actions button", ".report-back"]);
    assert.deepEqual(lowContrast(readable), [], JSON.stringify(readable));
    await shot("desktop-unavailable.png");
    await reportPage().getByRole("button", { name: "Open version 4 (current)" }).click();
    await until("version 4", async () => /version 4/.test(await reportPage().locator(".report-meta").innerText().catch(() => "")));
    assert.equal(page.url(), linkHref(4));
    await reportPage().locator(".report-back").click();
    await until("Home", async () => !(await reportPage().count()) && page.locator(".home-view").isVisible());
    assert.equal(page.url(), `https://${HOST}/`, "the page's Back stays in Yuzuno");
    assert.equal(await page.evaluate(() => history.length), length, "no entry added");
    evalVersion = 3;
  });

  await step("a report link in a conversation opens the report, and Back returns to that message", async () => {
    await open(1440, 900);
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click({ timeout: 10_000 });
    const link = page.locator('[data-item-id="r1"] a', { hasText: "Synthetic eval" });
    await link.waitFor({ timeout: 10_000 });
    await link.click();
    await reportPage().locator(".report-head h1").waitFor();
    assert.equal(await page.locator(".home-view").count(), 1, "Home is under the report");
    const backButton = reportPage().locator(".report-back");
    assert.equal((await backButton.innerText()).trim(), "Back to the message");
    await backButton.click();
    await until("the conversation", async () => !(await page.locator(".home-view").count()) && page.locator('[data-item-id="r1"]').isVisible());
    return { url: page.url() };
  });

  await step("phone 390: Contents first, Sources & attachments after the body, nothing sideways; Back returns to the card", async () => {
    await open(390, 844);
    await toHome();
    await openReport("eval");
    await reportPage().locator(".report-rail").scrollIntoViewIfNeeded();
    await until("the image", async () => (await layout()).image?.loaded);
    await reportPage().locator(".report-head").scrollIntoViewIfNeeded();
    const shown = await layout();
    assert.ok(shown.rail === false && shown.contents === true && shown.contentsHeight >= 44 && shown.railHeading === true, JSON.stringify(shown));
    assert.ok(shown.railBox.top >= shown.main.top + shown.main.height - 1, "Sources & attachments after the body");
    assert.ok(shown.sources === true && shown.image?.visible === true, JSON.stringify(shown));
    assert.equal(shown.h1, 23);
    assert.equal(shown.leadSize, 16);
    assert.ok(!shown.page && !shown.sideways.length, JSON.stringify(shown));
    assert.ok(shown.hero.width >= shown.root.width - 1, `the figure edge to edge (${shown.hero.width} of ${shown.root.width})`);
    await shot("phone-report.png");
    // The whole page: the report scrolls in its own container, so the window
    // is made as tall as that content for one capture, then put back.
    const extra = await page.evaluate(() => { const r = document.querySelector(".home-report"); return r.scrollHeight - r.clientHeight; });
    await page.setViewportSize({ width: 390, height: 844 + extra });
    await sleep(200);
    assert.equal(await page.evaluate(() => { const r = document.querySelector(".home-report"); return r.scrollHeight <= r.clientHeight + 1; }), true, "the whole report in one capture");
    await page.screenshot({ path: resolve(output, "phone-report-full.png"), fullPage: true });
    report.shots.push("phone-report-full.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    await reportPage().locator(".report-contents summary").click();
    await reportPage().locator(".report-contents button", { hasText: "Sources & attachments" }).click();
    await sleep(150);
    await shot("phone-sources.png");
    await reportPage().locator(".report-back").click();
    await until("the report closed", async () => !(await reportPage().count()));
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-section-key="eval"] .home-report-open') ?? false), true);
    return { layout: shown };
  });

  for (const [width, height, name] of [[1720, 1100, "home-1720"], [1200, 900, "home-1200"], [647, 900, "home-647"], [390, 844, "home-phone-390"]])
    await step(`Home deck at ${width}: columns by the pane; small, wide and large cards in the author's order, none cut; conditions in two lines, cards with no summary show how they open; nothing sideways`, async () => {
      await open(width, height);
      await toHome();
      // The repositories' line reads its activity only once on screen, as the lists did.
      await page.locator('[data-home-project="p1"] .home-repos').scrollIntoViewIfNeeded();
      await until("the repository's line", () => page.locator('[data-home-project="p1"] .home-repos .repo-line-commit .repo-row').count());
      await card("audit").scrollIntoViewIfNeeded();
      await until("the image figure", () => page.evaluate(() => { const img = document.querySelector('[data-section-key="screens"] .home-card-frame img'); return img?.complete && img.naturalWidth > 0; }));
      const deckShape = await page.evaluate(() => {
        const brief = document.querySelector('[data-home-project="p1"] .home-brief');
        // The deck's own width decides its columns (Dev 7's v12).
        const container = brief.closest(".home-panel-content").clientWidth;
        const cards = [...brief.querySelectorAll(".home-section")];
        const grid = getComputedStyle(brief);
        const columns = grid.gridTemplateColumns.split(" ").length, gap = parseFloat(grid.columnGap);
        const column = (brief.clientWidth - gap * (columns - 1)) / columns;
        const places = cards.map((el) => {
          const r = el.getBoundingClientRect(), style = getComputedStyle(el);
          return { key: el.dataset.sectionKey, size: el.dataset.cardSize ?? null, source: el.dataset.sizeSource ?? null, top: Math.round(r.top), left: Math.round(r.left),
            width: Math.round(r.width), height: Math.round(r.height), span: Math.round((r.width + gap) / (column + gap)), rows: style.gridRowStart,
            cut: el.scrollHeight > el.clientHeight + 1,
            // A wide card's figure beside its text, or under it; a small card's frame (none) and big numbers.
            beside: (() => { const text = el.querySelector(".home-summary-text"), fig = el.querySelector(".home-card-frame");
              return text && fig ? fig.getBoundingClientRect().left >= text.getBoundingClientRect().right - 1 : null; })(),
            frame: !!el.querySelector(".home-card-frame"),
            // Nothing kept between the text and the figure but the body's gap (Dev 7, 2547).
            leadGap: (() => { const text = el.querySelector(".home-summary-text"), fig = el.querySelector(".home-card-frame");
              return text && fig && fig.getBoundingClientRect().top > text.getBoundingClientRect().top ? Math.round(fig.getBoundingClientRect().top - text.getBoundingClientRect().bottom) : null; })(),
            minHeight: style.minHeight,
            // "Open report" on one line, however the foot wraps (Dev 7, 2396).
            open: (() => { const b = el.querySelector(".home-report-open"); return b ? { wrap: getComputedStyle(b).whiteSpace, height: Math.round(b.getBoundingClientRect().height) } : null; })(),
            subOf: el.querySelector(".home-summary-head > .home-sub-of:first-child, .home-section-head > .home-sub-of")?.textContent ?? null,
            borderLeft: style.borderLeftWidth,
            conditions: (() => { const c = el.querySelector(".home-card-conditions"); if (!c) return null; const cs = getComputedStyle(c);
              return { widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth], colors: new Set([cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor]).size, radius: cs.borderTopLeftRadius }; })(),
            numbers: [...el.querySelectorAll(".home-card-numbers > div")].map((d) => ({ label: d.querySelector("dt").textContent, value: d.querySelector("dd").textContent, size: getComputedStyle(d.querySelector("dd")).fontSize, wrap: getComputedStyle(d.querySelector("dd")).whiteSpace })) };
        });
        const one = (key) => document.querySelector(`.home-view [data-section-key="${key}"]`);
        const frame = (key) => one(key)?.querySelector(".home-card-frame-body")?.getBoundingClientRect().height ?? null;
        const chips = [...one("audit").querySelectorAll(".home-card-condition-chips li")];
        const shown = chips.filter((li) => !li.hidden);
        const scroller = document.scrollingElement;
        return {
          container, columns, places,
          frames: { audit: frame("audit"), screens: frame("screens"), batches: frame("batches"), eval: frame("eval") },
          chipLines: new Set(shown.map((li) => li.offsetTop)).size, hidden: chips.length - shown.length,
          more: one("audit").querySelector(".home-card-conditions-toggle")?.textContent ?? null,
          table: one("batches").querySelector("figcaption")?.textContent ?? null,
          tableCells: one("batches").querySelectorAll(".home-card-table tbody td").length,
          legacy: one("setup").querySelector(".home-summary-lead")?.textContent ?? null,
          legacyBody: !!one("setup").querySelector(".brief-body"),
          // A card with no summary: its height, at the deck's minimum as the others have (YN-3).
          legacyHeights: ["setup", "dose-study"].map((key) => Math.round(one(key).getBoundingClientRect().height)),
          leadMin: getComputedStyle(one("audit").querySelector(".home-summary-lead .brief-markdown")).minHeight,
          machines: (() => {
            const widget = document.querySelector(".home-machines"), column = document.querySelector(".home-widget-column");
            const cells = [...widget.querySelectorAll(".home-machine > *")].map((el) => el.getBoundingClientRect());
            return { width: Math.round(widget.getBoundingClientRect().width), column: Math.round(column.getBoundingClientRect().width),
              height: Math.round(widget.getBoundingClientRect().height), rows: new Set(cells.map((r) => Math.round(r.top))).size, cells: cells.length };
          })(),
          repos: (() => {
            const bar = document.querySelector('[data-home-project="p1"] .home-repos'), line = bar?.querySelector(".repo-line");
            return bar && { height: Math.round(bar.getBoundingClientRect().height), lineHeight: Math.round(line.getBoundingClientRect().height),
              text: line.innerText.replace(/\s+/g, " "), details: bar.querySelector(".home-repos-details")?.textContent ?? null };
          })(),
          sideways: scroller.scrollWidth > scroller.clientWidth || [...document.querySelectorAll(".home-view *")].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "auto" && !el.closest(".result-table-scroll, pre")),
        };
      });
      const expected = deckShape.container >= 1248 ? 4 : deckShape.container >= 560 ? 2 : 1;
      assert.equal(deckShape.columns, expected, JSON.stringify(deckShape));
      // Each card at the size its author named (Lead 2457), the notes wide though a lead alone; a card with no
      // summary small, and one kept from before sizes (uptime) its figure's (Lead 2473).
      const sizes = Object.fromEntries(deckShape.places.filter((p) => p.size).map((p) => [p.key, `${p.size} ${p.source}`]));
      assert.deepEqual(sizes, { setup: "small content", data: "small content", baseline: "small content", eval: "wide author", "dose-study": "small content",
        audit: "wide author", "audit/notes": "wide author", screens: "large author", batches: "wide author", uptime: "small content", pulse: "wide author" });
      for (const place of deckShape.places.filter((p) => p.size)) {
        const span = deckShape.columns === 1 || place.size === "small" ? 1 : 2;
        assert.equal(place.span, span, `${place.key} spans ${span}: ${JSON.stringify(place)}`);
        assert.equal(place.rows, place.size === "large" && deckShape.columns === 4 ? "span 2" : "auto", `${place.key}'s rows: ${JSON.stringify(place)}`);
        assert.equal(place.cut, false, `${place.key} shows all it holds: ${JSON.stringify(place)}`);
        // A wide card's figure beside its text where the deck has two columns or more; stacked on one.
        if (place.size === "wide" && place.beside !== null) assert.equal(place.beside, deckShape.columns > 1, `${place.key}'s figure beside its text: ${JSON.stringify(place)}`);
        if (place.size === "small") assert.equal(place.frame, false, `a small card has no frame: ${place.key}`);
        if (place.size === "large" && place.leadGap !== null) assert.ok(place.leadGap <= 12, `${place.key}: ${place.leadGap} px between its text and its figure`);
        // A minimum on each card, not each row (Dev 7, 2396): none on one column; a card with no summary has it too (YN-3).
        const least = deckShape.columns === 1 ? "auto" : place.size === "large" && deckShape.columns === 4 ? "536px" : "260px";
        assert.equal(place.minHeight, least, `${place.key}'s minimum height: ${JSON.stringify(place)}`);
        if (place.open) assert.ok(place.open.wrap === "nowrap" && place.open.height <= 34, `${place.key}'s Open on one line: ${JSON.stringify(place.open)}`);
        // No stripe on any card's side, nor on its conditions: one border all round.
        assert.equal(place.borderLeft, "1px", `${place.key}: ${place.borderLeft}`);
        if (place.conditions) assert.ok(place.conditions.widths.every((w) => w === "1px") && place.conditions.colors === 1 && place.conditions.radius === "8px", `${place.key}'s conditions: ${JSON.stringify(place.conditions)}`);
      }
      // The Ask takes its whole row, at its own height.
      const ask = deckShape.places.find((p) => p.key === "pages");
      assert.equal(ask.span, deckShape.columns, `the Ask spans its row: ${JSON.stringify(ask)}`);
      assert.equal(ask.minHeight, "auto");
      assert.equal(ask.cut, false);
      // The audit's sub-topic says which topic it is in, first in its head.
      assert.equal(deckShape.places.find((p) => p.key === "audit/notes").subOf, "in Audit");
      assert.deepEqual(deckShape.places.filter((p) => p.subOf && p.key !== "audit/notes").map((p) => p.key), []);
      // The small Metrics card: its first value large, the second beside it, each with its unit on one line.
      const uptime = deckShape.places.find((p) => p.key === "uptime");
      assert.deepEqual(uptime.numbers.map((n) => [n.label, n.value]), [["Uptime", "99.2\u00a0%"], ["Incidents", "1"]], JSON.stringify(uptime));
      assert.equal(uptime.numbers[0].size, "32px");
      assert.ok(uptime.numbers.every((n) => n.wrap === "nowrap"), JSON.stringify(uptime.numbers));
      // The order on screen, row by row, is the author's: nothing packed into an earlier gap.
      const onScreen = [...deckShape.places].sort((a, b) => a.top - b.top || a.left - b.left).map((p) => p.key);
      assert.deepEqual(onScreen, deckShape.places.map((p) => p.key), JSON.stringify(deckShape.places));
      // Frames by size (Dev 7's v12): wide 140 px stacked, as tall as the body (140 or more) beside the text;
      // large 200 px stacked, 260 or more on two columns or four. A chart's (eval's) is never under 152 px, which
      // holds its names, legend and axes with a plot between them (Lead 2655; home-card-chart-check).
      for (const [key, value] of Object.entries(deckShape.frames)) {
        const height = Math.round(value);
        const least = key === "eval" ? 152 : 140;
        if (key === "screens") assert.ok(deckShape.columns > 1 ? height >= 260 : height === 200, `a large card's figure: ${height}`);
        else assert.ok(deckShape.columns > 1 ? height >= least : height === least, `${key}'s frame: ${height} ${JSON.stringify(deckShape.frames)}`);
      }
      assert.ok(deckShape.chipLines <= 3 && deckShape.hidden !== 1, JSON.stringify(deckShape));
      if (deckShape.hidden > 0) assert.equal(deckShape.more, `+${deckShape.hidden} more conditions`);
      assert.equal(deckShape.table, "3 of 9 rows · 3 of 6 columns");
      assert.equal(deckShape.tableCells, 9);
      assert.equal(deckShape.legacy, "Paragraph 1 about the setup.");
      assert.equal(deckShape.legacyBody, false);
      assert.equal(deckShape.sideways, false, JSON.stringify(deckShape));
      // Dev 7 (2308): the lead keeps three lines only where a row lines up.
      assert.equal(deckShape.leadMin === "0px", deckShape.columns === 1, `the lead's minimum height: ${deckShape.leadMin}`);
      if (deckShape.columns > 1) assert.ok(deckShape.legacyHeights.every((h) => h >= 260), `cards with no summary at the deck's minimum: ${deckShape.legacyHeights}`);
      // Machines fills its row, as one row of four cells where it is wide.
      assert.equal(deckShape.machines.width, deckShape.machines.column, JSON.stringify(deckShape.machines));
      assert.equal(deckShape.machines.cells, 4);
      // One row of four where it is wide, two by two where it is narrow; Jobs is one line either way (Dev 7, 2326).
      const wide = deckShape.machines.width > 760;
      assert.equal(deckShape.machines.rows, wide ? 1 : 2, JSON.stringify(deckShape.machines));
      assert.ok(deckShape.machines.height <= (wide ? 140 : 210), `Machines stays short: ${JSON.stringify(deckShape.machines)}`);
      // Repositories: one line under the project head where there is room.
      assert.match(deckShape.repos.text, /example\/atlas-notes.*main.*passed\s*CI.*b2eaeea\s*Merge the synthetic loader fix.*2 open PRs/);
      assert.equal(deckShape.repos.details, "Repository details");
      if (deckShape.container >= 800) assert.ok(deckShape.repos.lineHeight <= 30, `one line: ${JSON.stringify(deckShape.repos)}`);
      await shot(`${name}.png`);
      // Every palette and theme (Dev 7, 2351), the controls that show only after a click included:
      // the conditions' toggle both ways, a card's More actions, Repository details opened.
      const CARD_TEXT = [
        ".home-summary-card :is(.home-summary-title-link, .home-summary-lead, .home-summary-foot span, .home-report-open, .home-card-condition-chips li, figcaption, .home-card-conditions-label, .home-card-conditions-toggle)",
        ".home-summary-card .home-card-conditions .brief-markdown :is(p, li)",
        ".home-summary-card .home-card-numbers :is(dt, dd)",
        ".home-summary-card :is(.home-sub-of, .home-card-numbers-count)",
        '[data-home-project="p1"] .home-repos :is(.repo-name, .repo-branch, .repo-state, .repo-row-title, .repo-line-pulls, .repo-asof, .home-repos-details)',
        ".home-machines :is(.home-load-title, .home-load-short, .home-machine-job-count, .home-machine-job-first, .home-machines-manage)",
      ];
      const measured = { closed: await contrast(CARD_TEXT) };
      // The conditions' toggles (chips: "+N more conditions"; text: "Show all conditions"; open: "Show fewer
      // conditions"), at rest, under the pointer and with keyboard focus, in every palette and theme (Lead 2353).
      const toggle = (key) => card(key).locator(".home-card-conditions-toggle");
      const toggleStates = async (state) => {
        for (const key of ["audit", "batches"]) {
          if (!(await toggle(key).count())) continue;
          const selector = `.home-view [data-section-key="${key}"] .home-card-conditions-toggle`;
          const aria = await toggle(key).evaluate((el) => ({ label: el.textContent, expanded: el.getAttribute("aria-expanded"), controls: !!document.getElementById(el.getAttribute("aria-controls")) }));
          assert.equal(aria.controls, true, `${key}: aria-controls names the conditions`);
          await toggle(key).hover();
          measured[`${state} ${key} hover (${aria.label})`] = await contrast([selector]);
          await page.mouse.move(0, 0);
          // Reached by the keyboard, as a keyboard user reaches it.
          await toggle(key).focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          assert.equal(await toggle(key).evaluate((el) => el === document.activeElement), true, `${key}: Tab returns to it`);
          const ring = await toggle(key).evaluate((el) => ({ visible: el.matches(":focus-visible"), outline: getComputedStyle(el).outlineWidth }));
          assert.ok(ring.visible && parseFloat(ring.outline) >= 2, `${key}: a focus ring ${JSON.stringify(ring)}`);
          measured[`${state} ${key} focus (${aria.label})`] = await contrast([selector]);
          await toggle(key).blur();
          // The cascade as computed: at rest it is the accent ink, the colour of the card's "Open report".
          const inks = await card(key).evaluate((el) => [el.querySelector(".home-card-conditions-toggle"), el.querySelector(".home-report-open")].map((n) => getComputedStyle(n).color));
          assert.equal(inks[0], inks[1], `${key}: the toggle in the accent ink ${JSON.stringify(inks)}`);
          measured[`${state} ${key} at rest`] = await contrast([selector]);
          measured[`${state} ${key} aria`] = aria;
        }
      };
      await toggleStates("closed");
      assert.match(await toggle("batches").textContent(), /^Show all conditions$/, "the text conditions are clamped");
      if (deckShape.hidden > 0) {
        await toggle("audit").click();
        const opened = await card("audit").evaluate((el) => ({ hidden: el.querySelectorAll(".home-card-condition-chips li[hidden]").length, label: el.querySelector(".home-card-conditions-toggle").textContent }));
        assert.deepEqual(opened, { hidden: 0, label: "Show fewer conditions" });
      }
      await toggle("batches").click();
      assert.equal(await toggle("batches").textContent(), "Show fewer conditions");
      await toggleStates("open");
      await card("batches").scrollIntoViewIfNeeded();
      await shot(`${name}-conditions-open.png`);
      for (const key of ["audit", "batches"])
        if (measured[`open ${key} aria`]) assert.equal(measured[`open ${key} aria`].expanded, "true", key);
      await shot(`${name}-conditions-open.png`);
      // Details first: a click outside a card's More list closes it.
      const refreshed = report.refreshes.length;
      await page.locator('[data-home-project="p1"] .home-repos-details').click();
      await page.locator('[data-home-project="p1"] .home-repos .repo-activity-lists').waitFor();
      for (let end = Date.now() + 5000; report.refreshes.length < refreshed + 1 && Date.now() < end; ) await sleep(50);
      assert.equal(report.refreshes.length, refreshed + 1, "showing the links asked Core for one refresh");
      await card("audit").locator(".home-summary-more > button").click();
      await card("audit").locator(".home-summary-more-list").waitFor();
      measured.opened = await contrast([...CARD_TEXT, ".home-summary-more-list :is(.quiet-button, .copy-button, legend, .home-size-options label:not(.is-disabled))"]);
      const ratios = Object.entries(measured).filter(([state]) => !state.endsWith(" aria"))
        .flatMap(([state, all]) => Object.entries(all).map(([selector, v]) => ({ state, selector, ...v })));
      const low = ratios.filter((v) => v.ratio < 4.5);
      assert.deepEqual(low, [], JSON.stringify(low));
      const readable = [...ratios].sort((a, b) => a.ratio - b.ratio)[0];
      report.toggles = { ...(report.toggles || {}), [name]: Object.fromEntries(Object.entries(measured).filter(([state]) => / (hover|focus|at rest|aria)/.test(state))) };
      // The same conditions in prose on their report page, on its soft surface too.
      if (name === "home-1720") {
        await page.keyboard.press("Escape");
        await opener("batches").click();
        await reportPage().locator(".report-head h1").waitFor();
        const page_ = await contrast([".report-conditions .brief-markdown :is(p, li)", ".report-conditions-label"]);
        const lowPage = Object.entries(page_).filter(([, v]) => v.ratio < 4.5);
        assert.deepEqual(lowPage, [], JSON.stringify(page_));
        report.reportConditions = page_;
        await reportPage().locator(".report-back").click();
        await until("the report closed", async () => !(await reportPage().count()));
        await card("audit").locator(".home-summary-more > button").click();
        await card("audit").locator(".home-summary-more-list").waitFor();
      }
      // Back as it was for the frame of the top: More closed (Escape, its button focused), details closed.
      await page.keyboard.press("Escape");
      await card("audit").locator(".home-summary-more-list").waitFor({ state: "hidden" });
      await page.locator('[data-home-project="p1"] .home-repos-details').click();
      // The top: Machines and the project's Repositories line, for review.
      await page.evaluate(() => document.querySelector(".home-machines").scrollIntoView({ block: "start" }));
      await sleep(150);
      await shot(`${name}-top.png`);
      return { deck: deckShape, readable };
    });

  await step("a newer version of one card moves no card while Home is read: its size the same, or its author's size another, it keeps its size until the next way to Home; no packing, no jump, no new card (T-18, Lead 2377, 2414, 2457)", async () => {
    await open(1720, 1100);
    await toHome();
    const places = () => page.evaluate(() => [...document.querySelectorAll('[data-home-project="p1"] .home-brief .home-section')].map((el) => {
      const r = el.getBoundingClientRect();
      return { key: el.dataset.sectionKey, version: el.dataset.sectionVersion, size: el.dataset.cardSize ?? null, top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    }));
    await card("batches").scrollIntoViewIfNeeded();
    const before = await places();
    batchesVersion = 2;
    try {
      // Home's own safety-net read, every 30 s while it is on screen; no event is faked.
      await until("the newer version", async () => (await card("batches").getAttribute("data-section-version")) === "2", 40_000);
      const after = await places();
      assert.equal(after.find((p) => p.key === "batches").size, "wide");
      const without = (list) => list.map(({ version, ...place }) => place);
      assert.deepEqual(without(after), without(before), JSON.stringify({ before, after }));
      // Its author now names it small, with two Metrics values: while Home is read, the card keeps the size it
      // was shown at, and stays the same element (no remount, nothing lost).
      await card("batches").evaluate((el) => { el.dataset.probe = "same"; });
      batchesVersion = 3;
      await until("the version with another figure", async () => (await card("batches").getAttribute("data-section-version")) === "3", 40_000);
      const held = await places();
      assert.equal(held.find((p) => p.key === "batches").size, "wide", "kept while Home is read");
      assert.deepEqual(without(held), without(before), JSON.stringify({ before, held }));
      assert.equal(await card("batches").getAttribute("data-probe"), "same");
      // The next explicit way to Home takes its own size now, in the same element.
      await page.locator(".toolbar-nav .catchup-nav").first().click();
      await until("its own size now", async () => (await card("batches").getAttribute("data-card-size")) === "small");
      assert.equal(await card("batches").getAttribute("data-probe"), "same", "no new card");
      assert.equal(await card("batches").locator(".home-card-frame").count(), 0);
      assert.deepEqual(await card("batches").locator(".home-card-numbers dd").evaluateAll((ds) => ds.map((d) => d.textContent)), ["2.4\u00a0%", "9"]);
      return { before, after, held };
    } finally {
      batchesVersion = 1;
    }
  });

  await step("only a card pinned to the widgets takes the user's size: none on the deck's cards, old choices ignored; a pinned card is its summary card, follows its Agent until the user chooses, keeps that through newer versions, never writes it back; unpinned and pinned again, or its section written again, it follows its Agent; a pin with no summary is shown in full (T-18, Lead 2457, 2473; Dev 7's v19)", async () => {
    await open(1720, 1100);
    // Choices an earlier build kept for the deck's cards: no longer read, never over the author's size.
    await page.evaluate((ws) => localStorage.setItem(`yuzuno.homeCardSizes.${ws}`, JSON.stringify({ "p1:30": "large", "p1:32": "small", "p1:31": "small" })), WS);
    await page.reload();
    await toHome();
    const writes = report.writes.length;
    const deckSize = (key) => card(key).evaluate((el) => `${el.dataset.cardSize} ${el.dataset.sizeSource}`);
    assert.deepEqual([await deckSize("audit"), await deckSize("batches"), await deckSize("screens")], ["wide author", "wide author", "large author"]);
    const pinFromDeck = async (key) => {
      await card(key).locator(".home-summary-more > button").click();
      const more = card(key).locator(".home-summary-more-list");
      assert.equal(await more.locator(".home-size-choice").count(), 0, "a deck card offers no size");
      await more.getByRole("button", { name: /^Pin “/ }).click();
      await page.keyboard.press("Escape");
    };
    // Pinned, the batches is its summary card on the widgets, at its Agent's size; Machines takes its own row.
    await pinFromDeck("batches");
    const slot = page.locator('.home-widget-slot[data-widget^="pin:p1:32:"]');
    await slot.waitFor();
    const pinned = slot.locator(".home-summary-card[data-pin-widget]");
    assert.equal(await slot.getAttribute("data-widget-size"), "wide");
    assert.equal(await pinned.getAttribute("data-section-key"), null, "the card in its project stays the one found by key");
    const machines = await page.evaluate(() => {
      const grid = document.querySelector(".home-widget-grid"), m = document.querySelector('.home-widget-slot[data-widget="machines"]');
      return { full: Math.abs(m.getBoundingClientRect().width - grid.getBoundingClientRect().width) <= 1, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length };
    });
    assert.deepEqual(machines, { full: true, columns: 4 }, JSON.stringify(machines));
    // Organize Home lists the widgets: Machines built in, the pin with its source and the choice.
    await page.locator(".home-widget-organize").click();
    const dialog = page.locator(".home-organize");
    const row = (prefix) => dialog.locator(`.home-organize-list li[data-widget^="${prefix}"]`);
    await row("pin:p1:32:").waitFor();
    assert.equal(await page.locator('[role="dialog"] h2').first().innerText(), "Organize Home");
    assert.equal(await row("machines").locator(".home-size-source").innerText(), "Built in: the whole row, as tall as its content");
    assert.equal(await row("machines").locator(".home-size-choice").count(), 0);
    assert.equal(await row("pin:p1:32:").locator(".home-size-source").innerText(), "Follow Agent: Wide 1×2");
    assert.deepEqual(await row("pin:p1:32:").locator(".home-size-options label").allInnerTexts(), ["Follow Agent", "Small", "Wide", "Large"]);
    const inks = await contrast([".home-organize :is(.home-size-source, .home-size-options label, .home-widget-sizes-note, .home-widget-name)"]);
    assert.deepEqual(Object.entries(inks).filter(([, v]) => v.ratio < 4.5), [], JSON.stringify(inks));
    // Large, by the keyboard: from Follow Agent, three steps on.
    await row("pin:p1:32:").locator('input[value="auto"]').focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    assert.equal(await row("pin:p1:32:").locator("input:checked").getAttribute("value"), "large");
    assert.equal(await row("pin:p1:32:").locator(".home-size-source").innerText(), "You set Large 2×2 · the card stays Wide 1×2");
    const reset = dialog.locator(".home-size-reset");
    assert.equal(await reset.isDisabled(), false);
    const resetInk = await contrast([".home-organize .home-size-reset"]);
    assert.deepEqual(Object.values(resetInk).filter((v) => v.ratio < 4.5), [], JSON.stringify(resetInk));
    await shot("organize-widget-size.png");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await slot.getAttribute("data-widget-size"), "large");
    await slot.scrollIntoViewIfNeeded();
    await shot("widgets-1720-pinned-large.png");
    // Never written back: the card on the deck keeps its author's size, and nothing is sent to Core.
    assert.equal(await deckSize("batches"), "wide author");
    const layout = () => page.evaluate((ws) => JSON.parse(localStorage.getItem(`yuzuno.homeWidgets.${ws}`)), WS);
    const pinOf = async (key) => (await layout()).pins.find((p) => p.key === key);
    assert.equal((await pinOf("batches")).size, "large");
    assert.equal(report.writes.length, writes, "a widget's size writes nothing to Core");
    const widgetMore = () => slot.locator(".home-summary-more > button");
    const widgetMenu = () => slot.locator(".home-summary-more-list");
    const menuRows = () => widgetMenu().locator(".home-size-options label").evaluateAll((labels) => labels.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
    try {
      // A newer version whose Agent names it small: the widget keeps the user's size, and shows that version.
      batchesVersion = 3;
      await page.reload();
      await toHome();
      assert.deepEqual([await slot.getAttribute("data-widget-size"), await deckSize("batches")], ["large", "small author"]);
      assert.equal(await pinned.getAttribute("data-section-version"), "3");
      // Large, its two Metrics values in a grid, in the middle of the frame (Dev 7, 2547).
      const centred = () => pinned.evaluate((card) => {
        const body = card.querySelector(".home-card-frame-body"), inner = body.firstElementChild;
        const b = body.getBoundingClientRect(), i = inner.getBoundingClientRect();
        return { shorter: i.height < b.height - 20, offset: Math.round(Math.abs((i.top + i.bottom) / 2 - (b.top + b.bottom) / 2)) };
      });
      assert.equal(await pinned.locator(".home-card-metrics-grid dd").count(), 2);
      const metricsPlace = await centred();
      assert.ok(!metricsPlace.shorter || metricsPlace.offset <= 2, JSON.stringify(metricsPlace));
      await slot.scrollIntoViewIfNeeded();
      await shot("widgets-1720-pinned-large-metrics.png");
      // Its own menu: the size first, then Unpin and Copy report.
      await widgetMore().click();
      assert.equal(await widgetMenu().locator("legend").innerText(), "SIZE OF THIS WIDGET");
      assert.deepEqual(await menuRows(), ["Follow Agent Small 1×1", "Small 1×1", "Wide 1×2", "Large 2×2 You set"]);
      assert.deepEqual(await widgetMenu().locator(":scope > button, :scope > .copy-button").allInnerTexts().then((t) => t.map((x) => x.trim())), ["Unpin", "Copy report"]);
      await shot("widget-menu.png");
      // Given back to its Agent: the size of the version it shows, the focus kept on the choice.
      await widgetMenu().locator('input[value="auto"]').check();
      assert.equal(await slot.getAttribute("data-widget-size"), "small");
      assert.equal(await widgetMenu().locator('input[value="auto"]').evaluate((input) => input === document.activeElement), true, "the focus stays on the choice");
      await page.keyboard.press("Escape");
      assert.equal(await widgetMore().evaluate((b) => b === document.activeElement), true, "Escape gives the focus back to its button");
      assert.equal((await pinOf("batches")).size, undefined);
      // Its Agent's size taken off (a summary kept from before sizes, a table again): the widget follows the version it shows.
      batchesVersion = 4;
      await page.reload();
      await toHome();
      assert.deepEqual([await slot.getAttribute("data-widget-size"), await deckSize("batches"), await pinned.getAttribute("data-section-version")], ["wide", "wide content", "4"]);
      // Home's next read fails: the widget says it may not be current and keeps what it shows, the focus where it was.
      homeFails = true;
      await widgetMore().focus();
      await until("the failed read said", async () => (await pinned.locator(".home-pinned-note").count()) > 0, 40_000);
      assert.deepEqual([await slot.getAttribute("data-widget-size"), await pinned.getAttribute("data-section-version")], ["wide", "4"]);
      assert.equal(await widgetMore().evaluate((b) => b === document.activeElement), true, "the focus stays where it was");
      await shot("widget-not-current.png");
      homeFails = false;
      batchesVersion = 1;
      await page.reload();
      await toHome();
      // Large again, then unpinned and pinned again: the new pin follows its Agent, nothing kept from the old one.
      await widgetMore().click();
      await widgetMenu().locator('input[value="large"]').check();
      await page.keyboard.press("Escape");
      assert.equal(await slot.getAttribute("data-widget-size"), "large");
      // Large, its table: the first 8 rows and 6 columns, said, in the middle of the frame (Dev 7, 2547).
      assert.equal(await pinned.locator("figcaption").innerText(), "8 of 9 rows · 6 of 6 columns");
      assert.equal(await pinned.locator(".home-card-table tbody td").count(), 48);
      const tablePlace = await centred();
      assert.ok(!tablePlace.shorter || tablePlace.offset <= 2, JSON.stringify(tablePlace));
      await slot.scrollIntoViewIfNeeded();
      await shot("widgets-1720-pinned-large-table.png");
      await widgetMore().click();
      await widgetMenu().getByRole("button", { name: "Unpin" }).click();
      await slot.waitFor({ state: "detached" });
      assert.equal(await pinOf("batches"), undefined);
      await pinFromDeck("batches");
      await slot.waitFor();
      assert.equal(await slot.getAttribute("data-widget-size"), "wide");
      assert.equal((await pinOf("batches")).size, undefined);
      // Large once more; then the batches written again under its key, another section: the old pin says so, and
      // pinning the new one starts it at its Agent's size.
      await widgetMore().click();
      await widgetMenu().locator('input[value="large"]').check();
      await page.keyboard.press("Escape");
      batchesId = 52;
      await page.reload();
      await toHome();
      const old = page.locator('.home-widget-slot[data-widget^="pin:p1:32:"]');
      assert.equal(await old.locator(".home-pinned[data-pin-state=\"replaced\"]").count(), 1);
      assert.equal(await old.getAttribute("class").then((c) => c.includes("is-full")), true);
      await old.locator(".home-pinned-actions .quiet-button").first().click();
      const renewed = page.locator('.home-widget-slot[data-widget^="pin:p1:52:"]');
      await renewed.waitFor();
      assert.equal(await renewed.getAttribute("data-widget-size"), "wide");
      assert.equal((await pinOf("batches")).size, undefined, "a section written again does not inherit the size");
    } finally {
      batchesVersion = 1;
      batchesId = 32;
      homeFails = false;
    }
    // A pin with no summary is shown in full, across the row, with nothing to size.
    await page.reload();
    await toHome();
    await card("setup").scrollIntoViewIfNeeded();
    await card("setup").locator(".home-summary-more > button").click();
    await card("setup").locator(".home-summary-more-list").getByRole("button", { name: /^Pin “/ }).click();
    await page.keyboard.press("Escape");
    const legacy = page.locator('.home-widget-slot[data-widget^="pin:p1:20:"]');
    await legacy.waitFor();
    assert.equal(await legacy.getAttribute("class").then((c) => c.includes("is-full")), true);
    assert.equal(await legacy.locator(".home-pinned-body").count(), 1, "its whole body, as before");
    await page.locator(".home-widget-organize").click();
    assert.equal(await row("pin:p1:20:").locator(".home-size-source").innerText(), "No summary named: shown in full, as before.");
    assert.equal(await row("pin:p1:20:").locator(".home-size-choice").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(report.writes.length, writes);
    // The old choices for the deck are still there, unread; the widget layout is this Workspace's alone.
    assert.ok(await page.evaluate((ws) => localStorage.getItem(`yuzuno.homeCardSizes.${ws}`) !== null, WS));
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("yuzuno.homeWidgets.")).sort()), [`yuzuno.homeWidgets.${WS}`]);
  });

  await step("a pinned card stays the same widget while Home is read: its summary dropped and back, the user's Small, its reply draft and the focus kept; at the next visit a pin with no size and no summary is shown in full, one with the user's size stays its card (T-18, Lead 2604)", async () => {
    await open(1720, 1100);
    await toHome();
    // What Core says when a Brief changes: Home reads again (App: workspace.changed, scope brief).
    const briefChanged = () => page.evaluate(() => window.__events.onmessage({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: "" }));
    await card("pulse").locator(".home-summary-more > button").click();
    await card("pulse").locator(".home-summary-more-list").getByRole("button", { name: /^Pin “/ }).click();
    await page.keyboard.press("Escape");
    const slot = page.locator('.home-widget-slot[data-widget^="pin:p1:36:"]');
    const widget = slot.locator(".home-summary-card[data-pin-widget]");
    await widget.waitFor();
    // The user's Small, from the widget's own menu.
    await widget.locator(".home-summary-more > button").click();
    await widget.locator('.home-summary-more-list input[value="small"]').check();
    await page.keyboard.press("Escape");
    assert.equal(await slot.getAttribute("data-widget-size"), "small");
    // A reply being written in the widget, the focus in it.
    await widget.locator(".home-reply-open").click();
    const field = widget.locator(".home-card-reply textarea");
    await field.fill("Keep the queue at 40.");
    await field.focus();
    await widget.evaluate((el) => { el.dataset.probe = "same"; });
    const state = async () => ({
      version: await widget.getAttribute("data-section-version"),
      same: await widget.getAttribute("data-probe"),
      size: await slot.getAttribute("data-widget-size"),
      full: await slot.evaluate((el) => el.classList.contains("is-full")),
      draft: await field.inputValue(),
      focused: await field.evaluate((el) => el === document.activeElement),
      unnamed: await widget.locator(".home-summary-card.is-unnamed").count(),
    });
    try {
      // Its Agent drops the summary: the same widget, the user's size, the draft and the focus; it says it has none.
      pulseVersion = 2;
      await briefChanged();
      await until("version 2 on the widget", async () => (await widget.getAttribute("data-section-version")) === "2");
      assert.deepEqual(await state(), { version: "2", same: "same", size: "small", full: false, draft: "Keep the queue at 40.", focused: true, unnamed: 1 });
      assert.equal(await slot.locator(".home-pinned-body").count(), 0, "never the body in place of the summary");
      await shot("widget-summary-dropped.png");
      // And names one again: still the same widget.
      pulseVersion = 3;
      await briefChanged();
      await until("version 3 on the widget", async () => (await widget.getAttribute("data-section-version")) === "3");
      assert.deepEqual(await state(), { version: "3", same: "same", size: "small", full: false, draft: "Keep the queue at 40.", focused: true, unnamed: 0 });
      // The next visit: the user's Small kept, its card.
      await page.reload();
      await toHome();
      await widget.waitFor();
      assert.equal(await slot.getAttribute("data-widget-size"), "small");
      // Given back to its Agent, and its summary dropped before the next visit: shown in full, as a pin with
      // no summary always was; the summary back while Home is read keeps it so until the next visit.
      await widget.locator(".home-summary-more > button").click();
      await widget.locator('.home-summary-more-list input[value="auto"]').check();
      await page.keyboard.press("Escape");
      pulseVersion = 2;
      await page.reload();
      await toHome();
      await slot.locator(".home-pinned").waitFor();
      assert.equal(await slot.evaluate((el) => el.classList.contains("is-full")), true);
      await slot.locator(".home-pinned").evaluate((el) => { el.dataset.probe = "same"; });
      pulseVersion = 3;
      await briefChanged();
      await until("version 3 read", async () => (await card("pulse").getAttribute("data-section-version")) === "3");
      assert.equal(await slot.locator('.home-pinned[data-probe="same"]').count(), 1, "the same widget until the next visit");
      await page.reload();
      await toHome();
      await widget.waitFor();
      assert.equal(await slot.getAttribute("data-widget-size"), "large", "its card again, at its Agent's size");
    } finally {
      pulseVersion = 1;
    }
  });

  for (const [width, height, name] of [[1200, 900, "organize-1200"], [647, 900, "organize-647"], [390, 844, "organize-390"]])
    await step(`Organize Home at ${width}: a pinned card's size and its source under its name; on a phone the choice takes its own row, its four buttons sharing it (T-18, Dev 7's v19)`, async () => {
      await open(width, height);
      await toHome();
      await card("audit").locator(".home-summary-more > button").click();
      await card("audit").locator(".home-summary-more-list").getByRole("button", { name: /^Pin “/ }).click();
      await page.keyboard.press("Escape");
      await page.locator('.home-widget-slot[data-widget^="pin:p1:30:"]').waitFor();
      // My widgets with the pinned card, at this width (Dev 7, 2547).
      await page.locator(".home-widget-column").scrollIntoViewIfNeeded();
      await shot(`widgets-${width}.png`);
      await page.locator(".home-widget-organize").click();
      const row = page.locator('.home-organize .home-organize-list li[data-widget^="pin:p1:30:"]');
      await row.waitFor();
      const shape = await row.evaluate((li) => {
        const box = (n) => n.getBoundingClientRect();
        const source = box(li.querySelector(".home-size-source")), options = box(li.querySelector(".home-size-options")), item = box(li);
        const buttons = [...li.querySelectorAll(".home-size-options label")].map((l) => box(l));
        return { under: options.top >= source.bottom - 1, full: Math.abs(options.width - item.width) <= 1,
          heights: buttons.map((b) => Math.round(b.height)), widths: buttons.map((b) => Math.round(b.width)),
          unit: li.querySelector(".home-size-unit").getClientRects().length };
      });
      assert.equal(shape.unit, 1, JSON.stringify(shape));
      if (width <= 520) {
        assert.ok(shape.under && shape.full, JSON.stringify(shape));
        assert.ok(shape.heights.every((h) => h >= 44), JSON.stringify(shape));
        assert.ok(Math.max(...shape.widths) - Math.min(...shape.widths) <= 1, `four equal buttons: ${JSON.stringify(shape)}`);
      }
      const sideways = await page.evaluate(() => { const m = document.querySelector(".home-organize"); return m.scrollWidth > m.clientWidth + 1; });
      assert.equal(sideways, false);
      await shot(`${name}.png`);
      return { shape };
    });

  await step("Machines either side of 720 and 540 px and on a 320 px phone: one row of four, then two by two with the shares, then two by two without; the Jobs one line; nothing sideways", async () => {
    const shape = () => page.evaluate(() => {
      const widget = document.querySelector(".home-widget-column .home-machines"), style = getComputedStyle(widget);
      const cells = [...widget.querySelectorAll(".home-machine > *")].map((el) => el.getBoundingClientRect());
      const line = widget.querySelector(".home-machine-job-line"), first = line?.querySelector(".home-machine-job-first");
      return {
        content: Math.round(widget.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.round(widget.getBoundingClientRect().height),
        rows: new Set(cells.map((r) => Math.round(r.top))).size,
        shares: [...widget.querySelectorAll(".home-load > .home-facts")].some((el) => el.checkVisibility()),
        // What is shown, flex items' line breaks read as spaces.
        titles: [...widget.querySelectorAll(".home-load-title")].slice(0, 2).map((el) => el.innerText.replace(/\s+/g, " ").trim()),
        values: [...widget.querySelectorAll(".home-load-short")].filter((el) => el.checkVisibility())
          .map((el) => ({ text: el.textContent, height: Math.round(el.getBoundingClientRect().height), lineHeight: Math.round(parseFloat(getComputedStyle(el).fontSize) * 1.6) })),
        line: line && { text: line.textContent, height: Math.round(line.getBoundingClientRect().height), cut: first.scrollWidth > first.clientWidth },
        sideways: widget.scrollWidth > widget.clientWidth + 1 || document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
      };
    });
    const shapes = {};
    await open(1440, 900);
    await toHome();
    const widget = () => page.locator(".home-widget-column .home-machines");
    await widget().locator(".home-machine:not([aria-busy])").waitFor();
    // The widget lays itself out by its own width: set it just either side of each step.
    for (const content of [721, 719, 541, 539]) {
      await widget().evaluate((el, content) => {
        const style = getComputedStyle(el);
        const frame = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
        el.style.width = `${style.boxSizing === "border-box" ? content + frame : content}px`;
      }, content);
      await sleep(100);
      shapes[content] = await shape();
    }
    await shot("machines-539.png", ".home-widget-column .home-machines");
    await page.context().close();
    await open(320, 640);
    await toHome();
    await widget().locator(".home-machine:not([aria-busy])").waitFor();
    await widget().scrollIntoViewIfNeeded();
    shapes.phone = await shape();
    await shot("machines-phone-320.png", ".home-widget-column .home-machines");
    assert.equal(shapes[721].content, 721, JSON.stringify(shapes));
    assert.equal(shapes[539].content, 539, JSON.stringify(shapes));
    assert.deepEqual([shapes[721].rows, shapes[719].rows, shapes[541].rows, shapes[539].rows, shapes.phone.rows], [1, 2, 2, 2, 2], JSON.stringify(shapes));
    assert.deepEqual([shapes[721].shares, shapes[541].shares, shapes[539].shares, shapes.phone.shares], [true, true, false, false], JSON.stringify(shapes));
    // Wide, the title says the value and its total; narrow, the label alone and a value line that keeps the
    // total, each on one line, a number never split from its unit (Dev 7, 2338).
    for (const at of [721, 719, 541]) {
      assert.deepEqual(shapes[at].values, [], `${at}: no value line`);
      assert.deepEqual(shapes[at].titles, ["CPU 20% of 32 cores", "Memory 11.7 GiB of 39.2 GiB"], `${at}: ${JSON.stringify(shapes[at].titles)}`);
    }
    for (const at of ["539", "phone"]) {
      assert.deepEqual(shapes[at].titles, ["CPU", "Memory"], `${at}: ${JSON.stringify(shapes[at].titles)}`);
      assert.deepEqual(shapes[at].values.map((v) => v.text), ["20% · 32 cores", "11.7 / 39.2 GiB"], `${at}: ${JSON.stringify(shapes[at].values)}`);
      for (const v of shapes[at].values) assert.ok(v.height <= v.lineHeight + 2, `${at}: one line ${JSON.stringify(v)}`);
    }
    for (const [at, s] of Object.entries(shapes)) {
      assert.match(s.line?.text ?? "", /^1 running/, `${at}: the Jobs here ${JSON.stringify(s)}`);
      assert.ok(s.line.height <= 30 && s.line.cut, `${at}: one line, cut ${JSON.stringify(s.line)}`);
      assert.equal(s.sideways, false, `${at}: nothing sideways`);
    }
    // About 170 px on a phone (Dev 7, 2326). At the deck's widths the one row stays under 140 px (the deck step);
    // just above 720 px the four cells are narrow and their shares wrap, so that row is taller.
    assert.ok(shapes.phone.height <= 210, JSON.stringify(shapes));
    return { shapes };
  });

  await step("an explicit way to Home closes the report: the toolbar, a push's Home link and one in the address, after a card or an address link; another Workspace's Home link closes nothing (T-18 R3)", async () => {
    const shape = () => page.evaluate(() => ({
      report: !!document.querySelector(".home-report"),
      inReach: !document.querySelector(".home-view")?.hasAttribute("inert"),
      hash: location.hash, marker: history.state?.yuzunoReport ?? null, length: history.length,
    }));
    const closed = async (what) => {
      await until(what, async () => !(await reportPage().count()));
      return shape();
    };
    // A card's report, then the toolbar's Home: its entry left, as its Back leaves it.
    await open(1440, 900);
    await toHome();
    const start = await page.evaluate(() => history.length);
    await openReport("eval");
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    const toolbar = await closed("the toolbar's Home closed it");
    assert.deepEqual({ ...toolbar, length: toolbar.length - start }, { report: false, inReach: true, hash: "", marker: null, length: 1 }, JSON.stringify(toolbar));
    assert.ok(await page.locator(".home-view").isVisible(), "on Home, not in a conversation");
    // A push notification clicked while Yuzuno is open: the service worker posts its Home link to this
    // window (T-200), with no navigation. Another Workspace's is said, and the report stays open.
    const push = (href) => page.evaluate((href) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "yuzuno:open", href } })), href);
    await openReport("eval");
    const opened = await page.evaluate(() => history.length);
    await push(`https://${HOST}/#/home?w=ws-elsewhere`);
    await page.locator(".toast", { hasText: "another Workspace" }).waitFor();
    assert.ok(await reportPage().isVisible(), "another Workspace's Home link closes nothing");
    // This Workspace's: the report closes, its entry left as its Back leaves it.
    await push(`https://${HOST}/#/home?w=${WS}`);
    const pushed = await closed("the push's Home link closed it");
    assert.deepEqual(pushed, { report: false, inReach: true, hash: "", marker: null, length: opened }, JSON.stringify(pushed));
    // A Home link in the address is a navigation of its own: the report closes, the address is Home's.
    await openReport("eval");
    await page.evaluate((ws) => { location.hash = `#/home?w=${ws}`; }, WS);
    const linked = await closed("the address's Home link closed it");
    assert.deepEqual({ report: linked.report, inReach: linked.inReach, hash: linked.hash, marker: linked.marker }, { report: false, inReach: true, hash: "", marker: null }, JSON.stringify(linked));
    await page.context().close();
    // A report from the address (a cold link), then the toolbar: the entry is Home's again, none added.
    await open(1440, 900, { at: `/#/report?w=${WS}&p=p1&k=eval&v=3&s=7` });
    await reportPage().locator(".report-head h1").waitFor();
    const cold = await page.evaluate(() => history.length);
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    const fromAddress = await closed("the toolbar's Home closed the address's report");
    assert.deepEqual(fromAddress, { report: false, inReach: true, hash: "", marker: null, length: cold }, JSON.stringify(fromAddress));
    await shot("explicit-home.png");
    return { toolbar, pushed, linked, fromAddress };
  });

  await step("a report link opens again after an explicit way to Home: A, Home, A and A, Home, B, from a cold address, after the toolbar and after a push (T-18 R3)", async () => {
    const A = `#/report?w=${WS}&p=p1&k=eval&v=3&s=7`, B = `#/report?w=${WS}&p=p1&k=dose-study&v=3&s=8`;
    const showing = async (what, title) => {
      await until(what, async () => (await reportPage().count()) > 0 && (await reportPage().locator(".report-head h1").textContent()) === title);
      return page.evaluate(() => location.hash);
    };
    const home = async (how) => {
      if (how === "toolbar") await page.locator(".toolbar-nav .catchup-nav").first().click();
      else await page.evaluate((href) => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "yuzuno:open", href } })), `https://${HOST}/#/home?w=${WS}`);
      await until(`Home by the ${how}`, async () => !(await reportPage().count()));
    };
    const to = (hash) => page.evaluate((hash) => { location.hash = hash; }, hash);
    await open(1440, 900, { at: `/${A}` });
    await showing("A from a cold address", "Synthetic eval: model B vs A");
    const seen = [];
    await home("toolbar");
    await to(A);
    seen.push(await showing("A again after the toolbar", "Synthetic eval: model B vs A"));
    await home("push");
    await to(B);
    seen.push(await showing("B after a push", doseStudy.title));
    await home("toolbar");
    await to(A);
    seen.push(await showing("A after B and the toolbar", "Synthetic eval: model B vs A"));
    await home("push");
    await to(A);
    seen.push(await showing("A again after a push", "Synthetic eval: model B vs A"));
    assert.deepEqual(seen, [A, B, A, A], "each link's report, in the address that names it");
    return { seen };
  });

  await step("motion: the report rises in over 220 ms, and under reduced motion nothing moves", async () => {
    const animation = async (motion) => {
      await open(1440, 900, { motion });
      await toHome();
      await openReport("eval");
      return page.evaluate(() => {
        const style = getComputedStyle(document.querySelector(".home-report"));
        return { name: style.animationName, duration: style.animationDuration };
      });
    };
    const moving = await animation("no-preference");
    await page.context().close();
    const still = await animation("reduce");
    assert.deepEqual(moving, { name: "report-open", duration: "0.22s" });
    assert.equal(still.name, "none");
    return { moving, still };
  });

  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: report.unexpected.join("\n") });
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
