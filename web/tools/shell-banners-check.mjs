// T-51 PR 2 (T-19's shell banner rows), in Chromium on a production build of the app with a synthetic Workspace
// and every API answered here (no Core, no Agent):
// - SH:M06: "Live reconnecting" shows once the live events have been down 600 ms, so a drop that comes back sooner
//   never flashes it; it reveals over small (its row and opacity) and leaves over exit-small.
// - SH:M04: the connection banner (the browser offline, or the Workspace unreadable) the same.
// - SH:M05: Retry, while the read it starts is on its way, says "Retrying…", is busy, and its icon turns; after that
//   read it is Retry again.
// - ST:SA7: a newer revision of the shared Appearance preset, applied here in the background, says so in a toast.
// Under reduced motion nothing plays: the banners show after the same wait and go at once, and Retry's icon stays
// still. The browser's offline report is the page's `navigator.onLine` and its events, faked here, so the network
// stays up. Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: the app's own saves of
// where an Agent was read; anything else is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/shell-banners-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/shell-banners");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], unknownGets: [], readingSaves: [], workspaceReads: 0, measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const WORKSPACE = "ws-shell-banners";
const agent = { id: "a", name: "Mori", status: "idle", goal: "", cwd: "/fixture", model: "m", color: "sage", createdAt: "",
  updatedAt: "1", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex",
  connectionState: "connected" };
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
// The shared Appearance preset: revision 2, a palette this device doesn't use, saved by another device.
const preset = { version: 1, revision: 2, savedAt: "2026-11-05T06:00:00.000Z", savedVia: "remote", appearance: { palette: "pine" } };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/appearance-preset": { workspaceId: WORKSPACE, preset },
  "/api/backlog": { observedAt: "2026-11-05T00:00:00Z", agents: {} },
  "/api/models": { models: [] },
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
};
let failWorkspace = false;
const holding = new Set();
const held = new Map();
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    let answer;
    if (method === "GET" && path === "/api/agents/a/reading") answer = () => route.fulfill({ json: { handoff: null } });
    else if (method === "PUT" && path === "/api/agents/a/reading") {
      report.readingSaves.push(path);
      answer = () => route.fulfill({ json: { accepted: true, sourceSeq: 0 } });
    } else if (method === "GET" && path === "/api/workspace") {
      report.workspaceReads++;
      // Decided as it is answered, so a held read answers as the Workspace is then.
      answer = () => failWorkspace
        ? route.fulfill({ status: 503, json: { error: "fixture: the Workspace can't be read now" } })
        : route.fulfill({ json: gets[path] });
    } else if (method === "GET") {
      if (gets[path] === undefined && !report.unknownGets.includes(path)) report.unknownGets.push(path);
      answer = () => route.fulfill({ json: gets[path] ?? {} });
    } else {
      report.writes.push(`${method} ${path}`);
      return route.fulfill({ status: 400, json: { error: "this check writes nothing" } });
    }
    const k = `${method} ${path}`;
    if (holding.has(k)) {
      if (!held.has(k)) held.set(k, []);
      held.get(k).push(answer);
      return;
    }
    return answer();
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = resolve(dist, file);
  assert.ok(full.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(full), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}
const hold = (method, path) => holding.add(`${method} ${path}`);
async function waiting(method, path) {
  const until = Date.now() + 10_000;
  while (!(held.get(`${method} ${path}`)?.length)) {
    if (Date.now() > until) throw new Error(`no ${method} ${path} came`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function release(method, path) {
  holding.delete(`${method} ${path}`);
  for (const answer of held.get(`${method} ${path}`)?.splice(0) ?? []) await answer();
}

/** In the page from the first script: the live events, the browser's offline report, and a recorder of a banner's
 * coming and going with what plays on it. */
function pageHelpers(follow) {
  let id = 0;
  const sources = [];
  const reset = (source) => source.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
  window.EventSource = class {
    constructor() {
      sources.push(this);
      this.readyState = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        reset(this);
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  const live = () => sources.filter((s) => s.readyState !== 2).at(-1);
  /** The live events drop; the browser would retry by itself (still connecting), so the page waits for it. */
  window.__drop = () => {
    const source = live();
    source.readyState = 0;
    source.onerror?.({});
  };
  /** That retry opens. */
  window.__open = () => {
    const source = live();
    source.readyState = 1;
    source.onopen?.({});
    reset(source);
  };
  /** Core says the Workspace changed: the page reads it again. */
  window.__reset = () => reset(live());
  let online = true;
  Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => online });
  window.__offline = () => {
    online = false;
    window.dispatchEvent(new Event("offline"));
  };
  window.__online = () => {
    online = true;
    window.dispatchEvent(new Event("online"));
  };
  if (!sessionStorage.getItem("t51-seeded")) {
    sessionStorage.setItem("t51-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (follow) localStorage.setItem("yuzuno.appearanceFollow", JSON.stringify({ workspaces: { [follow]: { revision: 1 } } }));
  }
  /** The animations running or about to run on `el` itself: their properties and duration. */
  window.__plays = (el) => !el ? null : el.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending").map((a) => ({
    props: [...new Set((a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k))
      .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))].sort().join("+"),
    duration: a.effect?.getTiming?.().duration ?? null,
  }));
  /** Records, from now, when `selector` first shows (ms), what plays on its reveal (or on it, where it has none),
   * and, after `mark()`, when its reveal starts leaving, what plays then, and when it is gone. Every DOM change and
   * every frame looks, so neither a one-frame banner nor a quick exit is missed. */
  window.__tracks = {};
  window.__track = (name, selector) => {
    const start = performance.now();
    const rec = { shown: null, plays: null, role: null, text: null, mark: null, leaving: null, leavePlays: null, gone: null, sightings: 0 };
    let el = null;
    const look = () => {
      const now = performance.now() - start;
      if (!el) {
        const found = document.querySelector(selector);
        if (found) {
          el = found;
          rec.shown = now;
          rec.plays = window.__plays(found.closest(".banner-reveal") ?? found);
          rec.role = found.getAttribute("role");
          rec.text = found.textContent.trim().slice(0, 200);
        }
      }
      if (!el) return;
      if (el.isConnected) rec.sightings++;
      const wrap = el.closest(".banner-reveal");
      if (rec.mark !== null && rec.leaving === null && wrap?.classList.contains("is-leaving")) {
        rec.leaving = now - rec.mark;
        rec.leavePlays = window.__plays(wrap);
      }
      if (rec.gone === null && !el.isConnected) rec.gone = rec.mark === null ? now : now - rec.mark;
    };
    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    let frame = requestAnimationFrame(function each() {
      look();
      frame = requestAnimationFrame(each);
    });
    window.__tracks[name] = {
      rec,
      mark: () => { rec.mark = performance.now() - start; },
      stop: () => { observer.disconnect(); cancelAnimationFrame(frame); return rec; },
    };
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
const LIVE = ".event-connection-banner";
const CORE = ".core-connection-banner:not(.event-connection-banner)";
/** Shown once its cause held 600 ms (and not much later), revealing over small, its row and opacity; under reduced
 * motion, after the same wait, with nothing playing. */
const revealed = (rec, reduced) => typeof rec?.shown === "number" && rec.shown >= 600 && rec.shown < 1100 && Array.isArray(rec.plays)
  && (reduced ? rec.plays.length === 0 : rec.plays.length === 1 && rec.plays[0].props === "gridTemplateRows+opacity" && rec.plays[0].duration === 180);
/** After its cause ends: leaving at once over exit-small, then gone; under reduced motion, gone at once with no exit. */
const left = (rec, reduced) => typeof rec?.gone === "number" && (reduced
  ? rec.leaving === null && rec.gone < 150
  : typeof rec.leaving === "number" && rec.leaving < 100 && Array.isArray(rec.leavePlays) && rec.leavePlays.length === 1
    && rec.leavePlays[0].props === "gridTemplateRows+opacity" && rec.leavePlays[0].duration === 130 && rec.gone >= 100 && rec.gone < 600);

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, still) => (reduced ? still : normal);
  failWorkspace = false;
  const measured = (report.measured[tag] = {});
  const open = async (follow) => {
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
      hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    await page.route("http://yuzuno-t51-banners.test/**", serve);
    await page.addInitScript(pageHelpers, follow);
    await page.goto("http://yuzuno-t51-banners.test/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
    // The banners are the conversation's, above it: on a phone, open Mori's.
    if (run.phone && (await page.locator(".app.phone-list").count())) await page.locator(".agent-row").first().click();
    await page.waitForTimeout(1200);
    return { context, page };
  };
  const { context, page } = await open(null);
  const wait = (ms) => page.waitForTimeout(ms);
  const track = (name, selector) => page.evaluate(([n, s]) => window.__track(n, s), [name, selector]);
  const mark = (name) => page.evaluate((n) => window.__tracks[n].mark(), name);
  const stop = (name) => page.evaluate((n) => window.__tracks[n].stop(), name);
  try {
    // ---- SH:M06: the live events drop for a moment, then for longer.
    {
      await track("liveFlap", LIVE);
      await page.evaluate(() => window.__drop());
      await wait(300);
      await page.evaluate(() => window.__open());
      await wait(1200);
      const flap = (measured.liveFlap = await stop("liveFlap"));
      ok(`${tag}: the live events down for 300 ms show no banner`, flap.shown === null, flap);

      await track("live", LIVE);
      await page.evaluate(() => window.__drop());
      await wait(1500);
      await mark("live");
      await page.evaluate(() => window.__open());
      await wait(800);
      const live = (measured.live = await stop("live"));
      ok(`${tag}: the live events down for longer: "Live reconnecting" shows once they have been down 600 ms, ${motion("revealing over small, its row and opacity", "with nothing playing")}`,
        revealed(live, reduced) && live.role === "status" && /Live/.test(live.text ?? ""), live);
      ok(`${tag}: the live events back, it ${motion("leaves over exit-small, then is gone", "is gone at once, with nothing playing")}`,
        left(live, reduced), live);
    }

    // ---- SH:M04: the browser reports being offline for a moment, then for longer.
    {
      await track("offlineFlap", CORE);
      await page.evaluate(() => window.__offline());
      await wait(300);
      await page.evaluate(() => window.__online());
      await wait(1200);
      const flap = (measured.offlineFlap = await stop("offlineFlap"));
      ok(`${tag}: the browser offline for 300 ms shows no banner`, flap.shown === null, flap);

      await track("offline", CORE);
      await page.evaluate(() => window.__offline());
      await wait(1500);
      await mark("offline");
      await page.evaluate(() => window.__online());
      await wait(800);
      const offline = (measured.offline = await stop("offline"));
      ok(`${tag}: the browser offline for longer: its banner shows once that has held 600 ms, ${motion("revealing over small, its row and opacity", "with nothing playing")}`,
        revealed(offline, reduced) && offline.role === "status", offline);
      ok(`${tag}: back online, it ${motion("leaves over exit-small, then is gone", "is gone at once, with nothing playing")}`,
        left(offline, reduced), offline);
    }

    // ---- SH:M05: Retry while the Workspace can't be read.
    {
      failWorkspace = true;
      await track("failed", CORE);
      await page.evaluate(() => window.__reset());
      const banner = page.locator(CORE);
      await banner.waitFor({ timeout: 5000 });
      await wait(400);
      const retry = banner.getByRole("button");
      const state = () => retry.evaluate((button) => {
        const icon = button.querySelector("svg");
        return { text: button.textContent.trim(), busy: button.getAttribute("aria-busy"), disabled: button.disabled,
          spins: window.__plays(icon) };
      });
      let busy = null;
      let after = null;
      try {
        measured.before = await state();
        hold("GET", "/api/workspace");
        await retry.click();
        await waiting("GET", "/api/workspace");
        await wait(200);
        busy = await state();
        await release("GET", "/api/workspace");
        await wait(400);
        after = { ...(await state()), banner: await banner.count(), role: await banner.getAttribute("role") };
      } catch (error) {
        busy = { error: String(error).slice(0, 200), busy };
      }
      measured.retry = { busy, after };
      ok(`${tag}: Retry pressed, it says "Retrying…" and is busy while the read it started is on its way, ${motion("its icon turning", "its icon still")}`,
        busy?.text === "Retrying…" && busy.busy === "true" && !busy.disabled && Array.isArray(busy.spins)
          && (reduced ? busy.spins.length === 0 : busy.spins.length === 1 && busy.spins[0].props === "transform" && busy.spins[0].duration === 1000),
        measured.retry);
      ok(`${tag}: that read failing too, Retry is ready again, still, and the banner stays`,
        after?.text === "Retry" && after.busy === null && Array.isArray(after.spins) && after.spins.length === 0 && after.banner === 1 && after.role === "alert",
        measured.retry);

      failWorkspace = false;
      await mark("failed");
      await retry.click().catch(() => {});
      await wait(800);
      const gone = (measured.failed = await stop("failed"));
      ok(`${tag}: a Retry that reads the Workspace ends the banner, ${motion("leaving over exit-small", "at once, with nothing playing")}`,
        left(gone, reduced), gone);
    }
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
  }
  await page.screenshot({ path: join(output, `${tag}-end.png`) }).catch(() => {});
  await context.close();

  // ---- ST:SA7: following the shared preset, a newer revision applied here in the background.
  {
    let follow = null;
    let reload = null;
    try {
      const { context, page } = await open(WORKSPACE);
      const toast = page.locator('.toast-stack .toast[role="status"]');
      follow = await page.evaluate(() => ({ palette: document.documentElement.dataset.palette,
        follow: JSON.parse(localStorage.getItem("yuzuno.appearanceFollow") ?? "null") }));
      follow.toast = (await toast.count()) ? (await toast.first().textContent()).trim() : null;
      if (!follow.toast) {
        await toast.first().waitFor({ timeout: 3000 }).catch(() => {});
        follow.toast = (await toast.count()) ? (await toast.first().textContent()).trim() : null;
      }
      // Loaded again with that revision applied: nothing new, so nothing is said.
      await page.reload();
      await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      reload = { toasts: await toast.count(), palette: await page.evaluate(() => document.documentElement.dataset.palette) };
      await context.close();
    } catch (error) {
      follow = { error: String(error).slice(0, 200), follow };
    }
    measured.follow = { follow, reload };
    ok(`${tag}: a newer revision of the shared Appearance preset, applied here in the background, says so in a toast`,
      follow?.palette === "pine" && follow.follow?.workspaces?.[WORKSPACE]?.revision === 2
        && follow.toast === "Appearance updated from this Workspace's shared preset", measured.follow);
    ok(`${tag}: loaded again with that revision applied, no toast`, reload?.toasts === 0 && reload.palette === "pine", measured.follow);
  }
}
await browser.close();

ok("no page errors", report.errors.length === 0, report.errors);
ok("writes: none but the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
await writeFile(join(output, "shell-banners-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exit(1);
