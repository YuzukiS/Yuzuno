// T-19 slice 2a, surfaces (M6: SH:M10, M11, C01, R27): in Chromium on a production build of the app
// with a synthetic Workspace that is never written to. Home fades in as it opens (opacity, medium);
// a conversation fades in as it opens from Home and as another Agent's takes its place (opacity,
// small). Opacity only, from the first frame: the surface it replaces is gone in that frame and the
// conversation's rows never move. Where it is read is placed as before: its rows come a frame
// after the body, already at the place they are read from, in one step, never scrolled there;
// with the fade that first frame, rows not yet in, is at opacity 0. A rapid switch leaves one fade,
// on the newest. Under reduced motion nothing plays; on a phone the conversation does not fade (its
// push and pop are M8, later). The app saves where an Agent was read as it leaves it (PUT
// /api/agents/<id>/reading); that is answered, any other write fails the check. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2a-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2a");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = (id, name) => ({ id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("a", "Mori"), agent("b", "Hana")];
// Long enough to scroll, so where it is read can be compared.
const turns = (who) => Array.from({ length: 6 }, (_, n) => ({ id: `${who}-t${n}`, status: "completed", items: [
  { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} question ${n + 1}` }] },
  { id: `${who}-r${n}`, type: "agentMessage", text: `${who} answer ${n + 1}. ${"A line of the answer. ".repeat(40)}` },
] }));
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: agents[0], pending: [], artifacts: [], turns: turns("Mori") },
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
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
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

/** In the page: every frame for `span` ms from the next click, of Home, the conversation and its rows. */
function pageHelpers() {
  window.__surfaces = () => {
    const home = document.querySelector(".home-view");
    const body = document.querySelector(".conversation-body");
    const plays = (el) => (el ? el.getAnimations().map((a) => ({ name: a.animationName ?? null, keyframes: a.effect?.getKeyframes?.().map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).join("+")).join("/"),
      duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing })) : []);
    const scroller = document.querySelector(".conversation-scroll");
    const row = document.querySelector(".turn");
    return {
      home: !!home, homePlays: plays(home), homeOpacity: home ? Number(getComputedStyle(home).opacity) : null,
      body: !!body, bodyPlays: plays(body), bodyOpacity: body ? Number(getComputedStyle(body).opacity) : null,
      title: document.querySelector(".conversation-heading h1")?.textContent ?? null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      rowTransform: row ? getComputedStyle(row).transform : null,
    };
  };
  window.__watch = (span = 400) => {
    window.__frames = [];
    addEventListener("click", () => {
      const t0 = performance.now();
      const frame = () => {
        window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__surfaces() });
        if (performance.now() - t0 < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { capture: true, once: true });
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
];
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
  await page.goto("http://yuzuno-motion.test/");
  await page.locator(".agent-row").first().waitFor();
  const open = (name) => page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  const step = async (what, act, span = 400) => {
    await page.evaluate((s) => window.__watch(s), span);
    await act();
    await page.waitForTimeout(span + 150);
    const frames = await page.evaluate(() => window.__frames);
    report.frames[`${tag}: ${what}`] = frames;
    return frames;
  };
  const fadeOf = (plays) => plays.find((p) => p.keyframes === "opacity/opacity" || p.keyframes === "opacity");

  if (run.phone) {
    // A phone opens a conversation from its list: no fade on it here (that push is M8, later).
    const pushed = await step("list → conversation", () => open("Mori"));
    const first = pushed.find((f) => f.body);
    ok(`${tag}: a conversation opened from the phone's list plays no fade on it (M8, later)`,
      !!first && pushed.every((f) => !f.bodyPlays.some((p) => p.keyframes === "opacity/opacity")), first);
    await context.close();
    continue;
  }
  // A conversation first, so Home has something to replace.
  await open("Mori");
  await page.locator(".conversation-body").waitFor();
  await page.waitForTimeout(600);

  // Home opens (SH:M10).
  const home = await step("Home opens", () => page.locator(".toolbar-nav .catchup-nav:not(.collab-nav)").first().click());
  const homeFirst = home.find((f) => f.home);
  if (reduced) ok(`${tag}: Home opens with nothing playing`, !!homeFirst && home.every((f) => !f.homePlays.length), homeFirst);
  else
    ok(`${tag}: Home fades in once over medium (opacity only, 240 ms, standard easing), the conversation gone in the same frame`,
      !!homeFirst && !homeFirst.body && fadeOf(homeFirst.homePlays)?.duration === 240 && /cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/.test(fadeOf(homeFirst.homePlays)?.easing ?? "") &&
        homeFirst.homeOpacity < 1 && home.at(-1).homeOpacity === 1 && !home.at(-1).homePlays.length, homeFirst);

  // Home → a conversation (SH:M11).
  const back = await step("Home → conversation", () => open("Hana"));
  const backFirst = back.find((f) => f.body);
  const backLast = back.at(-1);
  if (reduced)
    ok(`${tag}: the conversation opens from Home with nothing playing on it`,
      !!backFirst && back.every((f) => !f.bodyPlays.length), backFirst);
  else
    ok(`${tag}: from Home the conversation fades in once over small (opacity only, 180 ms), Home gone in the same frame`,
      !!backFirst && !backFirst.home && fadeOf(backFirst.bodyPlays)?.duration === 180 && backFirst.bodyOpacity < 1 && backLast.bodyOpacity === 1 && !backLast.bodyPlays.length, backFirst);
  const withRows = back.filter((f) => f.rowTransform !== null);
  const before = back.filter((f) => f.body && f.rowTransform === null);
  ok(`${tag}: its rows never move, and come already at the place they are read from, in one step (scrollTop ${withRows[0]?.scrollTop}, after ${before.length} frame(s) without rows${reduced ? "" : ` at opacity ${before.map((f) => f.bodyOpacity).join(", ")}`})`,
    withRows.length > 0 && withRows.every((f) => f.rowTransform === "none" && f.scrollTop === backLast.scrollTop) &&
      before.every((f) => f.scrollTop === 0 && (reduced || f.bodyOpacity === 0)), back.slice(0, 3));

  // Another Agent's conversation takes its place (SH:C01).
  await page.waitForTimeout(300);
  const swap = await step("switch Agent", () => open("Mori"));
  const swapFirst = swap.find((f) => f.title === "Mori");
  if (reduced)
    ok(`${tag}: switching Agent plays nothing on the conversation`, !!swapFirst && swap.every((f) => !f.bodyPlays.length), swapFirst);
  else
    ok(`${tag}: switching Agent fades the new conversation in over small (opacity only), the old one gone in the same frame`,
      !!swapFirst && fadeOf(swapFirst.bodyPlays)?.duration === 180 && swapFirst.bodyOpacity < 1 && swap.every((f) => f.title !== "Hana" || f.t === 0) &&
        swap.at(-1).bodyOpacity === 1, swapFirst);
  const swapRows = swap.filter((f) => f.rowTransform !== null);
  ok(`${tag}: and its rows never move, placed in one step (scrollTop ${swapRows[0]?.scrollTop})`,
    swapRows.length > 0 && swapRows.every((f) => f.rowTransform === "none" && f.scrollTop === swap.at(-1).scrollTop), swap.slice(0, 2));

  // A rapid switch: one fade, on the newest.
  if (!reduced) {
    await page.waitForTimeout(300);
    await open("Hana");
    await open("Mori");
    const rapid = await page.evaluate(() => window.__surfaces());
    ok(`${tag}: switched twice in a row, the newest conversation has one fade, not two`,
      rapid.title === "Mori" && rapid.bodyPlays.filter((p) => p.keyframes?.includes("opacity")).length <= 1, rapid);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2a-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
