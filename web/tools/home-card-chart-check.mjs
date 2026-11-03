// A chart as a card's figure on Home (T-18, Lead 2655), in a browser: the
// production bundle with an explicit API fixture (synthetic sections, no
// Core, daily window or real Agent). Line, bar and scatter charts on wide and
// large cards, on the deck and pinned to the widgets at the user's sizes, at
// 1720, 1200, 647 and 390 px and with larger text (20 and 24 px): each is drawn to fit its
// frame, its plot with both axes and their ticks inside it, the axes' names
// with their units whole, a legend for every series it draws (and how many
// there are when its lines can't name them all); no tooltip, data table or
// focusable part in the frame; its attachment data arriving later moves
// nothing. The report page keeps the whole chart. Reads only: nothing is
// written. Screenshots and report.json go to YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const HOST = "yuzuno-chart.test";
const WS = "ws-chart";
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
  await (selector ? page.locator(selector).first().screenshot({ path }) : page.screenshot({ path }));
  report.shots.push(name);
}

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const owner = { agentId: "a", name: "Mori", state: "active" };
const agent = { id: "a", name: "Mori", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "atlas-notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
// One summary each: its lead and its chart, at the size its author names.
const body = (lead, chart, size) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "fig", size } }, children: ["lead", "fig"] },
  lead: { type: "Markdown", props: { text: lead } },
  fig: chart,
} });
const section = (key, id, title, content, extra = {}) => ({ id, key, kind: "report", title, version: 1, owner, body: content, attachments: [], refs: {},
  seen: null, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN), ...extra });
const steps = [0, 50, 100, 150, 200, 250];
const lossData = { series: [{ name: "A", points: steps.map((x, i) => [x, 0.61 - i * 0.035]) }, { name: "B", points: steps.map((x, i) => [x, 0.6 - i * 0.04]) }],
  downsampled: false, sourcePoints: 12 };
const lossFile = { name: "loss.csv", kind: "data", mime: "text/csv", size: 220, snapshot: true, mayChange: false, takenAt: iso(-60 * MIN) };
const workers = Array.from({ length: 12 }, (_, i) => ({ name: `Synthetic worker ${i + 1} (east pool)`, points: [0, 1, 2, 3, 4, 5].map((m) => [m, 40 + ((i * 7 + m * 3) % 25)]) }));
const sections = [
  // Its data from an attachment, read after the card is drawn.
  section("trend", 41, "Validation loss", body("Loss falls for both arms; B stays below A after step 100.", { type: "LineChart", props: { id: "trend",
    title: "Validation loss by step", x: { label: "Step" }, y: { label: "Loss" },
    data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }, { name: "B", column: "b" }] } } }, "wide"), { attachments: [lossFile] }),
  section("stages", 42, "Wall time per stage", body("Training takes most of each run; loading is steady.", { type: "BarChart", props: { id: "stages",
    title: "Wall time per stage", x: { label: "Stage" }, y: { label: "Time", unit: "min" },
    series: ["Run 1", "Run 2", "Run 3"].map((name, r) => ({ name, points: [["load", 4 + r], ["train", 31 - r * 2], ["eval", 6], ["save", 2 + r]] })) } }, "wide")),
  section("sizes", 43, "Size against score", body("Score rises with size in both synthetic families, more slowly past 200M.", { type: "ScatterChart", props: { id: "sizes",
    title: "Size vs. score", x: { label: "Parameters", unit: "M" }, y: { label: "Score", unit: "%" },
    series: [{ name: "Family A", points: [[10, 61], [40, 66], [120, 71], [350, 74]] }, { name: "Family B", points: [[15, 58], [60, 64], [200, 70], [500, 72]] }] } }, "large")),
  // Twelve series with long names, and an axis whose name and unit are long: more than a card's legend names.
  section("pool", 44, "Worker pool throughput", body("Every synthetic worker stays between 40 and 65 requests per second.", { type: "LineChart", props: { id: "pool",
    title: "Requests per second by worker", x: { label: "Minute" }, y: { label: "Throughput of each synthetic worker in the pool", unit: "requests per second" },
    series: workers } }, "wide")),
  section("bench", 45, "Benchmark stages", body("The synthetic benchmark's slowest stage is the index build.", { type: "BarChart", props: { id: "bench",
    title: "Median wall time of each synthetic benchmark stage, both builds", x: { label: "Synthetic benchmark stage" }, y: { label: "Median wall time", unit: "seconds" },
    series: [{ name: "Build 1", points: [["fetch", 12], ["index", 48], ["query", 21], ["merge", 9], ["report", 4]] },
      { name: "Build 2", points: [["fetch", 11], ["index", 44], ["query", 19], ["merge", 10], ["report", 4]] }] } }, "large")),
  // Large negative values: the y axis's longest labels ("-200M"), which must not be cut on its left (Lead 2752).
  section("swing", 46, "Quarterly net flow", body("Net flow turned positive in Q3.", { type: "BarChart", props: { id: "swing",
    title: "Net flow by quarter", x: { label: "Quarter" }, y: { label: "Net flow", unit: "USD" },
    series: [{ name: "Net flow", points: [["Q1", -200_000_000], ["Q2", -45_500_000], ["Q3", 150_000_000], ["Q4", 12_345_678]] }] } }, "wide")),
];
const CHARTS = { trend: "line", stages: "bar", sizes: "scatter", pool: "line", bench: "bar", swing: "bar" };
const SERIES = { trend: 2, stages: 3, sizes: 2, pool: 12, bench: 2, swing: 1 };
// The user's widgets: the bars at Large, the scatter at Wide, the trend following its Agent (wide).
const pins = [["stages", 42, "large"], ["sizes", 43, "wide"], ["trend", 41, null]].map(([key, id, size]) => ({
  projectId: "p1", key, id, title: sections.find((s) => s.key === key).title, projectName: "atlas-notes", ...(size ? { size } : {}) }));
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "atlas-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections, history: [] }, unseen: 5, missing: [] }] });
const machineLoad = () => ({ at: new Date().toISOString(), cpu: { cores: 8, totalPct: 10, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 16384, usedMiB: 4000, availableMiB: 12384, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
// The attachment's points wait for the step to let them through.
let release = () => {};
let gate = Promise.resolve();
const holdData = () => (gate = new Promise((done) => (release = done)));

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
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (path === "/api/projects/p1/brief/chart/trend/fig") {
    report.reads.push(`${path}?${url.searchParams}`);
    await gate;
    return route.fulfill({ json: lossData }).catch(() => {});
  }
  if (["/api/agents/a/codex/usage", "/api/agents/a/codex/mcp", "/api/agents/a/conversation/inputs"].includes(path))
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  const json = {
    "/api/workspace": () => ({ workspace: { id: WS }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/a": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
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
async function open(width, height, { fontSize = 16 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce" });
  page = await context.newPage();
  await page.addInitScript(([ws, pinned, size]) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 50); }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: size, palette: "garden" }));
    localStorage.setItem(`yuzuno.homeWidgets.${ws}`, JSON.stringify({ order: [], hidden: [], pins: pinned }));
  }, [WS, pins, fontSize]);
  page.on("pageerror", (error) => report.errors.push(`${width}: pageerror: ${error.message}`));
  const answered404 = (message) => /\/api\/agents\/a\/(codex\/usage|codex\/mcp|conversation\/inputs)\b/.test(message.location()?.url ?? "");
  page.on("console", (message) => message.type() === "error" && !answered404(message) && report.errors.push(`${width}: console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  const nav = page.locator(".toolbar-nav .catchup-nav").first();
  await nav.waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await nav.click();
  await page.locator('.home-view [data-section-key="trend"]').waitFor({ timeout: 10_000 });
  await page.locator(".home-widget-column article[data-pin-widget]").nth(2).waitFor({ timeout: 10_000 });
}

/**
 * Every chart card in a place (the deck, or the widgets), as laid out: its
 * size, the frame, the chart's parts and the plot's axes, each with whether
 * it lies inside what holds it, and what in the frame could be used.
 */
const charts = (where) => page.evaluate((where) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const inside = (el, outer, slack = 0.5) => { const a = box(el), b = box(outer); return a.l >= b.l - slack && a.t >= b.t - slack && a.r <= b.r + slack && a.b <= b.b + slack; };
  const cards = where === "deck"
    ? [...document.querySelectorAll(".home-view .home-brief .home-summary-card[data-section-key]")]
    : [...document.querySelectorAll(".home-widget-column article[data-pin-widget]")];
  return cards.map((card) => {
    const key = card.dataset.sectionKey ?? card.dataset.pinWidget.split(":").at(-1);
    const frame = card.querySelector(".home-card-frame.is-chart .home-card-frame-body");
    const out = { key, size: card.dataset.cardSize, source: card.dataset.sizeSource };
    if (!frame) return out;
    const root = frame.querySelector(".home-card-chart");
    const plot = root?.querySelector(".home-card-chart-plot");
    const svg = plot?.querySelector("svg.recharts-surface");
    const legend = root?.querySelector(".home-card-chart-legend");
    const named = legend ? [...legend.querySelectorAll("li[data-series]")] : [];
    const axis = (side) => {
      const el = root.querySelector(`.home-card-chart-axis.is-${side}`);
      const [name, unit] = el.children;
      return { text: el.textContent, inside: inside(el, root), unit: unit ? { text: unit.textContent, whole: unit.scrollWidth <= unit.clientWidth + 0.5, inside: inside(unit, root) } : null,
        nameCut: name.scrollWidth > name.clientWidth + 0.5 };
    };
    // Recharts draws an axis's tick labels in a layer of their own, named by the axis.
    const ticks = (side) => [...(svg?.querySelectorAll(`.recharts-${side}Axis-tick-labels .recharts-cartesian-axis-tick-value`) ?? [])]
      .filter((t) => t.textContent.trim()).map((t) => ({ text: t.textContent, inside: inside(t, plot, 1) }));
    const baseline = svg?.querySelector(".recharts-xAxis .recharts-cartesian-axis-line");
    const drawn = svg ? svg.querySelectorAll(".recharts-line, .recharts-bar, .recharts-scatter").length : 0;
    // Each series in its slot's colour: a line's stroke, a bar's or a point's fill, and its key in the legend.
    const paint = svg ? [...svg.querySelectorAll(".recharts-line .recharts-curve, .recharts-bar-rectangle path, .recharts-scatter-symbol path")]
      .map((el) => getComputedStyle(el)[el.closest(".recharts-line") ? "stroke" : "fill"]) : [];
    return {
      ...out,
      chart: root?.dataset.chart ?? null,
      frame: { h: Math.round(box(frame).h), w: Math.round(box(frame).w), inert: frame.inert },
      rootInside: !!root && inside(root, frame),
      overflow: !!root && root.scrollHeight > root.clientHeight + 0.5,
      parts: root ? [...root.children].map((el) => ({ part: el.className.replace("home-card-chart-", "").split(" ")[0], inside: inside(el, root), h: Math.round(box(el).h) })) : [],
      state: root?.querySelector(".home-card-chart-state")?.textContent ?? null,
      plot: plot ? { h: Math.round(box(plot).h), w: Math.round(box(plot).w) } : null,
      svg: svg ? { h: Math.round(box(svg).h), w: Math.round(box(svg).w), inside: inside(svg, plot, 1), tabindex: svg.getAttribute("tabindex") } : null,
      baseline: baseline ? inside(baseline, plot, 1) : null,
      xTicks: ticks("x"), yTicks: ticks("y"),
      drawn,
      paint: [...new Set(paint)],
      keys: named.map((li) => getComputedStyle(li.querySelector("i")).backgroundColor),
      legend: legend ? { named: named.length, lines: new Set(named.concat([...legend.querySelectorAll(".is-count")]).map((li) => li.offsetTop)).size,
        inside: named.every((li) => inside(li, root)), count: legend.querySelector(".is-count")?.textContent ?? null } : null,
      title: root?.querySelector(".home-card-chart-title")?.textContent ?? null,
      x: root ? axis("x") : null, y: root ? axis("y") : null,
      // Recharts' own layers carry tabindex="-1" so that they are not tabbable; anything 0 or more would be.
      usable: [...frame.querySelectorAll("a, button, input, select, textarea, details, table, [tabindex], .recharts-tooltip-wrapper")]
        .filter((el) => !(el.matches("[tabindex]") && el.tabIndex < 0 && !el.matches("a, button, input, select, textarea, details, table"))).map((el) => el.outerHTML.slice(0, 80)),
    };
  });
}, where);

/** What every chart card must be, wherever it is and at whatever size. */
function assertBounded(found, label) {
  const name = `${label} ${found.key}`;
  assert.equal(found.chart, CHARTS[found.key], `${name}: drawn as its kind`);
  assert.equal(found.frame.inert, true, `${name}: the frame is inert`);
  assert.deepEqual(found.usable, [], `${name}: no tooltip, data table or focusable part in the frame`);
  assert.ok(found.rootInside && !found.overflow, `${name}: the chart lies inside its frame: ${JSON.stringify(found.frame)}`);
  assert.deepEqual(found.parts.filter((part) => !part.inside), [], `${name}: every part inside the chart`);
  assert.equal(found.state, null, `${name}: drawn, not ${found.state}`);
  assert.ok(found.svg && found.svg.inside && found.svg.h >= 48 && found.svg.w >= 120, `${name}: a plot to read: ${JSON.stringify({ svg: found.svg, plot: found.plot })}`);
  assert.equal(found.svg.tabindex, null, `${name}: the plot takes no focus`);
  assert.equal(found.baseline, true, `${name}: the x axis line inside the plot`);
  assert.ok(found.xTicks.length >= 2 && found.xTicks.every((t) => t.inside), `${name}: x ticks inside: ${JSON.stringify(found.xTicks)}`);
  assert.ok(found.yTicks.length >= 2 && found.yTicks.every((t) => t.inside), `${name}: y ticks inside: ${JSON.stringify(found.yTicks)}`);
  for (const side of ["x", "y"]) {
    const axis = found[side];
    assert.ok(axis.inside, `${name}: the ${side} axis's name inside`);
    if (axis.unit) assert.ok(axis.unit.whole && axis.unit.inside, `${name}: the ${side} axis's unit whole: ${JSON.stringify(axis)}`);
  }
  const colourless = (value) => !value || value === "none" || /^rgba?\(0, 0, 0(, 0)?\)$/.test(value);
  assert.ok(found.paint.length >= 1 && !found.paint.some(colourless), `${name}: its series in their colours: ${JSON.stringify(found.paint)}`);
  assert.ok(!found.keys.some(colourless), `${name}: each key in the legend in its colour: ${JSON.stringify(found.keys)}`);
  const total = SERIES[found.key];
  if (total > 1) {
    assert.ok(found.legend && found.legend.inside, `${name}: a legend inside the chart`);
    assert.ok(found.legend.lines <= (found.size === "large" ? 2 : 1), `${name}: the legend in its lines: ${JSON.stringify(found.legend)}`);
    assert.equal(found.drawn, found.legend.named, `${name}: it draws the series its legend names`);
    if (found.legend.named < total) assert.equal(found.legend.count, `${found.legend.named} of ${total} series`, `${name}: how many there are`);
    else assert.equal(found.legend.count, null);
  } else assert.equal(found.drawn, 1);
}

/** Each chart card on its own, deck and widgets: a whole deck in Home's scrolling pane is not one picture. */
async function cardShots(label) {
  for (const key of Object.keys(CHARTS)) await shot(`card-${label}-${key}.png`, `.home-view [data-section-key="${key}"]`);
  for (const pin of pins) await shot(`widget-${label}-${pin.key}.png`, `.home-widget-column article[data-pin-widget$=":${pin.key}"]`);
}

const WIDTHS = [[1720, 1100], [1200, 900], [647, 900], [390, 844]];
try {
  for (const [width, height] of WIDTHS)
    await step(`${width}: every chart card fits its frame, deck and widgets; the attachment's points arriving move nothing`, async () => {
      holdData();
      await open(width, height);
      // Before its points arrive: the names and legend there, the plot's room said to be loading.
      const trend = page.locator('.home-view [data-section-key="trend"]');
      await trend.scrollIntoViewIfNeeded();
      const before = await charts("deck");
      const waiting = before.find((c) => c.key === "trend");
      assert.equal(waiting.state, "Loading chart data…");
      assert.ok(waiting.rootInside && !waiting.overflow, JSON.stringify(waiting));
      const geometry = () => page.evaluate(() => [...document.querySelectorAll('.home-view [data-section-key="trend"], .home-widget-column article[data-pin-widget$=":trend"]')].map((card) => {
        const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.left), Math.round(b.width), Math.round(b.height)]; };
        return { card: r(card), frame: r(card.querySelector(".home-card-frame-body")), parts: [...card.querySelectorAll(".home-card-chart > *")].map(r) };
      }));
      const held = await geometry();
      await shot(`loading-${width}.png`, '.home-view [data-section-key="trend"]');
      release();
      await until("the trend drawn", async () => (await charts("deck")).find((c) => c.key === "trend").svg);
      await sleep(200);
      const drawn = await geometry();
      assert.deepEqual(drawn, held, "the cards, frames and the chart's parts where they were");
      const deck = await charts("deck");
      const widgets = await charts("widgets");
      assert.deepEqual(deck.map((c) => [c.key, c.size, c.source]), [["trend", "wide", "author"], ["stages", "wide", "author"], ["sizes", "large", "author"],
        ["pool", "wide", "author"], ["bench", "large", "author"], ["swing", "wide", "author"]]);
      assert.deepEqual(widgets.map((c) => [c.key, c.size, c.source]), [["stages", "large", "user"], ["sizes", "wide", "user"], ["trend", "wide", "author"]]);
      for (const found of deck) assertBounded(found, `${width} deck`);
      for (const found of widgets) assertBounded(found, `${width} widget`);
      await cardShots(`${width}`);
      return { deck, widgets };
    });

  // Larger text, up to the largest Settings offers (24 px): every tick label inside its plot, the y axis's longest,
  // "-200M", whole on its left.
  for (const [width, height, fontSize] of [[390, 844, 20], [390, 844, 24], [1200, 900, 24]])
    await step(`${width} with ${fontSize} px text: still bounded, the plot readable, the y axis as wide as its labels`, async () => {
      await open(width, height, { fontSize });
      await until("every chart drawn", async () => (await charts("deck")).every((c) => c.svg));
      const deck = await charts("deck");
      const widgets = await charts("widgets");
      for (const found of deck) assertBounded(found, `${width}/${fontSize}px deck`);
      for (const found of widgets) assertBounded(found, `${width}/${fontSize}px widget`);
      const swing = deck.find((c) => c.key === "swing");
      assert.ok(swing.yTicks.some((t) => /^[-−]\d/.test(t.text)), `the negative labels drawn: ${JSON.stringify(swing.yTicks)}`);
      await cardShots(`${width}-text-${fontSize}`);
      return { deck, widgets };
    });

  await step("1200: the chart's names, legend and ticks at 4.5:1 or more in every palette and theme", async () => {
    await open(1200, 900);
    await until("every chart drawn", async () => (await charts("deck")).every((c) => c.svg));
    const found = await page.evaluate((selectors) => {
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
              if (!el.textContent.trim()) continue;
              const chain = [];
              for (let n = el; n; n = n.parentElement) chain.unshift(getComputedStyle(n).backgroundColor);
              const background = paint(chain);
              // An SVG tick's colour is its fill.
              const ink = el instanceof SVGElement ? getComputedStyle(el).fill : getComputedStyle(el).color;
              const value = ratio(paint([`rgb(${background.join(",")})`, ink]), background);
              if (!out[selector] || value < out[selector].ratio) out[selector] = { ratio: value, palette, theme, text: el.textContent.trim().slice(0, 30) };
            }
        }
      [html.dataset.palette, html.dataset.theme] = kept;
      return out;
    }, [".home-card-chart-title", ".home-card-chart-legend li", ".home-card-chart-axis", ".home-card-chart .recharts-cartesian-axis-tick-value"]);
    assert.equal(Object.keys(found).length, 4, JSON.stringify(found));
    assert.deepEqual(Object.entries(found).filter(([, value]) => value.ratio < 4.5), [], JSON.stringify(found));
    return { contrast: found };
  });

  await step("the report page keeps the whole chart: its plot, legend, footer and data table", async () => {
    await open(1440, 900);
    const card = page.locator('.home-view [data-section-key="stages"]');
    await card.locator(".home-report-open").click();
    await page.locator(".home-report .report-head h1").waitFor();
    await until("the report's chart", async () => (await page.locator(".home-report .brief-chart svg.recharts-surface").count()) > 0);
    const whole = await page.evaluate(() => {
      const chart = document.querySelector(".home-report .brief-chart");
      return { plot: Math.round(chart.querySelector(".brief-chart-plot").getBoundingClientRect().height), legend: chart.querySelectorAll(".brief-legend li").length,
        foot: !!chart.querySelector(".brief-chart-foot"), table: !!chart.querySelector("details.brief-chart-data"), card: !!chart.closest(".home-card-frame") };
    });
    assert.deepEqual(whole, { plot: 260, legend: 3, foot: true, table: true, card: false });
    await shot("report-stages.png", ".home-report .brief-chart");
    return whole;
  });

  if (report.errors.length) report.failures.push({ name: "console", error: report.errors.join("\n") });
  if (report.writes.length) report.failures.push({ name: "writes", error: report.writes.join("\n") });
  if (report.unexpected.length) report.failures.push({ name: "unexpected requests", error: report.unexpected.join("\n") });
} finally {
  release();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
if (report.failures.length) {
  console.log(`failed: ${report.failures.map((x) => x.name).join("; ")}`);
  process.exit(1);
}
console.log(`passed: ${resolve(output, "report.json")}`);
