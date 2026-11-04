// T-19 CV:T-04, CV:T-09 and CV:Q-07 (Lead 2 4591), in Chromium on a production build of the app with a
// synthetic Workspace that is never written to, and a stand-in event stream this check speaks for Core.
// A shown Turn's own change and the question dock, live: each comes in once, opacity only, over small
// (180 ms), and only when Core streamed or announced the change; under reduced motion nothing plays.
// - T-09: a running Turn Core records completed: its working indicator goes at once, and its reply
//   actions and its files come in once; the Turn itself does not play. An interrupted one: no cue.
// - T-04: a message shown as a preview, then its Turn running (T-01 does not fade it): its working
//   indicator comes in once. A shown Turn running again: the same.
// - Q-07: a question arrives while the dock is not there: the dock comes in once, its opacity only (its
//   height at once: the deviation from the 11-03 inventory, T-19 3881), and the conversation's end is
//   kept. A second question while the dock is shown: no cue.
// - Not live: the first view (a running Turn, and another Agent's question), a Turn a Core reset
//   completes, and one completed while the stream was down that Core replays when it resumes: nothing
//   plays.
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: only the app's own
// saves of where an Agent was read; anything else is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-turn-cues-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-turn-cues");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 700)}`}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected", threadId: `th-${id}` });
const user = (id, text, extra = {}) => ({ id, type: "userMessage", content: [{ type: "text", text }], ...extra });
const answer = (id, text) => ({ id, type: "agentMessage", text });
const turn = (id, items, status = "completed") => ({ id, status, items });
const base = (who) => Array.from({ length: 10 }, (_, n) => turn(`${who}-t${n}`, [
  user(`${who}-u${n}`, `${who} question ${n + 1}`), answer(`${who}-r${n}`, `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(5)}`)]));
const html = (id) => ({ id, type: "fileChange", status: "completed", changes: [{ path: "/w/proto.html", kind: { type: "add" }, diff: "+<!doctype html>" }] });
const question = (id, title) => ({ id, type: "agentMessage", delivery: "async", text: "", questions: [{ title, options: ["Yes", "No"] }] });
const receipt = (clientMessageId, text, status = "sending", binding) => ({
  input: { clientMessageId, text, expectedTurnId: null, question: null }, status, turnId: binding?.turnId ?? null, ...(binding ? { binding } : {}) });
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
let agents, state;
// Changes Core makes before it says so, applied only when the page asks for /__check/release.
let staged = [];
const stage = (change) => staged.push(change);
const detailOf = (index, id) => ({ agent: agents[index], pending: [], artifacts: [], turns: state[id].turns, messageReceipts: state[id].receipts });
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/agents/a/codex/usage": usage, "/api/agents/b/codex/usage": usage, "/api/agents/a/codex/mcp": mcp, "/api/agents/b/codex/mcp": mcp,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": detailOf(0, "a"), "/api/agents/b": detailOf(1, "b"),
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/__check/release") {
    for (const change of staged.splice(0)) change();
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

/** In the page, from the first script on: the event stream, spoken for Core by this check (a fresh
 * connection starts with `reset`, one from a last ID with `resumed`); what is on screen every frame;
 * every animate() on the parts this check watches. */
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
        const start = url.includes("lastEventId") ? { type: "resumed" } : { type: "reset", reason: "new" };
        this.onmessage?.({ data: JSON.stringify(start), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener(type, listener) { ((this.listeners ??= {})[type] ??= []).push(listener); }
    close() { this.readyState = 2; }
  };
  const send = (event) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify(event), lastEventId: String(++id) });
  };
  const after = (...events) => async (agentId) => {
    await fetch("/__check/release");
    for (const event of events) send(typeof event === "function" ? event(agentId) : event);
  };
  // Core announces a change to the Agent (events.rs announce_changed).
  window.__announce = after((agentId) => ({ type: "agent.changed", agentId }));
  // Core cannot resume the stream: everything is read again.
  window.__reset = after({ type: "reset", reason: "check" });
  // Core's named heartbeat on the open stream; after `resumed` the first one ends its replay.
  window.__heartbeat = () => {
    const stream = streams.findLast((s) => s.readyState === 1);
    for (const listener of stream?.listeners?.heartbeat ?? []) listener({ type: "heartbeat" });
  };
  // A short break: the stream errs, opens again 300 ms later, Core resumes from the last ID and
  // replays what was missed (its announcement of the Agent's change), as events.rs does.
  window.__resumeReplay = async (agentId) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.readyState = 0;
    stream.onerror?.({});
    await new Promise((done) => setTimeout(done, 300));
    await fetch("/__check/release");
    stream.readyState = 1;
    stream.onopen?.({});
    for (const event of [{ type: "resumed" }, { type: "agent.changed", agentId }])
      stream.onmessage?.({ data: JSON.stringify(event), lastEventId: String(++id) });
  };
  const watched = ".turn[data-turn-id], .turn-activity, .reply-actions, .turn-files, .pending-questions";
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(watched)) {
      const part = this.matches(".turn[data-turn-id]") ? "turn" : this.matches(".pending-questions") ? "dock"
        : this.matches(".turn-activity") ? "activity" : this.matches(".turn-files") ? "files" : "actions";
      window.__calls.push({ part, turn: this.closest(".turn[data-turn-id]")?.dataset.turnId ?? null });
    }
    return animate.call(this, keyframes, options);
  };
  // Script animations only: a style's own animations and transitions are not this check's.
  const scripted = (a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) && !(typeof CSSTransition !== "undefined" && a instanceof CSSTransition);
  const plays = (el) => el ? el.getAnimations().filter(scripted).map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      duration: a.effect.getTiming().duration };
  }) : null;
  const part = (el) => el ? { plays: plays(el), opacity: Number(getComputedStyle(el).opacity), height: Math.round(el.getBoundingClientRect().height) } : null;
  const scroller = () => {
    let el = document.querySelector(".turn[data-turn-id]")?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    return el ?? document.scrollingElement;
  };
  window.__look = (ids) => {
    const turns = {};
    for (const turnId of ids) {
      const el = [...document.querySelectorAll(".turn[data-turn-id]")].find((t) => t.dataset.turnId === turnId);
      if (!el) continue;
      turns[turnId] = { turn: part(el), activity: part(el.querySelector(".turn-activity")),
        actions: part(el.querySelector(".reply-actions")), files: part(el.querySelector(".turn-files")) };
    }
    const box = scroller();
    return { turns, dock: part(document.querySelector(".pending-questions")),
      fromEnd: box ? Math.round(box.scrollHeight - box.scrollTop - box.clientHeight) : null };
  };
  /** Every frame for `span` ms, from the frame before `how` (a helper's name) runs for `agentId`. */
  window.__sample = (span, ids, how, agentId) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const record = () => seen.push({ t: Math.round(performance.now() - t0), ...window.__look(ids) });
    const frame = () => {
      record();
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    record();
    requestAnimationFrame(frame);
    if (how) window[how](agentId);
  });
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const IDS = ["work-1", "t-c1", "work-3", "work-4", "q-1", "q-2"];
const fadeOf = (plays) => plays?.length === 1 && plays[0].keys === "opacity/opacity" && plays[0].duration === 180;
/** Nothing watched plays in any frame. */
const quiet = (frames) => frames.every((f) => !f.dock?.plays?.length && Object.values(f.turns).every((t) =>
  ["turn", "activity", "actions", "files"].every((k) => !t[k]?.plays?.length)));
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  agents = [agent("a", "Mori"), agent("b", "Hana")];
  state = {
    a: { turns: [...base("Mori"), turn("work-1", [user("work-1-u", "Build the prototype"), answer("work-1-r", "Working on it.")], "inProgress")], receipts: [] },
    b: { turns: [...base("Hana"), turn("hq-1", [user("hq-1-u", "Plan it"), question("hq-1-q", "Ship on Friday?")])], receipts: [] },
  };
  staged = [];
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => page.evaluate(() => window.__calls.slice());
  const open = async (name) => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  };
  /** Frames from the one before `how` makes Mori's detail what `change` stages, and the animate()
   * calls made meanwhile. */
  const bring = async (change, how, span = 900) => {
    stage(change);
    const before = (await calls()).length;
    const frames = await page.evaluate(([span, ids, how]) => window.__sample(span, ids, how, "a"), [span, IDS, how]);
    return { frames, calls: (await calls()).slice(before) };
  };
  const statusOf = (turnId, status, ...items) => () => {
    state.a.turns = state.a.turns.map((t) => t.id === turnId ? { ...t, status, items: [...t.items, ...items] } : t);
  };
  const record = (label, got) => { report.frames[`${tag}: ${label}`] = got.frames; return got; };
  try {
    await page.goto("http://yuzuno-turn-cues.test/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.locator('.turn[data-turn-id="work-1"] .turn-activity').waitFor();
    const first = await page.evaluate((ids) => window.__sample(600, ids), IDS);
    ok(`${tag}: opening the conversation, a running Turn's working indicator shows with nothing playing`,
      first.length > 10 && !!first.at(-1).turns["work-1"]?.activity && quiet(first) && (await calls()).length === 0, first.at(-1)?.turns["work-1"]);

    // T-09: Core records work-1 completed, with a file and a last word.
    const done = record("work-1 completes", await bring(statusOf("work-1", "completed", html("work-1-f"), answer("work-1-end", "Done: the prototype is ready.")), "__announce"));
    const ended = done.frames.filter((f) => f.turns["work-1"]?.actions);
    const firstEnded = ended[0]?.turns["work-1"];
    const lastEnded = ended.at(-1)?.turns["work-1"];
    if (reduced) ok(`${tag}: under reduced motion, a running Turn Core records completed: its indicator goes and its reply actions and files show, nothing playing`,
      ended.length > 5 && !firstEnded.activity && !!lastEnded.files && quiet(done.frames) && done.calls.length === 0, { firstEnded, calls: done.calls });
    else ok(`${tag}: a running Turn Core records completed: its working indicator goes at once, its reply actions and its files come in once over small (opacity only), and the Turn itself does not play`,
      ended.length > 5 && !firstEnded.activity && fadeOf(firstEnded.actions?.plays) && firstEnded.actions.opacity < 1 && fadeOf(firstEnded.files?.plays)
        && !firstEnded.turn.plays.length && lastEnded.actions.opacity === 1 && !lastEnded.actions.plays.length
        && done.calls.length === 2 && done.calls.every((c) => c.turn === "work-1" && (c.part === "actions" || c.part === "files")),
      { firstEnded, lastEnded, calls: done.calls });

    // T-04: a message shown as a preview, then its Turn, running (T-01 does not fade it).
    await bring(() => { state.a.receipts = [receipt("c-1", "Run the tests")]; }, "__announce", 400);
    const started = record("a preview's Turn runs", await bring(() => {
      state.a.turns = [...state.a.turns, turn("t-c1", [user("u-c1", "Run the tests", { clientId: "c-1" })], "inProgress")];
      state.a.receipts = [receipt("c-1", "Run the tests", "accepted", { turnId: "t-c1", itemId: "u-c1", userIndex: 0 })];
    }, "__announce"));
    const runningNow = started.frames.filter((f) => f.turns["t-c1"]?.activity);
    if (reduced) ok(`${tag}: under reduced motion, a message shown as a preview, then its Turn running: its working indicator shows, nothing playing`,
      runningNow.length > 5 && quiet(started.frames) && started.calls.length === 0, { at: runningNow[0]?.turns["t-c1"], calls: started.calls });
    else ok(`${tag}: a message shown as a preview, then its Turn running: its working indicator comes in once over small (opacity only), and the Turn itself does not play`,
      runningNow.length > 5 && fadeOf(runningNow[0].turns["t-c1"].activity.plays) && !runningNow[0].turns["t-c1"].turn.plays.length
        && started.calls.length === 1 && started.calls[0].part === "activity" && started.calls[0].turn === "t-c1",
      { at: runningNow[0]?.turns["t-c1"], calls: started.calls });

    // An interrupted Turn: its own words, no cue.
    const stopped = record("t-c1 interrupted", await bring(statusOf("t-c1", "interrupted"), "__announce"));
    const after = stopped.frames.filter((f) => f.turns["t-c1"] && !f.turns["t-c1"].activity);
    ok(`${tag}: a running Turn Core records interrupted: its indicator goes and nothing plays`,
      after.length > 5 && quiet(stopped.frames) && stopped.calls.length === 0, { at: after[0]?.turns["t-c1"], calls: stopped.calls });

    // T-04: a shown Turn running again.
    const again = record("work-1 runs again", await bring(statusOf("work-1", "inProgress"), "__announce"));
    const rerun = again.frames.filter((f) => f.turns["work-1"]?.activity);
    if (reduced) ok(`${tag}: under reduced motion, a shown Turn running again: its working indicator shows, nothing playing`,
      rerun.length > 5 && quiet(again.frames) && again.calls.length === 0, { at: rerun[0]?.turns["work-1"], calls: again.calls });
    else ok(`${tag}: a shown Turn running again: its working indicator comes in once over small (opacity only)`,
      rerun.length > 5 && fadeOf(rerun[0].turns["work-1"].activity.plays) && again.calls.length === 1 && again.calls[0].part === "activity",
      { at: rerun[0]?.turns["work-1"], calls: again.calls });
    await bring(statusOf("work-1", "completed"), "__reset", 600);

    // Not live: a Turn a Core reset completes; one completed while the stream was down, replayed.
    await bring(() => { state.a.turns = [...state.a.turns, turn("work-3", [user("work-3-u", "Tidy up")], "inProgress")]; }, "__reset", 600);
    const resetDone = record("work-3 completed by a reset", await bring(statusOf("work-3", "completed", answer("work-3-r", "Tidied.")), "__reset"));
    ok(`${tag}: a running Turn a Core reset brings completed: its reply actions show, nothing playing`,
      resetDone.frames.some((f) => f.turns["work-3"]?.actions) && quiet(resetDone.frames) && resetDone.calls.length === 0, { calls: resetDone.calls });
    await bring(() => { state.a.turns = [...state.a.turns, turn("work-4", [user("work-4-u", "Check it")], "inProgress")]; }, "__reset", 600);
    const replayed = record("work-4 completed while the stream was down", await bring(statusOf("work-4", "completed", answer("work-4-r", "Checked.")), "__resumeReplay", 1400));
    ok(`${tag}: a Turn completed while the stream was down, Core replaying its announcement as the stream resumes: its reply actions show, nothing playing`,
      replayed.frames.some((f) => f.turns["work-4"]?.actions) && quiet(replayed.frames) && replayed.calls.length === 0, { calls: replayed.calls });
    // The replay ends at the stream's first heartbeat (Lead 3356): what follows is live again.
    await page.evaluate(() => window.__heartbeat());
    await page.waitForTimeout(300);

    // Q-07: a question arrives live; the dock was not there.
    const asked = record("a question arrives", await bring(() => {
      state.a.turns = [...state.a.turns, turn("q-1", [user("q-1-u", "Plan the release"), question("q-1-q", "Release on Friday?")])];
    }, "__announce", 1000));
    const docked = asked.frames.filter((f) => f.dock);
    const dockCalls = asked.calls.filter((c) => c.part === "dock");
    const end = asked.frames.at(-1)?.fromEnd;
    if (reduced) ok(`${tag}: under reduced motion, a question arrives while the dock is not there: the dock shows with nothing playing, and the conversation's end is kept`,
      !asked.frames[0].dock && docked.length > 5 && docked.every((f) => !f.dock.plays.length) && dockCalls.length === 0 && end !== null && end <= 1,
      { at: docked[0]?.dock, end });
    else ok(`${tag}: a question arrives while the dock is not there: the dock comes in once over small, its opacity only (its height at once), and the conversation's end is kept`,
      !asked.frames[0].dock && docked.length > 5 && fadeOf(docked[0].dock.plays) && docked[0].dock.opacity < 1 && dockCalls.length === 1
        && docked.every((f) => f.dock.height === docked[0].dock.height) && end !== null && end <= 1,
      { at: docked[0]?.dock, heights: [...new Set(docked.map((f) => f.dock.height))], end, dockCalls });
    const more = record("a second question", await bring(() => {
      state.a.turns = [...state.a.turns, turn("q-2", [user("q-2-u", "And the notes"), question("q-2-q", "Notes in English?")])];
    }, "__announce", 800));
    ok(`${tag}: a second question while the dock is shown: the dock plays nothing`,
      more.frames.every((f) => f.dock && !f.dock.plays.length) && !more.calls.some((c) => c.part === "dock"), { calls: more.calls });

    // Not live: another Agent's question on its first view.
    const before = (await calls()).length;
    await open("Hana");
    await page.locator(".pending-questions").waitFor();
    const hana = await page.evaluate(() => window.__sample(500, []));
    ok(`${tag}: another Agent's conversation, first shown with a question: the dock shows with nothing playing`,
      hana.every((f) => f.dock && !f.dock.plays.length) && !(await calls()).slice(before).some((c) => c.part === "dock"), hana.at(-1)?.dock);
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written; the app's own saves of where an Agent was read, counted apart: ${report.readingSaves.length}`, report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "motion-turn-cues-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
