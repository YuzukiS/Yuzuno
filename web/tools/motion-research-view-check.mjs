// T-19 HM:R1 (Lead 2 4644), in Chromium on a production build of the app with a synthetic Workspace and
// every API answered here (no Core, no Agent): a research desk on its report page (research-fixtures.mjs's
// dose study, with a second claim added here). A view the reader switches to (Claim, Evidence, Definitions,
// Next) comes in over small, opacity only; its height is there at once (T-19 3920). The chosen view's pill
// moves over micro. The view shown first, and a claim switch, play nothing; focus stays on the chosen radio.
// Under reduced motion nothing plays and the pill has no transition.
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: none; anything but a read
// is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-research-view-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { doseStudy, fixtureFiles } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-research-view");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], unknownGets: [], writes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 700)}`}`);
};

// The dose study, with a second claim so a claim switch can be made.
const desk = structuredClone(doseStudy);
const props = desk.body.elements.desk.props;
props.claims.push({ ...structuredClone(props.claims[0]), id: "c2", title: "The effect holds under v1", statement: "Under the v1 outcome the effect is smaller." });
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const agent = { id: "sora", name: "Sora", projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null };
const projects = [{ id: "p1", name: "Research (synthetic)", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const section = { key: desk.key, kind: "report", title: desk.title, version: 3, owner: { agentId: "sora", name: "Sora", state: "active" }, body: desk.body,
  attachments: [], refs: {}, seen: { version: 3, at: iso(-MIN) }, history: false, updatedTurnId: null, updatedAt: iso(-5 * MIN) };
const pointer = (document, at) => at.split("/").slice(1).reduce((value, step) => (value && typeof value === "object" ? value[step] : undefined), document);
/** Core's research read of the desk, from the fixture files, as research.rs answers it. */
function research(version) {
  const values = {};
  for (const plot of props.plots)
    for (const row of plot.rows)
      for (const [id, estimate] of [[row.id, row.estimate], ...(row.parts ?? []).map((part) => [part.id, part.estimate])])
        for (const field of ["value", "low", "high"]) {
          const number = estimate[field];
          if (!number || typeof number !== "object") continue;
          const found = pointer(fixtureFiles[number.from], number.pointer);
          values[`${id}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: "missing", from: number.from };
        }
  const sources = Object.fromEntries(props.sources.filter((source) => source.snapshot).map((source) => [source.id, {
    attachment: source.snapshot, takenAt: iso(-60 * MIN), size: 1200, sha256: "5f3c".padEnd(64, "0"), available: true,
    ...(source.sha256 ? { stated: "different" } : {}),
  }]));
  return { key: desk.key, version, elementId: "desk", values, sources };
}
const home = () => ({ generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "Research (synthetic)" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: [section], history: [] }, unseen: 0, missing: [] }] });
const gets = {
  "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" }),
  "/api/home": home,
  "/api/agents/sora": () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [] }),
  "/api/agents/sora/reading": () => ({ handoff: null }),
  "/api/projects/p1/repo-activity": () => ({ observedAt: iso(-MIN), repositories: [] }),
  "/api/updates": () => unmanagedUpdates, "/api/jobs/budget": () => idleJobsBudget, "/api/jobs": () => noJobs, "/api/jobs/live": () => noLiveJobs,
  "/api/ci/live": () => ({ agents: {} }), "/api/ci": () => noCiRuns, "/api/reviews": () => noReviews,
  "/api/backlog": () => ({ observedAt: new Date().toISOString(), agents: {} }),
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (request.method() === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (path === `/api/projects/p1/brief/research/${desk.key}/desk`) return route.fulfill({ json: research(Number(url.searchParams.get("version"))) });
    const json = gets[path];
    if (json) return route.fulfill({ json: json() });
    if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
    return route.fulfill({ json: {} });
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const at = resolve(dist, file);
  assert.ok(at.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(at), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page: every animate() on the desk's view, and the view and its pills each frame. */
function pageHelpers() {
  window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 50); } close() {} addEventListener() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".research-main")) window.__calls.push(Math.round(performance.now()));
    return animate.call(this, keyframes, options);
  };
  const scripted = (a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) && !(typeof CSSTransition !== "undefined" && a instanceof CSSTransition);
  window.__view = () => {
    const main = document.querySelector(".home-report .research-desk .research-main");
    if (!main) return null;
    const chosen = document.querySelector('.home-report .research-views [role="radio"][aria-checked="true"]');
    return { view: document.querySelector(".home-report .research-desk")?.dataset.view, opacity: Number(getComputedStyle(main).opacity),
      height: Math.round(main.getBoundingClientRect().height),
      plays: main.getAnimations().filter(scripted).map((a) => ({ keys: (a.effect?.getKeyframes?.() ?? []).map((k) => Object.keys(k)
        .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"), duration: a.effect.getTiming().duration })),
      pill: chosen ? { text: chosen.textContent.trim(), transition: getComputedStyle(chosen).transitionProperty, duration: getComputedStyle(chosen).transitionDuration } : null,
      focus: document.activeElement?.getAttribute("role") === "radio" ? document.activeElement.textContent.trim() : document.activeElement?.tagName ?? null };
  };
  window.__sample = (span) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      seen.push({ t: Math.round(performance.now() - t0), view: window.__view() });
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
const still = (frames) => frames.every((f) => !f.view || !f.view.plays.length);
/** A switch to `view`: from its first frame there one opacity animation over 180 ms, and at rest at the end. */
const cameIn = (frames, view) => {
  const shown = frames.filter((f) => f.view?.view === view);
  const first = shown[0]?.view;
  const last = shown.at(-1)?.view;
  return { first, last, ok: !!first && first.plays.length === 1 && first.plays[0].keys === "opacity/opacity" && first.plays[0].duration === 180
    && first.opacity < 1 && last.opacity === 1 && !last.plays.length };
};
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
  const radio = (name) => page.locator(".home-report .research-views [role='radio']", { hasText: name });
  try {
    await page.goto("http://yuzuno-research-motion.test/");
    if (!(await page.locator(".home-view").isVisible().catch(() => false))) await page.locator(".toolbar-nav .catchup-nav").first().click();
    const toggle = page.locator('.home-view .home-panel-toggle[aria-expanded="false"]');
    await page.locator(".home-view .home-panel-toggle").first().waitFor();
    if (await toggle.count()) await toggle.first().click();
    const opener = page.locator(`.home-view [data-section-key="${desk.key}"] .home-report-open`);
    await opener.scrollIntoViewIfNeeded();
    const first = record("its report page opens", await during(700, () => opener.click()));
    await page.locator(".home-report .research-desk").waitFor();
    ok(`${tag}: the desk's report page opens: the view shown first plays nothing`,
      first.some((f) => f.view) && still(first) && (await calls()) === 0, first.find((f) => f.view)?.view);

    // From the keyboard: the chosen radio focused, then the arrow key to the next view.
    const before = await calls();
    await radio("Claim & interval").focus();
    const evidence = record("to Evidence, from the keyboard", await during(600, () => page.keyboard.press("ArrowRight")));
    const toEvidence = cameIn(evidence, "evidence");
    if (reduced) ok(`${tag}: under reduced motion, a switch to Evidence from the keyboard shows it with nothing playing, focus on its radio`,
      evidence.some((f) => f.view?.view === "evidence") && still(evidence) && (await calls()) === before && evidence.at(-1).view.focus === "Evidence & limits",
      { last: evidence.at(-1)?.view });
    else ok(`${tag}: a switch to Evidence from the keyboard: the view comes in once, opacity only over small, its height at once, focus on its radio`,
      toEvidence.ok && (await calls()) - before === 1 && evidence.filter((f) => f.view?.view === "evidence").every((f) => f.view.height === toEvidence.first.height)
        && toEvidence.last.focus === "Evidence & limits", { first: toEvidence.first, last: toEvidence.last, calls: (await calls()) - before });

    // A click on another view.
    const clicked = await calls();
    const history = record("to Definitions, with a click", await during(600, () => radio("Definitions").click()));
    const toHistory = cameIn(history, "history");
    if (reduced) ok(`${tag}: under reduced motion, a click on Definitions shows it with nothing playing`,
      history.some((f) => f.view?.view === "history") && still(history) && (await calls()) === clicked, { last: history.at(-1)?.view });
    else ok(`${tag}: a click on Definitions: the view comes in once more, opacity only over small`,
      toHistory.ok && (await calls()) - clicked === 1, { first: toHistory.first, calls: (await calls()) - clicked });

    // The chosen pill's transition.
    const pill = history.at(-1)?.view?.pill;
    if (reduced) ok(`${tag}: under reduced motion, the chosen view's pill has no transition`, !!pill && /^0s(, 0s)*$/.test(pill.duration), pill);
    else ok(`${tag}: the chosen view's pill moves over micro (its background, colour and shadow)`,
      !!pill && /background-color/.test(pill.transition) && /box-shadow/.test(pill.transition) && pill.duration.split(", ").every((d) => d === "0.12s"), pill);

    // A claim switch.
    await radio("Claim & interval").click();
    await page.waitForTimeout(300);
    const claimed = await calls();
    const claim = record("another claim", await during(500, () => page.locator(".home-report .research-claim-list [role='radio']", { hasText: "The effect holds under v1" }).click()));
    ok(`${tag}: choosing another claim plays nothing on the view`, still(claim) && (await calls()) === claimed, { calls: (await calls()) - claimed });
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
await writeFile(join(output, "motion-research-view-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
