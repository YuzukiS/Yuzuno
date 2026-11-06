// T-19 CV:WD-08 (Lead 2 4644), in Chromium on a production build of the app with a synthetic Workspace and
// every API answered here (no Core, no Agent). A sub-agent's card, opened from its node in the work dock or
// from the dock's list, comes in from the node's side once it is placed: opacity and scale(0.98) to none,
// over small (180 ms), once per opening. As its details arrive (read 400 ms after it opens, the card grows)
// or as another child is chosen, it plays nothing; closed, it goes at once; opened again, it comes in
// again. Focus is in the card once it is placed. Under reduced motion nothing plays.
// Desktop 1440×760 and phone 390×844 (the work dock opened from its button), each with normal and reduced
// motion. Writes: none; anything but a read is refused and counted. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-subagent-card-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-subagent-card");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], unknownGets: [], writes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 700)}`}`);
};

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, connectionState: "connected", threadId: "th-a" };
const thread = (n) => `01a1418f-0000-7000-8000-00000000000${n}`;
const activity = (kind, n) => ({ type: "subAgentActivity", id: `${kind}-${n}`, kind, agentThreadId: thread(n), agentPath: `/root/child-${n}`,
  model: kind === "started" ? "gpt-6-astra" : null });
const turns = [{ id: "t1", status: "completed", items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text: "Send a few sub-agents to look" }] },
  ...[1, 2, 3, 4, 5].map((n) => activity("started", n)),
  ...[1, 2, 3, 4, 5].map((n) => activity("completed", n)),
  { id: "r1", type: "agentMessage", text: "All five sub-agents are done." },
] }];
const childDetail = (id) => ({ threadId: id, parentThreadId: "parent", nickname: null, role: null, path: `/root/child-${id.at(-1)}`, depth: 1,
  model: "gpt-6-astra", status: "idle", turn: { id: "child-turn", status: "completed", error: null },
  result: { text: Array.from({ length: 14 }, (_, i) => `Finding ${i + 1}: a line long enough to make the card taller.`).join("\n"), truncated: false },
  readFrom: "history", readAt: new Date().toISOString() });
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
const gets = {
  "/api/workspace": { workspace: { id: "ws-subagent" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns,
  "/api/ci/live": noCiRuns, "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
  "/api/home": { generatedAt: "", order: [], needsYou: [], projects: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    if (request.method() === "PUT" && url.pathname === "/api/agents/a/reading") return route.fulfill({ json: { accepted: true } });
    if (request.method() !== "GET") {
      report.writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const child = url.pathname.match(/^\/api\/agents\/a\/subagents\/([^/]+)$/);
    if (child) {
      await new Promise((done) => setTimeout(done, 400));
      return route.fulfill({ json: childDetail(decodeURIComponent(child[1])) }).catch(() => {});
    }
    if (url.pathname === "/api/agents/a/reading") return route.fulfill({ json: { handoff: null } });
    const json = gets[url.pathname];
    if (json) return route.fulfill({ json });
    if (!report.unknownGets.includes(url.pathname)) report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
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

/** In the page: every animate() on the card, and the card each frame. */
function pageHelpers() {
  window.EventSource = class { close() {} addEventListener() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  window.__calls = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    if (this.matches?.(".subagent-card")) window.__calls.push({ t: Math.round(performance.now()), label: this.getAttribute("aria-label") });
    return animate.call(this, keyframes, options);
  };
  const scripted = (a) => !(typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation) && !(typeof CSSTransition !== "undefined" && a instanceof CSSTransition);
  window.__card = () => {
    const el = document.querySelector(".subagent-card");
    if (!el) return null;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { label: el.getAttribute("aria-label"), visible: style.visibility !== "hidden", opacity: Number(style.opacity), transform: style.transform,
      origin: style.transformOrigin, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      plays: el.getAnimations().filter(scripted).map((a) => ({ keys: (a.effect?.getKeyframes?.() ?? []).map((k) => Object.keys(k)
        .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)).sort().join("+")).join("/"), duration: a.effect.getTiming().duration })),
      focusIn: el.contains(document.activeElement), answer: !!el.querySelector(".subagent-answer") };
  };
  /** Every frame for `span` ms; `node` (a selector) is where it was opened from, and is watched too. */
  window.__sample = (span, node) => new Promise((done) => {
    const t0 = performance.now();
    const seen = [];
    const frame = () => {
      const from = node && document.querySelector(node)?.getBoundingClientRect();
      seen.push({ t: Math.round(performance.now() - t0), at: Math.round(performance.now()), card: window.__card(), node: from ? [Math.round(from.left), Math.round(from.top)] : null });
      if (performance.now() - t0 < span) requestAnimationFrame(frame);
      else done(seen);
    };
    frame();
  });
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1440, height: 760 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1440, height: 760 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
/** The opening play: one opacity+transform animation over 180 ms on the card, seen from its first visible frame. */
const cameIn = (frames) => {
  const shown = frames.filter((f) => f.card?.visible);
  const first = shown[0]?.card;
  return { first, last: shown.at(-1)?.card, ok: !!first && first.plays.length === 1 && first.plays[0].keys === "opacity+transform/opacity+transform"
    && first.plays[0].duration === 180 && first.opacity < 1 && first.transform !== "none" && shown.at(-1).card.opacity === 1 && !shown.at(-1).card.plays.length };
};
const still = (frames) => frames.every((f) => !f.card || !f.card.plays.length);
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const calls = async () => page.evaluate(() => window.__calls.length);
  const record = (label, frames) => { report.frames[`${tag}: ${label}`] = frames; return frames; };
  /** Frames for `span` ms from the frame before `act` (an action in the test) runs. */
  const during = async (span, act) => {
    await page.evaluate((span) => { window.__pending = window.__sample(span); }, span);
    await act();
    return page.evaluate(() => window.__pending);
  };
  /** On a phone the work dock is opened from its button first. */
  const dock = async () => {
    if (run.phone && !(await page.locator(".work-dock .conversation-subagent").first().isVisible().catch(() => false)))
      await page.locator(".phone-dock-work").click();
    await page.locator(".work-dock .conversation-subagent").first().waitFor();
  };
  try {
    await page.goto("http://yuzuno-subagent-motion.test/");
    if (run.phone) {
      await page.locator(".agent-row").first().waitFor();
      if (await page.locator(".app.phone-list").count()) await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').first().click();
    }
    await page.locator(".turn[data-turn-id='t1']").waitFor();
    await dock();

    // A node's card, opened: in once from the node's side; its details arriving place it again.
    const node = ".work-dock .conversation-subagent";
    const before = await calls();
    const opened = record("a node's card opens", await during(900, () => page.locator(node).first().click()));
    const came = cameIn(opened);
    const places = [...new Set(opened.filter((f) => f.card?.visible).map((f) => f.card.box.join(",")))];
    if (reduced) ok(`${tag}: under reduced motion, a node's card opens: it shows placed, with nothing playing`,
      opened.some((f) => f.card?.visible) && still(opened) && (await calls()) === before, { first: came.first });
    else ok(`${tag}: a node's card opens: it comes in once from its node's side, opacity and scale over small, and ends at rest`,
      came.ok && came.first.origin.startsWith("0px 0px") && (await calls()) - before === 1, { first: came.first, last: came.last, calls: (await calls()) - before });
    const answered = opened.find((f) => f.card?.answer);
    const late = (await page.evaluate(() => window.__calls.slice())).slice(before).filter((c) => answered && c.t >= answered.at);
    ok(`${tag}: as its details arrive (the card grows), it plays nothing more`,
      !!answered && late.length === 0 && opened.filter((f) => f.card?.answer).every((f) => !f.card.plays.length),
      { late, places, answeredAt: answered?.t });
    ok(`${tag}: once placed, focus is in the card`, opened.filter((f) => f.card?.visible).at(-1)?.card.focusIn === true, opened.at(-1)?.card);
    await page.keyboard.press("Escape");
    await page.locator(".subagent-card").waitFor({ state: "detached" });

    // The dock's list, then a child chosen in it, then back to the list: one play, at the opening.
    await dock();
    const listed = await calls();
    const list = record("the list opens", await during(500, () => page.getByRole("button", { name: "Sub-agents: open the list" }).click()));
    const chosen = record("a child chosen in the list", await during(700, () => page.locator(".subagent-card-list button", { hasText: "child-2" }).first().click()));
    const back = record("back to the list", await during(400, () => page.getByRole("button", { name: "All sub-agents" }).click()));
    const plays = (await calls()) - listed;
    if (reduced) ok(`${tag}: under reduced motion, the list opens, a child is chosen and the list comes back: nothing plays`,
      still(list) && still(chosen) && still(back) && plays === 0, { plays });
    else ok(`${tag}: the list opens and comes in once; choosing a child in it, and going back to the list, plays nothing`,
      cameIn(list).ok && still(chosen) && still(back) && plays === 1, { plays, first: cameIn(list).first });
    await page.keyboard.press("Escape");
    await page.locator(".subagent-card").waitFor({ state: "detached" });

    // Opened again: in again, once.
    await dock();
    const again = await calls();
    const reopened = record("another node's card opens", await during(600, () => page.locator(node).nth(1).click()));
    if (reduced) ok(`${tag}: under reduced motion, a card opened again shows with nothing playing`, still(reopened) && (await calls()) === again, {});
    else ok(`${tag}: a card opened again comes in again, once`, cameIn(reopened).ok && (await calls()) - again === 1,
      { first: cameIn(reopened).first, calls: (await calls()) - again });
    await page.keyboard.press("Escape");
    await page.locator(".subagent-card").waitFor({ state: "detached" });
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    await page.screenshot({ path: join(output, `${tag}-error.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
ok("nothing was written", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
report.passed = report.failures.length === 0;
await writeFile(join(output, "motion-subagent-card-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
process.exit(report.passed ? 0 : 1);
