// T-19 slice 2d-4, Back to latest (M9: SH:C19, CV:CW-05), in Chromium on a production build of the
// app with a synthetic Workspace and a stand-in event stream this check speaks for Core.
// - Scrolled 96 px or more from the end it comes in: it fades in and rises 4 px over small, centred
//   all the while, and takes the pointer from its first frame. Under 48 px it leaves through a copy,
//   aria-hidden, inert and passed through by the pointer, that fades out over exit-small where it
//   was. Between, it stays as it was, so a scroll that wavers there does not make it flicker.
// - Back to latest pressed leaves the same way. Another Agent shown takes it away at once.
// - Under reduced motion nothing plays and no copy is left; reduced motion turned on while it comes
//   in or leaves stops it.
// Writes: only the app's own saves of where an Agent was read; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d4-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d4");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("a", "Mori"), agent("b", "Hana")];
// Mori's conversation is long enough to be read well away from its end; Hana's is short.
const turns = (who, count, lines) => Array.from({ length: count }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: Array.from({ length: lines }, (_, i) => `${who} answer ${n + 1}, part ${i + 1}. ${"A line of the answer. ".repeat(6)}`).join("\n\n") },
] }));
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: [], artifacts: [], turns: turns("Mori", 10, 6), messageReceipts: [] },
  "/api/agents/b": { agent: agents[1], pending: [], artifacts: [], turns: turns("Hana", 1, 1), messageReceipts: [] },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
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

/** In the page, from the first script on: the event stream (a fresh connection starts with `reset`,
 * as events.rs does); Back to latest and its copy every frame; every animate() on it. */
function pageHelpers() {
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        const start = url.includes("lastEventId") ? { type: "resumed" } : { type: "reset", reason: "new" };
        this.onmessage?.({ data: JSON.stringify(start), lastEventId: "1" });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  const plays = (el) => el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { name: a.animationName ?? "", duration: a.effect.getTiming().duration, current: a.currentTime,
      keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/") };
  });
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round((r.left + r.width / 2) * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };
  const hit = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width) return false;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && el.contains(at);
  };
  window.__pane = () => document.querySelector(".conversation-scroll");
  window.__state = () => {
    const pane = window.__pane();
    const pill = document.querySelector("button.jump-latest");
    const copy = document.querySelector(".jump-latest-leaving");
    const style = (el) => getComputedStyle(el);
    return {
      gap: pane ? Math.round(pane.scrollHeight - pane.clientHeight - pane.scrollTop) : null,
      pill: pill ? { ...box(pill), opacity: Number(style(pill).opacity), transform: style(pill).transform, plays: plays(pill), onTop: hit(pill) } : null,
      copy: copy ? { ...box(copy), opacity: Number(style(copy).opacity), display: style(copy).display, plays: plays(copy),
        ariaHidden: copy.getAttribute("aria-hidden"), inert: copy.inert === true, pointer: style(copy).pointerEvents, passedThrough: !hit(copy) } : null,
    };
  };
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".jump-latest, .jump-latest-leaving")) window.__calls.push({ t: Math.round(performance.now()), what: this.className });
    return animate.call(this, keyframes, options);
  };
  /** Scrolls Mori's conversation to `gap` px from its end. */
  window.__toGap = (gap) => {
    const pane = window.__pane();
    pane.scrollTop = pane.scrollHeight - pane.clientHeight - gap;
  };
  /** Scrolls to each of `gaps` in turn, `every` ms apart: a scroll that wavers. */
  window.__waver = ({ gaps, every }) => gaps.forEach((gap, i) => setTimeout(() => window.__toGap(gap), i * every));
  /** Every frame for `span` ms. The first record is taken before `how` runs, with `arg`. */
  window.__sample = (span, how, arg) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const record = () => seen.push({ t: Math.round(performance.now() - t0), ...window.__state() });
    const frame = () => {
      record();
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    record();
    requestAnimationFrame(frame);
    if (how) window[how](arg);
  });
  /** Holds the first animation on `selector` at `at` ms, the frame it is found. */
  window.__hold = (selector, at) => new Promise((done) => {
    let tries = 0;
    const tick = () => {
      const el = document.querySelector(selector);
      const fade = el?.getAnimations()[0];
      if (!fade && ++tries > 120) return done({ held: false, shown: !!el });
      if (!fade) return requestAnimationFrame(tick);
      fade.pause();
      fade.currentTime = at;
      requestAnimationFrame(() => done({ held: true, opacity: Number(getComputedStyle(el).opacity) }));
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
const near = (a, b, d) => Math.abs(a - b) <= d;
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  // Kept to read, not counted: a refused read logs a failed load.
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => (await page.evaluate(() => window.__calls.length));
  const sample = (span, how, arg) => page.evaluate(([span, how, arg]) => window.__sample(span, how, arg), [span, how, arg]);
  const open = async (name) => {
    if (run.phone && await page.locator(".phone-back").count()) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  };
  /** From a known state: at the end (nothing shown or leaving), or well away (shown, done coming in). */
  const atEnd = async () => { await page.evaluate(() => window.__toGap(0)); await page.waitForTimeout(600); };
  const away = async () => { await atEnd(); await page.evaluate(() => window.__toGap(300)); await page.waitForTimeout(500); };
  const record = (label, frames) => { report.frames[`${tag}: ${label}`] = frames; return frames; };
  const none = (frames) => frames.every((f) => !f.pill && !f.copy);
  const restful = (frames) => frames.every((f) => f.pill && !f.pill.plays.length && f.pill.opacity === 1 && !f.copy);
  try {
    await page.goto("http://127.0.0.1:4319/");
    await page.locator(".agent-row").first().waitFor();
    await open("Mori");
    await page.locator('[data-item-id="Mori-r9"]').waitFor();
    await page.waitForTimeout(400);

    const opened = record("opened", await sample(300));
    ok(`${tag}: opened at the latest (${opened.at(-1).gap} px from the end), Back to latest is not shown`, opened.at(-1).gap < 8 && none(opened), opened.at(-1));

    // Between the 72 px line (where following stops) and 96 px: it does not come in.
    await atEnd();
    const between = record("80 px from the end", await sample(400, "__toGap", 80));
    ok(`${tag}: 80 px from the end (${between.at(-1).gap} px), Back to latest stays hidden`, near(between.at(-1).gap, 80, 4) && none(between), between.at(-1));

    // 120 px from the end: it comes in.
    await atEnd();
    const mark = await calls();
    const coming = record("120 px from the end", await sample(500, "__toGap", 120));
    const shown = coming.filter((f) => f.pill);
    const first = shown[0]?.pill;
    const last = shown.at(-1)?.pill;
    if (reduced) {
      ok(`${tag}: under reduced motion, 120 px from the end, Back to latest shows with nothing playing (${(await calls()) - mark} calls)`,
        !coming[0].pill && shown.length > 5 && (await calls()) === mark && restful(shown), first);
    } else {
      const fade = first?.plays.find((p) => p.keys === "opacity+transform/opacity+transform");
      const xs = shown.map((f) => f.pill.x);
      ok(`${tag}: 120 px from the end, Back to latest comes in: it fades in and rises 4 px over small (${fade?.keys}, ${fade?.duration} ms; first frame opacity ${first?.opacity}, ${first?.transform}), and ends in place`,
        !coming[0].pill && !!fade && fade.duration === 180 && first.opacity < 1 && /matrix\(1, 0, 0, 1, 0, [0-4](\.\d+)?\)/.test(first.transform)
          && first.y - last.y > 0.3 && first.y - last.y <= 4.5 && last.opacity === 1 && last.transform === "none" && !last.plays.length
          && (await calls()) - mark === 1, { first, last });
      ok(`${tag}: and it stays centred, taking the pointer from its first frame (x ${Math.min(...xs)}–${Math.max(...xs)})`,
        shown.length > 5 && Math.max(...xs) - Math.min(...xs) <= 0.6 && first.onTop, { xs: xs.slice(0, 4), first });
    }

    // Back within 72 px but not under 48 px: it stays.
    await away();
    const staying = record("60 px from the end, shown", await sample(400, "__toGap", 60));
    ok(`${tag}: shown, then 60 px from the end (${staying.at(-1).gap} px), Back to latest stays, with nothing playing`,
      near(staying.at(-1).gap, 60, 4) && restful(staying), staying.at(-1));

    // A scroll that wavers either side of 72 px, shown: it neither leaves nor comes in again.
    await away();
    const markShown = await calls();
    const waveringShown = record("wavering, shown", await sample(700, "__waver", { gaps: [85, 60, 85, 60], every: 120 }));
    ok(`${tag}: shown, a scroll wavering between 85 and 60 px from the end leaves Back to latest as it is (${(await calls()) - markShown} calls)`,
      restful(waveringShown) && (await calls()) === markShown, waveringShown.map((f) => f.gap));

    // Under 48 px: it leaves through a copy where it was.
    await away();
    const leaving = record("20 px from the end, shown", await sample(600, "__toGap", 20));
    const lastShown = [...leaving].reverse().find((f) => f.pill)?.pill;
    const goneAt = leaving.findIndex((f) => !f.pill);
    if (reduced) {
      ok(`${tag}: under reduced motion, 20 px from the end, Back to latest goes at once, and no copy is left`,
        !!leaving[0].pill && goneAt > 0 && leaving.slice(goneAt).every((f) => !f.pill && !f.copy), leaving[goneAt]);
    } else {
      const copy = leaving[goneAt]?.copy;
      const out = copy?.plays.find((p) => p.name === "jump-latest-out");
      ok(`${tag}: 20 px from the end, Back to latest leaves through a copy where it was (${copy ? `${copy.x},${copy.y} ${copy.w}×${copy.h}` : "none"}; it was ${lastShown ? `${lastShown.x},${lastShown.y} ${lastShown.w}×${lastShown.h}` : "none"}), fading out over exit-small (${out?.duration} ms)`,
        !!leaving[0].pill && goneAt > 0 && !!copy && !!lastShown && near(copy.x, lastShown.x, 1) && near(copy.y, lastShown.y, 1)
          && near(copy.w, lastShown.w, 1) && near(copy.h, lastShown.h, 1) && !!out && out.duration === 130
          && leaving.slice(goneAt).every((f) => !f.pill) && !leaving.at(-1).copy, { copy, lastShown });
      ok(`${tag}: the copy is aria-hidden and inert, and the pointer passes through it`,
        !!copy && copy.ariaHidden === "true" && copy.inert && copy.pointer === "none" && copy.passedThrough, copy);
    }

    // A scroll that wavers either side of 72 px, hidden: it does not come in.
    await atEnd();
    const markHidden = await calls();
    const waveringHidden = record("wavering, hidden", await sample(700, "__waver", { gaps: [60, 85, 60, 85], every: 120 }));
    ok(`${tag}: hidden, a scroll wavering between 60 and 85 px from the end does not bring Back to latest in (${(await calls()) - markHidden} calls)`,
      none(waveringHidden) && (await calls()) === markHidden, waveringHidden.map((f) => f.gap));

    // Pressed: the conversation goes to its end, and it leaves the same way.
    await away();
    const pressing = page.evaluate(() => window.__sample(900));
    await page.locator("button.jump-latest").click();
    const pressed = record("pressed", await pressing);
    const afterPress = pressed.slice(pressed.findIndex((f) => !f.pill));
    ok(`${tag}: Back to latest pressed: the conversation goes to its end (${pressed.at(-1).gap} px), and it ${reduced ? "goes at once, no copy left" : "leaves through a copy"}`,
      pressed.at(-1).gap < 8 && afterPress.length > 0 && afterPress.every((f) => !f.pill)
        && (reduced ? afterPress.every((f) => !f.copy) : afterPress.some((f) => f.copy) && !pressed.at(-1).copy), afterPress[0]);

    // Shown, then another Agent: it goes with Mori's conversation, and no copy comes over Hana's.
    await away();
    const switching = page.evaluate(() => window.__sample(500));
    await open("Hana");
    const hana = record("another Agent", await switching);
    ok(`${tag}: shown, then another Agent opened: no copy of Back to latest comes over its conversation`,
      hana.every((f) => !f.copy), hana.filter((f) => f.copy).slice(0, 2));
    await open("Mori");
    await page.locator(".conversation-scroll").waitFor();
    await page.waitForTimeout(400);
    // Mori may open again where it was left: back to its latest first.
    if (await page.locator("button.jump-latest").count()) await page.locator("button.jump-latest").click();
    await page.waitForTimeout(600);

    if (!reduced) {
      // Reduced motion turned on while it comes in, held at 60 ms.
      await atEnd();
      const holding = page.evaluate(() => window.__hold("button.jump-latest", 60));
      await page.evaluate(() => window.__toGap(300));
      const held = await holding;
      await page.emulateMedia({ reducedMotion: "reduce" });
      const during = await sample(250);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const after = await sample(300);
      record("reduced motion turned on while it comes in", { held, during: during.slice(0, 3), after: after.slice(0, 2) });
      const settled = (f) => f.pill && !f.pill.plays.length && f.pill.opacity === 1 && f.pill.transform === "none";
      const stillHeld = (f) => f.pill?.plays.length === 1 && Math.round(f.pill.plays[0].current) === 60;
      ok(`${tag}: reduced motion turned on while Back to latest comes in (held at 60 ms, opacity ${held.opacity}): it stops within a frame of the change, in place from then on`,
        held.held && held.opacity < 1 && during.length > 1 && (settled(during[0]) || stillHeld(during[0])) && during.slice(1).every(settled), { held, during: during.slice(0, 3) });
      ok(`${tag}: and turned off again, nothing plays again`, after.length > 0 && after.every(settled), after.slice(0, 2));

      // Reduced motion turned on while its copy leaves, held at 60 ms: the copy is gone.
      await page.waitForTimeout(300);
      const holdingCopy = page.evaluate(() => window.__hold(".jump-latest-leaving", 60));
      await page.evaluate(() => window.__toGap(20));
      const heldCopy = await holdingCopy;
      await page.emulateMedia({ reducedMotion: "reduce" });
      const gone = await sample(250);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      record("reduced motion turned on while its copy leaves", { heldCopy, gone: gone.slice(0, 3) });
      ok(`${tag}: reduced motion turned on while the copy leaves (held at 60 ms, opacity ${heldCopy.opacity}): it is gone within a frame of the change`,
        heldCopy.held && heldCopy.opacity < 1 && gone.length > 1 && gone.slice(1).every((f) => !f.pill && (!f.copy || f.copy.display === "none")), gone.slice(0, 3));
    }
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
await writeFile(join(output, "motion-2d4-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
