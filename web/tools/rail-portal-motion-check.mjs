// T-51 plan item 7, the Agent list's and the Portal's own motion (T-19 WK:PG-03, SH:R13, WK:PT-02, WK:SV-05): in
// Chromium on a production build of the app with a synthetic Workspace (two projects, five Agents, a finished Turn
// that wrote one HTML file), every API answered by the check (no Core, no Agent). Desktop 1280×860 and phone
// 390×844, each with normal and reduced motion:
// - PG-03: folding a group by hand plays its fold; a search opens a folded group at once, and closing the search
//   folds it back at once, nothing playing either way.
// - SH:R13: a touch held on an Agent's row presses it in (scale 0.985) and tints it over medium from 150 ms, done
//   before the actions open at 500 ms, when it is let go at once; a touch that moves past the slop, or lifts early,
//   lets it go at once and opens nothing. Under reduced motion the tint is there at once and nothing scales. The
//   touches are pointer events of type touch, dispatched on the row.
// - PT-02: the Portal over the chat (a window too narrow to share, 700 px wide; a phone) fades in over medium,
//   opacity only, nothing moved or scaled.
// - SV-05: the file card's ▾ menu drops in from it over small; Escape takes it back into the ▾ over exit-small,
//   inert, the focus back on the ▾.
// Under reduced motion nothing plays. Writes: only the app's own saves of where an Agent was read and the Portal's
// request for a preview, refused here; anything else would be recorded and fail the check. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/rail-portal-motion-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/rail-portal-motion");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], previewRequests: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

const base = { goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "", unreadCount: 0,
  pendingCount: 0, lastSeq: 1, reviewedSeq: 1, harness: "codex", connectionState: "connected" };
const agents = [
  { ...base, id: "mori", name: "Mori", projectId: "p1" },
  { ...base, id: "hana", name: "Hana", projectId: "p2" },
  { ...base, id: "kaze", name: "Kaze", projectId: "p1" },
  { ...base, id: "sora", name: "Sora", projectId: "p2" },
  { ...base, id: "yuki", name: "Yuki", projectId: null },
];
const projects = [
  { id: "p1", name: "yuzuno-next", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
  { id: "p2", name: "Paper notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" },
];
// Mori's last Turn wrote one HTML file: its card opens it in the Portal.
const turns = (agent) => [{ id: `${agent.id}-t`, status: "completed", items: [
  { id: `${agent.id}-u`, type: "userMessage", content: [{ type: "text", text: "Make a small timer page." }] },
  ...(agent.id === "mori" ? [{ id: "mori-f", type: "fileChange", status: "completed", changes: [{ path: "/w/timer.html", kind: { type: "add" }, diff: "" }] }] : []),
  { id: `${agent.id}-r`, type: "agentMessage", text: `${agent.name} wrote it.` },
] }];
const page200 = "<!doctype html><meta charset=utf-8><title>Timer</title><body><h1>A synthetic page</h1></body>";
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects, projectUsage: { p1: { agents: 2, tasks: 0 }, p2: { agents: 2, tasks: 0 } },
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p1", "p2"], needsYou: [], projects: [] },
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/w" }] },
  "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
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
    // The Portal asks Core for a preview of the file: refused here, so nothing is made.
    if (request.method() === "POST" && url.pathname === "/api/previews") {
      report.previewRequests.push(url.pathname);
      return route.fulfill({ status: 503, json: { error: "previews are not served in this check" } });
    }
    if (request.method() === "POST" && ["/api/collaboration/github_repositories", "/api/collaboration/task_list"].includes(url.pathname))
      return route.fulfill({ json: url.pathname.endsWith("task_list") ? { tasks: [], hasMore: false, counts: {} } : { repositories: [] } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
    if (agent) return route.fulfill({ json: { agent, pending: [], artifacts: [], messageReceipts: [], turns: turns(agent) } });
    if (url.pathname === "/api/artifact") return route.fulfill({ body: page200, contentType: "text/plain" });
    const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    return route.fulfill({ json: hit ? gets[hit] : {} });
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

// In the page: what plays where, frame by frame.
function probe() {
  const plays = (el) => (el ? el.getAnimations({ subtree: true }).filter((a) => a.playState !== "finished").map((a) => {
    const timing = a.effect.getTiming();
    const what = a.animationName || a.transitionProperty || a.effect.getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).sort().filter((k, i, all) => all.indexOf(k) === i).join("+");
    return `${what}:${timing.duration}`;
  }) : []);
  window.__plays = plays;
  window.__sample = (ms, read) => new Promise((done) => {
    const frames = [];
    const t0 = performance.now();
    const frame = () => {
      frames.push({ t: Math.round(performance.now() - t0), ...read() });
      if (performance.now() - t0 < ms) requestAnimationFrame(frame);
      else done(frames);
    };
    requestAnimationFrame(frame);
  });
  // A group's body: how open it is, and what plays on it.
  window.__group = (name) => {
    const g = [...document.querySelectorAll(".project-group")].find((el) => el.querySelector(".project-group-name")?.textContent === name);
    const body = g?.querySelector(".project-group-body");
    return { height: body ? Math.round(body.getBoundingClientRect().height) : null, expanded: g?.querySelector(".project-group-toggle")?.getAttribute("aria-expanded") ?? null,
      plays: plays(body) };
  };
  // Kaze's row: held or not, its scale, its tint, and whether the actions are open.
  window.__row = () => {
    const row = document.querySelector('.agent-row[data-agent-id="kaze"]');
    const transform = row ? getComputedStyle(row).transform : null;
    const scale = transform && transform !== "none" ? Number(transform.match(/matrix\(([^,]+)/)?.[1]) : 1;
    const tint = row ? getComputedStyle(row, "::before") : null;
    return { holding: !!row?.classList.contains("is-holding"), scale: Math.round(scale * 10000) / 10000,
      tint: tint && tint.content !== "none" ? Number(tint.opacity) : null, plays: plays(row),
      menu: !!document.querySelector('.agent-actions-menu[role="menu"]'),
      hold: plays(row).filter((p) => /^(transform|agent-row-hold):/.test(p)) };
  };
  window.__touch = (type, dx = 0) => {
    const target = document.querySelector('.agent-row[data-agent-id="kaze"] .agent-select');
    const box = target.getBoundingClientRect();
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerType: "touch", isPrimary: true,
      pointerId: 7, clientX: box.left + 40 + dx, clientY: box.top + box.height / 2 }));
  };
  window.__menu = () => {
    const menu = document.querySelector(".open-choice-menu");
    return { shown: !!menu, leaving: !!menu?.classList.contains("is-leaving"), inert: !!menu?.inert, plays: plays(menu),
      opacity: menu ? Number(getComputedStyle(menu).opacity) : null, focusOnMore: document.activeElement?.classList.contains("open-choice-more") ?? false };
  };
  window.__portal = () => {
    const panel = document.querySelector(".portal-panel");
    return { shown: !!panel, full: !!panel?.classList.contains("is-full"), plays: panel ? panel.getAnimations().map((a) => ({
      duration: a.effect.getTiming().duration, keyframes: a.effect.getKeyframes().map(({ opacity, transform }) => ({ opacity, transform })) })) : [],
      opacity: panel ? Number(getComputedStyle(panel).opacity) : null };
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
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, still) => (reduced ? still : normal);
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(() => {
    window.EventSource = class { addEventListener() {} close() {} };
    if (!localStorage.getItem("rail-portal-fixture")) {
      localStorage.setItem("yuzuno.selected", JSON.stringify("mori"));
      localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
      localStorage.setItem("rail-portal-fixture", "seeded");
    }
  });
  await page.addInitScript(probe);
  const group = (name) => page.locator(".project-group", { has: page.locator(".project-group-name", { hasText: new RegExp(`^${name}$`) }) });
  try {
    await page.goto("http://yuzuno-rail.test/");
    await page.locator('.agent-row[data-agent-id="kaze"]').waitFor({ state: "attached" });
    if (run.phone && await page.locator(".phone-back").isVisible()) await page.locator(".phone-back").click();
    await page.locator('.agent-row[data-agent-id="kaze"]').waitFor();
    await page.waitForTimeout(400);

    // PG-03: Paper notes folded by hand, then a search, then the search closed.
    const fold = page.evaluate(() => window.__sample(400, () => window.__group("Paper notes")));
    await group("Paper notes").locator(".project-group-toggle").click();
    const folding = await fold;
    await page.waitForTimeout(400);
    report.frames[`${tag}: PG-03 by hand`] = folding;
    ok(`${tag}: a group folded by hand ${motion("plays its fold (grid-template-rows over medium)", "folds at once, nothing playing")} (PG-03)`,
      folding.at(-1).expanded === "false" && folding.at(-1).height === 0 && (reduced ? folding.every((f) => !f.plays.length)
        : folding.some((f) => f.plays.includes("grid-template-rows:240") && f.height > 0)), folding.slice(0, 4).concat(folding.slice(-1)));
    await page.getByRole("button", { name: "Search agents" }).click();
    const opening = page.evaluate(() => window.__sample(400, () => window.__group("Paper notes")));
    await page.getByRole("textbox", { name: "Search agents" }).fill("a");
    const opened = await opening;
    report.frames[`${tag}: PG-03 search`] = opened;
    const shownAt = opened.findIndex((f) => f.expanded === "true");
    ok(`${tag}: a search opens the folded group at once: fully open in the frame it shows, nothing playing (PG-03)`,
      shownAt >= 0 && opened.slice(shownAt).every((f) => f.expanded === "true" && f.height > 40 && !f.plays.length) && opened[shownAt].height === opened.at(-1).height,
      opened.slice(Math.max(shownAt, 0), shownAt + 4));
    await page.waitForTimeout(200);
    const closing = page.evaluate(() => window.__sample(400, () => window.__group("Paper notes")));
    await page.getByRole("button", { name: "Close search" }).click();
    const closed = await closing;
    report.frames[`${tag}: PG-03 search closed`] = closed;
    const foldedAt = closed.findIndex((f) => f.expanded === "false");
    ok(`${tag}: closing the search folds it back at once: closed in the frame it shows, nothing playing (PG-03)`,
      foldedAt >= 0 && closed.slice(foldedAt).every((f) => f.expanded === "false" && f.height === 0 && !f.plays.length), closed.slice(Math.max(foldedAt, 0), foldedAt + 4));
    await page.waitForTimeout(300);

    // SH:R13: a touch held on Kaze's row, then one that moves, then one lifted early.
    const held = await page.evaluate(async () => {
      window.__touch("pointerdown");
      return window.__sample(700, window.__row);
    });
    report.frames[`${tag}: R13 held`] = held;
    const menuAt = held.findIndex((f) => f.menu);
    const before = menuAt > 0 ? held.slice(0, menuAt) : held;
    const pressed = before.filter((f) => f.holding);
    const last = before.at(-1);
    ok(`${tag}: a touch held on a row: nothing before 150 ms, then the row ${motion("presses in (scale 0.985, over medium) and tints, both done", "tints at once, nothing scaled and its press playing nothing,")} before the actions open at 500 ms (SH:R13)`,
      menuAt > 0 && before.filter((f) => f.t < 130).every((f) => !f.holding) && pressed.length > 0 && pressed[0].t >= 140 && pressed[0].t < 260 &&
        (reduced ? pressed.every((f) => f.scale === 1 && f.tint === 1 && !f.hold.length)
          : pressed.some((f) => f.scale < 1 && f.scale > 0.985) && last.holding && Math.abs(last.scale - 0.985) < 0.0005 && last.tint === 1 && !last.hold.length),
      { first: pressed[0], last, menuAt: held[menuAt] });
    ok(`${tag}: when the actions open, the row is let go at once: not held, not scaled, its press playing nothing back (SH:R13)`,
      menuAt > 0 && held.slice(menuAt).every((f) => !f.holding && f.scale === 1 && f.tint === null && !f.hold.length), held.slice(menuAt, menuAt + 3));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    for (const how of ["moves past the slop", "lifts early"]) {
      const frames = await page.evaluate(async (how) => {
        window.__touch("pointerdown");
        await new Promise((done) => setTimeout(done, 300));
        const at300 = window.__row();
        if (how === "moves past the slop") window.__touch("pointermove", 20);
        else window.__touch("pointerup");
        const after = await window.__sample(600, window.__row);
        window.__touch("pointercancel");
        return { at300, after };
      }, how);
      report.frames[`${tag}: R13 ${how}`] = frames;
      ok(`${tag}: a touch that ${how} lets the row go at once, nothing played back, and opens nothing (SH:R13)`,
        frames.at300.holding && frames.after.every((f) => !f.holding && f.scale === 1 && f.tint === null && !f.hold.length && !f.menu), frames);
      await page.waitForTimeout(200);
    }

    // PT-02 and SV-05: Mori's file card, in a window too narrow to share (or a phone).
    await page.locator('.agent-row[data-agent-id="mori"] .agent-select').click();
    const card = page.locator(".turn-file .open-choice").first();
    await card.waitFor({ timeout: 8000 });
    if (!run.phone) {
      await page.setViewportSize({ width: 700, height: 860 });
      await card.waitFor({ timeout: 8000 });
    }
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const dropping = page.evaluate(() => window.__sample(300, window.__menu));
    await page.evaluate(() => document.querySelector(".turn-file .open-choice-more").click());
    const dropped = await dropping;
    report.frames[`${tag}: SV-05 open`] = dropped;
    const menuShown = dropped.filter((f) => f.shown);
    ok(`${tag}: the file card's ▾ menu ${motion("drops in from it over small (open-choice-menu-in 180 ms)", "is there at once, nothing playing")} (SV-05)`,
      menuShown.length > 0 && (reduced ? menuShown.every((f) => !f.plays.length && f.opacity === 1) : menuShown[0].plays.includes("open-choice-menu-in:180")),
      menuShown.slice(0, 2));
    await page.waitForTimeout(200);
    const rising = page.evaluate(() => window.__sample(400, window.__menu));
    await page.keyboard.press("Escape");
    const rose = await rising;
    report.frames[`${tag}: SV-05 Escape`] = rose;
    const leaving = rose.filter((f) => f.shown);
    ok(`${tag}: Escape ${motion("takes it back into its ▾ over exit-small (open-choice-menu-out 130 ms), inert, gone after", "closes it at once")}, the focus back on the ▾ (SV-05)`,
      !rose.at(-1).shown && rose.at(-1).focusOnMore && (reduced ? rose.every((f) => !f.shown)
        : leaving.length > 0 && leaving.every((f) => f.leaving && f.inert) && leaving[0].plays.includes("open-choice-menu-out:130")), { leaving: leaving.slice(0, 2), end: rose.at(-1) });
    await page.waitForTimeout(200);
    const fading = page.evaluate(() => window.__sample(400, window.__portal));
    await page.evaluate(() => document.querySelector(".turn-file .open-choice-split > .primary-button:not(.open-choice-more)").click());
    const faded = await fading;
    report.frames[`${tag}: PT-02`] = faded;
    const panel = faded.find((f) => f.shown);
    const fade = panel?.plays[0];
    ok(`${tag}: the Portal over the chat ${motion("fades in over medium (240 ms), opacity only, nothing moved or scaled", "is there at once, nothing playing")} (PT-02)`,
      !!panel && panel.full && (reduced ? faded.filter((f) => f.shown).every((f) => !f.plays.length && f.opacity === 1)
        : panel.plays.length === 1 && fade.duration === 240 && fade.keyframes.every((k) => k.transform === undefined) && fade.keyframes[0].opacity === "0"),
      panel);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(output, `${tag}-end.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
  }
  await context.close();
}
await browser.close();
ok("no page errors", report.errors.length === 0, report.errors);
ok(`nothing was written but where an Agent was read (PUT .../reading, ${report.readingSaves.length}) and the Portal's preview requests, refused (POST /api/previews, ${report.previewRequests.length})`,
  report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "rail-portal-motion-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
process.exit(report.passed ? 0 : 1);
