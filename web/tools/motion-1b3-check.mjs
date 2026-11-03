// T-19 batch 1b, settle (M4): in Chromium on a production build of the
// labelled design preview (?preview=1, synthetic Agents, no Core). Where a
// jump lands is shown once, over settle (1200 ms), after the jump: a Turn
// the dock jumps to is tinted from the first frame (an instant scroll) and
// the tint is gone when its animation ends; Home's Needs you area, reached by
// a smooth scroll from the return overview, is marked only once that scroll
// has stopped, keeps its outline until the next press, and loses it then.
// A source highlight's ring fades once as it arrives. Under reduced motion
// nothing animates; a Turn's landing is then a still tint, gone after the
// settle's time. A jump still on its way when another starts, when the
// reader wheels or presses, or when Home is left shows nothing; one whose
// target its own scroller keeps moving (longer than 400 ms) is marked only
// once that stops, whatever other scroller ends meanwhile. Focus is compared with the build before this batch
// (--baseline records it). Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1b3-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1b3");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", checks: [], failures: [], errors: [], apiCalls: [], writes: [], notShown: [], focus: {}, frames: {} };
const ok = (name, cond, detail) => {
  if (baseline) return;
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const api = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs,
  "/api/jobs": noJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
};
// The app itself on a synthetic Workspace whose Agent has three Turns, for the dock's jump (the preview's
// Agents each have one Turn). Never written to.
const turn = (n) => ({ id: `turn-${n}`, status: "completed", items: [
  { id: `in-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}: ${"words ".repeat(40)}` }] },
  { id: `out-${n}`, type: "agentMessage", text: `Answer ${n}. ${"More of the answer. ".repeat(60)}` },
] });
const fixtureAgent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const fixtureApi = {
  ...api,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [fixtureAgent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: fixtureAgent, pending: [], artifacts: [], turns: [turn(1), turn(2), turn(3)] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

async function serve(route, fixture = false) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    const method = route.request().method();
    report.apiCalls.push(`${fixture ? "fixture " : ""}${method} ${url.pathname}`);
    const table = fixture ? fixtureApi : api;
    const hit = Object.keys(table).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (hit && method === "GET") return route.fulfill({ json: table[hit] });
    if (fixture && method === "GET") return route.fulfill({ json: {} });
    if (fixture) report.writes.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
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

function pageHelpers() {
  window.__describe = (el) => {
    if (!el || el === document.body) return "body";
    return `${el.tagName.toLowerCase()}${el.className ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
  };
  /** Every frame from the next click, for `span` ms: what `read` says. */
  window.__watch = (read, span = 1700) => {
    window.__frames = [];
    const start = () => {
      removeEventListener("click", start, true);
      const t0 = performance.now();
      const frame = () => {
        const t = performance.now() - t0;
        window.__frames.push({ t: Math.round(t), focus: window.__describe(document.activeElement), ...read() });
        if (t < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("click", start, true);
  };
}

const ms = (v) => (v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN);
const describe = (page) => page.evaluate(() => window.__describe(document.activeElement));

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "app", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference", fixture: true },
  { name: "app-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce", fixture: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", (route) => serve(route, !!run.fixture));
  await page.addInitScript(pageHelpers);
  if (run.fixture) await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.goto(run.fixture ? "http://yuzuno-motion.test/" : "http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row").first().waitFor();
  await page.waitForTimeout(400);

  // The three settles as computed, on probes: settle, the token, and nothing under reduced motion.
  if (!baseline) {
    const probes = await page.evaluate(() => Object.fromEntries([["home", "data-home-highlight"], ["turn", "data-settle"], ["source", null]].map(([name, attribute]) => {
      const el = document.createElement("div");
      if (attribute) el.setAttribute(attribute, "");
      else el.className = "source-highlight";
      document.body.append(el);
      const s = getComputedStyle(el);
      const value = { name: s.animationName, duration: s.animationDuration };
      el.remove();
      return [name, value];
    })));
    const want = { home: "home-highlight", turn: "settle-tint", source: "settle-ring" };
    ok(`${tag}: Home's landing, a Turn's landing and a source's arrival settle once over 1200 ms${reduced ? " (none under reduced motion)" : ""}`,
      Object.entries(want).every(([k, name]) => (reduced ? probes[k].name === "none" : probes[k].name === name && ms(probes[k].duration) === 1200)), probes);
  }

  // A Turn the dock jumps to (instant): tinted from the first frame, gone when the tint ends.
  await page.locator(".agent-row", { hasText: "Mori" }).first().click();
  await page.waitForTimeout(500);
  const stops = page.locator(".turn-dock-stop").filter({ visible: true });
  if ((await stops.count()) > 1) {
    await page.evaluate(() => window.__watch(() => {
      const el = document.querySelector("[data-settle]");
      return { settled: !!el, on: el ? (el.matches("article.turn") ? "turn" : el.dataset.itemId ? "item" : el.tagName) : null,
        animation: el ? getComputedStyle(el).animationName : null, tint: el ? getComputedStyle(el).backgroundColor : null };
    }));
    await stops.first().click();
    await page.waitForTimeout(1900);
    const frames = await page.evaluate(() => window.__frames);
    report.frames[`${tag}: turn jump`] = frames;
    report.focus[`${tag}: a Turn reached from the dock`] = await describe(page);
    const first = frames.find((f) => f.settled);
    if (reduced) {
      ok(`${tag}: a Turn reached from the dock is not animated under reduced motion`, !frames.some((f) => f.settled && f.animation !== "none"), frames.slice(0, 2));
      // No animation ends there: the still tint is shown, then taken off after the settle's time.
      const shownFor = frames.filter((f) => f.settled).at(-1)?.t ?? null;
      ok(`${tag}: under reduced motion its landing is a still tint from the first frames, gone after the settle's time (last seen at ${shownFor} ms)`,
        !!first && first.t <= 50 && !/rgba\(0, 0, 0, 0\)|transparent/.test(first.tint || "transparent") && shownFor >= 1000 && shownFor <= 1500 && !frames.at(-1).settled,
        { first, shownFor, last: frames.at(-1) });
    } else {
      ok(`${tag}: a Turn reached from the dock is tinted from the first frames (settle-tint)`, !!first && first.t <= 50 && first.animation === "settle-tint", first);
      ok(`${tag}: the tint is gone when it has played`, !frames.at(-1).settled, frames.at(-1));
    }
  } else report.notShown.push(`${tag}: the conversation has no second turn-dock stop`);
  if (run.fixture) { await context.close(); continue; }

  // Home's Needs you, from the return overview (a smooth scroll): marked once it stops, kept until a press.
  const home = page.locator(".toolbar-nav .catchup-nav", { hasText: /^Home/ }).first();
  if (await home.count()) {
    await home.click();
    const tile = page.locator(".home-return-tile.is-live").first();
    try {
      await tile.waitFor({ timeout: 3000 });
    } catch {}
    if (await tile.count()) {
      await page.evaluate(() => window.__watch(() => {
        const el = document.getElementById("home-current-needs");
        return { marked: !!el?.hasAttribute("data-home-highlight"), top: el ? Math.round(el.getBoundingClientRect().top) : null,
          animation: el ? getComputedStyle(el).animationName : null };
      }, 1600));
      await tile.click();
      await page.waitForTimeout(1800);
      const frames = await page.evaluate(() => window.__frames);
      report.frames[`${tag}: Needs you`] = frames;
      report.focus[`${tag}: Needs you from the return overview`] = await describe(page);
      const firstMarked = frames.findIndex((f) => f.marked);
      const moved = frames.slice(firstMarked).some((f, i, all) => i > 0 && Math.abs(f.top - all[i - 1].top) > 1);
      if (reduced) ok(`${tag}: Needs you is marked at once, not animated, under reduced motion`, firstMarked >= 0 && firstMarked <= 2 && frames[firstMarked].animation === "none", frames.slice(0, 3));
      else ok(`${tag}: Needs you is marked only once the smooth scroll has stopped (frame ${firstMarked}, at ${frames[firstMarked]?.t} ms), then plays home-highlight`,
        firstMarked >= 0 && !moved && frames[firstMarked].animation === "home-highlight", { firstMarked, at: frames[firstMarked], moved });
      const kept = await page.evaluate(() => document.getElementById("home-current-needs")?.hasAttribute("data-home-highlight"));
      // A press on Home's own heading text, so Home and the area stay (a press elsewhere could leave Home).
      const head = await page.locator(".home-return-head").first().boundingBox();
      await page.mouse.click(head.x + 8, head.y + head.height / 2);
      await page.waitForTimeout(100);
      const after = await page.evaluate(() => {
        const el = document.getElementById("home-current-needs");
        return { present: !!el, marked: !!el?.hasAttribute("data-home-highlight") };
      });
      ok(`${tag}: its outline stays after the settle and goes at the next press`, kept && after.present && !after.marked, { kept, after });

      // What a jump still on its way does, frame by frame: how many marks there are and where.
      const watchMarks = (span) => page.evaluate((span) => {
        window.__frames = [];
        const t0 = performance.now();
        const frame = () => {
          const marks = [...document.querySelectorAll("[data-home-highlight]")];
          const needs = document.getElementById("home-current-needs");
          window.__frames.push({ t: Math.round(performance.now() - t0), at: Math.round(performance.now()), marks: marks.length,
            on: marks.map((el) => el.id || el.className.toString().split(/\s+/)[0]), needsTop: needs ? Math.round(needs.getBoundingClientRect().top * 10) / 10 : null });
          if (performance.now() - t0 < span) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }, span);
      const clear = async () => {
        await page.mouse.click(head.x + 8, head.y + head.height / 2);
        await page.waitForTimeout(150);
      };
      const item = page.locator(".home-needs-item").first();
      // A section from a Needs you item (the reveal effect), then Needs you itself before it lands: one mark, on Needs you.
      if (await item.count()) {
        await clear();
        await watchMarks(1800);
        await item.click();
        await tile.click();
        await page.waitForTimeout(1900);
        const frames = await page.evaluate(() => window.__frames);
        report.frames[`${tag}: section then Needs you`] = frames;
        ok(`${tag}: a section jump then Needs you at once leaves one mark, on Needs you, never two`,
          frames.every((f) => f.marks <= 1) && frames.at(-1).marks === 1 && frames.at(-1).on[0] === "home-current-needs", { last: frames.at(-1), most: Math.max(...frames.map((f) => f.marks)) });
      } else report.notShown.push(`${tag}: no Needs you item on the preview's Home`);
      if (!reduced) {
        // Needs you while its own scroller keeps moving it for 800 ms (as a long smooth scroll would; not the
        // reader), and an unrelated scroller ends its scroll 100 ms in: marked only once it stops.
        await clear();
        await watchMarks(1800);
        await tile.click();
        const moved = await page.evaluate(() => new Promise((done) => {
          const needs = document.getElementById("home-current-needs");
          let scroller = needs.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          scroller ||= document.scrollingElement;
          const other = document.body.appendChild(Object.assign(document.createElement("div"), { style: "position:fixed;left:0;bottom:0;width:40px;height:40px;overflow:auto" }));
          other.appendChild(Object.assign(document.createElement("div"), { style: "height:400px" }));
          let otherEnded = null;
          other.addEventListener("scrollend", () => { otherEnded = Math.round(performance.now()); });
          const t0 = performance.now();
          let direction = 1;
          const step = () => {
            const t = performance.now() - t0;
            if (t > 100 && !other.scrollTop) other.scrollTop = 120;
            if (t < 800) {
              if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) direction = -1;
              if (scroller.scrollTop <= 1) direction = 1;
              scroller.scrollTop += 3 * direction;
              requestAnimationFrame(step);
            } else {
              const stoppedAt = Math.round(performance.now());
              setTimeout(() => { other.remove(); done({ scroller: scroller.className || scroller.tagName, started: Math.round(t0), otherEnded, stoppedAt }); }, 50);
            }
          };
          requestAnimationFrame(step);
        }));
        await page.waitForTimeout(1200);
        const frames = await page.evaluate(() => window.__frames);
        report.frames[`${tag}: Needs you kept moving`] = { moved, frames };
        const firstMarked = frames.find((f) => f.marks);
        // One clock (performance.now) for the frames and the mover.
        ok(`${tag}: Needs you whose scroller keeps moving it 800 ms is marked only after it stops (${firstMarked ? firstMarked.at - moved.stoppedAt : "no"} ms after), not when another scroller ends (${moved.otherEnded === null ? "never" : moved.otherEnded - moved.started} ms in)`,
          moved.otherEnded !== null && moved.otherEnded < moved.stoppedAt && !!firstMarked && firstMarked.at >= moved.stoppedAt && frames.at(-1).marks === 1, { moved, firstMarked });
      }
      // The reader takes over while it is on its way: a wheel, or a press, and it shows nothing.
      for (const [how, act] of [["a wheel", () => page.mouse.wheel(0, 120)], ["a press", () => page.mouse.click(head.x + 8, head.y + head.height / 2)]]) {
        await clear();
        await watchMarks(1500);
        await tile.click();
        await act();
        await page.waitForTimeout(1600);
        const frames = await page.evaluate(() => window.__frames);
        report.frames[`${tag}: Needs you, then ${how}`] = frames;
        ok(`${tag}: Needs you followed at once by ${how} shows no mark${reduced ? " (under reduced motion it lands at once, and the press takes it off)" : ""}`,
          reduced ? frames.at(-1).marks === (how === "a press" ? 0 : 1) : frames.every((f) => f.marks === 0), { most: Math.max(...frames.map((f) => f.marks)), last: frames.at(-1) });
      }
      // Home left while it is on its way (no press: the Agent row's own click), and come back to: no mark.
      await clear();
      await tile.click();
      await page.evaluate(() => document.querySelector(".agent-row button, .agent-row")?.click());
      await page.waitForTimeout(600);
      await home.click();
      await page.waitForTimeout(800);
      const left = await page.evaluate(() => document.querySelectorAll("[data-home-highlight]").length);
      ok(`${tag}: Home left while a jump was on its way shows no mark when it is back`, left === 0, left);
    } else report.notShown.push(`${tag}: no live Needs you tile on the preview's Home`);
  } else report.notShown.push(`${tag}: no Home entry in the toolbar`);
  await context.close();
}
await browser.close();

if (process.env.BASELINE_REPORT) {
  const before = JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).focus;
  for (const [where, after] of Object.entries(report.focus))
    ok(`focus unchanged by this batch: ${where}`, before[where] === after, { before: before[where], after });
}
ok("nothing was written to the synthetic Workspace", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1b3-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode: report.mode, passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown, focus: report.focus }));
process.exit(report.passed ? 0 : 1);
