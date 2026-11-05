// T-19 CV:CO-09 (Lead 2 4644), in Chromium on a production build of the app with a synthetic Workspace and
// every API answered here (no Core, no Agent). The composer's slash list, a CodeMirror tooltip, comes in
// once as it opens: opacity only, over micro (120 ms). Each keystroke after that only draws its rows again,
// in the same list, with nothing played; closed with Escape and opened again by typing on, it comes in once
// more. Under reduced motion nothing plays.
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: none (the draft stays in
// the browser); anything but a read is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-slash-menu-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-slash-menu");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], unknownGets: [], writes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 700)}`}`);
};

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, connectionState: "connected", threadId: "th-a",
  projectId: "p", goal: "" };
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Tidy the fixture notes." }] },
  { id: "r1", type: "agentMessage", text: "Done." },
] }];
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const gets = {
  "/api/workspace": { workspace: { id: "ws-slash" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs, "/api/agents/a/reading": { handoff: null },
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns,
  "/api/ci/live": noCiRuns, "/api/reviews": noReviews, "/api/home": { generatedAt: "", order: [], needsYou: [], projects: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && url.pathname === "/api/agents/a/reading") return route.fulfill({ json: { accepted: true } });
    if (request.method() === "POST" && url.pathname === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const json = gets[url.pathname];
    if (json) return route.fulfill({ json });
    if (!report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
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

/** In the page: every animate() on the list, and the list each frame. */
function pageHelpers() {
  window.EventSource = class { close() {} addEventListener() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".slash-menu")) window.__calls.push(Math.round(performance.now()));
    return animate.call(this, keyframes, options);
  };
  const scripted = (a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) && !(typeof CSSTransition !== "undefined" && a instanceof CSSTransition);
  let mark = 0;
  window.__menu = () => {
    const el = document.querySelector(".slash-menu");
    if (!el) return null;
    el.__mark ??= ++mark;
    return { element: el.__mark, opacity: Number(getComputedStyle(el).opacity), rows: el.querySelectorAll('[role="option"]').length,
      plays: el.getAnimations().filter(scripted).map((a) => ({ keys: (a.effect?.getKeyframes?.() ?? []).map((k) => Object.keys(k)
        .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"), duration: a.effect.getTiming().duration })) };
  };
  window.__sample = (span) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      seen.push({ t: Math.round(performance.now() - t0), menu: window.__menu() });
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    frame();
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
/** The list came in: from its first frame one opacity animation over 120 ms, and at rest at the end. */
const cameIn = (frames) => {
  const shown = frames.filter((f) => f.menu);
  const first = shown[0]?.menu;
  const last = shown.at(-1)?.menu;
  return { first, last, ok: !!first && first.plays.length === 1 && first.plays[0].keys === "opacity/opacity" && first.plays[0].duration === 120
    && first.opacity < 1 && last.opacity === 1 && !last.plays.length };
};
const still = (frames) => frames.every((f) => !f.menu || !f.menu.plays.length);
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => page.evaluate(() => window.__calls.length);
  const record = (label, frames) => { report.frames[`${tag}: ${label}`] = frames; return frames; };
  const during = async (span, act) => {
    await page.evaluate((span) => { window.__pending = window.__sample(span); }, span);
    await act();
    return page.evaluate(() => window.__pending);
  };
  try {
    await page.goto("http://yuzuno-slash-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    const composer = page.locator('[data-composer-input][aria-label="Message Mori"]');
    if (!(await composer.isVisible().catch(() => false))) {
      if (run.phone && (await page.locator(".phone-back").count()) && !(await page.locator(".app.phone-list").count()))
        await page.locator(".phone-back").click();
      await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    }
    await composer.waitFor();
    await composer.click();

    const before = await calls();
    const opened = record("typing / opens the list", await during(500, () => page.keyboard.type("/")));
    const came = cameIn(opened);
    if (reduced) ok(`${tag}: under reduced motion, typing / opens the list with nothing playing`,
      opened.some((f) => f.menu) && still(opened) && (await calls()) === before, { first: came.first });
    else ok(`${tag}: typing / opens the list: it comes in once, opacity only over micro, and ends at rest`,
      came.ok && (await calls()) - before === 1, { first: came.first, last: came.last, calls: (await calls()) - before });

    const typed = await calls();
    const typing = record("typing on in the list", await during(600, async () => {
      for (const key of ["s", "t", "a"]) {
        await page.keyboard.type(key);
        await page.waitForTimeout(120);
      }
    }));
    const elements = [...new Set(typing.filter((f) => f.menu).map((f) => f.menu.element))];
    ok(`${tag}: each keystroke after that draws the rows again in the same list, with nothing played`,
      typing.every((f) => f.menu) && elements.length === 1 && still(typing) && (await calls()) === typed, { elements, calls: (await calls()) - typed });

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".slash-menu"));
    const again = await calls();
    const reopened = record("typing on after Escape", await during(500, () => page.keyboard.type("t")));
    if (reduced) ok(`${tag}: under reduced motion, closed with Escape and opened again by typing on, the list shows with nothing playing`,
      reopened.some((f) => f.menu) && still(reopened) && (await calls()) === again, {});
    else ok(`${tag}: closed with Escape and opened again by typing on, the list comes in once more`,
      cameIn(reopened).ok && (await calls()) - again === 1, { first: cameIn(reopened).first, calls: (await calls()) - again });
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("nothing was written", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "motion-slash-menu-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
