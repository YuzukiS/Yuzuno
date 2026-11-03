// T-19, the Portal's Stop Job… confirmation and Disconnect (F2 + M9: WK:PT-11), in Chromium on a
// production build of the app, with a synthetic Workspace and every API answered here (no Core, no
// Agent). Each service is opened from its project's services list, as the user opens it.
// - A Job's service on an older Core (no lifecycle): Stop Job… opens its confirmation below the
//   actions. It reveals from nothing to its height over small with a fade, clipped meanwhile; only
//   the box it is in opens, so it keeps its own padding and margins and its buttons stay where they
//   are in it. It takes focus, and nothing is stopped. Keep it closes it and brings focus back to
//   Stop Job….
// - Disconnect, there and in a managed service's run details: once Core has it, the note takes the
//   page's place, fades in over small and, focus having gone with Disconnect, takes it.
// - Under reduced motion nothing plays; focus moves the same.
// Writes: only the service's own open (from the list) and close (Disconnect); anything else is
// refused and counted.
// Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-portal-confirm-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-portal-confirm");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], opens: [], closes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const HOST = "127.0.0.1:4320";
const PORT = 4382;
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const base = { harness: "claude", cwd: "/fixture", model: "test-model", settings: {}, color: "sage", createdAt: "", updatedAt: "",
  status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, goal: "" };
const agents = [{ ...base, id: "iris", name: "Iris", projectId: "p1", rev: 1 }];
const projects = [{ id: "p1", name: "Northstar", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
// Synthetic records only.
const job = { jobId: "demo-84", status: "running", owner: "verified", earlierJobIds: [], canStop: true, reason: null, resultReason: null,
  startedAt: iso(-3_600_000), finishedAt: null, timeoutSeconds: 4 * 3600, reserved: true, cancelRequestedAt: null, attempt: "a1", ownerCheckedAt: iso(-60_000) };
const intent = { revision: 0, desiredState: "unspecified", recoveryMode: "manual", requestedAt: null, requestedBy: null, appliesToJobId: null,
  sourceJobId: null, requestId: null };
const service = (managed) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "Northstar preview", author: { kind: "agent", id: "iris", name: "Iris" },
  createdAt: iso(-7_200_000),
  connection: { state: "available", localPort: PORT, httpStatus: 200, framing: "allowed", since: iso(-60_000) },
  job,
  health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-60_000) },
  // An older Core says no lifecycle: the Portal shows the Job's own facts and Stop Job….
  ...(managed ? { lifecycle: { intent, canStart: false, startBlockedCode: "service_busy", startBlockedReason: "service_busy", sourceJobId: job.jobId } } : {}),
});
const page200 = "<!doctype html><meta charset=utf-8><title>Northstar</title><body style=\"font:16px system-ui;margin:40px\"><h1>Northstar</h1><p>A synthetic page.</p></body>";
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function serve(tag, state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    // The service's own port, as this browser reaches it: the proof, and its page.
    if (url.host === `127.0.0.1:${PORT}`) {
      if (path.startsWith("/.well-known/yuzuno-service/"))
        return route.fulfill({ body: path.endsWith("/c-check") ? "a-check" : "nope", contentType: "text/plain", headers: { "access-control-allow-origin": "*" } });
      return route.fulfill({ body: page200, contentType: "text/html" });
    }
    if (path.startsWith("/api/")) {
      if (request.method() !== "GET") {
        // Reads that are POSTs, and change nothing.
        if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
        if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
        if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: { accepted: true } });
        if (path === "/api/services/s1/open") {
          report.opens.push(`${tag}: ${path}`);
          state.opened = true;
          // As Core answers it: the service and its way, never its Job, lifecycle or health.
          const { job: _job, lifecycle: _lifecycle, health: _health, ...opened } = state.service;
          return route.fulfill({ json: { ...opened, proof: { challenge: "c-check", answer: "a-check" } } });
        }
        if (path === "/api/services/s1/close") {
          report.closes.push(`${tag}: ${path}`);
          // Core takes a moment to close the way.
          await new Promise((done) => setTimeout(done, 120));
          return route.fulfill({ json: { ...state.service, connection: { state: "closed", since: iso(0) } } });
        }
        report.writes.push(`${tag}: ${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { error: "no writes here" } });
      }
      if (path === "/api/workspace")
        return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 1, tasks: 0 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" } });
      if (path === "/api/projects/p1/services")
        return route.fulfill({ json: { services: [state.opened ? state.service : { ...state.service, connection: { state: "closed", since: iso(-3_600_000) } }] } });
      if (path === "/api/agents/iris") return route.fulfill({ json: { agent: agents[0], pending: [], artifacts: [], messageReceipts: [], turns: [] } });
      if (path === "/api/machines") return route.fulfill({ json: { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] } });
      if (path === "/api/projects/p1/home-editors") return route.fulfill({ json: { version: 0, editorAgentIds: null } });
      if (path.startsWith("/api/jobs/") && path.endsWith("/logs")) {
        const text = "15:30  GET /health -> 200\n";
        return route.fulfill({ json: { text, offset: 0, nextOffset: text.length, oldestOffset: 0, totalBytes: text.length, truncated: false } });
      }
      const known = { "/api/updates": unmanagedUpdates, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/jobs/budget": idleJobsBudget,
        "/api/ci/runs": noCiRuns, "/api/reviews": noReviews,
        "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } }[path];
      if (known === undefined && !report.unknownGets.includes(path)) report.unknownGets.push(path);
      return route.fulfill({ json: known ?? {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
    } catch {
      return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
    }
  };
}

// In the page: press a button as a pointer does (focus, then click), and read what it opens each
// frame from then on.
function pageHelpers() {
  const button = (scope, words) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === words) ?? null;
  const frame = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    // What reveals: the box it is in, where it has one (useRevealIn), else the element itself.
    const box = el.parentElement?.classList.contains("reveal") ? el.parentElement : el;
    const animations = box.getAnimations();
    const own = getComputedStyle(el);
    const control = el.querySelector("button");
    return { h: Math.round(box.getBoundingClientRect().height * 10) / 10, opacity: Number(getComputedStyle(box).opacity), overflow: box.style.overflow,
      animations: animations.length, duration: animations[0]?.effect?.getComputedTiming().duration ?? null,
      // The element itself: its own padding and margins, and where its first button is in it.
      padding: `${own.paddingTop} ${own.paddingBottom}`, margin: `${own.marginTop} ${own.marginBottom}`,
      control: control ? Math.round((control.getBoundingClientRect().top - el.getBoundingClientRect().top) * 10) / 10 : null };
  };
  window.__focused = () => {
    const el = document.activeElement;
    return el ? { tag: el.tagName, text: el.textContent.trim().slice(0, 60), label: el.getAttribute("aria-label"),
      className: typeof el.className === "string" ? el.className : "", idle: el.dataset?.idle ?? null } : null;
  };
  window.__press = (scope, words, target, frames = 60) => new Promise((done) => {
    const b = button(scope, words);
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
  window.__frames = (target, frames = 1) => new Promise((done) => {
    const out = [];
    const step = () => {
      out.push(frame(target));
      if (out.length >= frames) done(out);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** A reveal as the frames show it, against the element's own height once it is still. */
function revealed(frames, still, reduced) {
  const shown = (frames ?? []).filter(Boolean);
  if (!shown.length || !still) return false;
  const first = shown[0];
  const last = shown.at(-1);
  if (reduced) return shown.every((f) => Math.abs(f.h - still.h) <= 0.5 && f.opacity === 1 && f.animations === 0);
  const rising = shown.every((f, i) => i === 0 || f.h >= shown[i - 1].h - 0.5);
  return first.h < still.h / 2 && first.opacity < 1 && first.overflow === "hidden" && Math.abs((first.duration ?? 0) - 180) < 0.5 && rising &&
    Math.abs(last.h - still.h) <= 0.5 && last.opacity === 1 && last.animations === 0 && last.overflow === "";
}
/** The element itself, from the first frame of its reveal to its end: its own padding and margins as
 * when it is still, and its buttons where they are in it then (only the box it is in opens). */
function steady(frames, still) {
  const shown = (frames ?? []).filter(Boolean);
  return !!still && still.control !== null && shown.length > 0 &&
    shown.every((f) => f.padding === still.padding && f.margin === still.margin && f.control !== null && Math.abs(f.control - still.control) <= 0.5);
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

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const JOB = ".portal-panel .portal-job";
const CONFIRM = `${JOB} .portal-confirm`;
const NOTE = '.portal-panel .portal-idle[data-idle="disconnected"]';
const DETAILS = ".portal-panel .service-lifecycle-details";

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  for (const managed of [false, true]) {
    const scene = managed ? "a managed service" : "a Job on an older Core";
    const state = { service: service(managed), opened: false };
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
      hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
    await page.route("**/*", serve(tag, state));
    await page.addInitScript(() => {
      window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
    });
    await page.addInitScript(pageHelpers);
    const press = (scope, words, target) => page.evaluate(([scope, words, target]) => window.__press(scope, words, target), [scope, words, target]);
    const still = (target) => page.evaluate((target) => window.__frames(target, 1).then((f) => f[0]), target);
    const focused = () => page.evaluate(() => window.__focused());
    const record = (label, value) => { report.frames[`${tag}, ${scene}: ${label}`] = value; return value; };
    try {
      await page.goto(`http://${HOST}/`);
      // From the project's services list, as the user opens it.
      await page.locator(".workspace-scope").first().click({ timeout: 10_000 });
      await page.locator("button", { hasText: /^Manage projects…$/ }).click();
      const dialog = page.locator('[role="dialog"]').first();
      await dialog.locator("button", { hasText: "Northstar" }).first().click();
      const panel = dialog.locator('[aria-label="Services"]');
      await panel.locator("button", { hasText: /^Open$/ }).click();
      await panel.locator(".services-open").waitFor({ timeout: 10_000 });
      await panel.locator(".open-choice-split > .primary-button:not(.open-choice-more)").click();
      await page.locator(managed ? ".portal-panel .portal-lifecycle" : JOB).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);

      if (!managed) {
        // Stop Job… (WK:PT-11).
        const frames = record("Stop Job… pressed", await press(JOB, "Stop Job…", CONFIRM));
        await page.waitForTimeout(150);
        const natural = record("Stop Job…: still", await still(CONFIRM));
        ok(`${tag}: Stop Job… pressed: its confirmation reveals below the actions from nothing over 180 ms with a fade, clipped meanwhile; under reduced motion it is there at once (first frame ${JSON.stringify(frames?.find(Boolean) ?? null)}, still ${natural?.h ?? "none"} px)`,
          revealed(frames, natural, reduced), { first: frames?.slice(0, 4), still: natural });
        ok(`${tag}: Stop Job…: the confirmation keeps its own padding and margins, and its buttons do not move within it, from the first frame of its reveal (padding ${natural?.padding}, margin ${natural?.margin}, button at ${natural?.control} px)`,
          steady(frames, natural), { moved: (frames ?? []).filter(Boolean).filter((f) => f.padding !== natural?.padding || f.margin !== natural?.margin || f.control !== natural?.control).slice(0, 3), still: natural });
        const inConfirm = await focused();
        ok(`${tag}: Stop Job…: the confirmation takes focus, and nothing is stopped (${inConfirm?.label})`,
          !!inConfirm?.className.includes("portal-confirm") && inConfirm.label === "Stop the Job" && report.writes.length === 0, inConfirm);
        await page.locator(CONFIRM).getByRole("button", { name: "Keep it", exact: true }).click({ timeout: 5000 });
        await page.waitForTimeout(100);
        const back = await focused();
        ok(`${tag}: Stop Job…: Keep it closes the confirmation and brings focus back to Stop Job… (${back?.text})`,
          !(await page.locator(CONFIRM).count()) && back?.tag === "BUTTON" && back.text === "Stop Job…", back);
      } else {
        await page.locator(`${DETAILS} > summary`).click();
        await page.locator(DETAILS).locator("button", { hasText: /^Disconnect preview$/ }).waitFor({ timeout: 5000 });
      }

      // Disconnect: there, or in the managed service's run details.
      const [scope, words] = managed ? [DETAILS, "Disconnect preview"] : [JOB, "Disconnect"];
      const before = report.closes.length;
      const note = record("Disconnect pressed", await press(scope, words, NOTE));
      await page.waitForTimeout(100);
      const onNote = await focused();
      ok(`${tag}: Disconnect (${scene}): once Core has it, the note takes the page's place and fades in over small; under reduced motion it is there at once (first frame ${JSON.stringify(note?.find(Boolean) ?? null)})`,
        report.closes.length === before + 1 && came(note, reduced), { first: note?.filter(Boolean).slice(0, 3), last: note?.filter(Boolean).at(-1) });
      ok(`${tag}: Disconnect (${scene}): focus, gone with Disconnect, is on the note (${onNote?.idle ?? onNote?.tag})`,
        onNote?.idle === "disconnected" && !!onNote.className.includes("portal-idle"), onNote);
      await page.screenshot({ path: join(output, `${tag}-${managed ? "managed" : "older"}-after.png`) });
    } catch (error) {
      ok(`${tag}: ${scene}: the sequence ran to its end`, false, String(error).slice(0, 400));
      await page.screenshot({ path: join(output, `${tag}-${managed ? "managed" : "older"}-error.png`) }).catch(() => {});
    }
    await context.close();
  }
}
await browser.close();
ok(`nothing was written but each service opened from its list (POST /api/services/s1/open, ${report.opens.length}) and its Disconnect (POST /api/services/s1/close, ${report.closes.length})`,
  report.writes.length === 0 && report.opens.length === 8 && report.closes.length === 8, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-portal-confirm-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
