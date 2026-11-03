// T-19 batch 1b, menus and toasts (M2, M3): in Chromium on a production build,
// on the labelled design preview (?preview=1) and on the app itself with a
// synthetic Workspace that is never written to. An Agent's action menu
// comes from its button once placed; closed by Escape, a press or a choice
// it stays on screen for its way out, inert, hidden and clicked through,
// while focus goes at once where it went before this batch; Tab, a scroll or
// a resize close it at once. A phone dock opened or closed by the reader rises or fades; one
// that comes back as the keyboard goes does not move. On its way out a closed panel is inert and
// hidden: on the app with a synthetic conversation of three Turns, each way the reader closes it
// (Escape, its close button the scrim, its own button) is followed at once by a real key or tap
// (Enter, Shift+Tab and Tab, a tap where its Back to latest was), and none reaches the panel;
// focus goes back to the dock's button, and a reopen, reduced motion and a browser with no Web
// Animations leave nothing marked. A toast rises in; set
// again with the same text it shows for its full time; replaced, it leaves
// through a hidden copy. Under reduced motion nothing moves and no copy is
// made. Focus is compared with the build before this batch (--baseline
// records it). An emulated phone is not a real one, and Chromium is not
// Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1b2-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1b2");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", checks: [], failures: [], errors: [], apiCalls: [], writes: [], notShown: [], focus: {}, frames: {}, dockExit: {} };
// A baseline run records focus only.
const ok = (name, cond, detail) => {
  if (baseline) return;
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const api = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs,
  "/api/jobs": noJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
};
const fixtureAgent = (id, name) => ({
  id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected",
});
const fixtureAgents = [fixtureAgent("a", "Mori"), fixtureAgent("b", "Hana")];
const fixtureApi = {
  ...api,
  "/api/workspace": { workspace: { id: "fixture" }, agents: fixtureAgents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent: fixtureAgents[0], pending: [], artifacts: [], turns: [] },
  "/api/agents/b": { agent: fixtureAgents[1], pending: [], artifacts: [], turns: [] },
};
// For a phone dock's way out: one Agent with three long Turns, so that the conversation scrolls and
// the turn panel offers Back to latest (the preview's Agents each have one Turn).
const turn = (n) => ({ id: `turn-${n}`, status: "completed", items: [
  { id: `in-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}: ${"words ".repeat(40)}` }] },
  { id: `out-${n}`, type: "agentMessage", text: `Answer ${n}. ${"More of the answer. ".repeat(60)}` },
] });
const dockApi = {
  ...api,
  "/api/workspace": { ...fixtureApi["/api/workspace"], agents: [fixtureAgents[0]] },
  "/api/agents/a": { agent: fixtureAgents[0], pending: [], artifacts: [], turns: [turn(1), turn(2), turn(3)] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

async function serve(route, table = api) {
  const url = new URL(route.request().url());
  const fixture = table !== api;
  if (url.pathname.startsWith("/api/")) {
    const method = route.request().method();
    report.apiCalls.push(`${fixture ? "fixture " : ""}${method} ${url.pathname}`);
    const hit = Object.keys(table).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (hit && method === "GET") return route.fulfill({ json: table[hit] });
    // On the synthetic Workspace any other read is empty; nothing is ever written.
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

/** In the page: where focus is, and every frame from the next trigger key or click. */
function pageHelpers() {
  window.__describe = (el) => {
    if (!el || el === document.body) return "body";
    return `${el.tagName.toLowerCase()}${el.className ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
  };
  window.__watch = (read, keys = ["Escape"], span = 600) => {
    window.__frames = [];
    const start = (event) => {
      if (event.type === "keydown" && !keys.includes(event.key)) return;
      removeEventListener("keydown", start, true);
      removeEventListener("click", start, true);
      removeEventListener("pointerdown", start, true);
      const t0 = performance.now();
      const frame = () => {
        const t = performance.now() - t0;
        window.__frames.push({ t: Math.round(t), focus: window.__describe(document.activeElement), ...window[read]() });
        if (t < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("keydown", start, true);
    addEventListener("click", start, true);
    addEventListener("pointerdown", start, true);
  };
  window.__menu = () => {
    const menus = [...document.querySelectorAll(".agent-actions-menu")];
    const open = menus.find((m) => !m.classList.contains("is-leaving"));
    const leaving = menus.find((m) => m.classList.contains("is-leaving"));
    return {
      open: !!open, leaving: !!leaving, focusInLeaving: !!leaving?.contains(document.activeElement),
      leavingHidden: leaving ? leaving.getAttribute("aria-hidden") === "true" && leaving.inert && getComputedStyle(leaving).pointerEvents === "none" && !leaving.querySelector("[role], [id]") && !leaving.hasAttribute("role") : null,
      leavingAnimation: leaving ? leaving.getAnimations().map((a) => `${a.animationName}:${a.effect.getTiming().duration}`) : [],
    };
  };
  window.__dock = () => {
    const body = document.querySelector(".conversation-body");
    const panels = [...(body?.querySelectorAll(":scope > .work-dock, :scope > .turn-dock") || [])];
    const shown = panels.find((el) => getComputedStyle(el).display !== "none");
    const scrim = body?.querySelector(":scope > .phone-dock-scrim");
    // What a tap at the probe point (where Back to latest was) would land on.
    const probe = window.__probe && document.elementFromPoint(window.__probe.x, window.__probe.y);
    return {
      dock: body?.dataset.phoneDock ?? null, way: body?.dataset.phoneDockWay ?? null, panelShown: !!shown,
      panelAnimation: shown ? getComputedStyle(shown).animationName : null, panelTaps: shown ? getComputedStyle(shown).pointerEvents : null,
      panelInert: shown ? shown.inert : null, panelHidden: shown ? shown.getAttribute("aria-hidden") === "true" : null,
      marked: panels.filter((el) => el.hasAttribute("inert") || el.hasAttribute("aria-hidden")).length,
      focusInPanel: panels.some((el) => el.contains(document.activeElement)),
      atProbe: probe ? (probe.closest(".work-dock, .turn-dock") ? "panel" : window.__describe(probe)) : null,
      scrim: scrim ? { button: scrim.tagName === "BUTTON", taps: getComputedStyle(scrim).pointerEvents, hidden: scrim.getAttribute("aria-hidden") === "true", inert: scrim.inert } : null,
      panel: panels.length > 0,
    };
  };
  // Every press, click, key and focus from here on, and whether it reached a dock's panel.
  window.__record = () => {
    window.__events = [];
    if (window.__recording) return;
    window.__recording = true;
    for (const type of ["pointerdown", "click", "keydown", "focusin"])
      addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target : null;
        window.__events.push({ type, key: event.key, way: document.querySelector(".conversation-body")?.dataset.phoneDockWay ?? null,
          inPanel: !!target?.closest(".work-dock, .turn-dock"), target: window.__describe(target), focus: window.__describe(document.activeElement) });
      }, true);
  };
  window.__toasts = () => [...document.querySelectorAll(".toast-stack > .toast")].map((el) => ({
    text: el.textContent, leaving: el.classList.contains("toast-leaving"), role: el.getAttribute("role"), hidden: el.getAttribute("aria-hidden") === "true",
    animation: `${getComputedStyle(el).animationName}:${getComputedStyle(el).animationDuration}`,
  }));
}

const ms = (v) => (v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN);
const describe = (page) => page.evaluate(() => window.__describe(document.activeElement));

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
  { name: "app", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference", fixture: fixtureApi },
  // A phone dock's way out, on the app: with motion, under reduced motion, and with no Web Animations.
  { name: "phone-app", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true, fixture: dockApi, dockExit: true },
  { name: "phone-app-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true, fixture: dockApi, dockExit: true },
  { name: "phone-app-no-waapi", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true, fixture: dockApi, dockExit: true, noAnimate: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", (route) => serve(route, run.fixture || api));
  await page.addInitScript(pageHelpers);
  if (run.noAnimate) await page.addInitScript(() => { delete Element.prototype.animate; });
  if (run.fixture) await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.goto(run.fixture ? "http://yuzuno-motion.test/" : "http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row, .phone-dock-button").first().waitFor();
  await page.waitForTimeout(400);
  const visible = (selector) => page.locator(selector).filter({ visible: true }).first();

  // An Agent's action menu (desktop): its entrance once placed, then a close by Escape and one by Tab.
  if (!run.phone) {
    const trigger = visible(".agent-actions-button");
    if (await trigger.count()) {
      await trigger.click();
      await page.locator('.agent-actions-menu[data-placed="true"]').first().waitFor({ timeout: 3000 });
      const entrance = await page.evaluate(() => {
        const m = document.querySelector('.agent-actions-menu[data-placed="true"]');
        const s = getComputedStyle(m);
        return { name: s.animationName, duration: s.animationDuration, easing: s.animationTimingFunction, origin: m.style.transformOrigin, rise: m.style.getPropertyValue("--menu-rise") };
      });
      if (reduced) ok(`${tag}: the Agent menu opens with no animation under reduced motion`, entrance.name === "none", entrance);
      else ok(`${tag}: the Agent menu comes from its button once placed: small, standard easing, from the trigger's corner, 4px towards it`,
        entrance.name === "agent-menu-in" && ms(entrance.duration) === 180 && /0\.2, 0\.8, 0\.2, 1/.test(entrance.easing) && /right/.test(entrance.origin) && /-?4px/.test(entrance.rise), entrance);
      await page.waitForTimeout(250);
      const box = await page.locator(".agent-actions-menu").first().boundingBox();
      await page.evaluate(() => {
        window.__clicks = [];
        document.addEventListener("click", (e) => window.__clicks.push({ leaving: !!document.querySelector(".agent-actions-menu.is-leaving"),
          inMenu: !!e.target.closest?.(".agent-actions-menu") }), { capture: true });
        window.__watch("__menu", ["Escape"]);
      });
      await page.keyboard.press("Escape");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(700);
      const frames = await page.evaluate(() => window.__frames);
      report.frames[`${tag}: menu Escape`] = frames;
      report.focus[`${tag}: Agent menu closed with Escape`] = frames[0]?.focus;
      const first = frames[0] || {};
      const leavingFrames = frames.filter((f) => f.leaving);
      // Where focus goes is compared with the build before this batch below; here, that it is out of the copy at once.
      ok(`${tag}: in the first frame after Escape the menu is closed and focus is not in its copy`,
        first.open === false && !first.focusInLeaving, first);
      if (reduced) ok(`${tag}: no leaving menu under reduced motion`, leavingFrames.length === 0, leavingFrames.length);
      else {
        ok(`${tag}: the menu leaves through a copy that is aria-hidden, inert, clicked through and has no role or id, over exit-small`,
          leavingFrames.length > 0 && leavingFrames.every((f) => f.leavingHidden) && (leavingFrames[0].leavingAnimation || []).includes("agent-menu-out:130"), leavingFrames.slice(0, 1));
        const last = leavingFrames.at(-1)?.t ?? Infinity;
        ok(`${tag}: the leaving menu is gone within 400 ms (last seen at ${last} ms)`, last <= 400 && !frames.at(-1).leaving, last);
      }
      const click = await page.evaluate(() => window.__clicks.at(-1));
      ok(`${tag}: a click where the menu was lands on the page, not on it`, !!click && !click.inMenu, click);
      // Tab closes it at once: no way out.
      await trigger.click();
      await page.locator('.agent-actions-menu[data-placed="true"]').first().waitFor({ timeout: 3000 });
      await page.waitForTimeout(250);
      await page.evaluate(() => window.__watch("__menu", ["Tab"], 200));
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      const tabFrames = await page.evaluate(() => window.__frames);
      ok(`${tag}: Tab closes the menu at once, with no copy`, tabFrames.length > 0 && tabFrames.every((f) => !f.open && !f.leaving), tabFrames.slice(0, 2));
      report.focus[`${tag}: Agent menu closed with Tab`] = await describe(page);
    } else report.notShown.push(`${tag}: no visible Agent actions button`);
  }

  // A phone dock (phone): opened and closed by the reader, then back after the keyboard.
  if (run.phone && !run.dockExit) {
    await page.locator(".agent-row", { hasText: "Mori" }).first().tap().catch(() => {});
    await page.waitForTimeout(400);
    const button = visible(".phone-dock-button");
    if (await button.count()) {
      await button.tap();
      await page.waitForTimeout(30);
      const opened = await page.evaluate(() => window.__dock());
      if (reduced) ok(`${tag}: a phone dock opens with no animation under reduced motion`, opened.panelShown && opened.way === null && opened.panelAnimation === "none", opened);
      else ok(`${tag}: a phone dock the reader opens rises from its button (phone-dock-in)`, opened.panelShown && opened.way === "in" && opened.panelAnimation === "phone-dock-in", opened);
      await page.waitForTimeout(400);
      await page.evaluate(() => window.__watch("__dock", ["Escape"]));
      await page.locator(".phone-dock-scrim").first().tap();
      await page.waitForTimeout(700);
      const frames = await page.evaluate(() => window.__frames);
      report.frames[`${tag}: dock closed by its scrim`] = frames;
      report.focus[`${tag}: phone dock closed by its scrim`] = frames.at(-1)?.focus;
      const out = frames.filter((f) => f.way === "out");
      if (reduced) ok(`${tag}: a closed phone dock goes at once under reduced motion`, out.length === 0 && frames.every((f) => !f.panelShown), frames.slice(0, 2));
      else {
        ok(`${tag}: a phone dock the reader closes fades back, its panel inert and hidden and its scrim taking no taps`,
          out.length > 0 && out.every((f) => f.panelTaps === "none" && f.panelInert && f.panelHidden && (!f.scrim || (f.scrim.taps === "none" && !f.scrim.button && f.scrim.hidden && f.scrim.inert))) && out[0].panelAnimation === "phone-dock-out", out.slice(0, 1));
        const last = out.at(-1)?.t ?? Infinity;
        ok(`${tag}: the closed dock is gone within 400 ms (last seen at ${last} ms)`, last <= 400 && !frames.at(-1).panelShown, last);
      }
      // Open again; the keyboard comes and goes. With it up, phone-docks.css hides the open panel
      // (display: none); keyboard-viewport.ts sets that from the real viewport and focus, so here the same
      // display: none is put on and taken off directly. The panel back on screen has no way in.
      await button.tap();
      await page.waitForTimeout(400);
      const back = await page.evaluate(async () => {
        const style = document.head.appendChild(document.createElement("style"));
        style.textContent = ".conversation-body > :is(.work-dock, .turn-dock, .phone-dock-scrim) { display: none !important; }";
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const hidden = !window.__dock().panelShown;
        style.remove();
        await new Promise((r) => requestAnimationFrame(r));
        return { hidden, ...window.__dock() };
      });
      ok(`${tag}: a dock that comes back as the keyboard goes does not move`, back.hidden && back.panelShown && back.way === null && back.panelAnimation === "none", back);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    } else report.notShown.push(`${tag}: no visible phone dock button`);
  }

  // A phone dock's way out (phone-app runs): closed by the reader, the turn panel is still drawn but
  // nothing on it can be reached. Each way to close it is followed at once by a real key or tap.
  if (run.dockExit) {
    await page.locator(".agent-row", { hasText: "Mori" }).first().tap().catch(() => {});
    const toggle = page.locator(".phone-dock-turns");
    await toggle.waitFor({ timeout: 5000 }).catch(() => {});
    if (await toggle.isVisible()) {
      const moving = !reduced && !run.noAnimate;
      const record = report.dockExit[tag] = { animate: await page.evaluate(() => typeof Element.prototype.animate), sequences: {} };
      if (run.noAnimate) ok(`${tag}: this browser has no Web Animations`, record.animate === "undefined", record.animate);
      const byKey = { open: async () => { await toggle.focus(); await page.keyboard.press("Enter"); }, close: () => page.keyboard.press("Escape") };
      const byTap = { open: () => toggle.tap() };
      // A tap where Back to latest was, as soon as the panel is closed.
      let point;
      const tapLatest = () => page.touchscreen.tap(point.x, point.y);
      const sequences = [
        { name: "Escape, then Enter", ...byKey, kind: "keydown", then: () => page.keyboard.press("Enter"), reopens: true },
        { name: "Escape, then Shift+Tab and Tab", ...byKey, kind: "keydown", then: async () => { await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); } },
        { name: "its close button (the scrim), then a tap on Back to latest", ...byTap, kind: "pointerdown",
          close: () => page.locator(".phone-dock-scrim").tap({ position: { x: 20, y: 20 } }), then: tapLatest, tapsLatest: true },
        { name: "its own button, then a tap on Back to latest", ...byTap, kind: "pointerdown", close: () => toggle.tap(), then: tapLatest, tapsLatest: true },
      ];
      for (const sequence of sequences) {
        const name = `${tag}: ${sequence.name}`;
        // Away from the latest, so that the open turn panel offers Back to latest.
        await page.evaluate(() => { document.querySelector(".conversation-scroll").scrollTop = 0; });
        await page.waitForTimeout(300);
        await sequence.open();
        await page.waitForTimeout(400);
        const latest = await page.locator(".turn-dock .turn-dock-latest").boundingBox();
        if (!latest) {
          ok(`${name}: the open turn panel offers Back to latest`, false, await page.evaluate(() => window.__dock()));
          continue;
        }
        point = { x: latest.x + latest.width / 2, y: latest.y + latest.height / 2 };
        const scrolled = await page.evaluate((probe) => {
          window.__probe = probe;
          window.__record();
          window.__watch("__dock", ["Escape"], 500);
          return document.querySelector(".conversation-scroll").scrollTop;
        }, point);
        await sequence.close();
        await sequence.then();
        await page.waitForTimeout(700);
        const { frames, events, now } = await page.evaluate(() => ({ frames: window.__frames, events: window.__events,
          now: { ...window.__dock(), focus: window.__describe(document.activeElement), scrollTop: document.querySelector(".conversation-scroll").scrollTop } }));
        const closedBy = events.findIndex((e) => e.type === sequence.kind);
        const followed = events.slice(closedBy + 1).filter((e) => e.type === sequence.kind);
        const out = frames.filter((f) => f.way === "out");
        record.sequences[sequence.name] = { latest, scrolled, events, now, out: out.length, first: frames[0] };
        report.frames[name] = frames;
        if (moving) {
          ok(`${name}: the panel fades back (phone-dock-out) and every key or tap that follows comes while it does`,
            out.length > 0 && out[0].panelAnimation === "phone-dock-out" && followed.length > 0 && followed.every((e) => e.way === "out"), { out: out.length, followed });
          ok(`${name}: on its way out the panel is inert and aria-hidden, holds no focus, and a tap where Back to latest was lands beside it`,
            out.every((f) => f.panelInert && f.panelHidden && !f.focusInPanel && f.atProbe !== "panel"), out.slice(0, 2));
        } else ok(`${name}: the panel goes at once, with no way out`, out.length === 0 && !frames[0]?.panelShown, frames.slice(0, 2));
        ok(`${name}: no press, click, key or focus reaches the panel`, closedBy >= 0 && events.every((e) => !e.inPanel), events);
        // Where focus is when the next key or tap comes: after a tap elsewhere it rightly moves on.
        ok(`${name}: focus is back on the dock's button by the next key or tap`, /^button\.phone-dock-button\.phone-dock-turns/.test(followed[0]?.focus || ""), followed[0]);
        if (sequence.tapsLatest)
          ok(`${name}: Back to latest did not run (the conversation stayed where it was read)`, Math.abs(now.scrollTop - scrolled) < 4, { before: scrolled, after: now.scrollTop });
        // Nothing left marked: not while it is reopened, not after it has gone.
        ok(`${name}: the panel is marked only while on its way out, and nothing is left after`,
          frames.every((f) => f.way === "out" || f.marked === 0) && now.marked === 0 && !now.scrim?.hidden &&
          (sequence.reopens ? now.panelShown && now.way === null && !now.panelInert : !now.panelShown && !now.scrim), { last: now });
        if (sequence.reopens) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
        }
      }
    } else report.notShown.push(`${tag}: no visible turn dock button on the app`);
  }

  // Toasts (desktop preview): a real one from Send to Agent → Hana, set twice with the same text.
  if (!run.phone && !run.fixture) {
    await page.locator(".agent-row", { hasText: "Mikan" }).first().click();
    const sendTo = visible(".reply-actions .send-to-agent-button");
    const sendToHana = async () => {
      await sendTo.click();
      const hana = page.locator('.send-to-agent-menu [role="menuitem"]', { hasText: "Hana" }).first();
      if (!(await hana.count()) || !(await hana.isEnabled())) return false;
      await hana.click();
      return true;
    };
    if ((await sendTo.count()) && (await sendToHana())) {
      await page.locator(".toast-stack > .toast:not(.toast-leaving)").first().waitFor({ timeout: 3000 });
      const first = await page.evaluate(() => window.__toasts());
      if (!baseline) {
        if (reduced) ok(`${tag}: a toast shows with no animation under reduced motion`, first.length === 1 && /^none:/.test(first[0].animation), first);
        else ok(`${tag}: a toast rises in over small with the spring`, first.length === 1 && first[0].animation.startsWith("toast-in:") && ms(first[0].animation.split(":")[1]) === 180, first);
      }
      await page.waitForTimeout(1500);
      const t0 = Date.now();
      const again = await sendToHana();
      await page.waitForTimeout(30);
      const replaced = await page.evaluate(() => window.__toasts());
      if (again && !baseline) {
        const current = replaced.filter((x) => !x.leaving), leaving = replaced.filter((x) => x.leaving);
        ok(`${tag}: set again, the toast is shown anew${reduced ? "" : ", its last showing leaving through an aria-hidden copy with no role"}`,
          current.length === 1 && (reduced ? leaving.length === 0 : leaving.length === 1 && leaving[0].hidden && !leaving[0].role && leaving[0].animation.startsWith("toast-out:")), replaced);
        // It shows for its full 4 s from the second set (before this batch, a repeat kept the first timer).
        await page.waitForTimeout(Math.max(0, 3300 - (Date.now() - t0)));
        const still = await page.evaluate(() => window.__toasts().filter((x) => !x.leaving).length);
        ok(`${tag}: a toast set again shows for its full time (still shown 3.3 s after the second set, 4.8 s after the first)`, still === 1, still);
      } else if (!again) report.notShown.push(`${tag}: Send to Agent → Hana a second time was not available`);
      await page.waitForTimeout(1500);
    } else report.notShown.push(`${tag}: Send to Agent → Hana was not available in the preview`);
  }
  await context.close();
}
await browser.close();

// Focus against the build before this batch: the same places, or a difference to explain.
// One change on purpose (Lead 2605): a dock's panel the reader closes gives focus back to its button,
// where before it fell to the body.
const toDockButton = /^button\.phone-dock-button\.phone-dock-turns/;
const changed = { "phone: phone dock closed by its scrim": toDockButton, "phone-reduced: phone dock closed by its scrim": toDockButton };
if (process.env.BASELINE_REPORT) {
  const before = JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).focus;
  for (const [where, after] of Object.entries(report.focus))
    if (changed[where]) ok(`focus changed by this batch on purpose: ${where}, from the body to the dock's button`, before[where] === "body" && changed[where].test(after || ""), { before: before[where], after });
    else ok(`focus unchanged by this batch: ${where}`, before[where] === after, { before: before[where], after });
}
ok("nothing was written to the synthetic Workspace", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1b2-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode: report.mode, passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown, focus: report.focus }));
process.exit(report.passed ? 0 : 1);
