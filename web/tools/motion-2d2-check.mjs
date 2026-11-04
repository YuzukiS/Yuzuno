// T-19 slice 2d-2, a message sent from this window and an action's error (M9: CV:OM-01, SH:X05), in
// Chromium on a production build of the app with a synthetic Workspace and a stand-in event stream
// this check speaks for Core. A message sent while its Agent is shown comes in: its preview fades in
// and rises 4 px over small, once ("your message is on its way"). A preview Core lists from elsewhere,
// or one shown again after a return from another Agent, plays nothing. An action's error above the
// composer fades in over small, opacity only, and its Dismiss works from the first frame. Under
// reduced motion nothing plays, and reduced motion turned on while either comes in stops it. Writes:
// the sends themselves (held, never answered, or refused by the fixture for the error) and the app's
// own saves of where an Agent was read; anything else is refused and counted. Served from
// http://127.0.0.1 (a secure context: the composer needs crypto.randomUUID). Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d2-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d2");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], sends: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("a", "Mori"), agent("b", "Hana"), agent("k", "Kumo")];
const turns = (who) => Array.from({ length: 3 }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(8)}` },
] }));
// Receipts Core lists for Mori: a message on its way from another window, once released.
let moriReceipts;
let staged = [];
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: [], artifacts: [], turns: turns("Mori"), messageReceipts: moriReceipts },
  "/api/agents/b": { agent: agents[1], pending: [], artifacts: [], turns: turns("Hana"), messageReceipts: [] },
  "/api/agents/k": { agent: agents[2], pending: [], artifacts: [], turns: turns("Kumo"), messageReceipts: [] },
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
    const send = request.method() === "POST" && /^\/api\/agents\/([^/]+)\/messages$/.exec(url.pathname);
    if (send) {
      report.sends.push({ agent: send[1], body: request.postData()?.slice(0, 300) });
      // Kumo's sends are refused, so their error shows; the others are held, never answered.
      if (send[1] === "k") return route.fulfill({ status: 400, json: { error: "Refused by this check", code: "check_refused" } });
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

/** In the page, from the first script on: the event stream, spoken for Core by this check; the
 * previews and the composer's error every frame; every animate() on either. */
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
  // What the check staged becomes Core's state, and then Core announces a change to Mori.
  window.__announce = async () => {
    await fetch("/__check/release");
    const stream = streams.findLast((s) => s.readyState === 1);
    if (!stream) throw new Error("no open stream");
    stream.onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: "a" }), lastEventId: String(++id) });
  };
  const plays = (el) => el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      duration: a.effect.getTiming().duration, current: a.currentTime };
  });
  const look = (el) => {
    const style = getComputedStyle(el);
    return { opacity: Number(style.opacity), transform: style.transform, plays: plays(el) };
  };
  window.__error = () => [...document.querySelectorAll(".inline-error")].find((el) => el.textContent.includes("Refused by this check")) ?? null;
  window.__state = () => {
    const error = window.__error();
    let dismiss = null;
    if (error) {
      const button = error.querySelector("button");
      const box = button?.getBoundingClientRect();
      const hit = box && box.width ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
      dismiss = button ? { disabled: button.disabled, onTop: !!hit && button.contains(hit) } : null;
    }
    return {
      previews: Object.fromEntries([...document.querySelectorAll(".outgoing-message[data-client-message-id]")]
        .map((el) => [el.querySelector(".user-text")?.textContent?.trim().slice(0, 40) ?? el.dataset.clientMessageId, look(el)])),
      error: error ? { ...look(error), dismiss } : null,
    };
  };
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".outgoing-message, .inline-error")) window.__calls.push({ t: Math.round(performance.now()), what: this.className });
    return animate.call(this, keyframes, options);
  };
  /** Every frame for `span` ms, from the frame before `how` (a helper's name) runs. */
  window.__sample = (span, how) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      seen.push({ t: Math.round(performance.now() - t0), reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, ...window.__state() });
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    requestAnimationFrame(frame);
    if (how) window[how]();
  });
  /** Holds the first animation found on `find()` at `at` ms, the frame it is found. */
  window.__holdFirst = (selector, text, at) => new Promise((done) => {
    let tries = 0;
    const tick = () => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text));
      const fade = el?.getAnimations()[0];
      if (!fade && ++tries > 180) return done({ held: false, shown: !!el });
      if (!fade) return requestAnimationFrame(tick);
      fade.pause();
      fade.currentTime = at;
      requestAnimationFrame(() => done({ held: true, opacity: Number(getComputedStyle(el).opacity), transform: getComputedStyle(el).transform }));
    };
    requestAnimationFrame(tick);
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
const still = (frames) => frames.every((f) => Object.values(f.previews).every((p) => !p.plays.length && p.opacity === 1)
  && (!f.error || (!f.error.plays.length && f.error.opacity === 1)));
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  moriReceipts = [];
  staged = [];
  const sendsBefore = report.sends.length;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  // Kept to read, not counted: a refused read or send logs a failed load too.
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => (await page.evaluate(() => window.__calls.slice()));
  const open = async (name) => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  };
  /** Types `text` into the open Agent's composer and sends it; frames from the frame before the press. */
  const send = async (name, text, span = 700) => {
    const box = page.getByRole("textbox", { name: `Message ${name}` });
    await box.click();
    await page.keyboard.insertText(text);
    const button = page.getByRole("button", { name: "Send message", exact: true });
    await button.waitFor();
    const before = (await calls()).length;
    const sampling = page.evaluate((span) => window.__sample(span), span);
    await button.click();
    const frames = await sampling;
    return { frames, calls: (await calls()).slice(before) };
  };
  try {
    await page.goto("http://127.0.0.1:4319/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.getByRole("textbox", { name: "Message Mori" }).waitFor();

    // CV:OM-01: a message sent from here.
    const sent = await send("Mori", "Run the tests, please");
    report.frames[`${tag}: a message sent from here`] = sent.frames;
    const shown = sent.frames.filter((f) => f.previews["Run the tests, please"]);
    const at = shown[0]?.previews["Run the tests, please"];
    const end = shown.at(-1)?.previews["Run the tests, please"];
    if (reduced) {
      ok(`${tag}: under reduced motion, a message sent from here: its preview shows with nothing playing`,
        shown.length > 5 && sent.calls.filter((c) => c.what.includes("outgoing")).length === 0 && still(shown), at);
    } else {
      const fade = at?.plays.find((p) => p.keys === "opacity+transform/opacity+transform");
      ok(`${tag}: a message sent from here: its preview fades in and rises 4 px over small (${fade?.keys}, ${fade?.duration} ms; first frame opacity ${at?.opacity}, ${at?.transform}), and ends in place`,
        !!fade && fade.duration === 180 && at.opacity < 1 && /matrix\(1, 0, 0, 1, 0, [1-4](\.\d+)?\)/.test(at.transform)
          && sent.calls.filter((c) => c.what.includes("outgoing")).length === 1 && end?.opacity === 1 && end.transform === "none" && !end.plays.length, { at, end });
    }

    // A preview Core lists from elsewhere (another window's message on its way): only shown.
    staged.push(() => { moriReceipts = [{ input: { clientMessageId: "other-1", text: "From another window", expectedTurnId: null, question: null }, status: "sending", turnId: null }]; });
    const mark = (await calls()).length;
    const listed = await page.evaluate(() => window.__sample(900, "__announce"));
    const otherShown = listed.filter((f) => f.previews["From another window"]);
    ok(`${tag}: a preview Core lists from elsewhere shows with nothing playing (${otherShown.length} frames, ${(await calls()).length - mark} calls)`,
      otherShown.length > 5 && (await calls()).length === mark && still(listed), otherShown[0]?.previews["From another window"]);

    // To another Agent and back: the previews there show with nothing playing.
    const leave = (await calls()).length;
    await open("Hana");
    await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
    await open("Mori");
    await page.locator(".outgoing-message").first().waitFor();
    const back = await page.evaluate(() => window.__sample(500));
    ok(`${tag}: to another Agent and back, the previews show with nothing playing (${(await calls()).length - leave} calls)`,
      (await calls()).length === leave && back.every((f) => f.previews["Run the tests, please"]) && still(back), Object.keys(back[0]?.previews ?? {}));

    if (!reduced) {
      // Reduced motion turned on while a preview comes in, held at 60 ms (Hana: Mori's send is still on its way).
      await open("Hana");
      const box = page.getByRole("textbox", { name: "Message Hana" });
      await box.click();
      await page.keyboard.insertText("Build it");
      const holding = page.evaluate(() => window.__holdFirst(".outgoing-message", "Build it", 60));
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const held = await holding;
      await page.emulateMedia({ reducedMotion: "reduce" });
      const during = await page.evaluate(() => window.__sample(250));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const after = await page.evaluate(() => window.__sample(300));
      report.frames[`${tag}: reduced motion turned on while a preview comes in`] = { held, during: during.slice(0, 3), after: after.slice(0, 2) };
      const p = (f) => f.previews["Build it"];
      const settled = (f) => p(f) && !p(f).plays.length && p(f).opacity === 1 && p(f).transform === "none";
      const stillHeld = (f) => p(f)?.plays.length === 1 && Math.round(p(f).plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while a preview comes in (held at 60 ms, opacity ${held.opacity}): it stops within a frame of the change, in place from then on (first frame: ${during[0] && settled(during[0]) ? "in place" : "still held"})`,
        held.held && held.opacity < 1 && during.length > 1 && (settled(during[0]) || stillHeld(during[0])) && during.slice(1).every(settled), { held, during: during.slice(0, 3) });
      ok(`${tag}: and turned off again, nothing plays again`, after.length > 0 && after.every(settled), after.slice(0, 2));
    }

    // SH:X05: a send Core refuses (Kumo): its error appears above the composer.
    await open("Kumo");
    await page.getByRole("textbox", { name: "Message Kumo" }).waitFor();
    if (!reduced) {
      const holding = page.evaluate(() => window.__holdFirst(".inline-error", "Refused by this check", 60));
      const first = await send("Kumo", "This will be refused", 400);
      const errorShown = first.frames.filter((f) => f.error);
      const e0 = errorShown[0]?.error;
      const fade = e0?.plays.find((p) => p.keys === "opacity/opacity");
      const held = await holding;
      report.frames[`${tag}: an action's error appears`] = { frames: first.frames, held };
      ok(`${tag}: an action's error appears above the composer: it fades in over small, opacity only (${fade?.keys}, ${fade?.duration} ms; first frame opacity ${e0?.opacity}), and nothing in it moves`,
        !!fade && fade.duration === 180 && e0.opacity < 1 && errorShown.every((f) => f.error.transform === "none")
          && first.calls.filter((c) => c.what.includes("inline-error")).length === 1, { e0, calls: first.calls });
      ok(`${tag}: its Dismiss is enabled and on top at its centre from the first frame`, !!e0?.dismiss && !e0.dismiss.disabled && e0.dismiss.onTop, e0?.dismiss);
      // Reduced motion turned on while it fades in (held at 60 ms above): it stops.
      await page.emulateMedia({ reducedMotion: "reduce" });
      const during = await page.evaluate(() => window.__sample(250));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const er = (f) => f.error;
      const settled = (f) => er(f) && !er(f).plays.length && er(f).opacity === 1;
      const stillHeld = (f) => er(f)?.plays.length === 1 && Math.round(er(f).plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while the error fades in (held at 60 ms, opacity ${held.opacity}): it stops within a frame of the change, fully shown from then on`,
        held.held && held.opacity < 1 && during.length > 1 && (settled(during[0]) || stillHeld(during[0])) && during.slice(1).every(settled), { held, during: during.slice(0, 3) });
    } else {
      const first = await send("Kumo", "This will be refused", 600);
      const errorShown = first.frames.filter((f) => f.error);
      ok(`${tag}: under reduced motion, an action's error appears above the composer with nothing playing, its Dismiss on top`,
        errorShown.length > 5 && first.calls.filter((c) => c.what.includes("inline-error")).length === 0 && errorShown.every((f) => !f.error.plays.length && f.error.opacity === 1)
          && !!errorShown[0].error.dismiss && errorShown[0].error.dismiss.onTop, errorShown[0]?.error);
    }
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  const sendsHere = report.sends.slice(sendsBefore).map((s) => s.agent);
  const expectSends = reduced ? ["a", "k"] : ["a", "b", "k"];
  ok(`${tag}: the sends were exactly those made here (${sendsHere.join(", ")})`, JSON.stringify(sendsHere) === JSON.stringify(expectSends), sendsHere);
  await context.close();
}
await browser.close();
ok(`nothing else was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d2-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
