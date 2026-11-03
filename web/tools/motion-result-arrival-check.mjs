// T-19, an interactive result taking its placeholder's place (F3 + M9: HM:I5), in Chromium on a
// production build of the app with a synthetic Workspace and a stand-in event stream this check
// speaks for Core (no Core, no Agent).
// - As a conversation opens, a published result read then, and a result in a reply drawn while the
//   renderer is still loading, each show their placeholder; then the result takes its place and fades
//   in over small, opacity only.
// - A result block streamed in a running Turn shows its placeholder while it is written; once whole,
//   the result takes its place and fades in.
// - After a switch to another Agent and back, both results are drawn from the first frame they show:
//   no placeholder stands in for them (none painted, and none put in the page, which a MutationObserver
//   from the document's start records) and nothing fades.
// - Under reduced motion nothing fades.
// Writes: only the app's own saves of where an Agent was read; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-result-arrival-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-result-arrival");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: [], resultReads: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name, status = "idle") => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status, createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected", threadId: `th-${id}` });
const spec = (title, text) => JSON.stringify({ root: "result", elements: {
  result: { type: "Result", props: { title, summary: "Three changes this week." }, children: ["body"] },
  body: { type: "Text", props: { text } },
} });
const block = (title, text) => `Here is the summary.\n\n\`\`\`yuzuno-ui\n${spec(title, text)}\n\`\`\`\n`;
// A block still being written: the fence is not closed yet.
const unfinished = `Here is the table.\n\n\`\`\`yuzuno-ui\n{"root": "result", "elements": {`;
const user = (id, text) => ({ id, type: "userMessage", content: [{ type: "text", text }] });
const answer = (id, text) => ({ id, type: "agentMessage", text });
let state;
const fresh = () => ({
  streamed: false,
  turns: () => [
    { id: "t1", status: "completed", items: [user("u1", "What changed this week?"), answer("m1", block("Weekly notes", "Search, export and sign-in."))],
      _yuzunoResults: [{ id: "r1", chainId: "c1", version: 1, createdAt: "2026-11-03T09:00:00Z" }] },
    { id: "t2", status: "inProgress", items: [user("u2", "And the table?"),
      answer("m2", state.streamed ? block("Changes", "Three rows.") : unfinished)] },
  ],
});
const published = { id: "r1", spec: JSON.parse(spec("Published notes", "Read with the result tool.")) };
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const agents = [agent("a", "Mori", "working"), agent("b", "Iris")];
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/agents/a/codex/usage": usage, "/api/agents/b/codex/usage": usage, "/api/agents/a/codex/mcp": mcp, "/api/agents/b/codex/mcp": mcp,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: [], artifacts: [], turns: state.turns(), messageReceipts: [] },
  "/api/agents/b": { agent: agents[1], pending: [], artifacts: [], turns: [{ id: "b1", status: "completed", items: [user("bu1", "Hello"), answer("bm1", "Hello back.")] }], messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null }, "/api/agents/b/reading": { handoff: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const later = (ms) => new Promise((done) => setTimeout(done, ms));
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  // Core has the whole block now: its next read gives it, and then the stream says so.
  if (url.pathname === "/__check/stream") {
    state.streamed = true;
    return route.fulfill({ json: {} });
  }
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) {
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (url.pathname === "/api/agents/a/results/r1") {
      // Read the first time it is shown; it takes a moment.
      report.resultReads.push(url.pathname);
      await later(400);
      return route.fulfill({ json: published });
    }
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/agents\/[^/]+\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  // The result renderer takes a moment to arrive, as on a slow connection.
  if (basename(path).startsWith("InteractiveResult-")) await later(400);
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page, from the first script on: the event stream, spoken for Core by this check (a fresh
 * connection starts with `reset`, as events.rs does); and each frame, the results and their
 * placeholders. */
function pageHelpers() {
  let id = 0;
  const streams = [];
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      streams.push(this);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  // Core streams the reply's Item, its block now whole.
  window.__stream = async (item) => {
    await fetch("/__check/stream");
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "agent.item", agentId: "a", rev: 100 + id, turnId: "t2", item }), lastEventId: String(++id) });
  };
  const frame = (el) => {
    if (!el) return null;
    const animations = el.getAnimations();
    return { opacity: Number(getComputedStyle(el).opacity), animations: animations.length,
      duration: animations[0]?.effect?.getComputedTiming().duration ?? null };
  };
  const placeholder = (scope, words) => [...document.querySelectorAll(`${scope} .result-placeholder`)].some((p) => p.textContent.includes(words));
  const frames = [];
  window.__frames = frames;
  window.__now = () => frames.length;
  // Every placeholder put in the page, painted or not, with the frame it was put in at: a frame can
  // miss one that a later commit took out before the next paint.
  const placed = [];
  window.__placed = placed;
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const found = node.matches(".result-placeholder") ? [node] : [...node.querySelectorAll(".result-placeholder")];
        for (const p of found) placed.push({ at: frames.length, published: !!p.closest(".turn-results"), text: p.textContent.trim() });
      }
  }).observe(document, { childList: true, subtree: true });
  const step = () => {
    frames.push({
      // The published result, and its placeholder in the Turn's results.
      published: frame(document.querySelector('.turn-results .interactive-result[data-result-id="r1"]')),
      publishedWaits: placeholder(".turn-results", "Loading interactive result"),
      // The result in the first reply, and the renderer's placeholder in a reply.
      reply: frame(document.querySelector('.interactive-result[data-result-id=\'["a","t1","m1"]\']')),
      replyWaits: [...document.querySelectorAll(".result-placeholder")].some((p) => !p.closest(".turn-results") && p.textContent.includes("Loading interactive result")),
      // The block streamed in the running Turn, and its placeholder while it is written.
      streamed: frame(document.querySelector('.interactive-result[data-result-id=\'["a","t2","m2"]\']')),
      streamedWaits: placeholder("", "Generating interactive result"),
    });
    if (frames.length < 20_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** What came in, from its first frame: a fade over small under normal motion, at once under reduced. */
function came(frames, reduced) {
  const shown = frames.filter(Boolean);
  if (!shown.length) return false;
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => f.opacity === 1 && f.animations === 0);
  return shown[0].opacity < 1 && shown[0].animations === 1 && Math.abs((shown[0].duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.animations === 0;
}
/** Drawn as it is from its first frame: no fade. */
const still = (frames) => frames.filter(Boolean).length > 0 && frames.filter(Boolean).every((f) => f.opacity === 1 && f.animations === 0);
/** The frames of `part` from the first frame it shows, and whether its placeholder showed before it. */
function after(frames, part) {
  const first = frames.findIndex((f) => f[part]);
  return { waited: first > 0 && frames.slice(0, first).some((f) => f[`${part}Waits`]), shown: first < 0 ? [] : frames.slice(first, first + 30).map((f) => f[part]) };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  state = fresh();
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const placedSince = (from) => page.evaluate((from) => window.__placed.filter((p) => p.at >= from), from);
  /** Opens an Agent's conversation from the list, as the user does. */
  const open = async (name) => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click({ timeout: 10_000 });
  };
  const bothShown = () => page.locator('.turn-results .interactive-result[data-result-id="r1"]').waitFor({ timeout: 10_000 })
    .then(() => page.locator('.interactive-result[data-result-id=\'["a","t1","m1"]\']').waitFor({ timeout: 10_000 }));
  try {
    await page.goto("http://127.0.0.1:4321/");
    await page.locator(".agent-row").first().waitFor({ timeout: 10_000 });
    // A phone keeps the conversation behind the list: open it unless it shows.
    if (!(await page.locator(".turn-results").first().isVisible())) await open("Mori");
    await bothShown();
    await page.locator(".result-placeholder", { hasText: "Generating interactive result" }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const opening = await framesSince(0);
    const published = record("published, as the conversation opens", after(opening, "published"));
    const reply = record("in a reply, as the conversation opens", after(opening, "reply"));
    ok(`${tag}: a published result read as its conversation opens: its placeholder shows, then the result takes its place and fades in over small; under reduced motion it is there at once`,
      published.waited && came(published.shown, reduced), { waited: published.waited, first: published.shown.slice(0, 3), last: published.shown.at(-1) });
    ok(`${tag}: a result in a reply drawn while the renderer loads: its placeholder shows, then the result takes its place and fades in over small; under reduced motion it is there at once`,
      reply.waited && came(reply.shown, reduced), { waited: reply.waited, first: reply.shown.slice(0, 3), last: reply.shown.at(-1) });

    // The block in the running Turn is now whole: Core streams its Item.
    const before = await page.evaluate(() => window.__now());
    await page.evaluate((item) => window.__stream(item), answer("m2", block("Changes", "Three rows.")));
    await page.locator('.interactive-result[data-result-id=\'["a","t2","m2"]\']').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const streamed = record("streamed", after(await framesSince(before), "streamed"));
    ok(`${tag}: a result streamed in a running Turn: its placeholder stands while the block is written, then the result takes its place and fades in over small; under reduced motion it is there at once`,
      streamed.waited && came(streamed.shown, reduced), { waited: streamed.waited, first: streamed.shown.slice(0, 3), last: streamed.shown.at(-1) });

    // To another Agent and back: both results were read in this window.
    await open("Iris");
    await page.getByText("Hello back.").first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    const away = await page.evaluate(() => window.__now());
    await open("Mori");
    await bothShown();
    await page.waitForTimeout(500);
    const back = await framesSince(away);
    const putBack = record("placeholders put in the page, back", await placedSince(away));
    const publishedBack = record("published, back", after(back, "published"));
    const replyBack = record("in a reply, back", after(back, "reply"));
    // None painted, and none put in the page at all.
    const publishedWaited = back.some((f) => f.publishedWaits) || putBack.some((p) => p.published);
    ok(`${tag}: back from another Agent: the published result is drawn from the first frame it shows, with no placeholder before it, and does not fade`,
      !publishedWaited && still(publishedBack.shown), { placeholder: publishedWaited, placed: putBack, first: publishedBack.shown.slice(0, 3) });
    const replyWaited = back.some((f) => f.replyWaits) || putBack.some((p) => !p.published && p.text.includes("Loading interactive result"));
    ok(`${tag}: back from another Agent: the result in the reply is drawn from the first frame it shows, with no placeholder before it, and does not fade`,
      !replyWaited && still(replyBack.shown), { placeholder: replyWaited, placed: putBack, first: replyBack.shown.slice(0, 3) });
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but where an Agent was read (PUT .../reading, ${report.readingSaves.length}); the published result was read once in each run (${report.resultReads.length})`,
  report.writes.length === 0 && report.resultReads.length === runs.length, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-result-arrival-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
