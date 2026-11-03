// T-19, a section pinned here (M9 + M4: HM:W5), in Chromium on a production build of the app with a
// synthetic Workspace and every API answered here (no Core, no Agent).
// - Pin pressed on a report's card: the new widget, in the column above the projects, comes in over
//   small (opacity, 4 px up) and settles once (the tint shows, then goes), and the Pin pressed stays
//   where it was on the screen while that column grows. Under reduced motion the widget is there at
//   once and the tint stands, then goes.
// - The pinned widget shown again when Home opens (the saved layout, read) comes in and settles not at
//   all.
// - Lead 3597: the settle's tint is seen on the widget's card itself (its painted background changes),
//   not only set on an element behind it. The reader's own wheel, key or touch the frame after the
//   press stands: the rest of the hold does not undo it. Pin the new section, pressed on an old pin
//   whose new section is pinned already, removes the old pin and plays nothing on the one there.
// Writes: none (a pin is kept in this browser); Home's list read of linked repositories is a POST and
// counted apart; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-pin-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-pin");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], listReads: 0, frames: {} };
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
const sections = [
  { id: 11, key: "notes", kind: "report", title: "Weekly notes", version: 3, owner, updatedAt: iso(-30 * MIN), updatedTurnId: null,
    attachments: [], refs: {}, seen: null, history: false, body: body("The import is faster; the export waits for review.") },
  { id: 12, key: "plan", kind: "report", title: "Next steps", version: 2, owner, updatedAt: iso(-20 * MIN), updatedTurnId: null,
    attachments: [], refs: {}, seen: null, history: false, body: body("Ship the import, then look at the export.") },
  // More cards, so Home scrolls both ways around the Pin.
  ...[1, 2, 3, 4].map((n) => ({ id: 20 + n, key: `log-${n}`, kind: "report", title: `Log ${n}`, version: 1, owner, updatedAt: iso(-(40 + n) * MIN),
    updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false,
    body: body(Array.from({ length: 6 }, (_, line) => `Line ${line + 1} of log ${n}: what ran, and what it found.`).join("\n\n")) })),
];
// A pin of the plan's earlier version (id 5), beside one of its current version (12).
const PLAN = "pin:p1:12:plan";
const OLD_PLAN = "pin:p1:5:plan";
const planPins = [5, 12].map((id) => ({ projectId: "p1", key: "plan", id, title: "Next steps", projectName: "Yuzuno app" }));
const home = () => ({
  generatedAt: new Date().toISOString(),
  order: ["p1"],
  needsYou: [],
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
    // The Project's linked repositories, a list read Home asks with POST (home-api.ts).
    if (request.method() === "POST" && url.pathname === "/api/collaboration/github_repositories") {
      report.listReads++;
      return route.fulfill({ json: { repositories: [], links: [] } });
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

const WIDGET = "pin:p1:11:notes";
const PIN = '.home-main [data-section-key="notes"] .home-pin';
/** In the page, from the first script on, each frame: the pinned widget (whether it plays an entry
 * of its own, not the settle's CSS tint, and whether it is settled) and where the card's Pin is. */
function pageHelpers([widgetId, pinSelector, planId]) {
  const entries = (el) => el.getAnimations().filter((a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation));
  const frames = [];
  window.__frames = frames;
  window.__now = () => frames.length;
  /** A widget's slot: whether it plays an entry of its own (not the settle's CSS tint), whether it or
   * its card is settled, and the card's painted background. */
  const state = (id) => {
    const slot = [...document.querySelectorAll(".home-widget-slot")].find((el) => el.dataset.widget === id) ?? null;
    if (!slot) return null;
    const plays = entries(slot);
    const keys = new Set();
    for (const a of plays) for (const k of a.effect?.getKeyframes?.() ?? [])
      for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) keys.add(p);
    const card = slot.firstElementChild;
    return { opacity: Number(getComputedStyle(slot).opacity), entries: plays.length, keys: [...keys].sort().join("+"),
      duration: plays[0]?.effect?.getComputedTiming().duration ?? null,
      settle: slot.hasAttribute("data-settle") || !!card?.hasAttribute("data-settle"),
      card: card ? getComputedStyle(card).backgroundColor : null };
  };
  const step = () => {
    const pin = document.querySelector(pinSelector);
    frames.push({ widget: state(widgetId), plan: state(planId), pinTop: pin ? Math.round(pin.getBoundingClientRect().top * 10) / 10 : null });
    if (frames.length < 20_000) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // Pin pressed as a pointer does, on a Pin in view: brought into view first (a pointer can't press
  // one off the screen), then focus and click. Where it is is read once focus has it.
  window.__pin = () => {
    const button = document.querySelector(pinSelector);
    button.scrollIntoView({ block: "center", behavior: "instant" });
    button.focus();
    const top = button.getBoundingClientRect().top;
    button.click();
    // The frames read from here on are those after the press.
    return { top: Math.round(top * 10) / 10, from: frames.length };
  };
  // The Pin pressed, then, the frame after, the reader takes over: a wheel, a key or a touch, and the
  // scroll the browser makes for it (160 px, whichever way there is room).
  window.__pinThen = (kind) => {
    const pressed = window.__pin();
    const view = document.querySelector(".home-view");
    return new Promise((done) => requestAnimationFrame(() => {
      const by = view.scrollTop >= 160 ? -160 : 160;
      const event = kind === "wheel" ? new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: by })
        : kind === "key" ? new KeyboardEvent("keydown", { bubbles: true, key: by > 0 ? "PageDown" : "PageUp" })
          : new Event("touchstart", { bubbles: true });
      (kind === "key" ? document.activeElement ?? document.body : view).dispatchEvent(event);
      const before = view.scrollTop;
      view.scrollTop = before + by;
      done({ ...pressed, by, scrolled: view.scrollTop - before, after: view.scrollTop });
    }));
  };
  window.__scrollTop = () => document.querySelector(".home-view").scrollTop;
}

function cameIn(frames, reduced) {
  const shown = frames.filter(Boolean);
  if (!shown.length) return false;
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => f.opacity === 1 && f.entries === 0);
  return shown[0].opacity < 1 && shown[0].entries === 1 && shown[0].keys === "opacity+transform" && Math.abs((shown[0].duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.entries === 0;
}
const settledOnce = (frames) => {
  const shown = frames.filter(Boolean);
  const first = shown.findIndex((f) => f.settle);
  return first >= 0 && shown.slice(first).some((f) => !f.settle) && !shown.at(-1).settle;
};
const rgb = (color) => (color?.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
/** The tint is seen on the card itself: while settled, its painted background is not its resting one. */
const tintSeen = (frames) => {
  const shown = frames.filter(Boolean);
  const rest = rgb(shown.at(-1)?.card);
  return rest.length === 3 && shown.some((f) => f.settle && rgb(f.card).some((v, i) => Math.abs(v - rest[i]) >= 6));
};

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.addInitScript(pageHelpers, [WIDGET, PIN, PLAN]);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  const framesSince = (from) => page.evaluate((from) => window.__frames.slice(from), from);
  const openHome = async () => {
    await page.locator(".toolbar-nav .catchup-nav").first().click();
    await page.locator(PIN).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
  };
  try {
    await page.goto("http://127.0.0.1:4323/");
    await openHome();
    // Pin pressed on the report's card.
    const { top, from } = await page.evaluate(() => window.__pin());
    await page.waitForFunction((id) => [...document.querySelectorAll(".home-widget-slot")].some((el) => el.dataset.widget === id), WIDGET, { timeout: 10_000 });
    await page.waitForTimeout(2600);
    const pinned = record("pinned here", { top, frames: await framesSince(from) });
    const widget = pinned.frames.map((f) => f.widget);
    ok(`${tag}: a section pinned here: its new widget comes in over small, 4 px up with a fade, from its first frame; under reduced motion it is there at once`,
      cameIn(widget, reduced), { first: widget.filter(Boolean).slice(0, 3), last: widget.filter(Boolean).at(-1) });
    ok(`${tag}: a section pinned here: its new widget settles once, on its card (the tint is seen on the card, then goes)`,
      settledOnce(widget) && tintSeen(widget),
      { settles: widget.filter((f) => f?.settle).length, tinted: widget.find((f) => f?.settle)?.card, rest: widget.filter(Boolean).at(-1)?.card });
    const tops = pinned.frames.map((f) => f.pinTop).filter((t) => t !== null);
    const furthest = tops.reduce((most, t) => Math.max(most, Math.abs(t - top)), 0);
    ok(`${tag}: a section pinned here: the Pin pressed stays where it was on the screen while the widget column above grows, within 1 px in every frame (moved at most ${furthest} px)`,
      tops.length > 0 && furthest <= 1, { top, furthest, sample: tops.slice(0, 6) });

    // Home opened again: the saved layout, read, shows the widget.
    await page.reload();
    await openHome();
    await page.waitForTimeout(1500);
    const reopened = record("Home opened again", (await framesSince(0)).map((f) => f.widget));
    ok(`${tag}: a pinned widget shown again when Home opens (the saved layout, read): it does not come in or settle`,
      reopened.some(Boolean) && reopened.filter(Boolean).every((f) => f.entries === 0 && !f.settle), { first: reopened.filter(Boolean).slice(0, 2) });
    await page.screenshot({ path: join(output, `${tag}-after.png`) });

    // The reader takes over the frame after the press: the rest of the hold does not undo it.
    for (const [kind, words] of [["wheel", "a wheel"], ["key", "a key"], ["touch", "a touch"]]) {
      await page.locator(PIN).click();
      await page.waitForFunction((id) => ![...document.querySelectorAll(".home-widget-slot")].some((el) => el.dataset.widget === id), WIDGET, { timeout: 10_000 });
      await page.waitForTimeout(400);
      const took = await page.evaluate((kind) => window.__pinThen(kind), kind);
      await page.waitForTimeout(800);
      const final = await page.evaluate(() => window.__scrollTop());
      record(`reader takes over: ${kind}`, { ...took, final });
      ok(`${tag}: a section pinned here, and ${words} the frame after: the reader's scroll stands; the rest of the hold does not undo it`,
        Math.abs(took.scrolled) >= 100 && Math.abs(final - took.after) <= 1, { ...took, final });
    }

    // An old pin of the plan, beside the pin of its current version: Pin the new section on the old one.
    await page.evaluate((pins) => localStorage.setItem("yuzuno.homeWidgets.ws", JSON.stringify({ order: [], hidden: [], pins })), planPins);
    await page.reload();
    await openHome();
    const old = page.locator(`.home-widget-slot[data-widget="${OLD_PLAN}"]`);
    await old.getByRole("button", { name: "Pin the new section", exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__now());
    await old.getByRole("button", { name: "Pin the new section", exact: true }).click();
    await page.waitForFunction((id) => ![...document.querySelectorAll(".home-widget-slot")].some((el) => el.dataset.widget === id), OLD_PLAN, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const plan = record("Pin the new section, pinned already", (await framesSince(before)).map((f) => f.plan));
    ok(`${tag}: Pin the new section on an old pin whose new section is pinned already: the old pin goes, and the one there plays nothing (no entry, no settle)`,
      plan.some(Boolean) && plan.every((f) => !f || (f.entries === 0 && !f.settle)),
      { playing: plan.filter((f) => f?.entries).length, settles: plan.filter((f) => f?.settle).length });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written (a pin is kept in this browser); Home's list reads of linked repositories, counted apart: ${report.listReads}`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-pin-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
