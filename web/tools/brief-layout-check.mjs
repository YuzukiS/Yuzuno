// In-card layout on Home (T-115): Group tones and Columns, as Home draws
// them, and a live block edit.
// - Every Columns, nested ones and those of 3 and 4 columns included, sits
//   side by side at its widths while its narrowest column has at least
//   14rem, and stacks in the order given below that; nothing scrolls
//   sideways. Light and dark, 1440 to 390 px, and the app's 24 px text size
//   (the root, and so every rem, grows with it).
// - A tinted summary keeps its text at 4.5:1 or more; an old body without
//   layout components draws as before.
// - A live update that edits one block leaves the other blocks' DOM nodes,
//   the card's place, the reading position and a table's filter as they
//   were; editing the table itself clears its filter.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/brief-layout");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-layout.test";
const MIN_COLUMN_REM = 14;
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], views: {} };
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

// ---------------------------------------------------------------- fixture
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "sora", name: "Sora", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null };
const projects = [{ id: "p1", name: "Curve study", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "sora", name: "Sora", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const group = (title, children, tone) => node("Group", { ...(title ? { title } : {}), ...(tone ? { tone } : {}) }, children);
const body = (children, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, children), ...elements } });
const section = (key, title, version, content, extra = {}) => ({
  key, kind: "status", title, version, owner, body: content, attachments: [], refs: {}, seen: { version, at: iso(-MIN) }, history: false,
  updatedTurnId: null, updatedAt: iso(-5 * MIN), status: { asOf: iso(-5 * MIN), validFor: 86400, stale: false }, ...extra,
});
const runsTable = (rows) => node("Table", { id: "runs", title: "Runs", columns: [{ key: "run", label: "Run" }, { key: "loss", label: "Loss" }],
  rows: rows.map(([run, loss]) => ({ id: `r${run}`, cells: { run, loss } })) });
const steps = (ablations) => node("Plan", { steps: [
  { id: "baseline", text: "Baseline run", state: "done" },
  { id: "run-12", text: "Run 12, larger batch", state: ablations ? "done" : "doing" },
  { id: "ablations", text: "Ablations", state: ablations ? "doing" : "todo" },
] });
const overview = (ablations = false, rows = [["11", 0.437], ["12", 0.412], ["21", 0.44]]) => body(["now", "split"], {
  now: group("Where we are", ["summary"], "accent"),
  summary: md("Run 12 is converging; **one decision** blocks run 13."),
  split: node("Columns", { widths: [3, 2] }, ["work", "next"]),
  work: group("Progress and findings", ["progress", "findings", "runs"]),
  progress: steps(ablations),
  findings: node("Findings", { items: [{ id: "warmup", source: "run 12", severity: "info", text: "Validation loss falls 6% once warm-up ends." }] }),
  runs: runsTable(rows),
  next: group("Decisions and metrics", ["decisions", "metrics"]),
  decisions: node("Checklist", { items: [{ id: "split", text: "Choose the run 13 split", done: false }] }),
  metrics: node("Metrics", { items: [{ label: "Validation loss", value: 0.412, previous: 0.437 }] }),
});
const cell = (n) => group(`Column ${n}`, [`t${n}`]);
const cells = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => i + 1).flatMap((n) => [[`c${n}`, cell(n)], [`t${n}`, md(`Lane ${n}: two runs queued, one running.`)]]));
const f = {
  version: 9,
  sections: [
    section("overview", "Curve study overview", 4, overview()),
    section("quad", "Four lanes", 1, body(["lanes"], { lanes: node("Columns", {}, ["c1", "c2", "c3", "c4"]), ...cells(4) })),
    section("trio", "Three lanes at 2:1:1", 1, body(["lanes"], { lanes: node("Columns", { widths: [2, 1, 1] }, ["c1", "c2", "c3"]), ...cells(3) })),
    section("nested", "Columns inside a column", 1, body(["outer"], {
      outer: node("Columns", {}, ["left", "right"]),
      left: group("Left, split again", ["inner"], "muted"),
      inner: node("Columns", {}, ["c1", "c2"]),
      right: group("Right", ["t3"]),
      ...cells(3),
    })),
    section("legacy", "An older body", 2, body(["intro", "detail"], {
      intro: md("Written before layout components existed."),
      detail: group("Detail", ["more"]),
      more: md("A titled group, as before."),
    })),
  ],
};
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
  projects: [{
    project: { id: "p1", name: "Curve study" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: f.version, sections: f.sections, history: [] },
    unseen: 0, missing: [],
  }],
});
const detail = () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] });
const machineLoad = () => ({
  at: new Date().toISOString(),
  cpu: { cores: 32, totalPct: 20, jobsPct: 0, agentsPct: null, otherPct: null },
  memory: { totalMiB: 40107, usedMiB: 12000, availableMiB: 28107, jobsMiB: 0, agentsMiB: null },
  gpus: [], jobs: [],
});

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/agents/sora": detail,
    "/api/machine-load": machineLoad,
    "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
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
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}

/** What the fixture declares for each Columns, by section and nesting depth: never read back from the page. */
const DECLARED = {
  "overview/0": { widths: [3, 2], count: 2 },
  "quad/0": { widths: [1, 1, 1, 1], count: 4 },
  "trio/0": { widths: [2, 1, 1], count: 3 },
  "nested/0": { widths: [1, 1], count: 2 },
  "nested/1": { widths: [1, 1], count: 2 },
};
/** Whether the declared columns should stack in a Columns this wide: when the narrowest would fall below 14rem. */
const shouldStack = ({ widths, count }, width, rem) =>
  ((width - 16 * (count - 1)) * Math.min(...widths)) / widths.reduce((a, b) => a + b, 0) < MIN_COLUMN_REM * rem;
/** Checks every Columns against DECLARED; returns what is wrong. */
function judge(shown) {
  const wrong = [];
  const seen = shown.map((c) => `${c.key}/${c.depth}`).sort();
  if (JSON.stringify(seen) !== JSON.stringify(Object.keys(DECLARED).sort())) wrong.push({ problem: "not the declared Columns", seen });
  for (const c of shown) {
    const declared = DECLARED[`${c.key}/${c.depth}`];
    if (!declared) continue;
    if (c.cells.length !== declared.count) wrong.push({ ...c, problem: `${c.cells.length} columns, declared ${declared.count}` });
    const threshold = ((MIN_COLUMN_REM * c.rem) * declared.widths.reduce((a, b) => a + b, 0)) / Math.min(...declared.widths) + 16 * (declared.count - 1);
    // Within 2 px of the threshold either answer is right.
    if (Math.abs(c.width - threshold) > 2 && shouldStack(declared, c.width, c.rem) !== c.stacked)
      wrong.push({ ...c, problem: `stacked ${c.stacked} at ${c.width}px; the threshold is ${Math.round(threshold)}px` });
    const inOrder = c.cells.every((x, i) => i === 0 || (c.stacked ? x.top >= c.cells[i - 1].bottom : x.top === c.cells[0].top && x.left > c.cells[i - 1].left));
    if (!inOrder) wrong.push({ ...c, problem: "columns out of order" });
    if (!c.stacked) {
      const unit = c.cells[0].width / declared.widths[0];
      if (c.cells.some((x, i) => Math.abs(x.width - unit * declared.widths[i]) > 3))
        wrong.push({ ...c, problem: `widths ${c.cells.map((x) => x.width)} are not ${declared.widths}` });
    }
  }
  return wrong;
}

/** Every Columns on Home: its own width, whether it stacked, and its columns' boxes. */
const columnsShown = () =>
  page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return [...document.querySelectorAll(".home-view .brief-columns")].map((el) => {
      const key = el.closest("[data-section-key]").dataset.sectionKey;
      const cells = [...el.children].map((child) => {
        const r = child.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) };
      });
      const widths = (el.style.getPropertyValue("--brief-columns").match(/[\d.]+fr/g) || []).map((w) => parseFloat(w));
      return { key, depth: [...document.querySelectorAll(".home-view .brief-columns")].filter((o) => o !== el && o.contains(el)).length,
        width: el.clientWidth, rem, stacked: el.hasAttribute("data-stacked"), widths, cells };
    });
  });
const overflow = () =>
  page.evaluate(() => {
    const view = document.querySelector(".home-view");
    const cards = [...document.querySelectorAll(".home-view [data-section-key]")].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.dataset.sectionKey);
    return { page: document.documentElement.scrollWidth > innerWidth, view: view.scrollWidth > view.clientWidth + 1, cards };
  });
// Computed colours come as rgb(0-255 …) or, from color-mix(in srgb, …), as
// color(srgb 0-1 …).
const channels = (value) => {
  const parts = value.match(/[\d.]+/g).slice(0, 3).map(Number);
  return value.startsWith("color(srgb") ? parts : parts.map((v) => v / 255);
};
const luminance = (value) => {
  const [r, g, b] = channels(value).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Each tinted group: its background, and the colour of its body text and its title, measured apart. */
const tones = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".home-view .brief-group[data-tone]")].map((g) => {
      const text = g.querySelector(".brief-markdown p, .brief-markdown");
      const title = g.querySelector(":scope > h4");
      return { tone: g.dataset.tone, background: getComputedStyle(g).backgroundColor, card: getComputedStyle(g.closest(".brief-body")).backgroundColor,
        text: text && getComputedStyle(text).color, title: title && getComputedStyle(title).color };
    }),
  );
const card = (key) => page.locator(`.home-view [data-section-key="${key}"]`);
const briefChanged = () =>
  page.evaluate(() => window.__homeEvents?.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "brief" }), lastEventId: "" }));

async function open(theme, width, rootPx, palette = "garden") {
  page = await browser.newPage({ viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await page.addInitScript(({ theme, fontSize, palette }) => {
    window.EventSource = class {
      constructor() {
        window.__homeEvents = this;
        setTimeout(() => this.onopen?.(), 50);
      }
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize, palette }));
  }, { theme, fontSize: rootPx ?? 16, palette });
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
  if (!(await page.locator(".home-view").isVisible())) await page.locator(".toolbar-nav .catchup-nav").first().click();
  // Everything here is seen, so the panel opens folded: open it, as the user would.
  const toggle = page.locator('.home-view .home-panel-toggle[aria-expanded="false"]');
  await page.locator(".home-view .home-panel-toggle").first().waitFor();
  if (await toggle.count()) await toggle.first().click();
  await card("legacy").waitFor();
  await sleep(300);
}

try {
  const views = [
    ["light", 1440], ["dark", 1440], ["light", 1100], ["dark", 820], ["light", 390], ["dark", 390], ["light", 1440, 24], ["dark", 820, 24],
  ];
  for (const [theme, width, rootPx] of views) {
    const name = `${theme}-${width}${rootPx ? `-text-${rootPx}` : ""}`;
    await step(`${name}: every Columns stacks exactly when a column would fall below ${MIN_COLUMN_REM}rem, in order, and nothing scrolls sideways`, async () => {
      await open(theme, width, rootPx);
      // The setting took: the root and the Brief text are at its size.
      const size = rootPx ?? 16;
      const root = await page.evaluate(() => ({
        fontSize: document.documentElement.dataset.fontSize,
        reading: document.documentElement.style.getPropertyValue("--reading-size"),
        adjust: document.documentElement.style.getPropertyValue("--font-adjust"),
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
        brief: parseFloat(getComputedStyle(document.querySelector(".home-view .brief-body")).fontSize),
      }));
      assert.deepEqual({ ...root, brief: Math.round(root.brief * 100) / 100 },
        { fontSize: String(size), reading: `${size}px`, adjust: `${size - 13}px`, rem: size, brief: Math.round(0.88 * size * 100) / 100 });
      const shown = await columnsShown();
      assert.deepEqual(judge(shown), []);
      const fit = await overflow();
      assert.deepEqual(fit, { page: false, view: false, cards: [] });
      await page.screenshot({ path: resolve(output, `${name}.png`) });
      for (const key of ["overview", "nested"]) {
        await card(key).evaluate((el) => el.scrollIntoView({ block: "center" }));
        await sleep(100);
        await card(key).screenshot({ path: resolve(output, `${name}-${key}.png`) });
      }
      report.views[name] = shown.map((c) => ({ key: c.key, depth: c.depth, width: c.width, stacked: c.stacked }));
      return { columns: report.views[name] };
    });
    await step(`${name}: tinted groups keep their text at 4.5:1 or more`, async () => {
      const found = await tones();
      assert.deepEqual(found.map((t) => t.tone).sort(), ["accent", "muted"]);
      for (const t of found) {
        assert.notEqual(t.background, t.card, `${t.tone} is tinted`);
        assert.ok(t.text, `${t.tone} has body text to measure`);
        assert.ok(contrast(t.text, t.background) >= 4.5, `${t.tone} text ${contrast(t.text, t.background).toFixed(2)}`);
        if (t.title) assert.ok(contrast(t.title, t.background) >= 4.5, `${t.tone} title ${contrast(t.title, t.background).toFixed(2)}`);
      }
      return { tones: found.map((t) => ({ tone: t.tone, text: +contrast(t.text, t.background).toFixed(2), title: t.title && +contrast(t.title, t.background).toFixed(2) })) };
    });
    await page.close();
  }

  await step("every palette, light and dark: tinted groups keep their body text and titles at 4.5:1 or more", async () => {
    const measured = {};
    for (const palette of ["garden", "yuzu", "graphite", "pine", "sunroom"])
      for (const theme of ["light", "dark"]) {
        await open(theme, 1440, undefined, palette);
        const found = await tones();
        const low = found.filter((t) => !t.text || contrast(t.text, t.background) < 4.5 || (t.title && contrast(t.title, t.background) < 4.5));
        measured[`${palette}-${theme}`] = found.map((t) => [t.tone, +contrast(t.text, t.background).toFixed(2), t.title && +contrast(t.title, t.background).toFixed(2)]);
        assert.deepEqual(low.map((t) => t.tone), [], `${palette}-${theme}: ${JSON.stringify(measured[`${palette}-${theme}`])}`);
        await page.close();
      }
    return { measured };
  });

  await step("on one page, narrow to wide and back: each Columns follows its own width, the nested pair in different states on the way", async () => {
    await open("light", 390);
    const states = [];
    for (const width of [390, 1440, 2400, 1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(400);
      const shown = await columnsShown();
      assert.deepEqual(judge(shown), [], `at ${width}px`);
      const nested = Object.fromEntries(shown.filter((c) => c.key === "nested").map((c) => [c.depth ? "inner" : "outer", c.stacked]));
      states.push({ width, outer: nested.outer, inner: nested.inner, overview: shown.find((c) => c.key === "overview").stacked });
      assert.deepEqual(await overflow(), { page: false, view: false, cards: [] }, `at ${width}px`);
      await page.screenshot({ path: resolve(output, `resize-${width}-${states.length}.png`) });
    }
    assert.ok(states.some((s) => s.outer === false && s.inner === true), `the outer pair side by side while the inner pair stacks: ${JSON.stringify(states)}`);
    assert.ok(states[0].overview && !states[1].overview && states.at(-1).overview, `the overview stacks, unstacks and stacks again: ${JSON.stringify(states)}`);
    await page.close();
    return { states };
  });

  await step("an older body without layout components draws as before: its titled group, no failed part", async () => {
    await open("light", 1440);
    const legacy = card("legacy");
    assert.equal(await legacy.locator(".brief-group h4").innerText(), "Detail");
    assert.equal(await legacy.locator(".brief-columns, .brief-group[data-tone]").count(), 0);
    assert.equal(await page.locator(".home-view .result-part-error").count(), 0);
  });

  await step("a live edit of one block keeps every other block's node, the card's place, the scroll and the table's filter; editing the table clears it", async () => {
    const overviewCard = card("overview");
    await overviewCard.locator('input[aria-label="Filter Runs"]').fill("2");
    // "2" matches runs 12 and 21.
    await until("the filter", async () => (await overviewCard.locator(".result-table-scroll tbody tr").count()) === 2);
    // Scroll the overview's table into the middle, then mark what is drawn.
    await overviewCard.locator(".result-table-scroll").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await sleep(100);
    const before = await page.evaluate(() => {
      const scroller = [...document.querySelectorAll(".home-view, .home-view *")].find((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) || document.scrollingElement;
      window.__scroller = scroller;
      const cardEl = document.querySelector('.home-view [data-section-key="overview"]');
      // Every block but the Plan, which the edit replaces.
      cardEl.querySelectorAll('.brief-markdown, .brief-list:not([aria-label="Plan"]), .brief-metrics, .result-table-section').forEach((el, i) => (el.dataset.mark = `m${i}`));
      return { scroll: scroller.scrollTop, top: Math.round(cardEl.getBoundingClientRect().top), marked: cardEl.querySelectorAll("[data-mark]").length };
    });
    f.sections[0] = { ...f.sections[0], version: 5, body: overview(true) };
    f.version += 1;
    await briefChanged();
    await until("the edited plan", async () => /Ablations/.test(await overviewCard.locator('[aria-label="Plan"] li[data-state="doing"]').innerText().catch(() => "")));
    await sleep(300);
    const after = await page.evaluate(() => {
      const cardEl = document.querySelector('.home-view [data-section-key="overview"]');
      return { scroll: window.__scroller.scrollTop, top: Math.round(cardEl.getBoundingClientRect().top), marked: cardEl.querySelectorAll("[data-mark]").length };
    });
    assert.equal(after.marked, before.marked, "the unchanged blocks are the same nodes");
    assert.ok(Math.abs(after.scroll - before.scroll) <= 1 && Math.abs(after.top - before.top) <= 1, JSON.stringify({ before, after }));
    assert.equal(await overviewCard.locator('input[aria-label="Filter Runs"]').inputValue(), "2", "the table's filter is kept");
    // Now the table itself changes: its old filter no longer applies.
    f.sections[0] = { ...f.sections[0], version: 6, body: overview(true, [["11", 0.437], ["12", 0.412], ["21", 0.44], ["13", 0.401]]) };
    f.version += 1;
    await briefChanged();
    await until("the edited table", async () => (await overviewCard.locator(".result-table-scroll tbody tr").count()) === 4);
    assert.equal(await overviewCard.locator('input[aria-label="Filter Runs"]').inputValue(), "");
    return { before, after };
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
