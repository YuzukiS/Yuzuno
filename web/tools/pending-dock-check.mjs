// T-51 third PR (T-19's CV:Q-03 and CV:WD-05), in Chromium on a production build of the app with a synthetic
// Workspace and every API answered here (no Core, no Agent):
// - CV:Q-03: a Codex question answered: its "Response sent" hint fades in over small; once Core resolves it, the card
//   leaves over exit-small through a copy where it was (aria-hidden, inert, no ids or tab stops) while the card itself
//   is gone at once. A card that opens already sent shows its hint as it is, and another Agent opened takes any copy
//   with its conversation.
// - CV:WD-05: a job on the conversation's dock that ends while it shows settles once: its fill fades in over small,
//   and a success also springs .96 → 1 (1.02 at most) over micro. The same statuses read again, a job first shown
//   ended, a start, a cancel under way and an unknown status play nothing; a job read as unknown and then ended
//   settles against what it was before.
// Under reduced motion nothing plays: the hint shows and the card goes at once. Desktop 1280×860 and phone 390×844,
// each with normal and reduced motion. Writes: the answer this check sends and the app's own saves of where an Agent
// was read; anything else is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/pending-dock-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/pending-dock");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], answers: [], unknownGets: [], readingSaves: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const WORKSPACE = "ws-pending-dock";
const base = { status: "waiting", goal: "", model: "m", color: "sage", createdAt: "", updatedAt: "1", unreadCount: 0,
  pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const mori = { ...base, id: "a", name: "Mori", cwd: "/fixture/mori" };
const hana = { ...base, id: "b", name: "Hana", cwd: "/fixture/hana", status: "idle" };
const question = (id, sent = false) => ({ id, agentId: "a", method: "item/tool/requestUserInput", createdAt: "",
  params: { questions: [{ id: "q1", question: "Which fixture branch?", options: [{ label: "main", description: "The main fixture" }] }],
    ...(sent ? { _responseSent: true } : {}) } });
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const jobBase = { requestId: "r", taskRef: "T-1", agentId: "a", agent: { name: "Mori" }, machine: { name: "lab-host" },
  resources: { cpuMillis: 500, memoryMiB: 96, swapMiB: 0 }, reservation: { cpuMillis: 600, memoryMiB: 160, swapMiB: 0 },
  argv: ["/bin/true"], cwd: "/fixture", env: {}, reserved: false, reason: "", cursor: 1, outputs: [], guardGit: true, timeoutSeconds: 900 };
const job = (id, name, status) => ({ ...jobBase, id, name, status, createdAt: "2026-11-05T08:00:00Z", startedAt: "2026-11-05T08:01:00Z",
  finishedAt: ["running", "queued", "cancelling", "unknown"].includes(status) ? null : "2026-11-05T08:05:00Z" });
const state = { pending: [], jobs: [] };
const detail = (agent) => ({ agent, pending: agent.id === "a" ? state.pending : [], messageReceipts: [], artifacts: [], turns: [] });
const gets = {
  "/api/workspace": () => ({ workspace: { id: WORKSPACE }, agents: [{ ...mori, pendingCount: state.pending.length }, hana],
    projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }], runtime: { connected: true }, defaultCwd: "/fixture" }),
  "/api/agents/a": () => detail(mori), "/api/agents/b": () => detail(hana),
  "/api/jobs": (url) => url.searchParams.get("agentId") === "a" ? { jobs: state.jobs, liveJobs: [], hasMore: false, nextBefore: null }
    : { jobs: [], liveJobs: [], hasMore: false, nextBefore: null },
  "/api/backlog": () => ({ observedAt: "2026-11-05T00:00:00Z", agents: {} }),
  "/api/models": () => ({ models: [] }), "/api/home": () => emptyHome, "/api/updates": () => unmanagedUpdates,
  "/api/jobs/budget": () => idleJobsBudget, "/api/jobs/live": () => noLiveJobs, "/api/ci": () => noCiRuns,
  "/api/ci/live": () => noCiRuns, "/api/reviews": () => noReviews,
};
for (const id of ["a", "b"]) {
  gets[`/api/agents/${id}/codex/usage`] = () => usage;
  gets[`/api/agents/${id}/codex/mcp`] = () => ({ state: "observed", reason: "", generation: 1, more: 0, servers: [] });
  gets[`/api/agents/${id}/conversation/inputs`] = () => noConversationInputs;
}
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (method === "GET" && /^\/api\/agents\/[ab]\/reading$/.test(path)) return route.fulfill({ json: { handoff: null } });
    if (method === "PUT" && /^\/api\/agents\/[ab]\/reading$/.test(path)) {
      report.readingSaves.push(path);
      return route.fulfill({ json: { accepted: true, sourceSeq: 0 } });
    }
    if (method === "POST" && /^\/api\/requests\/[^/]+\/respond$/.test(path)) {
      report.answers.push(path);
      return route.fulfill({ json: {} });
    }
    if (method === "GET") {
      if (gets[path]) return route.fulfill({ json: gets[path](url) });
      if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
      return route.fulfill({ json: {} });
    }
    report.writes.push(`${method} ${path}`);
    return route.fulfill({ status: 400, json: { error: "this check writes nothing else" } });
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

/** In the page from the first script: the live events, and recorders of what plays on the pending card and the dock. */
function pageHelpers() {
  let id = 0;
  const sources = [];
  window.EventSource = class {
    constructor() {
      sources.push(this);
      this.readyState = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        window.__send({ type: "reset", reason: "new" });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  /** Core sends `event` on the live events. */
  window.__send = (event) => sources.filter((s) => s.readyState === 1).at(-1)?.onmessage?.({ data: JSON.stringify(event), lastEventId: String(++id) });
  if (!sessionStorage.getItem("t51-seeded")) {
    sessionStorage.setItem("t51-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  }
  /** What plays on `el` itself: each animation's properties, duration and keyframes. */
  window.__plays = (el) => !el ? null : el.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending").map((a) => {
    const keyframes = a.effect?.getKeyframes?.() ?? [];
    return {
      props: [...new Set(keyframes.flatMap((k) => Object.keys(k))
        .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))].sort().join("+"),
      duration: a.effect?.getTiming?.().duration ?? null,
      scale: keyframes.map((k) => k.scale).filter((v) => v !== undefined),
    };
  });
  /** From now: the "Response sent" hint as it shows, and the card's copy as it is put where the card was. */
  window.__watchCard = () => {
    // `framed`: a copy was there at an animation frame, just before a paint, so it showed.
    const rec = { hint: null, copy: null, cardGoneAt: null, copyGoneAt: null, framed: false, start: performance.now() };
    const look = () => {
      const now = performance.now() - rec.start;
      const hint = [...document.querySelectorAll(".pending-card:not(.pending-card-leaving) .field-hint")]
        .find((p) => p.textContent.includes("Response sent"));
      if (hint && !rec.hint) rec.hint = { at: now, plays: window.__plays(hint) };
      const copy = document.querySelector(".pending-card-leaving");
      if (copy && !rec.copy) rec.copy = { at: now, plays: window.__plays(copy), hidden: copy.getAttribute("aria-hidden"),
        inert: copy.hasAttribute("inert"), ids: copy.querySelectorAll("[id], [tabindex], [name]").length + (copy.id ? 1 : 0),
        focusInside: copy.contains(document.activeElement) };
      // Its fade starts a microtask after it is put in place: what plays is read until it does.
      else if (copy && rec.copy && !rec.copy.plays?.length) rec.copy.plays = window.__plays(copy);
      if (rec.copy && !copy && rec.copyGoneAt === null) rec.copyGoneAt = now;
      if (rec.hint && rec.cardGoneAt === null && !document.querySelector(".pending-card:not(.pending-card-leaving)")) rec.cardGoneAt = now;
    };
    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    let frame = requestAnimationFrame(function each() {
      if (document.querySelector(".pending-card-leaving")) rec.framed = true;
      look();
      frame = requestAnimationFrame(each);
    });
    window.__card = { rec, stop: () => { observer.disconnect(); cancelAnimationFrame(frame); look(); return rec; } };
  };
  /** From now: each dock job's status changes and what plays on its node then, by name. */
  window.__watchDock = () => {
    const seen = new Map();
    const rec = {};
    const look = () => {
      for (const item of document.querySelectorAll(".conversation-job")) {
        const name = item.querySelector("strong")?.textContent ?? "?";
        const status = [...item.classList].find((c) => c.startsWith("state-"))?.slice(6) ?? null;
        if (seen.get(name) === status) continue;
        seen.set(name, status);
        (rec[name] ??= []).push({ status, plays: window.__plays(item.querySelector(".work-dock-node")) });
      }
    };
    look();
    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    window.__dock = { rec, stop: () => { observer.disconnect(); look(); return rec; } };
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
const fadedSmall = (plays, reduced) => Array.isArray(plays) && (reduced ? plays.length === 0
  : plays.length === 1 && plays[0].props === "opacity" && plays[0].duration === 180);
/** What a job's node played as it took `status`, from the dock's record. */
const at = (rec, name, status) => (rec?.[name] ?? []).filter((r) => r.status === status).map((r) => r.plays);
/** A settle: the fill (background colour for a filled node, opacity for a ring) over small, and for a success a
    spring over micro, 1.02 at most. Under reduced motion, nothing. */
const settled = (plays, kind, reduced) => {
  if (!Array.isArray(plays)) return false;
  if (reduced) return plays.length === 0;
  const fill = plays.find((p) => p.duration === 180);
  const spring = plays.find((p) => p.props === "scale");
  const fillOk = !!fill && fill.props === (kind === "ring" ? "opacity" : "backgroundColor");
  if (kind !== "success") return fillOk && !spring && plays.length === 1;
  return fillOk && !!spring && spring.duration === 120 && spring.scale.join() === "0.96,1.02,1" && plays.length === 2;
};
const still = (list) => list.length > 0 && list.every((plays) => Array.isArray(plays) && plays.length === 0);

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, quiet) => (reduced ? quiet : normal);
  const measured = (report.measured[tag] = {});
  state.pending = [question("ask")];
  state.jobs = [job("j1", "train", "running"), job("j2", "lint", "running"), job("j3", "eval", "running")];
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("http://yuzuno-t51-pending.test/**", serve);
  await page.addInitScript(pageHelpers);
  const wait = (ms) => page.waitForTimeout(ms);
  const send = (event) => page.evaluate((e) => window.__send(e), event);
  const openMori = async () => {
    if (run.phone && (await page.locator(".app.phone-list").count())) await page.locator(".agent-row").filter({ hasText: "Mori" }).first().click();
    else if (!run.phone) await page.locator(".agent-row").filter({ hasText: "Mori" }).first().click();
    await page.locator(".pending-card, .conversation-scroll").first().waitFor({ timeout: 10_000 });
    await wait(600);
  };
  try {
    await page.goto("http://yuzuno-t51-pending.test/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
    await openMori();

    // ---- CV:Q-03: answered, then resolved.
    {
      let card = null;
      try {
        await page.locator(".pending-card").first().waitFor({ timeout: 10_000 });
        await page.evaluate(() => window.__watchCard());
        await page.locator(".pending-card label.answer-option").first().click();
        await page.getByRole("button", { name: "Send answer", exact: true }).click();
        await page.locator(".pending-card .field-hint", { hasText: "Response sent" }).waitFor({ timeout: 5000 });
        await wait(300);
        state.pending = [];
        await send({ type: "reset", reason: "fixture" });
        await page.waitForFunction(() => !document.querySelector(".pending-card:not(.pending-card-leaving)"), null, { timeout: 5000 });
        await wait(700);
        card = await page.evaluate(() => window.__card.stop());
        card.leftover = await page.locator(".pending-card-leaving").count();
      } catch (error) {
        card = { error: String(error).slice(0, 200), card };
      }
      measured.q03 = card;
      ok(`${tag}: a question answered says "Response sent" ${motion("fading in over small, opacity only", "with nothing playing")}`,
        !!card?.hint && fadedSmall(card.hint.plays, reduced) && report.answers.length > 0, card);
      ok(`${tag}: resolved, the card is gone at once and ${motion("its copy leaves where it was over exit-small, aria-hidden, inert, with no ids, names or tab stops and no focus, then goes", "nothing is left in its place")}`,
        typeof card?.cardGoneAt === "number" && card.leftover === 0 && (reduced
          ? card.copy === null && card.framed === false
          : !!card.copy && card.copy.hidden === "true" && card.copy.inert === true && card.copy.ids === 0 && card.copy.focusInside === false
            && Array.isArray(card.copy.plays) && card.copy.plays.length === 1 && card.copy.plays[0].props === "opacity"
            && card.copy.plays[0].duration === 130 && card.framed === true && typeof card.copyGoneAt === "number" && card.copyGoneAt - card.copy.at < 450), card);
      report.answers.length = 0;
    }

    // ---- CV:Q-03: a card that opens already sent, and another Agent opened while a card shows.
    {
      let opened = null;
      try {
        state.pending = [question("sent", true), question("open")];
        await page.evaluate(() => window.__watchCard());
        await send({ type: "reset", reason: "fixture" });
        await page.locator(".pending-card .field-hint", { hasText: "Response sent" }).waitFor({ timeout: 5000 });
        await wait(300);
        // Another Agent: Mori's conversation goes, its cards with it.
        if (run.phone) await page.locator(".phone-back").click();
        await page.locator(".agent-row").filter({ hasText: "Hana" }).first().click();
        await page.waitForFunction(() => !document.querySelector(".pending-card"), null, { timeout: 5000 });
        await wait(500);
        opened = await page.evaluate(() => window.__card.stop());
        opened.leftover = await page.locator(".pending-card-leaving").count();
      } catch (error) {
        opened = { error: String(error).slice(0, 200), opened };
      }
      measured.q03opened = opened;
      // A copy put in as Mori's cards go is taken out in the same task, before any paint, with nothing playing.
      ok(`${tag}: a card that opens already sent shows its hint with nothing playing, and another Agent opened leaves no copy of Mori's cards`,
        !!opened?.hint && Array.isArray(opened.hint.plays) && opened.hint.plays.length === 0 && opened.framed === false
          && (opened.copy === null || (opened.copy.plays?.length === 0 && opened.copyGoneAt !== null && opened.copyGoneAt - opened.copy.at < 5))
          && opened.leftover === 0, opened);
      if (run.phone) await page.locator(".phone-back").click().catch(() => {});
      state.pending = [];
      await openMori();
    }

    // ---- CV:WD-05: jobs that end while the dock shows them.
    {
      let ends = null;
      let again = null;
      let quiet = null;
      try {
        // A phone keeps the dock behind its button: open it, so its nodes show as they change.
        if (run.phone) {
          await page.locator(".phone-dock-work").click();
          await wait(500);
        }
        await page.locator(".conversation-job").first().waitFor({ timeout: 10_000 });
        await page.evaluate(() => window.__watchDock());
        state.jobs = [job("j1", "train", "succeeded"), job("j2", "lint", "failed"), job("j3", "eval", "cancelled")];
        await send({ type: "workspace.changed", scope: "jobs" });
        await page.waitForFunction(() => document.querySelectorAll(".conversation-job.state-running").length === 0, null, { timeout: 5000 });
        await wait(400);
        ends = await page.evaluate(() => window.__dock.stop());

        // The same ends read again, and a job that first shows ended.
        await page.evaluate(() => window.__watchDock());
        state.jobs = [...state.jobs, job("j4", "pack", "succeeded")];
        await send({ type: "workspace.changed", scope: "jobs" });
        await page.locator(".conversation-job", { hasText: "pack" }).waitFor({ timeout: 5000 });
        await wait(400);
        again = await page.evaluate(() => window.__dock.stop());

        // Starts, a cancel under way, an unknown status, then ends after it.
        state.jobs = [job("k1", "fetch", "queued"), job("k2", "index", "running"), job("k3", "sync", "running")];
        await send({ type: "workspace.changed", scope: "jobs" });
        await page.locator(".conversation-job", { hasText: "fetch" }).waitFor({ timeout: 5000 });
        await wait(400);
        await page.evaluate(() => window.__watchDock());
        for (const [statuses, settle] of [[["running", "cancelling", "unknown"], 400], [["unknown", "cancelling", "unknown"], 400], [["succeeded", "cancelled", "running"], 400]]) {
          state.jobs = [job("k1", "fetch", statuses[0]), job("k2", "index", statuses[1]), job("k3", "sync", statuses[2])];
          await send({ type: "workspace.changed", scope: "jobs" });
          await page.waitForFunction((want) => want.every(([n, s]) =>
            [...document.querySelectorAll(".conversation-job")].some((el) => el.textContent.includes(n) && el.classList.contains(`state-${s}`))),
          [["fetch", statuses[0]], ["index", statuses[1]], ["sync", statuses[2]]], { timeout: 5000 });
          await wait(settle);
        }
        quiet = await page.evaluate(() => window.__dock.stop());
      } catch (error) {
        ends = ends ?? { error: String(error).slice(0, 200) };
        quiet = quiet ?? { error: String(error).slice(0, 200) };
      }
      measured.wd05 = { ends, again, quiet };
      ok(`${tag}: jobs that end while the dock shows them settle once: ${motion("a success fills over small and springs .96 → 1 (1.02 at most) over micro, a failure fills, a cancel fades in", "nothing plays")}`,
        settled(at(ends, "train", "succeeded")[0], "success", reduced) && settled(at(ends, "lint", "failed")[0], "fill", reduced)
          && settled(at(ends, "eval", "cancelled")[0], "ring", reduced), measured.wd05);
      ok(`${tag}: the same ends read again and a job that first shows ended play nothing`,
        !!again && !again.error && Object.entries(again).every(([, list]) => list.every((r) => Array.isArray(r.plays) && r.plays.length === 0))
          && (again.pack ?? []).length > 0, measured.wd05);
      ok(`${tag}: a start, a cancel under way and an unknown status play nothing; a job read as unknown after running, and a cancel that ends, ${motion("settle once they are read ended", "end with nothing playing")}`,
        !!quiet && !quiet.error && still(at(quiet, "fetch", "running")) && still(at(quiet, "index", "cancelling"))
          && still(at(quiet, "fetch", "unknown")) && still(at(quiet, "sync", "unknown"))
          && settled(at(quiet, "index", "cancelled")[0], "ring", reduced)
          && settled(at(quiet, "fetch", "succeeded")[0], "success", reduced) && still(at(quiet, "sync", "running")), measured.wd05);
    }
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
  }
  await page.screenshot({ path: join(output, `${tag}-end.png`) }).catch(() => {});
  await context.close();
}
await browser.close();

ok("no page errors", report.errors.length === 0, report.errors);
ok("writes: none but the answers this check sends and the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
await writeFile(join(output, "pending-dock-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
if (report.failures.length) process.exit(1);
