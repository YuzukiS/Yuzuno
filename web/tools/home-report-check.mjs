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
const report = { task: "T-18", checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], shots: [],
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
  body: { type: "BriefBody", props: { summary: { lead: "answer", visual: "curve", conditions: "holds" }, details: ["method"] },
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
const deck = [
  section("audit", 30, 2, { title: "Fewer LLM round trips: three-stage static audit", body: summaryBody(
    "Found fixed hand-offs worth trying; not yet shown that most development calls can go to programs.",
    { holds: { type: "Checklist", props: { items: ["Read-only stored records", "Three-stage flow", "304 model replies", "Rule pre-screen", "Item-by-item audit", "One reviewer", "No live traffic", "Synthetic prompts"].map((text, i) => ({ id: `c${i}`, text, done: true })) } },
      funnel: { type: "Metrics", props: { items: [{ label: "Model replies", value: 304 }, { label: "Pre-screened", value: 52 }, { label: "Kept", value: 29 }] } } },
    { lead: "lead", visual: "funnel", conditions: "holds" }) }),
  section("screens", 31, 1, { title: "Home layout screenshots", attachments: [evalFiles[1]], body: summaryBody(
    "The deck adds a column as the pane widens and stacks on a phone.",
    { shot: { type: "Attachments", props: { items: [{ name: "shot.png", caption: "Loss by subset" }] } } },
    { lead: "lead", visual: "shot" }) }),
  section("batches", 32, 1, { title: "Why batches were dropped", body: summaryBody(
    "All three batches stay under the 5% stop line; duplicates are the largest cause.",
    { why: { type: "Markdown", props: { text: "Only synthetic batches A to C were measured; real imports may differ." } },
      table: { type: "Table", props: { id: "batches", title: "Drops by batch", columns: ["batch", "dupes", "dates", "amounts", "regions", "other"].map((key) => ({ key, label: key })),
        rows: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((id, i) => ({ id, cells: { batch: id, dupes: `${2 + i / 10}%`, dates: "0.4%", amounts: "0.1%", regions: "0.2%", other: "0%" } })) } } },
    { lead: "lead", visual: "table", conditions: "why" }) }),
];
const sections = () => [...fillers, section("eval", 7, evalVersion, { title: "Synthetic eval: model B vs A", attachments: evalFiles }),
  { ...section("dose-study", 8, 3), title: doseStudy.title, body: doseStudy.body }, ...deck];
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
  memory: { totalMiB: 40107, usedMiB: 12000, availableMiB: 28107, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
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
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  });
  page.on("pageerror", (error) => report.errors.push(`${width}: pageerror: ${error.message}`));
  // The fixture answers this Agent's Codex account, tools and queued inputs with 404 on purpose.
  const answered404 = (message) => /\/api\/agents\/a\/(codex\/usage|codex\/mcp|conversation\/inputs)\b/.test(message.location()?.url ?? "");
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
    await step(`Home deck at ${width}: columns by the pane, summary cards bounded, conditions in two lines, legacy cards plain; nothing sideways`, async () => {
      await open(width, height);
      await toHome();
      // The repositories' line reads its activity only once on screen, as the lists did.
      await page.locator('[data-home-project="p1"] .home-repos').scrollIntoViewIfNeeded();
      await until("the repository's line", () => page.locator('[data-home-project="p1"] .home-repos .repo-line-commit .repo-row').count());
      await card("audit").scrollIntoViewIfNeeded();
      await until("the image figure", () => page.evaluate(() => { const img = document.querySelector('[data-section-key="screens"] .home-card-frame img'); return img?.complete && img.naturalWidth > 0; }));
      const deckShape = await page.evaluate(() => {
        const brief = document.querySelector('[data-home-project="p1"] .home-brief');
        const view = document.querySelector(".home-view");
        const style = getComputedStyle(view);
        const container = view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const cards = [...brief.querySelectorAll(".home-section")];
        const lefts = [...new Set(cards.map((el) => Math.round(el.getBoundingClientRect().left)))];
        const one = (key) => document.querySelector(`.home-view [data-section-key="${key}"]`);
        const frame = (key) => one(key)?.querySelector(".home-card-frame-body")?.getBoundingClientRect().height ?? null;
        const chips = [...one("audit").querySelectorAll(".home-card-condition-chips li")];
        const shown = chips.filter((li) => !li.hidden);
        const scroller = document.scrollingElement;
        return {
          container, columns: lefts.length,
          frames: { audit: frame("audit"), screens: frame("screens"), batches: frame("batches") },
          chipLines: new Set(shown.map((li) => li.offsetTop)).size, hidden: chips.length - shown.length,
          more: one("audit").querySelector(".home-card-conditions-toggle")?.textContent ?? null,
          table: one("batches").querySelector("figcaption")?.textContent ?? null,
          tableCells: one("batches").querySelectorAll(".home-card-table tbody td").length,
          legacy: one("setup").querySelector(".home-summary-unnamed")?.textContent ?? null,
          legacyBody: !!one("setup").querySelector(".brief-body"),
          // A card with no summary keeps its own height beside taller cards.
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
      const expected = deckShape.container >= 1500 ? 4 : deckShape.container >= 1100 ? 3 : deckShape.container >= 540 ? 2 : 1;
      assert.equal(deckShape.columns, expected, JSON.stringify(deckShape));
      const frameHeight = deckShape.container >= 540 ? 138 : 118;
      for (const [key, value] of Object.entries(deckShape.frames)) assert.equal(Math.round(value), frameHeight, `${key} frame: ${JSON.stringify(deckShape)}`);
      assert.ok(deckShape.chipLines <= 3 && deckShape.hidden !== 1, JSON.stringify(deckShape));
      if (deckShape.hidden > 0) assert.equal(deckShape.more, `+${deckShape.hidden} more conditions`);
      assert.equal(deckShape.table, "3 of 9 rows · 3 of 6 columns");
      assert.equal(deckShape.tableCells, 9);
      assert.equal(deckShape.legacy, "No summary named");
      assert.equal(deckShape.legacyBody, false);
      assert.equal(deckShape.sideways, false, JSON.stringify(deckShape));
      // Dev 7 (2308): the lead keeps three lines only where a row lines up.
      assert.equal(deckShape.leadMin === "0px", deckShape.container < 540, `the lead's minimum height: ${deckShape.leadMin}`);
      if (deckShape.container >= 540) assert.ok(deckShape.legacyHeights.every((h) => h <= 170), `legacy cards at their own height: ${deckShape.legacyHeights}`);
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
      if (deckShape.hidden > 0) {
        await card("audit").locator(".home-card-conditions-toggle").click();
        const opened = await card("audit").evaluate((el) => ({ hidden: el.querySelectorAll(".home-card-condition-chips li[hidden]").length, label: el.querySelector(".home-card-conditions-toggle").textContent }));
        assert.deepEqual(opened, { hidden: 0, label: "Show fewer conditions" });
        await shot(`${name}-conditions-open.png`);
      }
      const readable = await page.evaluate(() => {
        const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const paint = (colors) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = "#fff"; probe.fillRect(0, 0, 1, 1); for (const c of colors) { probe.fillStyle = "#000"; probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); } return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
        let lowest = { ratio: 99 };
        for (const el of document.querySelectorAll(".home-summary-card :is(.home-summary-title-link, .home-summary-lead, .home-summary-unnamed, .home-summary-foot span, .home-report-open, .home-card-condition-chips li, figcaption, .home-card-conditions-label)")) {
          if (!el.checkVisibility() || !el.textContent.trim()) continue;
          const chain = [];
          for (let n = el; n; n = n.parentElement) chain.unshift(getComputedStyle(n).backgroundColor);
          const bg = paint(chain);
          const value = ratio(paint([`rgb(${bg.join(",")})`, getComputedStyle(el).color]), bg);
          if (value < lowest.ratio) lowest = { ratio: value, text: el.textContent.trim().slice(0, 30), cls: el.className };
        }
        return lowest;
      });
      assert.ok(readable.ratio >= 4.5, JSON.stringify(readable));
      // The top: Machines and the project's Repositories line, for review.
      await page.evaluate(() => document.querySelector(".home-machines").scrollIntoView({ block: "start" }));
      await sleep(150);
      await shot(`${name}-top.png`);
      return { deck: deckShape, readable };
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
