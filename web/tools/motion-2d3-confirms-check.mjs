// T-19 slice 2d-3, inline previews and confirms (M9 + F2: ST:SA3, ST:SA4, ST:BR2), in Chromium on a
// production build of the app, through the real Settings, with every API answered here (no Core).
// - The shared Appearance preset's Preview… and Follow this preset… stay enabled while their preview
//   is open, say so (aria-expanded) and keep focus; pressed again, Preview… closes its preview. Each
//   preview reveals: from nothing to its height over small with a fade, clipped meanwhile; only the
//   box it is in opens, and the preview keeps its own padding and margins, its buttons still within
//   it. Cancel brings focus back to the button that opened it.
// - A backup's Remove… confirmation reveals the same way below the backup and takes focus; Cancel
//   brings focus back to that Remove….
// - Under reduced motion each is there at once; reduced motion turned on while one reveals shows it
//   whole within a frame.
// Writes: none but the retention preview this check asks for (POST .../retention/preview) and the
// app's own saves of where an Agent was read; anything else is refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2d3-confirms-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2d3-confirms");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], reads: [], unknownGets: [], writes: [], previews: 0, readingSaves: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const GIB = 1024 ** 3;
const NAME = "yuzuno-backup-20261021T0300Z";
const backup = { canChange: true, workspaceId: "fixture", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 3 * 1024 * 1024,
  current: null, recent: [], notCovered: [], replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped" };
const retention = (keep) => ({
  folder: "/backups/daily", keep, unreadableNames: 0, removableEstimateBytes: 2 * GIB, removableUnknownSizes: 0,
  sizeBasis: "Sizes are what each backup's manifest declares for its database and files.",
  entries: [
    { name: "yuzuno-backup-20261028T0300Z", path: "/backups/daily/yuzuno-backup-20261028T0300Z", verdict: "keep", reason: `One of the latest ${keep}`,
      createdAt: "2026-10-28T03:00:30Z", estimateBytes: 2 * GIB, manifestSha256: "a".repeat(64) },
    { name: NAME, path: `/backups/daily/${NAME}`, verdict: "remove", reason: `Older than the latest ${keep}`,
      createdAt: "2026-10-21T03:00:30Z", estimateBytes: 2 * GIB, lastCheckedAt: "2026-10-22T09:00:00Z", manifestSha256: "b".repeat(64) },
  ],
});
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [], messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
  // A preset another device saved: a dark theme.
  "/api/appearance-preset": { workspaceId: "fixture", preset: { version: 1, revision: 3, savedAt: "2026-11-03T08:00:00.000Z", savedVia: "local", appearance: { theme: "dark" } } },
  "/api/workspace/backup": backup,
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
    if (request.method() === "POST" && url.pathname === "/api/workspace/backup/retention/preview") {
      report.previews++;
      return route.fulfill({ json: retention(request.postDataJSON().keep) });
    }
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (!report.reads.includes(url.pathname)) report.reads.push(url.pathname);
    const known = gets[url.pathname];
    if (known === undefined && !report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    if (known === undefined && /^\/api\/(agents|workspace)\/./.test(url.pathname)) return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
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

// In the page: press a button as a pointer does (focus, then click), and read the panel it opens
// each frame from then on; or hold its reveal at 60 ms.
function pageHelpers() {
  const button = (scope, words) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === words) ?? null;
  const frame = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    // What reveals: the box the panel is in, where it has one (useRevealIn), else the panel itself.
    const box = el.parentElement?.classList.contains("reveal") ? el.parentElement : el;
    const animations = box.getAnimations();
    const own = getComputedStyle(el);
    const button = el.querySelector("button");
    return { h: Math.round(box.getBoundingClientRect().height * 10) / 10, opacity: Number(getComputedStyle(box).opacity), overflow: box.style.overflow,
      animations: animations.length, duration: animations[0]?.effect?.getComputedTiming().duration ?? null,
      // The panel itself: its own padding and margins, and where its first button is in it.
      padding: `${own.paddingTop} ${own.paddingBottom}`, margin: `${own.marginTop} ${own.marginBottom}`,
      control: button ? Math.round((button.getBoundingClientRect().top - el.getBoundingClientRect().top) * 10) / 10 : null };
  };
  window.__focused = () => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, text: el.textContent.trim().slice(0, 60), label: el.getAttribute("aria-label"), className: el.className } : null;
  };
  window.__buttonState = (scope, words) => {
    const b = button(scope, words);
    return b && { disabled: b.disabled, expanded: b.getAttribute("aria-expanded"), focused: document.activeElement === b };
  };
  window.__press = (scope, words, panel, frames = 30) => new Promise((done) => {
    const b = button(scope, words);
    if (!b) return done(null);
    b.focus();
    b.click();
    const out = [];
    const step = () => {
      out.push(frame(panel));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  window.__pressHeld = (scope, words, panel) => new Promise((done) => {
    const b = button(scope, words);
    if (!b) return done({ held: false });
    b.focus();
    b.click();
    requestAnimationFrame(() => {
      const el = document.querySelector(panel);
      const reveal = el?.getAnimations()[0];
      if (!reveal) return done({ held: false, frame: frame(panel) });
      reveal.pause();
      reveal.currentTime = 60;
      done({ held: true, frame: frame(panel) });
    });
  });
  window.__frames = (panel, frames = 10) => new Promise((done) => {
    const out = [];
    const step = () => {
      out.push(frame(panel));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** A reveal as the frames show it, against the panel's own height once it is still. */
function revealed(frames, still, reduced) {
  const shown = frames.filter(Boolean);
  if (!shown.length || !still) return false;
  const first = shown[0];
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => Math.abs(f.h - still.h) <= 0.5 && f.opacity === 1 && f.animations === 0);
  const rising = shown.every((f, i) => i === 0 || f.h >= shown[i - 1].h - 0.5);
  return first.h < still.h / 2 && first.opacity < 1 && first.overflow === "hidden" && Math.abs((first.duration ?? 0) - 180) < 0.5 && rising &&
    Math.abs(last.h - still.h) <= 0.5 && last.opacity === 1 && last.animations === 0 && last.overflow === "";
}

/** The panel itself, from the first frame of its reveal to its end: its own padding and margins as
 * when it is still, and its buttons where they are in it then (only the box it is in opens). */
function steady(frames, still) {
  const shown = (frames ?? []).filter(Boolean);
  return !!still && still.control !== null && shown.length > 0 &&
    shown.every((f) => f.padding === still.padding && f.margin === still.margin && f.control !== null && Math.abs(f.control - still.control) <= 0.5);
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const SHARED = "#settings-editor-appearance .appearance-file";
const PANEL = `${SHARED} .appearance-file-preview`;
const CONFIRM = "#settings-editor-backup .backup-retention-confirm";
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
  await page.addInitScript(pageHelpers);
  const openEditor = async (query, title, editor) => {
    if (!(await page.locator(".settings-search input").isVisible())) {
      await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    await page.locator(".settings-search input").fill(query);
    const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
    await card.locator("button").click({ timeout: 10_000 });
    await page.locator(`#settings-editor-${editor}`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  const press = (scope, words, panel) => page.evaluate(([scope, words, panel]) => window.__press(scope, words, panel), [scope, words, panel]);
  const still = (panel) => page.evaluate((panel) => window.__frames(panel, 1).then((f) => f[0]), panel);
  const focused = () => page.evaluate(() => window.__focused());
  const buttonState = (scope, words) => page.evaluate(([scope, words]) => window.__buttonState(scope, words), [scope, words]);
  const record = (label, value) => { report.frames[`${tag}: ${label}`] = value; return value; };
  /** Cancel in the panel, pressed as a pointer does. */
  const cancel = async (panel) => {
    await page.locator(panel).getByRole("button", { name: "Cancel", exact: true }).click({ timeout: 5000 });
    await page.waitForTimeout(100);
  };
  /** A preview opener, pressed: it stays enabled, says it is open and keeps focus; then its preview reveals. */
  async function opener(words, label) {
    const frames = record(`${label}: pressed`, await press(SHARED, words, PANEL));
    await page.waitForTimeout(150);
    const state = record(`${label}: its button`, await buttonState(SHARED, words));
    const natural = record(`${label}: still`, await still(PANEL));
    ok(`${tag}: ${label} pressed: it stays enabled, says it is open (aria-expanded) and keeps focus (${JSON.stringify(state)})`,
      !!state && !state.disabled && state.expanded === "true" && state.focused, { state, focus: await focused() });
    ok(`${tag}: ${label}: its preview reveals from nothing to its height over 180 ms with a fade, clipped meanwhile; under reduced motion it is there at once (first frame ${JSON.stringify(frames?.find(Boolean) ?? null)}, still ${natural?.h ?? "none"} px)`,
      revealed(frames ?? [], natural, reduced), { first: frames?.slice(0, 4), still: natural });
    ok(`${tag}: ${label}: the preview keeps its own padding and margins, and its buttons do not move within it, from the first frame of its reveal (padding ${natural?.padding}, margin ${natural?.margin}, button at ${natural?.control} px)`,
      steady(frames, natural), { moved: (frames ?? []).filter(Boolean).filter((f) => f.padding !== natural?.padding || f.margin !== natural?.margin || f.control !== natural?.control).slice(0, 3), still: natural });
  }
  try {
    await page.goto("http://127.0.0.1:4319/");
    await page.locator(".agent-row").first().waitFor();
    await openEditor("shared preset", "Shared Appearance preset", "appearance");
    await page.waitForFunction((scope) => [...document.querySelectorAll(`${scope} button`)].some((b) => b.textContent.trim() === "Preview…" && !b.disabled), SHARED, { timeout: 10_000 });

    // Preview… (ST:SA3).
    await opener("Preview…", "Preview…");
    await cancel(PANEL);
    const afterCancel = await focused();
    ok(`${tag}: Preview…: Cancel closes the preview and brings focus back to Preview… (${afterCancel?.text})`,
      !(await page.locator(PANEL).count()) && afterCancel?.tag === "BUTTON" && afterCancel.text === "Preview…", afterCancel);
    await press(SHARED, "Preview…", PANEL, 2);
    await page.waitForTimeout(300);
    await press(SHARED, "Preview…", PANEL, 2);
    await page.waitForTimeout(150);
    const toggled = { open: await page.locator(PANEL).count(), state: await buttonState(SHARED, "Preview…") };
    ok(`${tag}: Preview… pressed again while its preview is open closes it, with focus still on it (${JSON.stringify(toggled)})`,
      toggled.open === 0 && toggled.state?.expanded === "false" && toggled.state.focused, toggled);
    if (await page.locator(PANEL).count()) await cancel(PANEL);

    // Reduced motion turned on while the preview reveals (held at 60 ms): it is whole within a frame.
    if (!reduced) {
      const held = record("held at 60 ms", await page.evaluate(([scope, panel]) => window.__pressHeld(scope, "Preview…", panel), [SHARED, PANEL]));
      await page.emulateMedia({ reducedMotion: "reduce" });
      const after = record("reduced turned on", await page.evaluate((panel) => window.__frames(panel, 6), PANEL));
      const whole = await still(PANEL);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      ok(`${tag}: reduced motion turned on while the preview reveals (held at 60 ms, ${held.frame?.h ?? "none"} px): it is whole within a frame, nothing clipped`,
        held.held && held.frame.h < (whole?.h ?? 0) - 1 && after.length > 1 && after.slice(1).every((f) => f && Math.abs(f.h - whole.h) <= 0.5 && f.animations === 0 && f.overflow === ""),
        { held, after: after.slice(0, 3), whole });
      if (await page.locator(PANEL).count()) await cancel(PANEL);
    }

    // Follow this preset… (ST:SA4).
    await opener("Follow this preset…", "Follow this preset…");
    await cancel(PANEL);
    const afterFollow = await focused();
    ok(`${tag}: Follow this preset…: Cancel closes the preview and brings focus back to Follow this preset… (${afterFollow?.text})`,
      !(await page.locator(PANEL).count()) && afterFollow?.tag === "BUTTON" && afterFollow.text === "Follow this preset…", afterFollow);

    // A backup's Remove… (ST:BR2).
    await openEditor("backup", "Workspace backup & restore", "backup");
    await page.getByLabel("Folder holding backups").fill("/backups/daily");
    await page.locator("#settings-editor-backup .backup-retention").getByRole("button", { name: "Preview", exact: true }).click();
    await page.locator("#settings-editor-backup .backup-retention-result").waitFor({ timeout: 10_000 });
    const frames = record("Remove… pressed", await press("#settings-editor-backup .backup-retention-result", "Remove…", CONFIRM));
    await page.waitForTimeout(150);
    const natural = await still(CONFIRM);
    ok(`${tag}: Remove…: its confirmation reveals below the backup from nothing over 180 ms with a fade, clipped meanwhile; under reduced motion it is there at once (still ${natural?.h ?? "none"} px)`,
      revealed(frames ?? [], natural, reduced), { first: frames?.slice(0, 4), still: natural });
    ok(`${tag}: Remove…: the confirmation keeps its own padding and margins, and its buttons do not move within it, from the first frame of its reveal (padding ${natural?.padding}, margin ${natural?.margin}, button at ${natural?.control} px)`,
      steady(frames, natural), { moved: (frames ?? []).filter(Boolean).filter((f) => f.padding !== natural?.padding || f.margin !== natural?.margin || f.control !== natural?.control).slice(0, 3), still: natural });
    const inConfirm = await focused();
    ok(`${tag}: Remove…: the confirmation takes focus (${inConfirm?.label})`,
      inConfirm?.className.includes("backup-retention-confirm") && inConfirm.label === `Remove ${NAME}`, inConfirm);
    await cancel(CONFIRM);
    const back = await focused();
    ok(`${tag}: Remove…: Cancel closes the confirmation and brings focus back to that Remove… (${back?.text})`,
      !(await page.locator(CONFIRM).count()) && back?.tag === "BUTTON" && back.text === "Remove…", back);
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but the retention previews asked for (POST .../retention/preview, ${report.previews}) and where an Agent was read (PUT .../reading, ${report.readingSaves.length})`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2d3-confirms-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
