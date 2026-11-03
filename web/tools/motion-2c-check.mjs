// T-19 slice 2c, side panels (M7: SH:T01, T02, P03, WK:PT-01; PT-03 stays instant): in Chromium on a
// production build of the app with a synthetic Workspace that is never written to. A side panel shown
// again comes in from its side (opacity 0 → 1 and translateX(±8px) → none, medium): on a desktop window
// the Agent list from the left and the context panel from the right; on a phone the context panel from
// the right, its heading taking focus; the Portal beside the chat from the right. The column changes in
// the first frame, as before, and hiding or closing is instant. The first screen, arriving at a
// conversation, and a window turning into a phone's and back play none; nor does reduced motion. Writes:
// only the app's own saves of where an Agent was read, and the Portal's request for a preview, refused
// here. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2c-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2c");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], previewRequests: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("a", "Mori"), agent("b", "Hana")];
const turns = (who) => Array.from({ length: 6 }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(40)}` },
] }));
// A synthetic HTML file from Mori's latest turn: the Portal opens it beside the chat.
const page = "<!doctype html><meta charset=utf-8><title>Timer</title><body><h1>A synthetic page</h1></body>";
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: [], turns: turns("Mori"),
    artifacts: [{ path: "/w/timer.html", name: "timer.html", kind: "text", sourceItemId: "Mori-r5" }] },
  "/api/agents/b": { agent: agents[1], pending: [], artifacts: [], turns: turns("Hana") },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
};
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
    // The Portal asks Core for a preview of the file: refused here, so nothing is made.
    if (request.method() === "POST" && url.pathname === "/api/previews") {
      report.previewRequests.push(url.pathname);
      return route.fulfill({ status: 503, json: { error: "previews are not served in this check" } });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (url.pathname === "/api/artifact") return route.fulfill({ body: page, contentType: "text/plain" });
    return route.fulfill({ json: gets[url.pathname] ?? {} });
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

/** In the page: the side panels every frame for `span` ms from the next click or key, and every animate() on them. */
function pageHelpers() {
  const plays = (el) => (el ? el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      from: frames[0]?.transform ?? null, duration: a.effect.getTiming().duration, current: a.currentTime };
  }) : []);
  const box = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { shown: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0, opacity: Number(style.opacity),
      transform: style.transform, left: Math.round(rect.left), width: Math.round(rect.width), plays: plays(el) };
  };
  window.__panels = () => {
    const app = document.querySelector(".app");
    const main = document.querySelector(".main-panel")?.getBoundingClientRect();
    const focus = document.activeElement;
    const scroller = document.scrollingElement;
    return {
      rail: box(document.querySelector(".rail")),
      inspector: box(document.querySelector("aside.inspector")),
      portal: box(document.querySelector(".portal-panel")),
      main: main ? { left: Math.round(main.left), width: Math.round(main.width) } : null,
      withInspector: !!app?.classList.contains("with-inspector"),
      railHidden: !!app?.classList.contains("rail-hidden"),
      portalMode: document.documentElement.dataset.portal ?? null,
      focus: focus ? { tag: focus.tagName, text: (focus.textContent || "").trim().slice(0, 40), inInspector: !!focus.closest("aside.inspector") } : null,
      sideways: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  };
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const which = this.matches?.(".rail") ? "rail" : this.matches?.("aside.inspector") ? "inspector" : this.matches?.(".portal-panel") ? "portal" : null;
    if (which) window.__calls.push({ t: Math.round(performance.now()), which });
    return animate.call(this, keyframes, options);
  };
  // The first screen, frame by frame for 1.5 s from the first: nothing may come in before it is shown again.
  window.__boot = [];
  const t0 = performance.now();
  const sample = () => {
    window.__boot.push({ t: Math.round(performance.now() - t0), ...window.__panels() });
    if (performance.now() - t0 < 1500) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__watch = (span = 400) => {
    window.__frames = [];
    window.__mark = window.__calls.length;
    const start = () => {
      removeEventListener("click", start, true);
      removeEventListener("keydown", start, true);
      const t0 = performance.now();
      const frame = () => {
        window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__panels() });
        if (performance.now() - t0 < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("click", start, true);
    addEventListener("keydown", start, true);
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
const moveOf = (plays) => plays?.find((p) => p.keys === "opacity+transform/opacity+transform");
const still = (frames, part) => frames.every((f) => !(f[part]?.plays ?? []).length);
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  const step = async (what, act, span = 400) => {
    await page.evaluate((s) => window.__watch(s), span);
    await act();
    await page.waitForTimeout(span + 150);
    const seen = await page.evaluate(() => ({ frames: window.__frames, calls: window.__calls.slice(window.__mark) }));
    report.frames[`${tag}: ${what}`] = seen;
    return seen;
  };
  // A panel shown again: it comes in from its side over medium, its column (or place) taken in the first frame.
  const comesIn = (seen, part, from, what) => {
    const first = seen.frames[0];
    const last = seen.frames.at(-1);
    if (reduced) {
      ok(`${tag}: under reduced motion, ${what} shows with nothing playing`, first?.[part]?.shown && still(seen.frames, part) && !seen.calls.length, first?.[part]);
      return;
    }
    const move = moveOf(first?.[part]?.plays);
    ok(`${tag}: ${what} comes in from ${from} over medium (from ${move?.from}, ${move?.duration} ms), shown in the first frame`,
      first?.[part]?.shown && move?.duration === 240 && move.from === from && first[part].opacity < 1, first?.[part]);
    ok(`${tag}: and ${what} ends in place, nothing left playing (${last?.[part]?.transform}, opacity ${last?.[part]?.opacity})`,
      last?.[part]?.transform === "none" && last[part].opacity === 1 && !last[part].plays.length, last?.[part]);
  };
  const instant = (seen, part, what) => ok(`${tag}: ${what} goes at once, in the first frame, with nothing playing`,
    !seen.frames[0]?.[part]?.shown && seen.frames.every((f) => !f[part]?.shown) && !seen.calls.length, seen.frames[0]?.[part]);
  const nothing = (seen, what) => ok(`${tag}: ${what} plays nothing on the side panels (${seen.calls.length} animate() calls)`,
    !seen.calls.length && still(seen.frames, "rail") && still(seen.frames, "inspector") && still(seen.frames, "portal"), seen.calls);
  const open = (name) => page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  const toggle = (label) => page.locator(`.toolbar button[aria-label="${label}"]`).first().click();
  try {
    await page.goto("http://yuzuno-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    await page.waitForFunction(() => window.__boot.length > 0 && window.__boot.at(-1).t >= 1450);
    const boot = await page.evaluate(() => ({ frames: window.__boot, calls: window.__calls.slice() }));
    report.frames[`${tag}: first screen`] = boot;
    ok(`${tag}: the first screen plays nothing on the side panels (${boot.frames.length} frames from the first; ${boot.calls.length} animate() calls)`,
      boot.frames.length > 30 && !boot.calls.length && still(boot.frames, "rail") && still(boot.frames, "inspector"), boot.calls);

    // Arriving at a conversation: on a desktop window its context panel is already on, and arrives with it.
    const arrive = await step("open Mori", () => open("Mori"));
    nothing(arrive, "arriving at a conversation");
    await page.locator(".conversation-scroll [data-item-id]").first().waitFor();

    if (!run.phone) {
      ok(`${tag}: the context panel is on beside the conversation`, arrive.frames.at(-1).inspector?.shown && arrive.frames.at(-1).withInspector, arrive.frames.at(-1));
      // T02: closed, then opened again.
      const close = await step("close the context panel", () => page.locator('aside.inspector button[aria-label="Close context panel"]').click());
      instant(close, "inspector", "the context panel");
      ok(`${tag}: and its column goes with it in that frame`, !close.frames[0].withInspector, close.frames[0]);
      await page.waitForTimeout(150);
      const reopen = await step("open the context panel", () => toggle("Toggle context panel"));
      comesIn(reopen, "inspector", "translateX(8px)", "the context panel");
      ok(`${tag}: its column is there in the first frame: the conversation is as wide then as at the end (${reopen.frames[0].main?.width} → ${reopen.frames.at(-1).main?.width} px)`,
        reopen.frames[0].withInspector && reopen.frames[0].main?.width === reopen.frames.at(-1).main?.width, reopen.frames[0].main);
      ok(`${tag}: nothing scrolls sideways while it comes in`, reopen.frames.every((f) => f.sideways <= 0), reopen.frames.map((f) => f.sideways).slice(0, 4));

      // T01: the Agent list hidden, then shown again.
      await page.waitForTimeout(150);
      const hide = await step("hide the Agent list", () => toggle("Hide agent sidebar"));
      instant(hide, "rail", "the Agent list");
      ok(`${tag}: and its column goes with it in that frame`, hide.frames[0].railHidden, hide.frames[0]);
      await page.waitForTimeout(150);
      const show = await step("show the Agent list", () => toggle("Show agent sidebar"));
      comesIn(show, "rail", "translateX(-8px)", "the Agent list");
      ok(`${tag}: its column is there in the first frame: the conversation starts as far right then as at the end (${show.frames[0].main?.left} → ${show.frames.at(-1).main?.left} px)`,
        !show.frames[0].railHidden && show.frames[0].main?.left === show.frames.at(-1).main?.left, show.frames[0].main);
      ok(`${tag}: nothing scrolls sideways while it comes in`, show.frames.every((f) => f.sideways <= 0), show.frames.map((f) => f.sideways).slice(0, 4));

      // PT-01: the Portal beside the chat, from the file's preview; PT-03: closing it.
      await page.waitForTimeout(150);
      await page.locator('aside.inspector .artifact-row', { hasText: "timer.html" }).first().click();
      const choice = page.locator(".modal-footer .open-choice-split > .primary-button:not(.open-choice-more)");
      await choice.waitFor();
      const portal = await step("Preview beside", () => choice.click(), 500);
      const at = portal.frames.findIndex((f) => f.portal?.shown);
      const opened = { frames: portal.frames.slice(Math.max(at, 0)), calls: portal.calls.filter((c) => c.which === "portal") };
      report.frames[`${tag}: Preview beside, from the frame it shows`] = opened;
      ok(`${tag}: the Portal opens beside the chat (${opened.frames[0]?.portalMode}), its column there in the frame it shows`,
        at >= 0 && opened.frames[0].portalMode === "side" && opened.frames[0].main?.width === opened.frames.at(-1).main?.width, opened.frames[0]);
      comesIn(opened, "portal", "translateX(8px)", "the Portal");
      const shut = await step("close the Portal", () => page.locator('.portal-panel button[aria-label="Close preview"]').click());
      instant(shut, "portal", "the Portal");
      ok(`${tag}: and the chat has its column back in that frame`, shut.frames[0].portalMode === null, shut.frames[0]);

      if (!reduced) {
        // A window turning into a phone's and back, with both panels on: no panel comes in.
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.__mark = window.__calls.length; });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(300);
        await page.setViewportSize(run.viewport);
        const after = [];
        for (let n = 0; n < 12; n++) after.push(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(window.__panels())))));
        const calls = await page.evaluate(() => window.__calls.slice(window.__mark));
        report.frames[`${tag}: phone and back`] = { frames: after, calls };
        nothing({ frames: after, calls }, "a window turning into a phone's and back");
        ok(`${tag}: and both panels are back as they were`, after.at(-1).rail?.shown && after.at(-1).inspector?.shown, after.at(-1));
      }
    } else {
      // P03: the context panel, a screen of its own over the conversation.
      const opening = await step("open the context panel", () => toggle("Toggle context panel"));
      comesIn(opening, "inspector", "translateX(8px)", "the context panel");
      const focus = opening.frames.at(-1).focus;
      ok(`${tag}: and its heading takes focus (${focus?.tag} "${focus?.text}")`, focus?.inInspector && focus.text === "At a glance", focus);
      const close = await step("close the context panel", () => page.locator('aside.inspector button[aria-label="Close context panel"]').click());
      instant(close, "inspector", "the context panel");
      if (!reduced) {
        // A window turning into a desktop's and back: the desktop's own panel shows with no move, and the phone's stays closed.
        await page.waitForTimeout(300);
        await page.evaluate(() => { window.__mark = window.__calls.length; });
        await page.setViewportSize({ width: 1280, height: 860 });
        await page.waitForTimeout(300);
        await page.setViewportSize(run.viewport);
        const after = [];
        for (let n = 0; n < 12; n++) after.push(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(window.__panels())))));
        const calls = await page.evaluate(() => window.__calls.slice(window.__mark));
        report.frames[`${tag}: desktop and back`] = { frames: after, calls };
        nothing({ frames: after, calls }, "a window turning into a desktop's and back");
      }
    }
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length}) and the Portal's preview requests, refused (POST /api/previews, ${report.previewRequests.length})`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2c-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
