// YN-209 in Chromium: the cards of card-face-fixtures.mjs on a project's page,
// every API answered here, through the production build, at 1440 px and on a
// phone (390 px, touch), in Chinese and English; each card set to its own span
// and its own height (as card-face.ts's references are), then measured and
// compared with cardFace for the same section:
//  - exact: size, layout, the picture (the image drawn), a table's rows and
//    columns drawn, Metrics values drawn, the files named, Open report;
//  - estimate: whether the lead is cut and how many characters show, the
//    conditions shown, a table's rows and columns and Metrics values fully and
//    partly inside the frame, and the card's height, within the tolerances
//    below. Every difference is kept in the report; none is dropped.
// Nothing is sent but reads, nothing is asked of another host.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node --experimental-strip-types tools/card-face-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { cardFace, FACE_REFERENCE } from "../src/home/card-face.ts";
import { CARD_FACE_FIXTURES } from "./card-face-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });

/** How far an estimate may be from Chromium: characters shown and height, whichever is larger of the two. */
const TOLERANCE = { chars: { abs: 4, rel: 0.05 }, height: { abs: 16, rel: 0.05 } };
const within = (estimate, real, { abs, rel }) => Math.abs(estimate - real) <= Math.max(abs, rel * real);

const HOST = "yuzuno-faces.test";
const PROJECT = "p-faces";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agents = [{ id: "l", name: "lead-1", harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/faces", projectId: PROJECT }];
const projects = [{ id: PROJECT, name: "face-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "lead-1", state: "active" };
const svg = (label, tint) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="${tint}"/><text x="40" y="210" font-size="48" font-family="sans-serif">${label}</text></svg>`;
const fixtures = CARD_FACE_FIXTURES.filter((f) => f.browser !== false);
let id = 700;
const sections = fixtures.map((f) => ({ id: id++, version: 3, owner, updatedAt: at(10), updatedTurnId: "t1", refs: {}, seen: null, history: false, ...f.section }));
const files = {};
for (const s of sections) for (const a of s.attachments) if (a.kind === "image") files[`/api/projects/${PROJECT}/brief/attachments/${s.key}/${a.name}`] = svg(a.name.replace(/\..*/, ""), "#e8efe6");
const home = () => ({
  generatedAt: at(0), order: [PROJECT], needsYou: [],
  projects: [{ project: { id: PROJECT, name: "face-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const report = { task: "YN-209", tolerance: TOLERANCE, reference: FACE_REFERENCE, runs: [], posts: [], unexpected: [], errors: [], failures: [] };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const language of ["zh-Hans", "en"])
    for (const [name, viewport, phone] of [["1440", { width: FACE_REFERENCE.wide.window, height: 1000 }, false], ["phone-390", { width: FACE_REFERENCE.phone.window, height: 844 }, true]])
      await run({ name: `${language}-${name}`, language, phone, viewport, width: phone ? "phone" : "wide" });
} finally {
  await browser.close();
  await writeFile(join(output, "card-face-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
assert.deepEqual(report.failures, [], "every exact field equal, every estimate within its tolerance");
console.log(`card-face-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.cards.length, 0)} cards, no failures`);

async function run(spec) {
  const result = { run: spec.name, viewport: spec.viewport, deck: null, cards: [] };
  report.runs.push(result);
  const context = await browser.newContext({
    viewport: spec.viewport, locale: spec.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC",
    ...(spec.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addInitScript(([language]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (!localStorage.getItem("yuzuno.selected.ws-s")) localStorage.setItem("yuzuno.selected.ws-s", JSON.stringify("l"));
  }, [spec.language]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: spec.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    if (files[path]) return route.fulfill({ body: files[path], contentType: "image/svg+xml" });
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-s" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": home(),
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  page.on("pageerror", (error) => report.errors.push(`${spec.name}: ${error.message}`));
  try {
    // The project's page, where its cards are (YN-86): from its glance on Home.
    await page.goto(spec.phone ? `http://${HOST}/#/home?w=ws-s` : `http://${HOST}/`);
    if (!spec.phone) await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await page.locator(`[data-glance-project="${PROJECT}"] .project-glance-open`).click({ timeout: 15_000 });
    await page.locator(`[data-project-home="${PROJECT}"]`).waitFor({ timeout: 15_000 });
    const card = (key) => page.locator(`#home-section-${PROJECT}-${key}`);
    for (const s of sections) await card(s.key).waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    result.deck = await page.evaluate(() => {
      const grid = document.querySelector(".project-home-main .home-brief");
      return { width: grid.clientWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length };
    });
    assert.equal(result.deck.width, FACE_REFERENCE[spec.width].deck, `${spec.name}: the deck is the reference's`);
    for (const fixture of fixtures) {
      const face = cardFace(fixture.section);
      const own = face[spec.width];
      const span = own.columns >= 2 && face.size !== "small" ? 2 : 1;
      const real = await card(fixture.section.key).evaluate(measureCard, span);
      await card(fixture.section.key).screenshot({ path: join(output, `${spec.name}-${fixture.id}.png`) });
      result.cards.push(compare(spec, fixture, face, own, real));
    }
  } finally {
    await context.close();
  }
}

/** One card's row of the report: each exact field and each estimate beside what Chromium drew. */
function compare(spec, fixture, face, own, real) {
  const row = { card: fixture.id, exact: {}, estimate: {}, parts: real.parts };
  const exact = (field, mine, theirs) => {
    const ok = JSON.stringify(mine) === JSON.stringify(theirs);
    row.exact[field] = { face: mine, chromium: theirs, ok };
    if (!ok) report.failures.push(`${spec.name} ${fixture.id} ${field}: ${JSON.stringify(mine)} ≠ ${JSON.stringify(theirs)}`);
  };
  const estimate = (field, mine, theirs, ok) => {
    row.estimate[field] = { face: mine, chromium: theirs, ok };
    if (!ok) report.failures.push(`${spec.name} ${fixture.id} ${field}: estimate ${JSON.stringify(mine)}, Chromium ${JSON.stringify(theirs)}`);
  };
  const drawn = face.visual.drawn;
  exact("size", face.size, real.size);
  exact("layout", own.layout, real.layout);
  exact("picture", face.visual.file && face.visual.type === "image" ? face.visual.file : null, real.image ?? null);
  exact("tableDrawn", drawn?.as === "table" ? [drawn.rows, drawn.columns] : null, real.table ? [real.table.rows, real.table.columns] : null);
  exact("valuesDrawn", drawn?.as === "values" ? drawn.shown : null, real.values ?? null);
  exact("files", face.files?.named ?? [], real.files);
  exact("opensReport", face.opensReport, real.opensReport);
  // CSS arithmetic in whole pixels, as Chromium rounds a box's width.
  const textPx = real.lead?.width ?? own.textPx;
  row.exact.textPx = { face: own.textPx, chromium: textPx, ok: Math.abs(own.textPx - textPx) <= 1 };
  if (!row.exact.textPx.ok) report.failures.push(`${spec.name} ${fixture.id} textPx: ${own.textPx} ≠ ${textPx}`);
  const lead = own.estimate.lead;
  if (lead && real.lead) {
    estimate("leadCut", lead.cut, real.lead.cut, lead.cut === real.lead.cut);
    const shown = face.lead.chars - (lead.hiddenChars ?? 0);
    estimate("leadShownChars", shown, real.lead.shownChars, within(shown, real.lead.shownChars, TOLERANCE.chars));
    estimate("leadLines", lead.lines, real.lead.lines, Math.abs(lead.lines - real.lead.lines) <= 1);
  }
  const conditions = own.estimate.conditions;
  if (conditions && "shown" in conditions) estimate("conditionsShown", conditions.shown, real.conditions?.shown, conditions.shown === real.conditions?.shown);
  if (conditions && "cut" in conditions) estimate("conditionsCut", conditions.cut, real.conditions?.cut, conditions.cut === real.conditions?.cut);
  if (own.estimate.table) estimate("tableInFrame", own.estimate.table, real.table?.inFrame, JSON.stringify(own.estimate.table) === JSON.stringify(real.table?.inFrame));
  if (own.estimate.metrics) {
    const { full, partial } = own.estimate.metrics;
    estimate("metricsInFrame", { full, partial }, real.metricsInFrame, full === real.metricsInFrame?.full && partial === real.metricsInFrame?.partial);
  }
  estimate("heightPx", own.estimate.heightPx, real.height, own.estimate.heightAtLeast ? real.height >= own.estimate.heightPx - TOLERANCE.height.abs : within(own.estimate.heightPx, real.height, TOLERANCE.height));
  row.naturalHeight = real.naturalHeight;
  return row;
}

/** In the page: one card at its own span and height, as a face describes it. */
async function measureCard(el, span) {
  const naturalHeight = Math.round(el.getBoundingClientRect().height);
  el.style.gridColumn = `span ${span}`;
  el.style.alignSelf = "start";
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  await new Promise((done) => setTimeout(done, 120));
  const rect = (node) => node.getBoundingClientRect();
  const box = rect(el);
  const out = { size: el.dataset.cardSize, height: Math.round(box.height), naturalHeight, files: [], opensReport: !!el.querySelector(".home-report-open") };
  /** Each character of `node` with the line it lies on (by its box's top) and whether it ends inside `clip`. */
  const charsOf = (node, clip) => {
    const range = document.createRange();
    const found = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      let offset = 0;
      for (const ch of text.data) {
        range.setStart(text, offset);
        range.setEnd(text, offset + ch.length);
        const r = range.getClientRects()[0];
        offset += ch.length;
        if (!r || /\s/.test(ch)) continue;
        found.push({ ch, top: Math.round(r.top), inside: r.bottom <= clip.bottom + 1 });
      }
    }
    return found;
  };
  const lineTops = (chars) => [...new Set(chars.map((c) => c.top))].sort((a, b) => a - b);
  const lead = el.querySelector(".home-summary-lead .brief-markdown");
  if (lead) {
    const chars = charsOf(lead, rect(lead));
    const tops = lineTops(chars);
    // Visible characters, spaces left out on both sides: compared with the face's count less its spaces.
    const text = lead.textContent.replace(/\s+/g, " ").trim();
    const spaces = (value) => (value.match(/ /g) ?? []).length;
    const shownNoSpace = chars.filter((c) => c.inside).length;
    const shownText = [...text];
    // Rebuild the count with spaces: the first shownNoSpace non-space characters and the spaces between them.
    let seen = 0, withSpaces = 0;
    for (const ch of shownText) {
      if (seen >= shownNoSpace) break;
      withSpaces += 1;
      if (ch !== " ") seen += 1;
    }
    out.lead = { width: Math.round(lead.clientWidth), lines: tops.length, shownLines: lineTops(chars.filter((c) => c.inside)).length,
      cut: chars.some((c) => !c.inside), chars: [...text].length, shownChars: withSpaces, spaces: spaces(text) };
  }
  const textBox = el.querySelector(".home-summary-text");
  const frame = el.querySelector(".home-card-frame");
  if (frame) {
    out.layout = textBox && rect(frame).left >= rect(textBox).right - 1 ? "beside" : "under";
    const body = frame.querySelector(".home-card-frame-body") ?? frame;
    const fb = rect(body);
    const img = frame.querySelector("img");
    if (img) out.image = decodeURIComponent(img.getAttribute("src") ?? "").split("/").pop()?.split("?")[0];
    const table = frame.querySelector("table");
    if (table) {
      const rows = [...table.querySelectorAll("tbody tr")];
      const heads = [...table.querySelectorAll("thead th")];
      out.table = {
        rows: rows.length, columns: heads.length,
        inFrame: {
          rows: { full: rows.filter((r) => rect(r).bottom <= fb.bottom + 0.5).length, partial: rows.filter((r) => rect(r).bottom > fb.bottom + 0.5 && rect(r).top < fb.bottom).length },
          columns: { full: heads.filter((c) => rect(c).right <= fb.right + 0.5).length, partial: heads.filter((c) => rect(c).right > fb.right + 0.5 && rect(c).left < fb.right).length },
        },
      };
    }
    const values = [...frame.querySelectorAll(".brief-metrics > div, .home-card-metrics-grid > div")];
    if (values.length) {
      out.values = values.length;
      out.metricsInFrame = { full: values.filter((v) => rect(v).bottom <= fb.bottom + 0.5).length, partial: values.filter((v) => rect(v).bottom > fb.bottom + 0.5 && rect(v).top < fb.bottom).length };
    }
    out.frame = { height: Math.round(fb.height), width: Math.round(fb.width), caption: frame.querySelector("figcaption") ? Math.round(rect(frame.querySelector("figcaption")).height) : null };
  } else if (el.querySelector(".home-card-numbers, .home-card-figure-note")) {
    out.layout = "line";
    const numbers = el.querySelectorAll(".home-card-numbers > div");
    if (numbers.length) out.values = numbers.length;
  } else out.layout = "none";
  const chips = [...el.querySelectorAll(".home-card-condition-chips li")];
  const prose = el.querySelector(".home-card-condition-text");
  if (chips.length) out.conditions = { shown: chips.filter((c) => !c.hasAttribute("hidden")).length };
  else if (prose) out.conditions = { cut: prose.scrollHeight > prose.clientHeight + 1 };
  out.files = [...el.querySelectorAll(".home-card-files li .home-card-file span")].map((s) => s.textContent);
  const part = (selector) => {
    const node = el.querySelector(selector);
    return node ? Math.round(rect(node).height * 10) / 10 : null;
  };
  const chip = chips.find((c) => !c.hasAttribute("hidden"));
  const metricTops = [...el.querySelectorAll(".brief-metrics > div")].map((v) => Math.round(rect(v).top - (rect(el.querySelector(".home-card-frame-body") ?? v).top)));
  out.parts = {
    head: part(".home-summary-head"), foot: part(".home-summary-foot"), title: part(".home-summary-title"), text: part(".home-summary-text"),
    body: part(".home-summary-body"), conditions: part(".home-card-conditions"), conditionsLabel: part(".home-card-conditions-label"),
    chip: chip ? Math.round(rect(chip).height * 10) / 10 : null, tableRow: part(".home-card-table tbody tr"), tableHead: part(".home-card-table thead tr"),
    metricTops, metric: part(".brief-metrics > div:not([data-lead])"), metricLead: part(".brief-metrics > [data-lead]"),
    caption: part(".home-card-frame figcaption"), files: part(".home-card-files"), numbers: part(".home-card-numbers-frame"), figureNote: part(".home-card-figure-note"),
  };
  el.style.gridColumn = "";
  el.style.alignSelf = "";
  return out;
}
