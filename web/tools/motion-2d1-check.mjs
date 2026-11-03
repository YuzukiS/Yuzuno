// T-19 slice 2d-1, a request card that arrives live while its conversation is open (M9: CV:Q-01), in
// Chromium on a production build of the app with a synthetic Workspace that is never written to, and
// a stand-in event stream this check speaks for Core. A request Core announces (`agent.changed`, then
// the detail lists it) fades in over small, opacity only: nothing in it moves, and its buttons work
// from the first frame it shows. Nothing plays for a request listed when the conversation first
// shows, one a Core reset brings (also when it comes right after an announcement, before the read),
// one in a new native session, one shown again after a return from another Agent, or the same list
// read again; nor under reduced motion, and reduced motion turned on while it fades stops the fade.
// Allow once, pressed while its card is still coming in, is sent and every decision locks. Writes:
// one decision per run, held and never answered, and the app's own saves of where an Agent was read;
// anything else is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d1-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d1");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], held: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected", threadId: `th-${id}` });
let agents;
const turns = (who) => Array.from({ length: 4 }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(20)}` },
] }));
// Synthetic requests to Mori.
const request = (id, command) => ({ id, agentId: "a", method: "item/commandExecution/requestApproval",
  params: { command, cwd: "/w", reason: "A synthetic request", threadId: "th", turnId: "Mori-t3", itemId: `cmd-${id}`,
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] },
  createdAt: new Date().toISOString() });
const listed = request("listed-1", "npm run lint");
let moriPending;
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: moriPending, artifacts: [], turns: turns("Mori") },
  "/api/agents/b": { agent: agents[1], pending: [], artifacts: [], turns: turns("Hana") },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    // A decision: held, never answered (as approval-spinner-check does).
    const respond = request.method() === "POST" && /^\/api\/requests\/([^/]+)\/respond$/.exec(url.pathname);
    if (respond) {
      report.held.push({ id: decodeURIComponent(respond[1]), body: request.postData() });
      return;
    }
    if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(url.pathname)) {
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    return route.fulfill({ json: gets()[url.pathname] ?? {} });
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

/** In the page, from the first script on: the event stream, spoken for Core by this check (each
 * connection opens and says it resumed); the request cards every frame; every animate() on one. */
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
        this.onmessage?.({ data: JSON.stringify({ type: "resumed" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  const send = (event) => {
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify(event), lastEventId: String(++id) });
  };
  // Core announces a change to Mori: how a new request is announced (events.rs announce_changed).
  window.__announce = () => send({ type: "agent.changed", agentId: "a" });
  // Core cannot resume the stream: everything is read again.
  window.__reset = () => send({ type: "reset", reason: "check" });
  window.__announceThenReset = () => { window.__announce(); window.__reset(); };
  const plays = (el) => el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      duration: a.effect.getTiming().duration, current: a.currentTime };
  });
  window.__cards = () => Object.fromEntries([...document.querySelectorAll(".pending-card")].map((card) => {
    const style = getComputedStyle(card);
    const allow = card.querySelector(".button-row .primary-button");
    const box = allow?.getBoundingClientRect();
    const inView = !!box && box.width > 0 && box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
    const hit = inView ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
    return [card.id, { opacity: Number(style.opacity), transform: style.transform, plays: plays(card),
      allow: allow ? { disabled: allow.disabled, pointerEvents: getComputedStyle(allow).pointerEvents, inView, onTop: !!hit && allow.contains(hit) } : null }];
  }));
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".pending-card")) window.__calls.push({ t: Math.round(performance.now()), id: this.id });
    return animate.call(this, keyframes, options);
  };
  /** Every frame for `span` ms, from the frame before `how` (a helper's name) runs. */
  window.__sample = (span, how) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      seen.push({ t: Math.round(performance.now() - t0), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, cards: window.__cards() });
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    requestAnimationFrame(frame);
    if (how) window[how]();
  });
  /** An announcement that brings card `id`; its fade is held at `at` ms the frame it is found (as motion-2a-check does). */
  window.__hold = (id, at) => new Promise((done) => {
    let tries = 0;
    const look = () => {
      const card = document.getElementById(id);
      const fade = card?.getAnimations().find((a) => a.effect?.getKeyframes?.()[0]?.opacity !== undefined);
      if (!fade && ++tries > 180) return done({ held: false, shown: !!card });
      if (!fade) return requestAnimationFrame(look);
      fade.pause();
      fade.currentTime = at;
      requestAnimationFrame(() => done({ held: true, opacity: Number(getComputedStyle(card).opacity) }));
    };
    requestAnimationFrame(look);
    window.__announce();
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
const LISTED = `request-${listed.id}`;
const fadeOf = (plays) => plays?.find((p) => p.keys === "opacity/opacity");
const still = (frames) => frames.every((f) => Object.values(f.cards).every((c) => !c.plays.length && c.opacity === 1));
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  agents = [agent("a", "Mori"), agent("b", "Hana")];
  moriPending = [listed];
  const heldBefore = report.held.length;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => (await page.evaluate(() => window.__calls.length));
  const open = (name) => page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  /** Frames from the one before `how`, which makes the detail list `add` as well. */
  const bring = async (add, how, span = 900) => {
    moriPending = [...moriPending, add];
    const before = await calls();
    const frames = await page.evaluate(([span, how]) => window.__sample(span, how), [span, how]);
    const id = `request-${add.id}`;
    const shown = frames.filter((f) => f.cards[id]);
    return { id, frames, shown, at: shown[0]?.cards[id], calls: (await page.evaluate(() => window.__calls.slice())).slice(before) };
  };
  const onlyShows = (label, got) => ok(`${tag}: ${label}: it shows with nothing playing (${got.shown.length} frames, ${got.calls.length} animate() calls)`,
    !got.frames[0]?.cards[got.id] && got.shown.length > 5 && got.calls.length === 0 && still(got.frames), { at: got.at, first: got.frames[0] });
  try {
    await page.goto("http://yuzuno-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.locator(`#${LISTED}`).waitFor();
    const first = await page.evaluate(() => window.__sample(600));
    report.frames[`${tag}: the conversation opened`] = first;
    ok(`${tag}: opening the conversation, its listed request shows with nothing playing (${first.length} frames; ${await calls()} animate() calls on a card)`,
      first.length > 10 && (await calls()) === 0 && first.every((f) => f.cards[LISTED]) && still(first), first[0]);

    // CV:Q-01: Core announces a change, and the detail read after it lists a new request.
    const came = await bring(request("live-1", "npm test"), "__announce");
    report.frames[`${tag}: a request arrives live`] = came.frames;
    const end = came.shown.at(-1)?.cards[came.id];
    ok(`${tag}: the announced request was not yet shown when the frames began, and shows within them (from ${came.shown[0]?.t} ms, ${came.shown.length} frames)`,
      !came.frames[0]?.cards[came.id] && came.shown.length > 5, came.frames[0]);
    if (reduced) {
      ok(`${tag}: under reduced motion, a request that arrives live shows with nothing playing`,
        !!came.at && came.calls.length === 0 && still(came.shown), came.at);
    } else {
      const fade = fadeOf(came.at?.plays);
      ok(`${tag}: a request that arrives live fades in over small, opacity only (${fade?.keys}, ${fade?.duration} ms, ${came.at?.opacity} in its first frame), and nothing in it moves`,
        !!fade && fade.duration === 180 && came.at.plays.length === 1 && came.at.opacity < 1 && came.shown.every((f) => f.cards[came.id].transform === "none")
          && came.calls.length === 1 && came.calls[0].id === came.id, { at: came.at, calls: came.calls });
      ok(`${tag}: and it ends at opacity 1 with nothing left playing`, end?.opacity === 1 && !end.plays.length, end);
    }
    ok(`${tag}: in its first frame Allow once is enabled and takes the pointer${came.at?.allow?.inView ? ", on top at its centre" : " (below the fold: hit not tested here; the click row tests it)"}`,
      !!came.at?.allow && !came.at.allow.disabled && came.at.allow.pointerEvents !== "none" && (!came.at.allow.inView || came.at.allow.onTop), came.at?.allow);
    ok(`${tag}: the request already listed plays nothing as the other arrives`,
      came.frames.every((f) => f.cards[LISTED] && !f.cards[LISTED].plays.length && f.cards[LISTED].opacity === 1), came.frames[0]?.cards[LISTED]);

    // The same list read again, after an announcement and after a reset: nothing plays.
    for (const how of ["__announce", "__reset"]) {
      const mark = await calls();
      const again = await page.evaluate((how) => window.__sample(600, how), how);
      ok(`${tag}: the same requests read again after ${how === "__reset" ? "a reset" : "an announcement"}: nothing plays (${(await calls()) - mark} calls)`,
        (await calls()) === mark && still(again) && again.every((f) => f.cards[LISTED] && f.cards[came.id]), again[0]);
    }

    // What a sync brings is only shown (Lead 3250): a reset, and an announcement a reset follows before the read.
    onlyShows("a request a Core reset brings", await bring(request("sync-1", "npm run fmt"), "__reset"));
    onlyShows("a request announced and then reset before the read", await bring(request("sync-2", "npm run docs"), "__announceThenReset"));

    // Another native session of the same Agent is a new baseline.
    agents[0].threadId = "th-a-2";
    onlyShows("a new native session listed with a new request", await bring(request("session-1", "npm run check"), "__announce"));

    // To another Agent and back: the cards there show with nothing playing.
    const leave = await calls();
    if (run.phone) await page.locator(".phone-back").click();
    await open("Hana");
    await page.waitForTimeout(300);
    if (run.phone) await page.locator(".phone-back").click();
    await open("Mori");
    await page.locator(`#${came.id}`).waitFor();
    const back = await page.evaluate(() => window.__sample(400));
    ok(`${tag}: to another Agent and back, every card shows with nothing playing (${(await calls()) - leave} calls)`,
      (await calls()) === leave && still(back) && back.every((f) => f.cards[LISTED] && f.cards[came.id] && f.cards["request-session-1"]), back[0]);

    if (!reduced) {
      // Reduced motion turned on while a live request fades in, held at 60 ms; in the new session, after the return.
      const third = request("live-2", "npm run build");
      moriPending = [...moriPending, third];
      const held = await page.evaluate((id) => window.__hold(id, 60), `request-${third.id}`);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const during = await page.evaluate(() => window.__sample(250));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const after = await page.evaluate(() => window.__sample(300));
      report.frames[`${tag}: reduced motion turned on mid-way`] = { held, during, after };
      const card = (f) => f.cards[`request-${third.id}`];
      const settled = (f) => card(f) && !card(f).plays.length && card(f).opacity === 1;
      const stillHeld = (f) => card(f)?.plays.length === 1 && Math.round(card(f).plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while a live request fades in (held at 60 ms, opacity ${held.opacity}): it stops within a frame of the change, fully shown from then on (first frame: ${during[0] && settled(during[0]) ? "shown" : "still held"})`,
        held.held && held.opacity < 1 && during.length > 1 && (settled(during[0]) || stillHeld(during[0])) && during.slice(1).every(settled), { held, during: during.slice(0, 3) });
      ok(`${tag}: and turned off again, nothing plays again`, after.length > 0 && after.every(settled), after.slice(0, 2));
    }

    // Pressed while it comes in: a live request, its fade held at 60 ms (none under reduced
    // motion), and Allow once clicked where it shows. The reply is held, never answered.
    const last = request("live-3", "npm run e2e");
    moriPending = [...moriPending, last];
    const id = `request-${last.id}`;
    const hold = reduced
      ? await page.evaluate((id) => window.__sample(900, "__announce").then((f) => ({ held: false, shown: f.some((x) => x.cards[id]), plays: f.some((x) => x.cards[id]?.plays.length) })), id)
      : await page.evaluate((id) => window.__hold(id, 60), id);
    await page.locator(`#${id} .button-row .primary-button`).click({ timeout: 3000 });
    const sent = () => report.held.slice(heldBefore).filter((h) => h.id === last.id);
    for (let n = 0; n < 40 && !sent().length; n++) await page.waitForTimeout(50);
    const pressed = await page.evaluate((id) => [...document.getElementById(id).querySelectorAll(".button-row button")]
      .map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, busy: b.getAttribute("aria-busy") })), id);
    report.frames[`${tag}: pressed while it comes in`] = { hold, pressed };
    ok(reduced
      ? `${tag}: under reduced motion, Allow once on a request that just arrived live (nothing playing) is sent, once (${sent().length})`
      : `${tag}: Allow once pressed while its card fades in (held at 60 ms, opacity ${hold.opacity}) is sent, once (${sent().length})`,
      (reduced ? hold.shown && !hold.plays : hold.held && hold.opacity < 1) && sent().length === 1
        && JSON.parse(sent()[0].body).response?.decision === "accept", { hold, sent: sent() });
    ok(`${tag}: and every decision on it locks at once, Allow once busy`,
      pressed.length === 4 && pressed.every((b) => b.disabled) && pressed[0].busy === "true", pressed);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  ok(`${tag}: one decision was sent and held in this run (${report.held.length - heldBefore})`, report.held.length - heldBefore === 1, report.held.slice(heldBefore));
  await context.close();
}
await browser.close();
ok(`nothing else was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d1-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
