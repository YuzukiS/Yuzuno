// T-197: Home's Brief cards line up, in Chromium on a production build with
// every API answered here (no Core, no GitHub).
// A root topic with its sub-topics, a sub-topic whose topic has no card, and
// several such, on a wide window, either side of the 520 px rule, a 320 px
// phone, at 16 and 24 px text, expanded, folded and after a reload:
// - every Brief card shares one left and one right edge (to a pixel);
// - nothing scrolls sideways;
// - the topics keep their grouping and order, and each card folds on its own
//   and stays folded;
// - on a sub-card, its controls are where a tap reaches them, an Ask's draft
//   outlives a fold, and Reply opens;
// - Seen is the only write Home makes (the app's reading handoff for a
//   conversation is answered and counted apart);
// - a pinned sub-card's widget is not drawn as a sub-card.
// Each alignment case is checked and each failure listed (FAIL <case>), so on
// a build with the old indent exactly its offsets show.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-brief-align-check.mjs
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
const report = { task: "T-197", source: process.env.T197_HEAD || null, checks: [], cases: [], alignFailures: [], writes: [], readingHandoff: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-brief-align.test";

// ---------------------------------------------------------------- fixture
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
let id = 0;
const section = (key, kind, title, text, extra = {}) => ({ id: ++id, key, kind, title, version: 1, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: ago(5), updatedTurnId: "t1", body: markdown(text), attachments: [], refs: {}, seen: null, history: false, ...extra });
// The topics as an Agent may write them: a root with sub-topics, a sub-topic
// alone, two sub-topics without their root, and a card of its own.
const sections = [
  section("development", "report", "Development", "Where development stands. ".repeat(6)),
  section("development/merge-queue", "status", "Merge queue", "Batch 2 is running. ".repeat(4), { status: { asOf: ago(5), validFor: 86400, stale: false } }),
  section("development/ship", "ask", "Ship batch 2?", "The batch is green.", {
    ask: { question: "Ship batch 2 today?", state: "open", reply: { options: [{ id: "yes", label: "Ship" }, { id: "no", label: "Wait" }], freeText: true } } }),
  section("notes/review", "report", "Review notes", "A sub-topic whose topic has no card. ".repeat(3)),
  section("ops/deploy", "report", "Deploy", "Two sub-topics whose topic has no card. ".repeat(3)),
  section("ops/backup", "report", "Backup", "The second of them. ".repeat(4)),
  section("progress", "report", "Progress", "A card of its own. ".repeat(5)),
];
const keys = sections.map((s) => s.key);
const home = () => ({
  generatedAt: ago(0),
  order: ["p1"],
  needsYou: [{ kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "development/ship", title: "Ship batch 2?", since: ago(20) }],
  projects: [{
    project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [],
    brief: { version: 3, history: [], sections, teamSections: [] },
  }],
});
const machineLoad = { at: ago(0), cpu: { cores: 8, totalPct: 20, jobsPct: 5, agentsPct: null, otherPct: null },
  memory: { totalMiB: 32768, usedMiB: 9000, availableMiB: 23768, jobsMiB: 0, agentsMiB: null }, gpus: null, jobs: [] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function open(viewport, fontSize, label) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((fontSize) => {
    window.EventSource = class { close() {} };
    // Once: a reload keeps what the page stored since (folds, pins, drafts).
    if (sessionStorage.getItem("t197-seeded")) return;
    sessionStorage.setItem("t197-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize, palette: "garden" }));
  }, fontSize);
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    // The app's reading handoff for a conversation (T-170): answered, and
    // counted apart from Home's own writes.
    if (path === "/api/agents/a/reading") {
      if (method !== "GET") report.readingHandoff.push({ case: label, method });
      return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    }
    if (method !== "GET") {
      report.writes.push({ case: label, method, path });
      return route.fulfill({ json: {} });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-align" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
      "/api/home": home(), "/api/machine-load": machineLoad,
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  await page.goto(`https://${HOST}/`);
  await toHome(page);
  return { context, page };
}
/** Home, with every Brief card shown (the brief may be capped). */
async function toHome(page) {
  await page.locator(".toolbar-nav .catchup-nav").first().waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await page.locator(".toolbar-nav .catchup-nav").first().click();
  await card(page, "progress").waitFor({ timeout: 10_000 });
  const more = page.locator(".home-view .home-more");
  if ((await more.count()) && /Show more/.test(await more.first().innerText())) await more.first().click();
  await page.waitForTimeout(200);
}
const card = (page, key) => page.locator(`.home-view .home-main [data-section-key="${key}"]`);

/** Every Brief card's box, the grouping as drawn, and what scrolls sideways. */
const layout = (page) => page.evaluate(() => {
  const brief = document.querySelector(".home-view .home-main .home-brief");
  const cards = [...brief.querySelectorAll(".home-section")].map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.sectionKey, left: r.left, right: r.right, sub: el.classList.contains("is-sub"), collapsed: el.classList.contains("is-collapsed") };
  });
  const topics = [...brief.querySelectorAll(":scope > .home-topic")].map((topic) => ({
    topic: topic.dataset.topic,
    heading: topic.querySelector(":scope > .home-topic-name")?.textContent ?? null,
    parent: topic.querySelector(":scope > .home-section")?.dataset.sectionKey ?? null,
    subs: [...topic.querySelectorAll(":scope > .home-subs > .home-section")].map((el) => el.dataset.sectionKey),
  }));
  return {
    cards, topics,
    sideways: { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, brief: brief.scrollWidth - brief.clientWidth },
  };
});

/** Alignment: every card's left and right within a pixel of the first's. */
function alignment(l) {
  const [first] = l.cards;
  return l.cards.map((c) => ({ key: c.key, left: Math.round((c.left - first.left) * 10) / 10, right: Math.round((c.right - first.right) * 10) / 10 }))
    .filter((c) => Math.abs(c.left) > 1 || Math.abs(c.right) > 1);
}
const expectedTopics = [
  { topic: "development", heading: null, parent: "development", subs: ["development/merge-queue", "development/ship"] },
  { topic: "notes", heading: null, parent: "notes/review", subs: [] },
  { topic: "ops", heading: "Ops", parent: null, subs: ["ops/deploy", "ops/backup"] },
  { topic: "progress", heading: null, parent: "progress", subs: [] },
];

async function measure(page, label, state) {
  const l = await layout(page);
  const off = alignment(l);
  report.cases.push({ case: label, state, sideways: l.sideways, offsets: off, edges: l.cards.map((c) => ({ key: c.key, left: Math.round(c.left), right: Math.round(c.right), sub: c.sub, collapsed: c.collapsed })) });
  await page.screenshot({ path: resolve(output, `${label.replace(/[^a-z0-9]+/gi, "-")}-${state}.png`), fullPage: true });
  assert.deepEqual(l.cards.map((c) => c.key), keys, `${label}, ${state}: every card, in order`);
  assert.deepEqual(l.topics.map((t) => ({ ...t, heading: t.heading && t.heading.trim() })), expectedTopics, `${label}, ${state}: the grouping`);
  assert.ok(l.sideways.page <= 1 && l.sideways.brief <= 1, `${label}, ${state}: nothing scrolls sideways ${JSON.stringify(l.sideways)}`);
  if (off.length) {
    const message = `${label}, ${state}: card edges differ from the first's by ${JSON.stringify(off)}`;
    report.alignFailures.push({ case: label, state, offsets: off });
    console.log(`FAIL ${label}, ${state}: ${JSON.stringify(off)}`);
    return message;
  }
  return null;
}

const viewports = [
  { name: "wide", width: 1440, height: 900, touch: false, font: 16 },
  { name: "wide", width: 1440, height: 900, touch: false, font: 24 },
  { name: "above 520", width: 521, height: 900, touch: true, font: 16 },
  { name: "at 520", width: 520, height: 900, touch: true, font: 16 },
  { name: "phone", width: 320, height: 640, touch: true, font: 16 },
  { name: "phone", width: 320, height: 640, touch: true, font: 24 },
];

/** The header controls on a sub-card, each where a tap at its centre reaches it. */
const reachable = (page, key) => card(page, key).evaluate((el) => [...el.querySelectorAll(".home-section-head button, .home-fold, .home-reply-open, .home-pin, .home-seen")]
  .filter((b, i, all) => all.indexOf(b) === i && b.getClientRects().length)
  .map((b) => {
    b.scrollIntoView({ block: "nearest" });
    const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { name: b.getAttribute("aria-label") || b.textContent.trim(), reached: !!hit && (hit === b || b.contains(hit)) };
  }));

const failed = [];
try {
  for (const viewport of viewports) {
    const label = `${viewport.name} ${viewport.width}×${viewport.height}, ${viewport.font} px`;
    const { context, page } = await open(viewport, viewport.font, label);
    try {
      const misses = [];
      misses.push(await measure(page, label, "expanded"));
      // The root and a sub-topic folded: each folds on its own.
      await card(page, "development").locator(".home-fold").click();
      await card(page, "ops/backup").locator(".home-fold").click();
      await page.waitForTimeout(150);
      assert.equal(await card(page, "development").locator(".home-card-body").isVisible(), false, `${label}: the root folded`);
      assert.equal(await card(page, "development/merge-queue").locator(".home-card-body").isVisible(), true, `${label}: its sub-topic did not`);
      assert.equal(await card(page, "ops/deploy").locator(".home-card-body").isVisible(), true, `${label}: the other sub-topic did not`);
      misses.push(await measure(page, label, "folded"));
      // As left: after a reload, still folded.
      await page.reload();
      await toHome(page);
      assert.equal(await card(page, "development").locator(".home-card-body").isVisible(), false, `${label}: still folded after a reload`);
      assert.equal(await card(page, "ops/backup").locator(".home-card-body").isVisible(), false, `${label}: still folded after a reload`);
      misses.push(await measure(page, label, "reloaded"));
      await card(page, "development").locator(".home-fold").click();
      await card(page, "ops/backup").locator(".home-fold").click();
      // A sub-card's controls, its Ask's draft through a fold, and Reply.
      const controls = [...(await reachable(page, "development/ship")), ...(await reachable(page, "ops/deploy")), ...(await reachable(page, "development/merge-queue"))];
      report.cases.push({ case: label, state: "controls", controls });
      assert.ok(controls.length >= 6 && controls.every((c) => c.reached), `${label}: sub-card controls reached ${JSON.stringify(controls)}`);
      const draft = card(page, "development/ship").locator("textarea").first();
      await draft.fill("Ship after the batch CI");
      await card(page, "development/ship").locator(".home-fold").click();
      await card(page, "development/ship").locator(".home-fold").click();
      assert.equal(await draft.inputValue(), "Ship after the batch CI", `${label}: the Ask's draft outlives a fold`);
      await card(page, "ops/deploy").locator(".home-reply-open").click();
      await card(page, "ops/deploy").locator("textarea").first().waitFor({ timeout: 5000 });
      assert.deepEqual(report.writes.filter((w) => w.case === label), [], `${label}: folding, drafting and opening Reply write nothing`);
      // Seen on a sub-card: the one write.
      await card(page, "ops/backup").locator(".home-seen").click();
      await page.waitForTimeout(200);
      assert.deepEqual(report.writes.filter((w) => w.case === label).map((w) => w.path), ["/api/projects/p1/brief/seen"], `${label}: Seen is the only write`);
      // On the wide window, a sub-card pinned: its widget is not a sub-card.
      if (viewport.width >= 1440) {
        await card(page, "development/merge-queue").getByRole("button", { name: "Pin “Merge queue” to Widgets" }).click();
        const pinned = page.locator(".home-widget-column .home-pinned").first();
        await pinned.waitFor({ timeout: 5000 });
        const widget = await pinned.evaluate((el) => ({
          inSubs: !!el.closest(".home-subs"), sub: !!el.querySelector(".is-sub") || el.classList.contains("is-sub"),
          border: getComputedStyle(el).borderLeftWidth,
        }));
        report.cases.push({ case: label, state: "pinned", widget });
        assert.deepEqual({ inSubs: widget.inSubs, sub: widget.sub }, { inSubs: false, sub: false }, `${label}: the widget is not drawn as a sub-card`);
        assert.equal(report.writes.filter((w) => w.case === label).length, 1, `${label}: pinning writes nothing`);
        await page.screenshot({ path: resolve(output, `${label.replace(/[^a-z0-9]+/gi, "-")}-pinned.png`) });
      }
      const miss = misses.filter(Boolean);
      if (miss.length) failed.push(...miss);
      else check(`${label}: every Brief card on one pair of edges, expanded, folded and reloaded; grouping, folds, controls, draft, Reply, Seen${viewport.width >= 1440 ? ", Pin" : ""}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 1));
}
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.unexpected, [], "no other host");
assert.deepEqual(failed, [], "every card on one pair of edges");
