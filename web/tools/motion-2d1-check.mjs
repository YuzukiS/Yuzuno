// T-19 slice 2d-1, a request card that arrives while its conversation is open (M9: CV:Q-01), in
// Chromium on a production build of the app with a synthetic Workspace that is never written to. The
// arriving card fades in over small, opacity only: nothing in it moves, and its buttons work from the
// first frame it shows. A card listed when the conversation first shows, listed again by a refresh, or
// shown again after a return from another Agent plays nothing; nor does reduced motion, and reduced
// motion turned on while it fades stops the fade. Allow once, pressed while its card is still coming
// in, is sent and every decision locks. Writes: one decision per run, held and never answered, and the
// app's own saves of where an Agent was read; anything else is refused and counted. Chromium is not
// Safari.
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
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("a", "Mori"), agent("b", "Hana")];
const turns = (who) => Array.from({ length: 4 }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(20)}` },
] }));
// Synthetic requests: one listed from the start, one that arrives later.
const request = (id, command) => ({ id, agentId: "a", method: "item/commandExecution/requestApproval",
  params: { command, cwd: "/w", reason: "A synthetic request", threadId: "th", turnId: "Mori-t3", itemId: `cmd-${id}`,
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] },
  createdAt: new Date().toISOString() });
const listed = request("listed-1", "npm run lint");
const arriving = request("arrives-1", "npm test");
let moriPending = [listed];
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

/** In the page: the request cards every frame, and every animate() on one, from the first script on. */
function pageHelpers() {
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
  // A refresh: the event stream is not open here, so a focus reads the snapshot again.
  window.__refresh = () => window.dispatchEvent(new Event("focus"));
  /** Every frame for `span` ms, from the frame before `trigger` runs. */
  window.__sample = (span, trigger) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      seen.push({ t: Math.round(performance.now() - t0), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, cards: window.__cards() });
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    requestAnimationFrame(frame);
    trigger?.();
  });
  /** A refresh that brings card `id`; its fade is held at `at` ms the frame it is found (as motion-2a-check does). */
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
    window.__refresh();
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
const ARRIVES = `request-${arriving.id}`;
const fadeOf = (plays) => plays?.find((p) => p.keys === "opacity/opacity");
const still = (frames) => frames.every((f) => Object.values(f.cards).every((c) => !c.plays.length && c.opacity === 1));
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  moriPending = [listed];
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  const calls = async () => (await page.evaluate(() => window.__calls.length));
  const open = (name) => page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  try {
    await page.goto("http://yuzuno-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.locator(`#${LISTED}`).waitFor();
    const first = await page.evaluate(() => window.__sample(600));
    report.frames[`${tag}: the conversation opened`] = first;
    ok(`${tag}: opening the conversation, its listed request shows with nothing playing (${first.length} frames; ${await calls()} animate() calls on a card)`,
      first.length > 10 && (await calls()) === 0 && first.every((f) => f.cards[LISTED]) && still(first), first[0]);

    // CV:Q-01: a request arrives while the conversation is open; frames from the one before the refresh.
    moriPending = [listed, arriving];
    const before = await calls();
    const came = await page.evaluate(() => window.__sample(900, window.__refresh));
    report.frames[`${tag}: a request arrives`] = came;
    const shown = came.filter((f) => f.cards[ARRIVES]);
    const at = shown[0]?.cards[ARRIVES];
    const end = shown.at(-1)?.cards[ARRIVES];
    const callsNow = (await page.evaluate(() => window.__calls.slice())).slice(before);
    ok(`${tag}: the request was not yet shown when the frames began, and shows within them (from ${shown[0]?.t} ms, ${shown.length} frames)`,
      !came[0]?.cards[ARRIVES] && shown.length > 5, came[0]);
    if (reduced) {
      ok(`${tag}: under reduced motion, a request that arrives shows with nothing playing`,
        !!at && callsNow.length === 0 && still(shown), at);
    } else {
      const fade = fadeOf(at?.plays);
      ok(`${tag}: a request that arrives fades in over small, opacity only (${fade?.keys}, ${fade?.duration} ms, ${at?.opacity} in its first frame), and nothing in it moves`,
        !!fade && fade.duration === 180 && at.plays.length === 1 && at.opacity < 1 && shown.every((f) => f.cards[ARRIVES].transform === "none")
          && callsNow.length === 1 && callsNow[0].id === ARRIVES, { at, callsNow });
      ok(`${tag}: and it ends at opacity 1 with nothing left playing`, end?.opacity === 1 && !end.plays.length, end);
    }
    ok(`${tag}: in its first frame Allow once is enabled and takes the pointer${at?.allow?.inView ? ", on top at its centre" : " (below the fold: hit not tested here; the click row tests it)"}`,
      !!at?.allow && !at.allow.disabled && at.allow.pointerEvents !== "none" && (!at.allow.inView || at.allow.onTop), at?.allow);
    ok(`${tag}: the request already listed plays nothing as the other arrives`,
      came.every((f) => f.cards[LISTED] && !f.cards[LISTED].plays.length && f.cards[LISTED].opacity === 1), came[0]?.cards[LISTED]);

    // The same list read again: nothing plays.
    const mark = await calls();
    const again = await page.evaluate(() => window.__sample(600, window.__refresh));
    ok(`${tag}: a refresh that lists the same requests plays nothing (${(await calls()) - mark} calls)`,
      (await calls()) === mark && still(again) && again.every((f) => f.cards[LISTED] && f.cards[ARRIVES]), again[0]);

    // To another Agent and back: the cards there show with nothing playing.
    const leave = await calls();
    if (run.phone) await page.locator(".phone-back").click();
    await open("Hana");
    await page.waitForTimeout(300);
    if (run.phone) await page.locator(".phone-back").click();
    await open("Mori");
    await page.locator(`#${ARRIVES}`).waitFor();
    const back = await page.evaluate(() => window.__sample(400));
    ok(`${tag}: to another Agent and back, both cards show with nothing playing (${(await calls()) - leave} calls)`,
      (await calls()) === leave && still(back) && back.every((f) => f.cards[LISTED] && f.cards[ARRIVES]), back[0]);

    if (!reduced) {
      // Reduced motion turned on while an arriving request fades in, held at 60 ms.
      const third = request("arrives-2", "npm run build");
      moriPending = [listed, arriving, third];
      const held = await page.evaluate((id) => window.__hold(id, 60), `request-${third.id}`);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const during = await page.evaluate(() => window.__sample(250));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const after = await page.evaluate(() => window.__sample(300));
      report.frames[`${tag}: reduced motion turned on mid-way`] = { held, during, after };
      const card = (f) => f.cards[`request-${third.id}`];
      const settled = (f) => card(f) && !card(f).plays.length && card(f).opacity === 1;
      const stillHeld = (f) => card(f)?.plays.length === 1 && Math.round(card(f).plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while a request fades in (held at 60 ms, opacity ${held.opacity}): it stops within a frame of the change, fully shown from then on (first frame: ${during[0] && settled(during[0]) ? "shown" : "still held"})`,
        held.held && held.opacity < 1 && during.length > 1 && (settled(during[0]) || stillHeld(during[0])) && during.slice(1).every(settled), { held, during: during.slice(0, 3) });
      ok(`${tag}: and turned off again, nothing plays again`, after.length > 0 && after.every(settled), after.slice(0, 2));
    }

    // Pressed while it comes in: a fourth request, its fade held at 60 ms (none under reduced
    // motion), and Allow once clicked where it shows. The reply is held, never answered.
    const fourth = request("arrives-3", "npm run e2e");
    moriPending = [...moriPending, fourth];
    const id = `request-${fourth.id}`;
    const hold = reduced
      ? await page.evaluate((id) => window.__sample(900, window.__refresh).then((f) => ({ held: false, shown: f.some((x) => x.cards[id]) })), id)
      : await page.evaluate((id) => window.__hold(id, 60), id);
    const allow = page.locator(`#${id} .button-row .primary-button`);
    await allow.click({ timeout: 3000 });
    for (let n = 0; n < 40 && !report.held.some((h) => h.id === fourth.id); n++) await page.waitForTimeout(50);
    const pressed = await page.evaluate((id) => ({ card: window.__cards()[id],
      buttons: [...document.getElementById(id).querySelectorAll(".button-row button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, busy: b.getAttribute("aria-busy") })) }), id);
    report.frames[`${tag}: pressed while it comes in`] = { hold, pressed };
    ok(reduced
      ? `${tag}: under reduced motion, Allow once on a request that just arrived is pressed at once`
      : `${tag}: Allow once pressed while its card fades in (held at 60 ms, opacity ${hold.opacity}) is sent, once (${report.held.filter((h) => h.id === fourth.id).length})`,
      (reduced ? hold.shown : hold.held && hold.opacity < 1) && report.held.filter((h) => h.id === fourth.id).length === 1
        && JSON.parse(report.held.find((h) => h.id === fourth.id).body).response?.decision === "accept", { hold, held: report.held });
    ok(`${tag}: and every decision on it locks at once, Allow once busy`,
      pressed.buttons.length === 4 && pressed.buttons.every((b) => b.disabled) && pressed.buttons[0].busy === "true", pressed.buttons);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`one decision per run was sent and held (${report.held.length})`, report.held.length === runs.length, report.held);
ok(`nothing else was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d1-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
