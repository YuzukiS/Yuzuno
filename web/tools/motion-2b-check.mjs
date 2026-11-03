// T-19 slice 2b, a phone's push and pop (M8: SH:P01, P02, T08): in Chromium on a production build
// of the app with a synthetic Workspace that is never written to. On a phone, what the Agent list
// opens comes in from the right (opacity 0 → 1, translateX(8px) → none, medium) and Back brings
// the list in from the left (translateX(-8px), medium); the one it leaves is gone in the same frame.
// The toolbar's brand and Back swap with a fade (micro). A quick Back after an open leaves one move,
// on the newest. A window turning into a phone's and back plays nothing; neither does a desktop
// window, nor reduced motion. The conversation's rows keep their place. Writes: only the app's own
// save of where an Agent was read. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-2b-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-2b");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], frames: {} };
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

/** In the page: every frame for `span` ms from the next click, of the rail, the main panel and the toolbar's brand. */
function pageHelpers() {
  const plays = (el) => (el ? el.getAnimations().map((a) => {
    const frames = a.effect?.getKeyframes?.() ?? [];
    return { keys: frames.map((k) => Object.keys(k).filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"),
      from: frames[0]?.transform ?? null, duration: a.effect.getTiming().duration, current: a.currentTime };
  }) : []);
  const box = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    return { shown: style.display !== "none" && style.visibility !== "hidden", opacity: Number(style.opacity), transform: style.transform, plays: plays(el) };
  };
  window.__phone = () => ({
    rail: box(document.querySelector(".rail")),
    main: box(document.querySelector(".main-panel")),
    brand: box(document.querySelector(".toolbar-brand")),
    back: !!document.querySelector(".phone-back"),
    title: document.querySelector(".conversation-heading h1")?.textContent ?? null,
    scrollTop: Math.round(document.querySelector(".conversation-scroll")?.scrollTop ?? -1),
  });
  window.__watch = (span = 400) => {
    window.__frames = [];
    addEventListener("click", () => {
      const t0 = performance.now();
      const frame = () => {
        window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__phone() });
        if (performance.now() - t0 < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { capture: true, once: true });
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-sideways", viewport: { width: 844, height: 390 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
];
const moveOf = (plays) => plays.find((p) => p.keys === "opacity+transform/opacity+transform");
const fadeOf = (plays) => plays.find((p) => p.keys === "opacity/opacity");
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
    const frames = await page.evaluate(() => window.__frames);
    report.frames[`${tag}: ${what}`] = frames;
    return frames;
  };
  const open = (name) => page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).first().click();
  try {
    await page.goto("http://yuzuno-motion.test/");
    await page.locator(".agent-row").first().waitFor();
    await page.waitForTimeout(400);
    const start = await page.evaluate(() => window.__phone());
    if (!run.phone) {
      const desk = await step("open an Agent", () => open("Mori"));
      ok(`${tag}: no push, pop or swap on a desktop window`,
        desk.every((f) => !moveOf(f.main?.plays ?? []) && !moveOf(f.rail?.plays ?? []) && !fadeOf(f.brand?.plays ?? [])), desk.slice(0, 2));
      await context.close();
      continue;
    }
    ok(`${tag}: the list shows first, with nothing playing`, start.rail.shown && !start.main.shown && !start.rail.plays.length && !start.main.plays.length, start);

    // P01 + T08: the list opens a conversation.
    const push = await step("list → conversation", () => open("Mori"));
    const first = push[0];
    const last = push.at(-1);
    if (reduced) {
      ok(`${tag}: under reduced motion the conversation comes with nothing playing`,
        first.main.shown && !first.rail.shown && push.every((f) => !f.main.plays.length && !f.rail.plays.length && !f.brand.plays.length), first);
    } else {
      const move = moveOf(first.main.plays);
      ok(`${tag}: the conversation comes in from the right over medium (from ${move?.from}, ${move?.duration} ms), the list gone in the same frame`,
        first.main.shown && !first.rail.shown && move?.duration === 240 && move.from === "translateX(8px)" && first.main.opacity < 1, first);
      ok(`${tag}: and it ends in place, nothing left playing (${last.main.transform}, opacity ${last.main.opacity})`,
        last.main.transform === "none" && last.main.opacity === 1 && !last.main.plays.length, last.main);
      ok(`${tag}: the toolbar's brand gives way to Back with a fade over micro`, first.back && fadeOf(first.brand.plays)?.duration === 120, first.brand);
    }
    ok(`${tag}: the conversation's rows are where they were read from, in every frame they show`,
      push.filter((f) => f.scrollTop > 0).every((f) => f.scrollTop === last.scrollTop), push.map((f) => f.scrollTop).slice(0, 8));

    // P02 + T08: Back.
    await page.waitForTimeout(200);
    const pop = await step("Back → list", () => page.locator(".phone-back").click());
    const back = pop[0];
    if (reduced) {
      ok(`${tag}: under reduced motion the list comes back with nothing playing`,
        back.rail.shown && !back.main.shown && pop.every((f) => !f.main.plays.length && !f.rail.plays.length && !f.brand.plays.length), back);
    } else {
      const move = moveOf(back.rail.plays);
      ok(`${tag}: Back brings the list in from the left over medium (from ${move?.from}), the conversation gone in the same frame`,
        back.rail.shown && !back.main.shown && move?.duration === 240 && move.from === "translateX(-8px)", back);
      ok(`${tag}: and the list ends in place`, pop.at(-1).rail.transform === "none" && pop.at(-1).rail.opacity === 1 && !pop.at(-1).rail.plays.length, pop.at(-1).rail);
      ok(`${tag}: Back gives way to the brand with a fade over micro`, !back.back && fadeOf(back.brand.plays)?.duration === 120, back.brand);
    }

    if (!reduced) {
      // A quick Back after an open: one move, on the newest.
      await page.waitForTimeout(200);
      await open("Hana");
      await page.locator(".phone-back").click();
      const quick = await page.evaluate(() => window.__phone());
      ok(`${tag}: a quick Back after an open leaves one move, on the list, and none on the conversation`,
        quick.rail.shown && quick.rail.plays.filter((p) => moveOf([p])).length === 1 && !quick.main.plays.length, quick);
      await page.waitForTimeout(400);

      // A window turning into a phone's and back plays nothing (no move without one).
      await open("Mori");
      await page.waitForTimeout(400);
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.waitForTimeout(300);
      await page.setViewportSize(run.viewport);
      const after = [];
      for (let n = 0; n < 12; n++) after.push(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(window.__phone())))));
      report.frames[`${tag}: desktop and back`] = after;
      ok(`${tag}: a window turning into a desktop's and back plays nothing`,
        after.every((f) => !f.main.plays.length && !f.rail.plays.length && !f.brand.plays.length) && after.at(-1).main.shown, after.slice(0, 2));
    }
    await page.screenshot({ path: join(output, `${tag}-after.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok(`nothing was written but where each Agent was read (PUT .../reading, ${report.readingSaves.length})`, report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-2b-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors }));
process.exit(report.passed ? 0 : 1);
