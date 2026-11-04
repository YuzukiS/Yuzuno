// T-19, the Portal's Stop Job… confirmation and Disconnect (F2 + M9: WK:PT-11; Lead 3521), in Chromium
// on a production build of the app, with a synthetic Workspace and every API answered here (no Core,
// no Agent). Each service is opened from its project's services list, as the user opens it.
// - A Job's service on an older Core (no lifecycle): Stop Job… opens its confirmation below the
//   actions. It fades in over small, opacity only, at its own height from its first frame, nothing
//   clipped, and takes focus; nothing is stopped. Keep it closes it and brings focus back to Stop Job….
//   When a newer read says the Job can no longer be stopped, Keep it gives focus to the Portal's
//   title; when a newer read has no Job for the service, the confirmation goes and focus, which was in
//   it, goes to the title.
// - Disconnect, there and in a managed service's run details: once Core has it, the note takes the
//   page's place, fades in over small and, focus having gone with Disconnect, takes it. Where the run
//   isn't live (it ended before, or while Core closed the way), its state stands there and the title
//   takes focus. Focus the user moved elsewhere meanwhile stays there; a run ending by itself moves
//   no focus and plays nothing.
// - Under reduced motion nothing plays; focus moves the same.
// Writes: only each service's own open (from the list) and close (Disconnect); anything else is
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
const running = { jobId: "demo-84", status: "running", owner: "verified", earlierJobIds: [], canStop: true, reason: null, resultReason: null,
  startedAt: iso(-3_600_000), finishedAt: null, timeoutSeconds: 4 * 3600, reserved: true, cancelRequestedAt: null, attempt: "a1", ownerCheckedAt: iso(-60_000) };
// Stopped from elsewhere: no longer stoppable here.
const stopping = { ...running, status: "cancelling", canStop: false, cancelRequestedAt: iso(0) };
// The run ended by itself: it no longer listens on the port.
const ended = { ...running, status: "succeeded", owner: "notListening", canStop: false, reserved: false, finishedAt: iso(0) };
const intent = { revision: 0, desiredState: "unspecified", recoveryMode: "manual", requestedAt: null, requestedBy: null, appliesToJobId: null,
  sourceJobId: null, requestId: null };
const service = (managed, job = running) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "Northstar preview", author: { kind: "agent", id: "iris", name: "Iris" },
  createdAt: iso(-7_200_000),
  connection: { state: "available", localPort: PORT, httpStatus: 200, framing: "allowed", since: iso(-60_000) },
  job,
  health: { declared: true, path: "/health", state: "ok", httpStatus: 200, checkedAt: iso(-60_000) },
  // An older Core says no lifecycle: the Portal shows the Job's own facts and Stop Job….
  ...(managed ? { lifecycle: { intent, canStart: false, startBlockedCode: "service_busy", startBlockedReason: "service_busy", sourceJobId: running.jobId } } : {}),
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
          // Core takes a moment to close the way (some scenes, longer).
          await new Promise((done) => setTimeout(done, state.closeMs));
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
    // What plays: the element itself, or a box it is in (as a height reveal had it).
    const box = el.parentElement?.classList.contains("reveal") ? el.parentElement : el;
    const animations = box.getAnimations();
    const keys = new Set();
    for (const a of animations)
      for (const k of a.effect?.getKeyframes?.() ?? [])
        for (const p of Object.keys(k)) if (!["offset", "easing", "composite", "computedOffset"].includes(p)) keys.add(p);
    const own = getComputedStyle(el);
    const control = el.querySelector("button");
    return { h: Math.round(box.getBoundingClientRect().height * 10) / 10, opacity: Number(getComputedStyle(box).opacity), overflow: box.style.overflow,
      animations: animations.length, duration: animations[0]?.effect?.getComputedTiming().duration ?? null, keys: [...keys].sort().join("+"),
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
  // Everything playing in the Portal now.
  window.__playing = () => document.querySelector(".portal-panel")?.getAnimations({ subtree: true })
    .filter((a) => !a.effect?.target?.closest?.(".spin")).length ?? 0;
}

/** The confirmation came in: a fade over small, opacity only, at its own height from its first frame,
 * nothing clipped; under reduced motion, there at once. */
function fadedIn(frames, still, reduced) {
  const shown = (frames ?? []).filter(Boolean);
  if (!shown.length || !still) return false;
  const whole = shown.every((f) => Math.abs(f.h - still.h) <= 0.5 && f.overflow === "" && f.padding === still.padding && f.margin === still.margin);
  const first = shown[0];
  const last = shown.at(-1);
  if (reduced) return whole && shown.every((f) => f.opacity === 1 && f.animations === 0);
  return whole && first.opacity < 1 && first.animations === 1 && first.keys === "opacity" && Math.abs((first.duration ?? 0) - 180) < 0.5 &&
    last.opacity === 1 && last.animations === 0;
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
const onTitle = (f) => !!f?.className.includes("portal-title");

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
const IDLE = '.portal-panel .portal-idle[data-idle="ended"]';
// Each scene opens its own service in a fresh browser context.
const scenes = [
  { key: "older", managed: false },
  { key: "managed", managed: true },
  { key: "managed-ended", managed: true },
  { key: "managed-ends-while-closing", managed: true, closeMs: 6500 },
  { key: "managed-focus-moved", managed: true, closeMs: 1500 },
];

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  for (const scene of scenes) {
    const state = { service: service(scene.managed), opened: false, closeMs: scene.closeMs ?? 120 };
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
    const record = (label, value) => { report.frames[`${tag}, ${scene.key}: ${label}`] = value; return value; };
    /** A newer read of the services list (every 5 s) says what the fixture says now. */
    const nextRead = async (until) => page.waitForFunction(until, null, { timeout: 12_000 });
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
      await page.locator(scene.managed ? ".portal-panel .portal-lifecycle" : JOB).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);

      if (scene.key === "older") {
        // Stop Job…: it fades in at its own height and takes focus.
        const frames = record("Stop Job… pressed", await press(JOB, "Stop Job…", CONFIRM));
        await page.waitForTimeout(150);
        const natural = record("Stop Job…: still", await still(CONFIRM));
        ok(`${tag}: Stop Job… pressed: its confirmation fades in below the actions over small at its own height from its first frame, nothing clipped, only its opacity animated; under reduced motion it is there at once (first frame ${JSON.stringify(frames?.find(Boolean) ?? null)}, still ${natural?.h ?? "none"} px)`,
          fadedIn(frames, natural, reduced), { first: frames?.slice(0, 4), still: natural });
        const inConfirm = await focused();
        ok(`${tag}: Stop Job…: the confirmation takes focus, and nothing is stopped (${inConfirm?.label})`,
          !!inConfirm?.className.includes("portal-confirm") && inConfirm.label === "Stop the Job" && report.writes.length === 0, inConfirm);
        await page.locator(CONFIRM).getByRole("button", { name: "Keep it", exact: true }).click({ timeout: 5000 });
        await page.waitForTimeout(100);
        const back = await focused();
        ok(`${tag}: Stop Job…: Keep it closes the confirmation and brings focus back to Stop Job… (${back?.text})`,
          !(await page.locator(CONFIRM).count()) && back?.tag === "BUTTON" && back.text === "Stop Job…", back);

        // Open again; a newer read says the Job is being stopped from elsewhere: Stop Job… is gone.
        await press(JOB, "Stop Job…", CONFIRM);
        state.service = service(false, stopping);
        await nextRead(() => [...document.querySelectorAll(".portal-panel .portal-job header .portal-tag")].some((tag) => tag.textContent === "Stopping"));
        await page.locator(CONFIRM).getByRole("button", { name: "Keep it", exact: true }).click({ timeout: 5000 });
        await page.waitForTimeout(100);
        const kept = record("Keep it when Stop Job… is gone", await focused());
        ok(`${tag}: Stop Job… open when a newer read says the Job can no longer be stopped: Keep it gives focus to the Portal's title (${kept?.className || kept?.tag})`,
          onTitle(kept) && !(await page.locator(`${JOB} .portal-stop`).count()), kept);

        // Running again; open it; a newer read has no Job for the service: the confirmation goes.
        state.service = service(false, running);
        await nextRead(() => !!document.querySelector(".portal-panel .portal-job .portal-stop"));
        await press(JOB, "Stop Job…", CONFIRM);
        await page.waitForTimeout(150);
        const before = await focused();
        state.service = service(false, null);
        await nextRead(() => !document.querySelector(".portal-panel .portal-job .portal-confirm"));
        await page.waitForTimeout(100);
        const gone = record("the Job gone", { before, after: await focused() });
        ok(`${tag}: Stop Job… open when a newer read has no Job for the service: the confirmation goes, and focus, which was in it, goes to the Portal's title (${gone.after?.className || gone.after?.tag})`,
          !!before?.className.includes("portal-confirm") && onTitle(gone.after), gone);

        // The Job back: its confirmation stands again, as it does for the Job it was opened for. Keep it; then Disconnect there.
        state.service = service(false, running);
        await nextRead(() => !!document.querySelector(".portal-panel .portal-job .portal-confirm"));
        await page.locator(CONFIRM).getByRole("button", { name: "Keep it", exact: true }).click({ timeout: 5000 });
        await page.locator(`${JOB} .portal-stop`).waitFor({ timeout: 5000 });
        const note = record("Disconnect pressed", await press(JOB, "Disconnect", NOTE));
        await page.waitForTimeout(100);
        const onNote = await focused();
        ok(`${tag}: Disconnect (a Job on an older Core): once Core has it, the note takes the page's place and fades in over small; under reduced motion it is there at once (first frame ${JSON.stringify(note?.find(Boolean) ?? null)})`,
          came(note, reduced), { first: note?.filter(Boolean).slice(0, 3), last: note?.filter(Boolean).at(-1) });
        ok(`${tag}: Disconnect (a Job on an older Core): focus, gone with Disconnect, is on the note (${onNote?.idle ?? onNote?.tag})`,
          onNote?.idle === "disconnected" && !!onNote.className.includes("portal-idle"), onNote);
      } else {
        await page.locator(`${DETAILS} > summary`).click();
        await page.locator(DETAILS).locator("button", { hasText: /^Disconnect preview$/ }).waitFor({ timeout: 5000 });
      }

      if (scene.key === "managed") {
        const note = record("Disconnect pressed", await press(DETAILS, "Disconnect preview", NOTE));
        await page.waitForTimeout(100);
        const onNote = await focused();
        ok(`${tag}: Disconnect (a managed service): once Core has it, the note takes the page's place and fades in over small; under reduced motion it is there at once (first frame ${JSON.stringify(note?.find(Boolean) ?? null)})`,
          came(note, reduced), { first: note?.filter(Boolean).slice(0, 3), last: note?.filter(Boolean).at(-1) });
        ok(`${tag}: Disconnect (a managed service): focus, gone with Disconnect, is on the note (${onNote?.idle ?? onNote?.tag})`,
          onNote?.idle === "disconnected" && !!onNote.className.includes("portal-idle"), onNote);
      }

      if (scene.key === "managed-ended") {
        // The run ends by itself: a newer read shows its state; focus stays on Run details.
        const before = await focused();
        state.service = service(true, ended);
        await nextRead(() => !!document.querySelector('.portal-panel .portal-idle[data-idle="ended"]'));
        await page.waitForTimeout(100);
        const after = await focused();
        const playing = await page.evaluate(() => window.__playing());
        record("ended by itself", { before, after, playing });
        ok(`${tag}: a managed service's run ending by itself (a newer read): its state stands in the page's place, focus stays where it was, and nothing plays (${after?.tag} ${after?.text}, ${playing} playing)`,
          before?.tag === "SUMMARY" && after?.tag === "SUMMARY" && playing === 0 && !!(await page.locator(IDLE).count()), { before, after, playing });
        // Disconnect now.
        await press(DETAILS, "Disconnect preview", NOTE, 2);
        await page.waitForFunction(() => ![...document.querySelectorAll(".portal-panel .service-lifecycle-details button")].some((b) => b.textContent.trim() === "Disconnect preview"), null, { timeout: 5000 });
        await page.waitForTimeout(100);
        const onEnded = record("Disconnect, ended", await focused());
        ok(`${tag}: Disconnect (a managed service whose run is not live): once Core has it, focus, gone with Disconnect, is on the Portal's title (${onEnded?.className || onEnded?.tag})`,
          onTitle(onEnded) && !!(await page.locator(IDLE).count()), onEnded);
      }

      if (scene.key === "managed-ends-while-closing") {
        // Disconnect pressed; while Core closes the way (6.5 s), a newer read says the run ended.
        await press(DETAILS, "Disconnect preview", NOTE, 2);
        state.service = service(true, ended);
        await nextRead(() => !!document.querySelector('.portal-panel .portal-idle[data-idle="ended"]'));
        const meanwhile = await focused();
        await page.waitForFunction(() => ![...document.querySelectorAll(".portal-panel .service-lifecycle-details button")].some((b) => b.textContent.trim() === "Disconnect preview"), null, { timeout: 10_000 });
        await page.waitForTimeout(100);
        const after = record("Disconnect, ended while closing", { meanwhile, after: await focused() });
        ok(`${tag}: Disconnect (a managed service) whose run ends while Core closes the way: once Core has it, focus is on the Portal's title (${after.after?.className || after.after?.tag})`,
          meanwhile?.text === "Disconnect preview" && onTitle(after.after), after);
      }

      if (scene.key === "managed-focus-moved") {
        // Disconnect pressed; while Core closes the way (1.5 s), the user moves focus to Run details.
        await press(DETAILS, "Disconnect preview", NOTE, 2);
        await page.locator(`${DETAILS} > summary`).focus();
        await page.waitForFunction(() => !!document.querySelector('.portal-panel .portal-idle[data-idle="disconnected"]'), null, { timeout: 10_000 });
        await page.waitForTimeout(300);
        const after = record("Disconnect, focus moved", await focused());
        ok(`${tag}: Disconnect (a managed service) after the user moved focus elsewhere: once Core has it, focus stays where they put it (${after?.tag} ${after?.text})`,
          after?.tag === "SUMMARY", after);
      }
      await page.screenshot({ path: join(output, `${tag}-${scene.key}-after.png`) });
    } catch (error) {
      ok(`${tag}: ${scene.key}: the sequence ran to its end`, false, String(error).slice(0, 400));
      await page.screenshot({ path: join(output, `${tag}-${scene.key}-error.png`) }).catch(() => {});
    }
    await context.close();
  }
}
await browser.close();
ok(`nothing was written but each service opened from its list (POST /api/services/s1/open, ${report.opens.length}) and its Disconnect (POST /api/services/s1/close, ${report.closes.length})`,
  report.writes.length === 0 && report.opens.length === runs.length * scenes.length && report.closes.length === runs.length * scenes.length, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-portal-confirm-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
