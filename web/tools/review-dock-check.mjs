// T-25: a conversation's PR reviews on its work dock, in Chromium on a production build of the app with a
// synthetic Workspace and every API answered here (no Core, no Agent, no reviewer).
// - Appear: with a review round preparing on the Agent's PR and an earlier one that requested changes, the
//   dock shows a "PR reviews" group after Local jobs and GitHub Actions, in view, the round still going
//   first, each named by its PR and round, with its state in words and, once ended, how many findings.
// - Follow: Core says a review changed (workspace.changed, the jobs scope, as Core's announce sends it):
//   the dock reads its reviews again, and the round goes preparing, reviewing, then no actionable
//   findings, the only state marked passed. Nothing plays on its entries as they change but what every
//   dock entry already does (T-19 1a, CV:WD-05): the mark's colour eases to its new state's, a running mark
//   turns, and a mark whose run ends settles once; no entrance or replay, and an ended entry is still once
//   it has settled; and nothing is read again without such an event (no timer).
// - Open: the entry opens the Jobs panel's Reviews on that round, in its task, as the panel's own link does.
// Desktop (motion and reduced motion) and a phone, where the dock is behind its button.
// Writes: none; anything but a GET is refused and counted. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/review-dock-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/review-dock");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], reads: {}, frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1" };
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const turns = Array.from({ length: 3 }, (_, i) => ({ id: `t${i + 1}`, status: "completed", items: [
  { id: `u${i + 1}`, type: "userMessage", content: [{ type: "text", text: `Turn ${i + 1}: open the PR for review` }] },
  { id: `r${i + 1}`, type: "agentMessage", text: `Turn ${i + 1}: the PR is linked to its task; the Lead starts its review.` },
] }));
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };
const job = { id: "job-1", requestId: "r", name: "web tests", taskRef: "T-1", agentId: "a", agent: { name: "Mori" }, machine: { name: "lab-host" },
  status: "succeeded", reserved: false, reason: "success", resources: { cpuMillis: 2000, memoryMiB: 4096, swapMiB: 0 },
  reservation: { cpuMillis: 2100, memoryMiB: 4160, swapMiB: 0 }, cwd: "/fixture", env: {}, argv: ["/bin/true"], outputs: [], usage: null,
  createdAt: ago(900_000), startedAt: ago(890_000), finishedAt: ago(800_000), cursor: 3 };
const run = { id: "github:1:42:1", name: "CI", repository: "o/r", runId: "42", attempt: "1", headSha: "b".repeat(40), status: "passed",
  rawStatus: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/42/attempts/1", observedAt: ago(60_000),
  createdAt: ago(700_000), startedAt: ago(690_000), updatedAt: ago(600_000), cursor: 1 };
/** A review row as Core's /api/reviews gives it. */
const review = (id, patch) => ({ id, taskId: "task-one", taskRef: "T-1", taskTitle: "Deliver PR", linkId: "1:pull:7", repository: "o/r", number: 7,
  url: "https://github.com/o/r/pull/7", round: 1, status: "completed", phase: "completed", conclusion: "no_findings", requestedHarness: "claude",
  requestedModel: "test-model", actualHarness: "claude", actualModel: "test-model", baseSha: "a".repeat(40), headSha: "b".repeat(40),
  mergeBaseSha: "c".repeat(40), createdAt: ago(3_600_000), finishedAt: ago(3_000_000), error: null,
  requestedBy: { kind: "agent", id: "lead", name: "Lead" }, findingsCount: 0, outdated: false, cursor: 1, policyVersion: 3, reasonCodes: [], ...patch });
// The round on Mori's PR as Core sees it at each stage; round 1 ended earlier with changes requested.
let stage = 0;
const reviews = () => [
  review("round-2", { round: 2, cursor: 2, createdAt: ago(120_000),
    ...[{ status: "preparing", phase: "Fetching fixed PR revision", conclusion: "unknown", finishedAt: null },
      { status: "running", phase: "Reviewing", conclusion: "unknown", finishedAt: null },
      { status: "completed", phase: "completed", conclusion: "no_findings", finishedAt: ago(5_000) }][stage] }),
  review("round-1", { conclusion: "changes_requested", findingsCount: 3 }),
];
const page = (list) => ({ reviews: list, hasMore: false, nextBefore: null });
const gets = () => ({
  "/api/workspace": { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 1 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": detail,
  "/api/updates": unmanagedUpdates,
  "/api/jobs/budget": idleJobsBudget,
  "/api/jobs/live": noLiveJobs,
  "/api/jobs": { jobs: [job], liveJobs: [], hasMore: false, nextBefore: null },
  "/api/ci": { runs: [run], subscriptions: [], hasMore: false, nextBefore: null },
  "/api/ci/live": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
  "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route, tag) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() !== "GET") {
      report.writes.push(`${tag}: ${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (url.pathname === "/api/reviews") {
      const key = `${tag}: ${url.search || "?"}`;
      report.reads[key] = (report.reads[key] ?? 0) + 1;
      const q = url.searchParams;
      if (q.get("involving") === "a") return route.fulfill({ json: page(reviews()) });
      if (q.get("taskId") === "task-one" && q.get("reviewId")) return route.fulfill({ json: page(reviews().filter((r) => r.id === q.get("reviewId"))) });
      return route.fulfill({ json: page(reviews()) });
    }
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/agents\/[^/]+\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    return route.fulfill({ json: known ?? {} });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page from its first script: the event stream, spoken for Core here; and each frame, the dock's
 * review entries (their names, states and words, and whether anything plays on them). */
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
  // What Core's announce() sends when a review changes.
  window.__reviewChanged = () => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "jobs" }), lastEventId: String(++id) });
  };
  const frames = [];
  window.__frames = frames;
  window.__now = () => frames.length;
  const step = () => {
    const group = document.querySelector('.work-dock [role="group"][aria-label="PR reviews"]');
    frames.push(group ? [...group.querySelectorAll(".conversation-review")].map((el) => ({
      name: el.querySelector(".work-dock-label strong")?.textContent ?? null,
      state: [...el.classList].find((c) => c.startsWith("state-")) ?? null,
      text: el.textContent,
      // What plays on it and inside it, its marks' pseudo-elements included: a CSS transition by its property,
      // a CSS animation by its name, anything else as script, by its id where it has one.
      playing: el.getAnimations({ subtree: true }).map((a) => typeof CSSTransition !== "undefined" && a instanceof CSSTransition ? `transition:${a.transitionProperty}`
        : typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation ? `animation:${a.animationName}` : a.id ? `script:${a.id}` : "script"),
    })) : null);
    if (frames.length < 20_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
];
for (const r of runs) {
  const tag = r.name;
  stage = 0;
  const context = await browser.newContext({ viewport: r.viewport, reducedMotion: r.reducedMotion, locale: "en-US",
    hasTouch: !!r.phone, isMobile: !!r.phone, deviceScaleFactor: r.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", (route) => serve(route, tag));
  await page.addInitScript(() => localStorage.setItem("yuzuno.selected.ws", JSON.stringify("a")));
  await page.addInitScript(pageHelpers);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const reads = () => report.reads[`${tag}: ?involving=a`] ?? 0;
  const group = page.locator('.work-dock [role="group"][aria-label="PR reviews"]');
  /** The last frame's entries, once `test` holds for them. */
  const settled = async (test, label) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const last = await page.evaluate(() => window.__frames.at(-1));
      if (last && test(last)) return last;
      if (Date.now() > deadline) throw new Error(`${label}: not reached; last ${JSON.stringify(last)}`);
      await page.waitForTimeout(50);
    }
  };
  try {
    await page.goto("http://127.0.0.1:4331/");
    // A phone opens on the Agent list: the conversation first, then its work dock from its button.
    if (r.phone) await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click({ timeout: 10_000 });
    await page.locator('[data-composer-input][aria-label="Message Mori"]').waitFor({ timeout: 10_000 });
    if (r.phone) await page.getByRole("button", { name: "Jobs, CI, reviews and sub-agents", exact: true }).click();
    await group.waitFor({ timeout: 10_000 });
    // Appear.
    const first = await settled((f) => f.length === 2, "two entries");
    const order = await page.evaluate(() => [...document.querySelectorAll('.work-dock [role="group"]')].map((g) => g.getAttribute("aria-label")));
    const seen = await group.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 12), box.top + Math.min(box.height / 2, 12));
      return { shown: el.checkVisibility(), inWindow: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, hit: !!hit && el.contains(hit) };
    });
    ok(`${tag}: the Agent's PR reviews are a group of the work dock, after Local jobs and GitHub Actions, shown and in view (${order.join(", ")})`,
      order.join("|") === "Local jobs|GitHub Actions|PR reviews" && seen.shown && seen.inWindow && seen.hit, { order, seen });
    ok(`${tag}: the round still going comes first, then the latest ended; each named by its PR and round, its state in words, an ended one with its findings`,
      first[0].name === "PR #7 · round 2" && first[0].state === "state-pending" && /Preparing/.test(first[0].text)
        && first[1].name === "PR #7 · round 1" && first[1].state === "state-rejected" && /Changes requested · 3 findings/.test(first[1].text), first);
    await page.screenshot({ path: join(output, `${tag}-appear.png`) });
    // No timer: nothing is read again until Core says something changed.
    const before = reads();
    await page.waitForTimeout(4000);
    ok(`${tag}: without an event from Core the dock reads its reviews no more (${reads() - before} reads in 4 s)`, reads() === before, { before, after: reads() });
    // Follow, through Core's change events.
    const from = await page.evaluate(() => window.__now());
    stage = 1;
    await page.evaluate(() => window.__reviewChanged());
    const running = await settled((f) => f[0]?.state === "state-running", "reviewing");
    stage = 2;
    await page.evaluate(() => window.__reviewChanged());
    const ended = await settled((f) => f[0]?.state === "state-passed", "passed");
    await page.waitForTimeout(600);
    const followed = record("follow", await framesSince(from));
    ok(`${tag}: Core says the review changed, and the dock reads again: preparing, then reviewing, then no actionable findings, marked passed`,
      /Reviewing/.test(running[0].text) && /No actionable findings/.test(ended[0].text) && ended[0].name === "PR #7 · round 2" && reads() === before + 2,
      { running: running[0], ended: ended[0], reads: reads() - before });
    // Only what every dock entry does (T-19 1a): its colour eases to the new state's; a running mark turns; and
    // since CV:WD-05 a mark whose run ends settles once, its fill fading in and, passed, a small spring (WorkDock.tsx).
    const allowed = (e, n) => n === "transition:color" || (n === "animation:spin" && e.state === "state-running")
      || (/^script:dock-settle-(fill|spring)$/.test(n) && e.state === "state-passed");
    const shown = followed.filter(Boolean);
    const extra = shown.flatMap((f) => f.flatMap((e) => e.playing.filter((n) => !allowed(e, n))));
    const endedStill = shown.slice(-10).every((f) => f.every((e) => e.playing.length === 0));
    ok(`${tag}: nothing plays on the review entries as they change but what every dock entry does (its colour eases to its new state's, a running mark turns, an ended one settles once): no entrance or replay; an ended entry is still, and the earlier round stays as it was (T-19)`,
      extra.length === 0 && endedStill && shown.every((f) => f[1]?.state === "state-rejected") && shown.every((f) => f[1]?.playing.length === 0),
      { extra: [...new Set(extra)], endedStill, frames: followed.length,
        kinds: [...new Set(shown.flatMap((f) => f.flatMap((e) => e.playing)))], spinning: shown.filter((f) => f[0]?.playing.includes("animation:spin")).length });
    await page.screenshot({ path: join(output, `${tag}-ended.png`) });
    // Open.
    await group.locator(".conversation-review").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".review-jobs .job-detail h3").waitFor({ timeout: 10_000 });
    const opened = await dialog.evaluate((el) => ({ detail: el.querySelector(".review-jobs .job-detail")?.textContent ?? "",
      scope: el.querySelector(".job-task-scope")?.textContent ?? null }));
    ok(`${tag}: the entry opens the Jobs panel's Reviews on that round, in its task`,
      /Round 2/.test(opened.detail) && /No actionable findings/.test(opened.detail) && opened.scope === "Task task-one"
        && (report.reads[`${tag}: ?taskId=task-one&reviewId=round-2`] ?? 0) >= 1, { scope: opened.scope, detail: opened.detail.slice(0, 200) });
    await page.screenshot({ path: join(output, `${tag}-open.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written (anything but a GET is refused and counted: ${report.writes.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "review-dock-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
