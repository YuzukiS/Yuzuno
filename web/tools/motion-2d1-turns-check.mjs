// T-19 slice 2d-1, a Turn that arrives live while its conversation is open (M9: CV:T-01; Lead 3250), in
// Chromium on a production build of the app with a synthetic Workspace that is never written to, and
// a stand-in event stream this check speaks for Core. A Turn Core streams or announces, added after the
// Turns shown, fades in over small, opacity only: the Turn and the controls in it stay where they are,
// take the pointer while it fades, and the reading position does not move. Nothing plays for the Turns
// listed when the conversation first shows; for a message this window showed as a preview (Codex) or
// sending in its Turn (Claude), when it is confirmed; for a Turn a Core reset brings (also right after
// an announcement, before the read); for an earlier Turn added in front, as an earlier page adds it; in
// a new native session; after a return from another Agent (also straight back, before the other was
// read); for a Turn made while the stream was down, whether Core replays it when the stream resumes
// or resets it (Lead 3299, 3301); or when a Turn is drawn again after being scrolled away. A Turn
// streamed after each recovery fades again. Two messages with the same words and different IDs are two messages. Under reduced
// motion nothing plays, and reduced motion turned on while a Turn fades stops the fade. Writes: only
// the app's own saves of where an Agent was read; anything else is refused and counted. Chromium is
// not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d1-turns-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d1-turns");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name, harness = "codex") => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "",
  updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness, connectionState: "connected",
  ...(harness === "claude" ? { claudeSessionId: `cs-${id}` } : { threadId: `th-${id}` }) });
const user = (id, text, extra = {}) => ({ id, type: "userMessage", content: [{ type: "text", text }], ...extra });
const answer = (id, text) => ({ id, type: "agentMessage", text });
const turn = (id, items) => ({ id, status: "completed", items });
// Twelve Turns each, so the conversation is drawn in rows (ConversationRows draws past eight).
const base = (who) => Array.from({ length: 12 }, (_, n) => turn(`${who}-t${n}`, [
  user(`${who}-u${n}`, `${who} question ${n + 1}`), answer(`${who}-r${n}`, `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(6)}`)]));
const receipt = (clientMessageId, text, status = "sending", binding) => ({
  input: { clientMessageId, text, expectedTurnId: null, question: null }, status, turnId: binding?.turnId ?? null, ...(binding ? { binding } : {}) });
// Codex reads its account usage and MCP tools: none known here.
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
let agents, state;
// Changes Core makes before it says so. Staged here, they are applied only when the page asks for
// /__check/release right before the event, so a read already on its way cannot see one early.
let staged = [];
const stage = (change) => staged.push(change);
// While set, Hana's detail is answered this late: a return to Mori comes before it is read.
let holdHana = 0;
const detailOf = (index, id) => ({ agent: agents[index], pending: [], artifacts: [], turns: state[id].turns, messageReceipts: state[id].receipts });
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/agents/a/codex/usage": usage, "/api/agents/b/codex/usage": usage, "/api/agents/a/codex/mcp": mcp, "/api/agents/b/codex/mcp": mcp,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": detailOf(0, "a"), "/api/agents/b": detailOf(1, "b"), "/api/agents/k": detailOf(2, "k"),
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
    if (holdHana && url.pathname === "/api/agents/b") await new Promise((done) => setTimeout(done, holdHana));
    const known = gets()[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    // An Agent's other reads (Claude's runtime and tools among them) are not in this fixture.
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
 * connection starts with `reset`, one from a last ID with `resumed`, as events.rs does); the Turns
 * every frame; every animate() on a Turn. */
function pageHelpers() {
  let id = 0, rev = 100;
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
  // Core's named heartbeat on the open stream; after `resumed` the first one ends its replay.
  window.__heartbeat = () => {
    const stream = streams.findLast((s) => s.readyState === 1);
    for (const listener of stream?.listeners?.heartbeat ?? []) listener({ type: "heartbeat" });
  };
  const send = (event) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify(event), lastEventId: String(++id) });
  };
  // What the check staged becomes Core's state, and then Core says so.
  const after = (...events) => async (agentId) => {
    await fetch("/__check/release");
    for (const event of events) send(typeof event === "function" ? event(agentId) : event);
  };
  // Core streams an Item of a Turn this window does not have: the detail is read again (patchDetail).
  window.__stream = after((agentId) => ({ type: "agent.item", agentId, rev: ++rev, turnId: window.__streamTurn, item: window.__streamItem }));
  // Core announces a change to the Agent (events.rs announce_changed).
  window.__announce = after((agentId) => ({ type: "agent.changed", agentId }));
  // Core cannot resume the stream: everything is read again.
  window.__reset = after({ type: "reset", reason: "check" });
  window.__announceThenReset = after((agentId) => ({ type: "agent.changed", agentId }), { type: "reset", reason: "check" });
  // A short break, as the browser's own reconnect has it: the same stream errs, opens again 300 ms
  // later, before any poll could, and says what Core says then. What was staged changed meanwhile.
  const reconnect = (...events) => async (agentId) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.readyState = 0;
    stream.onerror?.({});
    await new Promise((done) => setTimeout(done, 300));
    await fetch("/__check/release");
    stream.readyState = 1;
    stream.onopen?.({});
    for (const event of events)
      stream.onmessage?.({ data: JSON.stringify(typeof event === "function" ? event(agentId) : event), lastEventId: String(++id) });
  };
  // Core resumes from the last ID and replays what was missed: here, an Item of the new Turn.
  window.__resumeReplay = reconnect({ type: "resumed" },
    (agentId) => ({ type: "agent.item", agentId, rev: ++rev, turnId: window.__streamTurn, item: window.__streamItem }));
  // Core cannot resume: everything is read again.
  window.__resetReplay = reconnect({ type: "reset", reason: "check" });
  // Core resumes and nothing was missed: nothing is replayed (#504 R1 276d4a1d).
  window.__quietResume = reconnect({ type: "resumed" });
  const plays = (el) => el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      duration: a.effect.getTiming().duration, current: a.currentTime };
  });
  window.__turns = () => Object.fromEntries([...document.querySelectorAll(".turn[data-turn-id]")].map((el) => {
    const style = getComputedStyle(el);
    return [el.dataset.turnId, { opacity: Number(style.opacity), transform: style.transform, plays: plays(el), top: Math.round(el.getBoundingClientRect().top) }];
  }));
  window.__previews = () => [...document.querySelectorAll(".outgoing-message[data-client-message-id]")].map((el) => el.dataset.clientMessageId);
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".turn[data-turn-id]")) window.__calls.push({ t: Math.round(performance.now()), id: this.dataset.turnId });
    return animate.call(this, keyframes, options);
  };
  /** Every frame for `span` ms, from the frame before `how` (a helper's name) runs for `agentId`. */
  window.__sample = (span, how, agentId) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const record = () => seen.push({ t: Math.round(performance.now() - t0), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      turns: window.__turns(), previews: window.__previews() });
    const frame = () => {
      record();
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    // The first record is taken before `how` runs: what it brings can come within one frame.
    record();
    requestAnimationFrame(frame);
    if (how) window[how](agentId);
  });
  /** Turn `turnId`, brought by `how`, its fade held at `at` ms the frame it is found (as motion-2a-check does). */
  window.__hold = (turnId, at, how, agentId) => new Promise((done) => {
    let tries = 0;
    const look = () => {
      const el = document.querySelector(`.turn[data-turn-id="${CSS.escape(turnId)}"]`);
      const fade = el?.getAnimations().find((a) => a.effect?.getKeyframes?.()[0]?.opacity !== undefined);
      if (!fade && ++tries > 180) return done({ held: false, shown: !!el });
      if (!fade) return requestAnimationFrame(look);
      fade.pause();
      fade.currentTime = at;
      requestAnimationFrame(() => done({ held: true, opacity: Number(getComputedStyle(el).opacity) }));
    };
    requestAnimationFrame(look);
    window[how](agentId);
  });
  // The conversation's scrolling box: the nearest scrolling ancestor of a drawn Turn.
  const scroller = () => {
    let el = document.querySelector(".turn[data-turn-id]")?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    return el ?? document.scrollingElement;
  };
  /** Scrolls the conversation to its start or end, then says which Turns are drawn, 25 frames on. */
  window.__scrollTo = (where) => new Promise((done) => {
    const box = scroller();
    box.scrollTop = where === "top" ? 0 : box.scrollHeight;
    let n = 0;
    const wait = () => {
      if (++n < 25) return requestAnimationFrame(wait);
      done({ top: Math.round(box.scrollTop), drawn: [...document.querySelectorAll(".turn[data-turn-id]")].map((el) => el.dataset.turnId) });
    };
    requestAnimationFrame(wait);
  });
  /** Where Turn `turnId`, its first button and the conversation are, and what is under that button's centre. */
  window.__place = (turnId) => {
    const el = document.querySelector(`.turn[data-turn-id="${CSS.escape(turnId)}"]`);
    const button = el?.querySelector("button:not([disabled])");
    const box = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
    const b = button?.getBoundingClientRect();
    const hit = b && b.width ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
    return { turn: el ? box(el) : null, button: button ? box(button) : null, label: button?.getAttribute("aria-label") || button?.textContent?.trim().slice(0, 40),
      onTop: !!hit && !!button && button.contains(hit), scrollTop: Math.round(scroller().scrollTop),
      opacity: el ? Number(getComputedStyle(el).opacity) : null };
  };
  /** Ends Turn `turnId`'s fade where it is held, as if its time had run out. */
  window.__finish = (turnId) => {
    const el = document.querySelector(`.turn[data-turn-id="${CSS.escape(turnId)}"]`);
    for (const a of el?.getAnimations() ?? []) a.finish();
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const fadeOf = (plays) => plays?.find((p) => p.keys === "opacity/opacity");
const still = (frames) => frames.every((f) => Object.values(f.turns).every((t) => !t.plays.length && t.opacity === 1));
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  agents = [agent("a", "Mori"), agent("b", "Hana"), agent("k", "Kumo", "claude")];
  state = { a: { turns: base("Mori"), receipts: [] }, b: { turns: base("Hana"), receipts: [] }, k: { turns: base("Kumo"), receipts: [] } };
  staged = [];
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  // Kept to read, not counted: a refused read logs a failed load too.
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => (await page.evaluate(() => window.__calls.length));
  const open = async (name) => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  };
  /** Frames from the one before `how` makes Agent `id`'s detail what `change` stages. */
  const bring = async (id, turnId, change, how, span = 900) => {
    stage(change);
    const before = await calls();
    const frames = await page.evaluate(([span, how, id]) => window.__sample(span, how, id), [span, how, id]);
    const shown = frames.filter((f) => f.turns[turnId]);
    return { turnId, frames, shown, at: shown[0]?.turns[turnId], calls: (await page.evaluate(() => window.__calls.slice())).slice(before) };
  };
  const onlyShows = (label, got) => ok(`${tag}: ${label}: it shows with nothing playing (${got.shown.length} frames, ${got.calls.length} animate() calls on a Turn)`,
    !got.frames[0]?.turns[got.turnId] && got.shown.length > 5 && got.calls.length === 0 && still(got.frames), { at: got.at, first: got.frames[0]?.previews });
  const fades = (label, got) => {
    if (reduced) return ok(`${tag}: under reduced motion, ${label}: it shows with nothing playing`,
      !got.frames[0]?.turns[got.turnId] && got.shown.length > 5 && got.calls.length === 0 && still(got.shown), got.at);
    const fade = fadeOf(got.at?.plays);
    const end = got.shown.at(-1)?.turns[got.turnId];
    ok(`${tag}: ${label}: it fades in over small, opacity only (${fade?.keys}, ${fade?.duration} ms, ${got.at?.opacity} in its first frame), nothing in it moves, and it ends at 1 with nothing left`,
      !got.frames[0]?.turns[got.turnId] && !!fade && fade.duration === 180 && got.at.plays.length === 1 && got.at.opacity < 1
        && got.shown.every((f) => f.turns[got.turnId].transform === "none") && got.calls.length === 1 && got.calls[0].id === got.turnId
        && end?.opacity === 1 && !end.plays.length, { at: got.at, end, calls: got.calls });
  };
  const add = (id, ...turns) => () => { state[id].turns = [...state[id].turns, ...turns]; };
  try {
    await page.goto("http://yuzuno-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.locator('.turn[data-turn-id="Mori-t11"]').waitFor();
    const first = await page.evaluate(() => window.__sample(600));
    ok(`${tag}: opening the conversation, its Turns show with nothing playing (${first.length} frames; ${await calls()} animate() calls on a Turn)`,
      first.length > 10 && (await calls()) === 0 && first.every((f) => f.turns["Mori-t11"]) && still(first), Object.keys(first[0]?.turns ?? {}));

    // CV:T-01: Core streams an Item of a new Turn, from elsewhere (another device, or mail).
    await page.evaluate(() => { window.__streamTurn = "remote-1"; window.__streamItem = { id: "remote-1-u", type: "userMessage", content: [{ type: "text", text: "From the phone" }] }; });
    const remote = await bring("a", "remote-1", add("a", turn("remote-1", [user("remote-1-u", "From the phone"), answer("remote-1-r", "On it.")])), "__stream");
    report.frames[`${tag}: a Turn arrives live`] = remote.frames;
    fades("a Turn Core streams from elsewhere", remote);

    // The preview of a message sent from this window, then its Turn (Codex, by clientId).
    await bring("a", "x", () => { state.a.receipts = [receipt("c-1", "Run the tests")]; }, "__announce", 400);
    const previewShown = await page.evaluate(() => window.__previews());
    const handed = await bring("a", "t-c1", () => {
      state.a.turns = [...state.a.turns, turn("t-c1", [user("u-c1", "Run the tests", { clientId: "c-1" }), answer("r-c1", "Running them.")])];
      state.a.receipts = [receipt("c-1", "Run the tests", "accepted", { turnId: "t-c1", itemId: "u-c1", userIndex: 0 })];
    }, "__announce");
    report.frames[`${tag}: a preview's Turn`] = handed.frames;
    ok(`${tag}: a message shown as a preview (${JSON.stringify(previewShown)}), then its Turn: the Turn shows with nothing playing, and the preview goes (${handed.calls.length} calls)`,
      previewShown.includes("c-1") && !handed.frames[0]?.turns["t-c1"] && handed.shown.length > 5 && handed.calls.length === 0 && still(handed.frames)
        && !handed.shown.at(-1).previews.includes("c-1"), { previewShown, at: handed.at, last: handed.shown.at(-1)?.previews });

    // The same words, another message: a preview of c-2 still on its way, and a Turn of c-3 from elsewhere.
    await bring("a", "x", () => { state.a.receipts = [...state.a.receipts, receipt("c-2", "Same words")]; }, "__announce", 400);
    const same = await bring("a", "t-c3", add("a", turn("t-c3", [user("u-c3", "Same words", { clientId: "c-3" }), answer("r-c3", "Noted.")])), "__announce");
    fades("a Turn with the same words as a preview still shown, and another ID", same);
    ok(`${tag}: and that preview stays (${JSON.stringify(same.shown.at(-1)?.previews)})`, same.shown.length > 0 && same.shown.every((f) => f.previews.includes("c-2")), same.shown.at(-1)?.previews);

    // What a sync brings is only shown: a reset, and an announcement a reset follows before the read.
    onlyShows("a Turn a Core reset brings", await bring("a", "sync-1", add("a", turn("sync-1", [user("sync-1-u", "Synced"), answer("sync-1-r", "Yes.")])), "__reset"));
    onlyShows("a Turn announced and then reset before the read",
      await bring("a", "sync-2", add("a", turn("sync-2", [user("sync-2-u", "Synced too"), answer("sync-2-r", "Yes.")])), "__announceThenReset"));
    // An earlier Turn added in front of the shown ones, as an earlier page adds it, read at the start
    // of the conversation, where a reader who asks for an earlier page is.
    await page.evaluate(() => window.__scrollTo("top"));
    onlyShows("an earlier Turn added in front, at the start of the conversation", await bring("a", "early-1", () => {
      state.a.turns = [turn("early-1", [user("early-1-u", "Long ago"), answer("early-1-r", "Indeed.")]), ...state.a.turns];
    }, "__announce"));
    await page.evaluate(() => window.__scrollTo("bottom"));
    // Another native session of the same Agent is a new baseline.
    onlyShows("a new native session listed with a new Turn", await bring("a", "session-1", () => {
      agents[0].threadId = "th-a-2";
      state.a.turns = [...state.a.turns, turn("session-1", [user("session-1-u", "Fresh start"), answer("session-1-r", "Hello.")])];
    }, "__announce"));

    // Drawn again after being scrolled away: nothing plays again.
    const mark = await calls();
    const atEnd = await page.evaluate(() => window.__scrollTo("bottom"));
    const atStart = await page.evaluate(() => window.__scrollTo("top"));
    const again = await page.evaluate(() => window.__scrollTo("bottom"));
    const redrawn = atEnd.drawn.filter((id) => !atStart.drawn.includes(id) && again.drawn.includes(id));
    const afterAway = await page.evaluate(() => window.__sample(300));
    // Which Turns are drawn at the end depends on their heights: any that arrived live will do.
    const arrived = ["remote-1", "t-c3"].filter((id) => redrawn.includes(id));
    ok(`${tag}: scrolled to the start and back, the Turns drawn again (${redrawn.length}, live arrivals among them: ${arrived.join(", ") || "none"}) play nothing (${(await calls()) - mark} calls)`,
      arrived.length > 0 && (await calls()) === mark && still(afterAway), { atEnd: atEnd.drawn, atStart: atStart.drawn, again: again.drawn });

    // To another Agent and back: nothing plays.
    const leave = await calls();
    await open("Hana");
    await page.locator('.turn[data-turn-id="Hana-t11"]').waitFor();
    await open("Mori");
    await page.locator('.turn[data-turn-id="session-1"]').waitFor();
    const back = await page.evaluate(() => window.__sample(400));
    ok(`${tag}: to another Agent and back, every Turn shows with nothing playing (${(await calls()) - leave} calls)`,
      (await calls()) === leave && still(back), Object.keys(back[0]?.turns ?? {}).length);

    // A short break (Lead 3299): a Turn Core replays as the stream resumes, or one its reset brings,
    // only shows; a Turn streamed after that recovery fades in again.
    const nextItem = async (turnId, text) => page.evaluate(([turnId, text]) => {
      window.__streamTurn = turnId;
      window.__streamItem = { id: `${turnId}-u`, type: "userMessage", content: [{ type: "text", text }] };
    }, [turnId, text]);
    const made = (turnId, text) => add("a", turn(turnId, [user(`${turnId}-u`, text), answer(`${turnId}-r`, "Seen.")]));
    await nextItem("replayed-1", "Sent while the stream was down");
    onlyShows("after a short break, the stream resumes and Core replays an Item of a Turn made meanwhile",
      await bring("a", "replayed-1", made("replayed-1", "Sent while the stream was down"), "__resumeReplay", 1300));
    onlyShows("after a short break, Core resets the stream instead: the Turn made meanwhile",
      await bring("a", "reset-1", made("reset-1", "Also meanwhile"), "__resetReplay", 1500));
    await nextItem("live-after", "After the break");
    fades("after that recovery, a Turn Core streams", await bring("a", "live-after", made("live-after", "After the break"), "__stream"));
    // A resumed stream's replay ends at its first heartbeat (Lead 3356; #504 R1 276d4a1d): the first
    // Turn streamed after it fades in. One streamed before it only shows, and one after it fades in.
    await page.evaluate(() => window.__quietResume("a"));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__heartbeat());
    await page.waitForTimeout(150);
    await nextItem("beat-1", "First after the heartbeat");
    fades("after the resumed stream's first heartbeat, the first Turn Core streams",
      await bring("a", "beat-1", made("beat-1", "First after the heartbeat"), "__stream"));
    await page.evaluate(() => window.__quietResume("a"));
    await page.waitForTimeout(300);
    await nextItem("pre-beat", "Before the heartbeat");
    onlyShows("before a resumed stream's first heartbeat, a Turn Core streams",
      await bring("a", "pre-beat", made("pre-beat", "Before the heartbeat"), "__stream"));
    await page.evaluate(() => window.__heartbeat());
    await page.waitForTimeout(150);
    await nextItem("post-beat", "After the heartbeat");
    fades("after that heartbeat, a Turn Core streams", await bring("a", "post-beat", made("post-beat", "After the heartbeat"), "__stream"));

    // To another Agent and straight back, before that one is read: Mori's next detail is a new
    // baseline, whatever was announced for it before (Lead 3301).
    await page.evaluate(() => window.__sample(400, "__announce", "a"));
    stage(made("quick-1", "Made while away"));
    await page.evaluate(() => fetch("/__check/release"));
    const quickMark = await calls();
    holdHana = 1500;
    await open("Hana");
    await open("Mori");
    await page.locator('.turn[data-turn-id="quick-1"]').waitFor();
    const quick = await page.evaluate(() => window.__sample(600));
    holdHana = 0;
    ok(`${tag}: to another Agent and straight back before it was read, a Turn made meanwhile shows with nothing playing (${(await calls()) - quickMark} calls)`,
      (await calls()) === quickMark && quick.every((f) => f.turns["quick-1"]) && still(quick), quick[0]?.turns["quick-1"]);
    await nextItem("live-quick", "After the return");
    fades("after that quick return, a Turn Core streams", await bring("a", "live-quick", made("live-quick", "After the return"), "__stream"));

    if (!reduced) {
      // A Turn with controls in it, held at 60 ms: they take the pointer where they will stay, and nothing moves.
      await page.evaluate(() => { window.__streamTurn = "remote-2"; window.__streamItem = { id: "remote-2-u", type: "userMessage", content: [{ type: "text", text: "Another from the phone" }] }; });
      stage(add("a", turn("remote-2", [user("remote-2-u", "Another from the phone"), answer("remote-2-r", "Also on it.")])));
      const held = await page.evaluate(() => window.__hold("remote-2", 60, "__stream", "a"));
      const during = await page.evaluate(() => window.__place("remote-2"));
      await page.evaluate(() => window.__finish("remote-2"));
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const ended = await page.evaluate(() => window.__place("remote-2"));
      report.frames[`${tag}: a Turn with controls, held`] = { held, during, ended };
      ok(`${tag}: in a Turn fading in (held at 60 ms, opacity ${during.opacity}), its first control (${during.label}) is on top at its centre`,
        held.held && during.opacity < 1 && !!during.button && during.onTop, during);
      ok(`${tag}: and the Turn, that control and the reading position are where they are once it has faded in`,
        JSON.stringify([during.turn, during.button, during.scrollTop]) === JSON.stringify([ended.turn, ended.button, ended.scrollTop]) && ended.opacity === 1, { during, ended });

      // Reduced motion turned on while a Turn fades in, held at 60 ms.
      await page.evaluate(() => { window.__streamTurn = "remote-3"; window.__streamItem = { id: "remote-3-u", type: "userMessage", content: [{ type: "text", text: "A third" }] }; });
      stage(add("a", turn("remote-3", [user("remote-3-u", "A third"), answer("remote-3-r", "Sure.")])));
      const held3 = await page.evaluate(() => window.__hold("remote-3", 60, "__stream", "a"));
      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedOn = await page.evaluate(() => window.__sample(250));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const reducedOff = await page.evaluate(() => window.__sample(300));
      report.frames[`${tag}: reduced motion turned on mid-way`] = { held3, reducedOn, reducedOff };
      const t3 = (f) => f.turns["remote-3"];
      const settled = (f) => t3(f) && !t3(f).plays.length && t3(f).opacity === 1;
      const stillHeld = (f) => t3(f)?.plays.length === 1 && Math.round(t3(f).plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while a Turn fades in (held at 60 ms, opacity ${held3.opacity}): it stops within a frame of the change, fully shown from then on (first frame: ${reducedOn[0] && settled(reducedOn[0]) ? "shown" : "still held"})`,
        held3.held && held3.opacity < 1 && reducedOn.length > 1 && (settled(reducedOn[0]) || stillHeld(reducedOn[0])) && reducedOn.slice(1).every(settled), { held3, first: reducedOn.slice(0, 3) });
      ok(`${tag}: and turned off again, nothing plays again`, reducedOff.length > 0 && reducedOff.every(settled), reducedOff.slice(0, 2));
    }

    // Claude: a new message's Turn shown before it is confirmed (sending, in its Turn), then confirmed.
    await open("Kumo");
    await page.locator('.turn[data-turn-id="Kumo-t11"]').waitFor();
    await bring("k", "x", () => { state.k.receipts = [receipt("c-5", "Check the build")]; }, "__announce", 400);
    const kPreview = await page.evaluate(() => window.__previews());
    const early = await bring("k", "k-t5", add("k", turn("k-t5", [user("k-u5", "Check the build", { _yuzunoClientMessageId: "c-5" })])), "__announce");
    const sendingNote = await page.evaluate(() => !!document.querySelector('.turn[data-turn-id="k-t5"] .message-delivery'));
    ok(`${tag}: Claude: a message shown as a preview (${JSON.stringify(kPreview)}), then in its own Turn while still sending (note shown: ${sendingNote}): the Turn shows with nothing playing (${early.calls.length} calls)`,
      kPreview.includes("c-5") && sendingNote && !early.frames[0]?.turns["k-t5"] && early.shown.length > 5 && early.calls.length === 0 && still(early.frames)
        && !early.shown.at(-1).previews.includes("c-5"), { at: early.at, last: early.shown.at(-1)?.previews });
    const confirmed = await bring("k", "k-t5", () => {
      state.k.turns = state.k.turns.map((t) => t.id === "k-t5" ? turn("k-t5", [user("k-u5", "Check the build", { clientId: "c-5", _yuzunoClientMessageId: "c-5" }), answer("k-r5", "Built.")]) : t);
      state.k.receipts = [receipt("c-5", "Check the build", "accepted", { turnId: "k-t5", itemId: "k-u5", userIndex: 0 })];
    }, "__announce", 600);
    ok(`${tag}: Claude: and confirmed, nothing plays (${confirmed.calls.length} calls)`, confirmed.calls.length === 0 && still(confirmed.frames), confirmed.frames.at(-1)?.turns["k-t5"]);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d1-turns-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
