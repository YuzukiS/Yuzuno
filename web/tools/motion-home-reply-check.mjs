// T-19, Home replies (M9/M14 + F2: HM:S7, HM:A3), in Chromium on a production build of the app with
// a synthetic Workspace and every API answered here (no Core, no Agent).
// - A report card's Reply, pressed: the reply fades in over small and its text takes focus. Closed
//   with its ✕ or with Escape, focus is back on Reply. A reply kept from before, shown again after a
//   reload, shows as it is: no fade, and focus stays where it was.
// - An Ask answered from this window: once Core has the reply, what was said takes the reply's place,
//   fades in and takes focus (the button pressed has gone). Reply again brings the reply back the
//   same way, with focus in its text. An Ask already replied when Home opens shows as it is.
// - Under reduced motion nothing fades; focus moves the same.
// Writes: only the one Ask reply sent on purpose in each run (POST .../brief/reply); anything else is
// refused and counted. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-home-reply-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-home-reply");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], replies: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const MIN = 60_000;
const base = { harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "mori", name: "Mori", projectId: "p1" }];
const projects = [{ id: "p1", name: "Yuzuno app", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const owner = { agentId: "mori", name: "Mori", state: "active" };
const body = (text) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: {}, children: ["text"] },
  text: { type: "Markdown", props: { text } },
} });
const template = () => [
  { key: "notes", kind: "report", title: "Weekly notes", version: 3, owner, updatedAt: iso(-30 * MIN), updatedTurnId: null,
    attachments: [], refs: {}, seen: null, history: false, body: body("The import is faster; the export waits for review.") },
  { key: "plain", kind: "ask", title: "Anything to add?", version: 2, owner, updatedAt: iso(-20 * MIN), updatedTurnId: null,
    attachments: [], refs: {}, seen: null, history: false, body: body("Anything else before we ship?"),
    ask: { question: "Anything else before we ship?", state: "open", reply: { freeText: true } } },
];
let sections = template();
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: sections.filter((s) => s.kind === "ask" && s.ask.state === "open")
    .map((s) => ({ kind: "ask", projectId: "p1", agentId: owner.agentId, agentName: owner.name, sectionKey: s.key, title: s.title, since: s.updatedAt })),
  projects: [{
    project: { id: "p1", name: "Yuzuno app" },
    agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [],
    brief: { version: 9, sections, history: [] },
    unseen: sections.length, missing: [],
  }],
});
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci/runs": noCiRuns, "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/home": home(),
  "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "POST" && url.pathname === "/api/projects/p1/brief/reply") {
      const sent = JSON.parse(request.postData() || "{}");
      report.replies.push({ key: sent.key, text: sent.text });
      const section = sections.find((s) => s.key === sent.key);
      if (section?.ask) section.ask = { ...section.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: sent.text };
      return route.fulfill({ json: { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: "accepted", turnId: "mori-t2", error: null } });
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

// In the page: press a button as a pointer does (focus, then click), then read what it brings each
// frame from then on: whether it is there, its opacity and what plays on it.
function pageHelpers() {
  const frame = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const animations = el.getAnimations();
    return { opacity: Number(getComputedStyle(el).opacity), animations: animations.length,
      duration: animations[0]?.effect?.getComputedTiming().duration ?? null };
  };
  window.__focused = () => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, text: el.textContent.trim().slice(0, 40), label: el.getAttribute("aria-label"),
      className: typeof el.className === "string" ? el.className : "", inCard: el.closest("[data-section-key]")?.dataset.sectionKey ?? null } : null;
  };
  window.__press = (button, target, frames = 40) => new Promise((done) => {
    const b = document.querySelector(button);
    if (!b) return done(null);
    b.focus();
    b.click();
    const out = [];
    const step = () => {
      out.push(frame(target));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  window.__frames = (target, frames = 20) => new Promise((done) => {
    const out = [];
    const step = () => {
      out.push(frame(target));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** What came in, from its first frame: a fade over small under normal motion, at once under reduced. */
function came(frames, reduced) {
  const shown = (frames ?? []).filter(Boolean);
  if (!shown.length) return false;
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => f.opacity === 1 && f.animations === 0);
  return shown[0].opacity < 1 && shown[0].animations === 1 && Math.abs((shown[0].duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.animations === 0;
}
const still = (frames) => (frames ?? []).filter(Boolean).length > 0 && frames.filter(Boolean).every((f) => f.opacity === 1 && f.animations === 0);

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const NOTES = '[data-section-key="notes"]';
const PLAIN = '[data-section-key="plain"]';
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  sections = template();
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.addInitScript(pageHelpers);
  const press = (button, target, frames) => page.evaluate(([button, target, frames]) => window.__press(button, target, frames), [button, target, frames]);
  const frames = (target, n) => page.evaluate(([target, n]) => window.__frames(target, n), [target, n]);
  const focused = () => page.evaluate(() => window.__focused());
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const openHome = async () => {
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator(NOTES).first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  try {
    await page.goto("http://127.0.0.1:4319/");
    await openHome();

    // A report card's Reply (HM:S7).
    const opened = record("Reply pressed", await press(`${NOTES} .home-reply-open`, `${NOTES} .home-card-reply`));
    const inReply = await focused();
    ok(`${tag}: Reply pressed on a report: the reply fades in over small (at once under reduced motion), and its text takes focus (${inReply?.tag} ${inReply?.label})`,
      came(opened, reduced) && inReply?.tag === "TEXTAREA" && inReply.inCard === "notes", { first: opened?.slice(0, 3), focus: inReply });
    await page.locator(`${NOTES} .home-card-reply-head .icon-button`).click();
    await page.waitForTimeout(150);
    const afterClose = await focused();
    ok(`${tag}: the reply closed with its ✕: focus is back on Reply (${afterClose?.text})`,
      !(await page.locator(`${NOTES} .home-card-reply`).count()) && afterClose?.className.includes("home-reply-open"), afterClose);
    await press(`${NOTES} .home-reply-open`, `${NOTES} .home-card-reply`, 12);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const afterEscape = await focused();
    ok(`${tag}: the reply closed with Escape in its text: focus is back on Reply (${afterEscape?.text})`,
      !(await page.locator(`${NOTES} .home-card-reply`).count()) && afterEscape?.className.includes("home-reply-open"), afterEscape);
    // A draft kept from before: after a reload the reply is open again, as it was. (Where Escape
    // did not close it, its ✕ does first.)
    if (await page.locator(`${NOTES} .home-card-reply`).count()) await page.locator(`${NOTES} .home-card-reply-head .icon-button`).click();
    await press(`${NOTES} .home-reply-open`, `${NOTES} .home-card-reply`, 12);
    await page.locator(`${NOTES} .home-card-reply textarea`).fill("A draft kept for later.");
    await page.waitForTimeout(300);
    await page.reload();
    await openHome();
    await page.locator(`${NOTES} .home-card-reply`).waitFor({ timeout: 10_000 });
    const kept = record("kept after a reload", await frames(`${NOTES} .home-card-reply`, 12));
    const keptFocus = await focused();
    ok(`${tag}: a reply kept from before, open again after a reload, shows as it is: no fade, and its text does not take focus (${keptFocus?.tag})`,
      still(kept) && !(keptFocus?.tag === "TEXTAREA" && keptFocus.inCard === "notes"), { kept: kept?.slice(0, 3), focus: keptFocus });

    // An Ask answered from this window (HM:A3).
    await page.locator(`${PLAIN} .home-text-reply textarea`).fill("Ship it after the export review.");
    const sent = record("Ask reply sent", await press(`${PLAIN} .home-text-reply button[type=submit]`, `${PLAIN} .home-ask-replied`, 60));
    await page.locator(`${PLAIN} .home-ask-replied`).waitFor({ timeout: 5000 });
    const onReplied = await focused();
    ok(`${tag}: an Ask answered here: what was said takes the reply's place, fades in over small (at once under reduced motion) and takes focus (${onReplied?.className})`,
      came(sent, reduced) && onReplied?.className.includes("home-ask-replied"), { first: sent?.filter(Boolean).slice(0, 3), focus: onReplied });
    const again = record("Reply again", await press(`${PLAIN} .home-ask-replied button`, `${PLAIN} .home-ask-reply`, 40));
    const inAgain = await focused();
    ok(`${tag}: Reply again: the reply comes back, fades in over small (at once under reduced motion), and its text takes focus (${inAgain?.tag})`,
      came(again, reduced) && inAgain?.tag === "TEXTAREA" && inAgain.inCard === "plain", { first: again?.slice(0, 3), focus: inAgain });
    // Home opened again with the Ask replied in Core's record.
    await page.reload();
    await openHome();
    await page.locator(`${PLAIN} .home-ask-replied`).waitFor({ timeout: 10_000 });
    const loaded = record("replied on opening", await frames(`${PLAIN} .home-ask-replied`, 12));
    const loadedFocus = await focused();
    ok(`${tag}: an Ask already replied when Home opens shows as it is: no fade, and it takes no focus (${loadedFocus?.className})`,
      still(loaded) && !loadedFocus?.className.includes("home-ask-replied"), { loaded: loaded?.slice(0, 3), focus: loadedFocus });
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but the one Ask reply sent in each run (POST /api/projects/p1/brief/reply, ${report.replies.length})`,
  report.writes.length === 0 && report.replies.length === runs.length && report.replies.every((r) => r.key === "plain"), { writes: report.writes, replies: report.replies });
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-home-reply-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
