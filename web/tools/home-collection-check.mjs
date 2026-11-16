// YN-128 (YN-113 §3.6) in Chromium, every API answered here (no Core, no
// daily configuration), through the production build, at 1440 px in English
// and on a phone (390 px, touch) in Simplified Chinese:
//  - a Collection named as a card's visual draws as a carousel (wide), a grid
//    (wide and large), a list (wide) and a small card's first item, under the
//    card's text, with how many there are; no element of a card reaches past
//    its edges (a carousel's pages scroll inside its track, which does not),
//    and no page is wider than the window;
//  - the report page shows every item: a grid and a list filter by tag, a
//    list is searched, a carousel turns by its arrow and by →;
//  - its pictures are the section's own, read from this Core; nothing is
//    sent but reads and Home's own record that a report was opened, and
//    nothing is asked of another host.
// The cards are on the project's page (YN-86), opened from its glance on Home.
// Pattern: home-inputs-check.mjs. Synthetic content only.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node --experimental-strip-types tools/home-collection-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-128", runs: [], posts: [], opened: [], unexpected: [], errors: [], pictures: [] };
const HOST = "yuzuno-collection.test";
const PROJECT = "p-co";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const agents = [{ id: "l", name: "digest-lead", harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/digest", projectId: PROJECT }];
const projects = [{ id: PROJECT, name: "daily-digest", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "digest-lead", state: "active" };
const node = (type, props, children) => ({ type, props, ...(children ? { children } : {}) });
const md = (text) => node("Markdown", { text });

// Synthetic pictures, shapes only (no text, so no font decides how they look).
const HUES = ["#3f6b4f", "#7a3b5c", "#5a7a2a", "#2f5470", "#8a6a2a", "#4d4a8a"];
const picture = (i) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180"><rect width="320" height="180" fill="${HUES[i % HUES.length]}"/>${
  [0, 1, 2, 3].map((r) => `<circle cx="${160 + (i % 3) * 20}" cy="90" r="${20 + r * 18}" fill="none" stroke="#f4f1e6" stroke-opacity="${0.9 - r * 0.18}" stroke-width="5"/>`).join("")
}${[0, 1, 2, 3, 4].map((b) => `<rect x="${24 + b * 22}" y="${150 - (b + i) % 5 * 18 - 20}" width="14" height="${(b + i) % 5 * 18 + 20}" fill="#f4f1e6" fill-opacity="0.75"/>`).join("")}</svg>`;
const files = new Map();
let id = 400;
/** A section as Core keeps it: first accepted by the real contract; its files are kept images. */
const section = (key, title, elements, children, summary, pictures = []) => {
  const body = { root: "body", elements: { body: node("BriefBody", { summary }, children), ...elements } };
  const checked = checkBriefSection({ key, kind: "report", title, body, ...(pictures.length ? { attachments: pictures.map((name) => ({ name, path: `/home/me/digest/${name}` })) } : {}) });
  pictures.forEach((name, i) => files.set(`/api/projects/${PROJECT}/brief/attachments/${encodeURIComponent(key)}/${name}`, picture(i + key.length)));
  return { id: id++, key, kind: "report", title, version: 3, owner, updatedAt: at(20), updatedTurnId: "t1",
    body: checked.body, attachments: pictures.map((name) => ({ name, kind: "image", mime: "image/svg+xml", size: 900, snapshot: true, mayChange: false, takenAt: at(21), width: 320, height: 180 })),
    refs: {}, seen: null, history: false };
};
const STORIES = ["Open model 1.0 leads long-context evals by 12 points", "A city opens its transit data to the public", "Chip export rules change again", "New battery chemistry passes 1,000 cycles", "Weather model beats last year's by a day", "Open dataset of 2 million receipts"];
const news = section("news", "Today's news", {
  lead: md("**Six stories worth reading today.** Two are about open models."),
  top: node("Collection", { id: "top", title: "Top stories", layout: "carousel", items: STORIES.map((title, i) => ({
    id: `s${i}`, title, text: "One line on why it matters, kept to a sentence.", meta: `News · 0${7 + (i % 3)}:${10 + i * 7}`, image: `s${i}.svg`, alt: `Illustration for story ${i + 1}`, href: `https://example.com/news/${i}`,
  })) }),
  more: md("Sources and the full text of each story are linked from its title."),
}, ["lead", "top", "more"], { lead: "lead", visual: "top", size: "wide" }, STORIES.map((_, i) => `s${i}.svg`));
const REPOS = ["long-ctx-bench", "agent-retry", "mixlaw", "tiny-tokenizer", "eval-harness-lite", "sparse-attn", "doc-chunker", "trace-viewer", "seed-sweeper"];
const repoItems = REPOS.map((title, i) => ({
  id: `r${i}`, title, text: ["Long-context eval set, +2.1k stars this week", "Retries and rolls back an Agent's tool calls", "Works out a pre-training data mix"][i % 3], meta: `GitHub · ${["Python", "TypeScript", "Rust"][i % 3]}`,
  href: `https://example.com/repo/${title}`, tags: [["Evals"], ["Agent"], ["Data"], ["Agent", "Data"]][i % 4], ...(i < 6 ? { image: `r${i}.svg`, alt: `Chart for ${title}` } : {}),
}));
const projectsCard = section("repos", "Open-source picks this week", {
  lead: md("**Nine new projects; three stand out.** All about long context or Agents."),
  top: node("Collection", { id: "top", layout: "grid", items: repoItems }),
}, ["lead", "top"], { lead: "lead", visual: "top", size: "wide" }, repoItems.filter((item) => item.image).map((item) => item.image));
const largeGrid = section("repos-large", "Picks, at a glance", {
  lead: md("The same picks on a large card: two rows."),
  top: node("Collection", { id: "top", layout: "grid", items: repoItems }),
}, ["lead", "top"], { lead: "lead", visual: "top", size: "large" }, repoItems.filter((item) => item.image).map((item) => item.image));
const PAPERS = ["Token-level uncertainty for RAG", "Multilingual instruction tuning at scale", "Self-correcting tool use", "Faster beam search with early stop", "Data mixing laws", "Long-context retrieval without chunking", "Small models as judges", "Curriculum for code agents", "Sparse experts, dense results", "Evaluating agents on real repositories", "Calibrated refusals", "Speculative decoding for long outputs", "Synthetic data that transfers", "Memory for multi-session agents"];
const paperItems = PAPERS.map((title, i) => ({
  id: `p${i}`, title, text: "One sentence on why it is worth reading.", meta: `${i % 2 ? "cs.LG" : "cs.CL"} · ${String(7 + (i % 5)).padStart(2, "0")}:${String(10 + i * 3).padStart(2, "0")}`,
  href: `https://example.com/papers/${i}`, tags: [["RAG", "Agent"], ["Multilingual"], ["Agent"], ["Inference"], ["Data"]][i % 5], ...(i < 3 ? { image: `p${i}.svg`, alt: `Figure from ${title}` } : {}),
}));
const papers = section("papers", "New papers (cs.CL, cs.LG)", {
  lead: md("**14 new papers in two hours; five picked.**"),
  top: node("Collection", { id: "top", title: "Papers", layout: "list", items: paperItems }),
}, ["lead", "top"], { lead: "lead", visual: "top", size: "wide" }, paperItems.filter((item) => item.image).map((item) => item.image));
const papersSmall = section("papers-small", "New papers (cs.LG)", {
  lead: md("Two picked in two hours."),
  top: node("Collection", { id: "top", layout: "list", items: paperItems.slice(0, 6) }),
}, ["lead", "top"], { lead: "lead", visual: "top", size: "small" }, paperItems.slice(0, 3).map((item) => item.image));
const sections = [news, projectsCard, papers, papersSmall, largeGrid];
const home = () => ({
  generatedAt: at(0), order: [PROJECT], needsYou: [],
  projects: [{ project: { id: PROJECT, name: "daily-digest" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { items: (n) => `${n} items`, shown: (a, b) => `${a} of ${b} shown`, all: "All" },
  "zh-Hans": { items: (n) => `共 ${n} 条`, shown: (a, b) => `显示 ${a} 条，共 ${b} 条`, all: "全部" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "en-1440", language: "en", theme: "light", phone: false, viewport: { width: 1440, height: 1000 } },
  { name: "zh-390", language: "zh-Hans", theme: "light", phone: true, viewport: { width: 390, height: 844 } },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-collection-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`home-collection-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

/** Elements of `root` past its left or right edge; a carousel's pages scroll inside its track and are not counted, the track is. */
function overflowOf(root) {
  const box = root.getBoundingClientRect();
  const past = [];
  for (const el of root.querySelectorAll("*")) {
    if (el.closest(".brief-carousel-track") && !el.classList.contains("brief-carousel-track")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < box.left - 1 || r.right > box.right + 1) past.push({ el: `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`, left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { left: Math.round(box.left), right: Math.round(box.right), past, sideways: root.scrollWidth > root.clientWidth + 1 };
}

/**
 * Whether every picture in view under `selector` has loaded. Pictures are lazy: those outside the window, and a
 * carousel's pages its track has not scrolled to, load when they come near; only those in view count.
 */
function picturesLoaded(selector) {
  return [...document.querySelectorAll(`${selector} img`)].filter((img) => {
    const r = img.getBoundingClientRect();
    // In the window: a picture far below it loads as it comes near.
    if (r.width === 0 || r.bottom <= 0 || r.top >= innerHeight) return false;
    const track = img.closest(".brief-carousel-track")?.getBoundingClientRect();
    return !track || (r.right > track.left + 1 && r.left < track.right - 1);
  }).every((img) => img.complete && img.naturalWidth > 0);
}

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC", colorScheme: run.theme,
    ...(run.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addInitScript(([language, theme]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    if (!localStorage.getItem("yuzuno.selected.ws-co")) localStorage.setItem("yuzuno.selected.ws-co", JSON.stringify("l"));
  }, [run.language, run.theme]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    // Home records a report the reader opened (project-home-check.mjs answers it the same way); nothing else is written.
    const opened = method === "POST" && path.match(/^\/api\/projects\/([^/]+)\/brief\/opened$/);
    if (opened) {
      const body = JSON.parse(request.postData() || "{}");
      report.opened.push({ run: run.name, key: body.key });
      return route.fulfill({ json: { projectId: PROJECT, sectionId: body.sectionId, key: body.key, version: body.version, at: at(0), recorded: true } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    if (files.has(path)) {
      report.pictures.push(`${run.name} ${path}${url.search}`);
      return route.fulfill({ body: files.get(path), contentType: "image/svg+xml" });
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-co" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
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
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const projectPage = () => page.locator(`[data-project-home="${PROJECT}"]`);
  const cardSelector = (key) => `[data-project-home="${PROJECT}"] [data-section-key="${key}"]`;
  const card = (key) => page.locator(cardSelector(key));
  const shot = async (locator, name) => {
    const file = `${run.name}-${name}.png`;
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const press = async (locator) => (run.phone ? locator.tap() : locator.click());
  try {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    // Home, as home-report-check.mjs reaches it: the toolbar's Home unless Home is already shown; then the
    // project's page from its glance, as project-home-check.mjs opens it on a phone (YN-86).
    const nav = page.locator(".toolbar-nav .catchup-nav").first();
    await nav.waitFor({ timeout: 10_000 });
    if (!(await page.locator(".home-view").isVisible())) await nav.click();
    await page.locator(`[data-glance-project="${PROJECT}"] .project-glance-open`).click();
    await projectPage().waitFor({ timeout: 15_000 });
    await card("news").waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language, "Home in the chosen language");

    // ---- Each card: its Collection under the text, as much as it holds, how many there are, nothing past its edges.
    const cards = {};
    for (const [key, size, layout, drawn, total] of [
      ["news", "wide", "carousel", 6, null],
      ["repos", "wide", "grid", run.phone ? 2 : 3, w.items(9)],
      ["repos-large", "large", "grid", run.phone ? 4 : 6, w.items(9)],
      ["papers", "wide", "list", 3, w.items(14)],
      ["papers-small", "small", "list", 1, w.items(6)],
    ]) {
      const c = card(key);
      await c.locator(".home-card-frame.kind-collection .brief-collection").waitFor({ timeout: 10_000 });
      await c.scrollIntoViewIfNeeded();
      await page.waitForFunction(picturesLoaded, cardSelector(key), { timeout: 10_000 });
      const read = await c.evaluate((el, overflow) => {
        const fn = new Function(`return (${overflow})`)();
        const frame = el.querySelector(".home-card-frame.kind-collection");
        const collection = frame.querySelector(".brief-collection");
        const visible = [...frame.querySelectorAll(".brief-collection-items > li, .brief-carousel-page")].filter((li) => li.getBoundingClientRect().width > 0);
        const text = el.querySelector(".home-summary-text").getBoundingClientRect();
        return { size: el.dataset.cardSize, layout: collection.dataset.layout, face: collection.dataset.face, drawn: visible.length,
          total: frame.querySelector(".brief-collection-total")?.textContent ?? null, under: frame.getBoundingClientRect().top >= text.bottom - 1,
          inert: !!frame.closest("[inert]"), tools: frame.querySelectorAll(".brief-collection-filters, input").length, overflow: fn(el) };
      }, overflowOf.toString());
      assert.equal(read.size, size, key);
      assert.equal(read.layout, layout, key);
      assert.equal(read.face, size, key);
      assert.equal(read.drawn, drawn, `${key}: ${JSON.stringify(read)}`);
      assert.equal(read.total, total, `${key}: ${JSON.stringify(read)}`);
      assert.ok(read.under && !read.inert && read.tools === 0, `${key}: under the text, live, no tools: ${JSON.stringify(read)}`);
      assert.deepEqual(read.overflow.past, [], `${key}: nothing past the card's edges: ${JSON.stringify(read.overflow)}`);
      assert.ok(!read.overflow.sideways, `${key}: ${JSON.stringify(read.overflow)}`);
      cards[key] = read;
      await shot(c, `card-${key}`);
    }
    pass("each card draws its Collection under its text, as much as it holds with how many there are, nothing past its edges", cards);

    // ---- The card's carousel turns by its arrow; a title opens its page in a new window, not in Home.
    const carousel = card("news").locator(".brief-carousel");
    const count = () => carousel.locator(".brief-carousel-count").textContent();
    assert.equal(await count(), "1 / 6");
    await press(carousel.locator(".brief-carousel-move").nth(1));
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "2 / 6", `${cardSelector("news")} .brief-carousel-count`, { timeout: 5000 });
    const link = await card("news").locator(".brief-collection-title a").first().evaluate((a) => ({ target: a.target, rel: a.rel, href: a.href }));
    assert.deepEqual(link, { target: "_blank", rel: "noopener noreferrer", href: "https://example.com/news/0" });
    assert.equal(await page.locator(".home-report").count(), 0, "the arrow opened no report");
    pass("a card's carousel turns by its arrow; a title links to its page in a new window", { link });

    // ---- The report page: every item; a list filtered by tag and searched.
    await press(card("papers").locator(".home-report-open"));
    const reportPage = page.locator(".home-report");
    await reportPage.waitFor({ timeout: 10_000 });
    const list = reportPage.locator('.brief-collection[data-layout="list"]');
    await list.waitFor({ timeout: 10_000 });
    const rows = () => list.locator(".brief-collection-items > li").count();
    assert.equal(await rows(), 14);
    await list.scrollIntoViewIfNeeded();
    await page.waitForFunction(picturesLoaded, ".home-report .brief-collection", { timeout: 10_000 });
    // The section's body on the page, which holds the Collection: nothing in it past its edges.
    const pageOverflow = async () => reportPage.locator(".brief-collection").first().evaluate((el, overflow) => new Function(`return (${overflow})`)()(el.closest(".brief-body")), overflowOf.toString());
    const listOverflow = await pageOverflow();
    assert.deepEqual(listOverflow.past, [], JSON.stringify(listOverflow));
    await shot(list, "report-list");
    await press(list.locator('.brief-collection-filters [data-tag="Agent"]'));
    await page.waitForFunction(() => document.querySelectorAll('.home-report .brief-collection[data-layout="list"] .brief-collection-items > li').length === 6, null, { timeout: 5000 });
    assert.equal(await list.locator(".brief-collection-shown").textContent(), w.shown(6, 14));
    await list.locator(".brief-collection-search input").fill("TOOL");
    await page.waitForFunction(() => document.querySelectorAll('.home-report .brief-collection[data-layout="list"] .brief-collection-items > li').length === 1, null, { timeout: 5000 });
    assert.match(await list.locator(".brief-collection-items > li").first().textContent(), /Self-correcting tool use/);
    await shot(list, "report-list-filtered");
    await press(list.locator(".brief-collection-filters button").first());
    await press(list.locator(".brief-collection-search button"));
    await page.waitForFunction(() => document.querySelectorAll('.home-report .brief-collection[data-layout="list"] .brief-collection-items > li').length === 14, null, { timeout: 5000 });
    await press(reportPage.locator(".report-back"));
    await reportPage.waitFor({ state: "detached", timeout: 10_000 });
    pass("the report page lists every item; a tag filters the list and the search narrows it, in any case", { overflow: listOverflow });

    // ---- A grid's report page: columns of at least 180 px (two on a phone), filtered by tag.
    await press(card("repos").locator(".home-report-open"));
    await reportPage.waitFor({ timeout: 10_000 });
    const grid = reportPage.locator('.brief-collection[data-layout="grid"]');
    await grid.waitFor({ timeout: 10_000 });
    await grid.scrollIntoViewIfNeeded();
    const columns = await grid.locator(".brief-collection-items").evaluate((ul) => getComputedStyle(ul).gridTemplateColumns.split(" ").map((v) => Math.round(parseFloat(v))));
    assert.ok(columns.length >= 2 && (run.phone ? columns.length === 2 : columns.every((c) => c >= 180)), JSON.stringify(columns));
    await page.waitForFunction(picturesLoaded, ".home-report .brief-collection", { timeout: 10_000 });
    const gridOverflow = await pageOverflow();
    assert.deepEqual(gridOverflow.past, [], JSON.stringify(gridOverflow));
    await shot(grid, "report-grid");
    await press(grid.locator('.brief-collection-filters [data-tag="Data"]'));
    await page.waitForFunction(() => document.querySelectorAll('.home-report .brief-collection[data-layout="grid"] .brief-collection-items > li').length === 4, null, { timeout: 5000 });
    assert.equal(await grid.locator(".brief-collection-search").count(), 0, "a grid has no search");
    await press(reportPage.locator(".report-back"));
    await reportPage.waitFor({ state: "detached", timeout: 10_000 });
    pass("a grid's report page has columns of at least 180 px (two on a phone) and filters by tag", { columns, overflow: gridOverflow });

    // ---- A carousel's report page: larger pages; → turns it while focus is in it.
    await press(card("news").locator(".home-report-open"));
    await reportPage.waitFor({ timeout: 10_000 });
    const onPage = reportPage.locator(".brief-carousel");
    await onPage.waitFor({ timeout: 10_000 });
    await onPage.locator(".brief-carousel-track").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".home-report .brief-carousel-count")?.textContent === "2 / 6", null, { timeout: 5000 });
    await page.waitForTimeout(600);
    const turned = await onPage.evaluate((el) => {
      const track = el.querySelector(".brief-carousel-track");
      const pages = [...track.querySelectorAll(".brief-carousel-page")];
      return { scrollLeft: Math.round(track.scrollLeft), second: Math.round(pages[1].offsetLeft), pageWidth: Math.round(pages[0].getBoundingClientRect().width), trackWidth: Math.round(track.clientWidth) };
    });
    assert.ok(Math.abs(turned.scrollLeft - turned.second) <= 2, `→ scrolled to the second page: ${JSON.stringify(turned)}`);
    assert.ok(turned.pageWidth < turned.trackWidth, `the next page's edge shows: ${JSON.stringify(turned)}`);
    await page.waitForFunction(picturesLoaded, ".home-report .brief-carousel", { timeout: 10_000 });
    const carouselOverflow = await pageOverflow();
    assert.deepEqual(carouselOverflow.past, [], JSON.stringify(carouselOverflow));
    await shot(onPage, "report-carousel");
    await press(reportPage.locator(".report-back"));
    await reportPage.waitFor({ state: "detached", timeout: 10_000 });
    pass("a carousel's report page shows larger pages, the next one's edge, and → turns it", { turned, overflow: carouselOverflow });

    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    await page.screenshot({ path: join(output, `${run.name}-home.png`), fullPage: true });
    result.shots.push(`${run.name}-home.png`);
    pass("nothing wider than the window", widths);
  } catch (error) {
    // What the page showed when a check failed, for whoever reads the report.
    await page.screenshot({ path: join(output, `${run.name}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}
