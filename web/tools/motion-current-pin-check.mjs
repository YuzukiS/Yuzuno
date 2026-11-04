// T-19 SH:N12 and CV:CP-02, the current-turn pin's body (M5): in Chromium on a production build of
// the app with a synthetic Workspace that is never written to. Sora's Turn is running, and its
// request, with a follow-up, has gone up out of view, so the pin holds it at the conversation's top.
// A press on the pin's summary (a tap on a phone), or Enter on it, opens the pin: the request's list
// unfolds over frames as the excerpt goes. A second press, or Escape, folds it again; Escape gives
// focus back to the summary. Under reduced motion the list is there, or gone, in the first frame.
// The whole pin only grows as it opens and only shrinks as it closes: the excerpt gives way as the list
// comes, so it never first dips or jumps. Throughout, the conversation does not scroll and the pin stays
// pinned. Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Each toggle is sampled
// every frame: the whole pin's height and its height below the summary, its open state, whether it is
// pinned, and the conversation's scrollTop. Two more things a reader may meet (Lead 4056):
// - while the pin is open, a follow-up arrives through the event stream (this check speaks it for Core)
//   and a read: the pin takes it in one step, and nothing in it plays again;
// - on a desktop, a jump made as the pin opens (Turn 8 from the turn dock, 40 ms after the press): the
//   pane's scroll padding follows the pin, and the jumped-to Turn must end below the open pin, with
//   nothing over it;
// - a fifth run, on a desktop, where the running Turn is an index entry (_yuzunoIndex), so the pin ends
//   with the preview's footer: the whole sequence again, and the footer's margin is the pin's end.
// - four more runs, desktop and phone, normal and reduced, with one short request and no follow-up
//   (Lead 4074): its one-line excerpt is shorter than the two lines it is clamped to.
// Writes: only the app's own saves of where an Agent was read. Reads the fixture does not know are
// answered {} and listed. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-current-pin-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-current-pin");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], unknownGets: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)}`}`);
};

const WORKSPACE = "ws-current-pin";
const agent = (id, name, status) => ({ id, name, status, goal: "", cwd: "/fixture", model: "m", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" });
const agents = [agent("c", "Sora", "working"), agent("a", "Mori", "idle")];
const request = "Check the phone layout again: run the layout check, then tell me which parts still run off the side and why.";
const followUp = "Also note which of them only run off the side with the larger reading size.";
const work = (n) => `Step ${n} of the layout check. ${"The check measures each part against the side of the window and notes what runs off. ".repeat(6)}`;
// Eight finished Turns, then the running one: its request and follow-up, and far more work below them,
// so at the latest both are out of view above and the pin holds them.
const turns = [
  ...Array.from({ length: 8 }, (_, n) => ({ id: `t${n}`, status: "completed", items: [
    { id: `u${n}`, type: "userMessage", content: [{ type: "text", text: `Earlier question ${n + 1}` }] },
    { id: `r${n}`, type: "agentMessage", text: `Earlier answer ${n + 1}.` },
  ] })),
  { id: "t8", status: "inProgress", items: [] },
];
const running = [
  { id: "u8", type: "userMessage", content: [{ type: "text", text: request }] },
  { id: "w1", type: "agentMessage", phase: "commentary", text: work(1) },
  { id: "u8b", type: "userMessage", content: [{ type: "text", text: followUp }] },
  ...Array.from({ length: 6 }, (_, n) => ({ id: `w${n + 2}`, type: "agentMessage", phase: "commentary", text: work(n + 2) })),
];
// A short request, one line in the pin, with no follow-up (Lead 4074): its excerpt is shorter than the
// two lines it is clamped to, and its list is short too.
const short = "Fix the typo in the heading.";
const runningShort = [{ id: "u8", type: "userMessage", content: [{ type: "text", text: short }] }, ...running.filter((item) => item.type !== "userMessage")];
// A second follow-up, sent while the pin is open: it arrives through the event stream and a read.
const later = { id: "u8c", type: "userMessage", content: [{ type: "text", text: "And list them in the order they appear." }] };
// With the event stream open, the app also reads each Agent's Codex usage and MCP list, and the backlog
// (the shapes motion-2d1-check answers).
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const gets = {
  "/api/agents/c/codex/usage": usage, "/api/agents/a/codex/usage": usage, "/api/agents/c/codex/mcp": mcp, "/api/agents/a/codex/mcp": mcp,
  "/api/agents/c/conversation/inputs": noConversationInputs, "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/backlog": { observedAt: "2026-11-04T00:00:00Z", agents: {} },
  "/api/workspace": { workspace: { id: WORKSPACE }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/c": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a": { agent: agents[1], pending: [], messageReceipts: [], artifacts: [], turns: turns.slice(0, 2) },
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  if (url.pathname.startsWith("/api/")) {
    if (/^\/api\/agents\/[ac]\/reading$/.test(url.pathname)) {
      if (method === "GET") return route.fulfill({ json: { handoff: null } });
      report.readingSaves.push(url.pathname);
      return route.fulfill({ json: { accepted: true, sourceSeq: 0 } });
    }
    // Home reads the repositories linked to its projects through a POST that changes nothing.
    if (method === "POST" && url.pathname === "/api/collaboration/github_repositories")
      return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      report.writes.push(`${method} ${url.pathname}`);
      return route.fulfill({ status: 400, json: { error: "this check writes nothing" } });
    }
    const json = gets[url.pathname];
    if (json) return route.fulfill({ json });
    report.unknownGets.push(url.pathname);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
}

/** Samples the pin every frame from now until `span` ms have passed. */
function startSampling(span) {
  const pin = document.querySelector(".main-panel .current-turn-prompt");
  const summary = pin.querySelector(":scope > summary");
  const scroller = document.querySelector(".main-panel .conversation-scroll");
  const t0 = performance.now();
  const read = () => ({
    t: Math.round(performance.now() - t0),
    open: pin.open,
    // The whole pin, its summary, and the list's share: its height below the summary (padding and border included).
    whole: Math.round(pin.getBoundingClientRect().height * 10) / 10,
    summary: Math.round(summary.getBoundingClientRect().height * 10) / 10,
    body: Math.round((pin.getBoundingClientRect().height - summary.getBoundingClientRect().height) * 10) / 10,
    pinned: pin.dataset.pinned,
    top: Math.round(scroller.scrollTop),
    // Animations and transitions playing in the pin that the browser reports (not ::details-content's).
    playing: pin.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
  });
  window.__pinFrames = [read()];
  window.__pinDone = false;
  const frame = () => {
    window.__pinFrames.push(read());
    if (performance.now() - t0 < span) requestAnimationFrame(frame);
    else window.__pinDone = true;
  };
  requestAnimationFrame(frame);
}

const browser = await launchBrowser();
const runs = [
  { tag: "desktop", width: 1280, height: 860, touch: false, reduced: false },
  { tag: "desktop-reduced", width: 1280, height: 860, touch: false, reduced: true },
  { tag: "phone", width: 390, height: 844, touch: true, reduced: false },
  { tag: "phone-reduced", width: 390, height: 844, touch: true, reduced: true },
  // The running Turn as an index entry stands for it (Core's _yuzunoIndex): the pin then ends with the
  // preview's footer, "View in conversation", not its list (Lead 4067).
  { tag: "desktop-footer", width: 1280, height: 860, touch: false, reduced: false, footer: true },
  { tag: "desktop-short", width: 1280, height: 860, touch: false, reduced: false, short: true },
  { tag: "desktop-short-reduced", width: 1280, height: 860, touch: false, reduced: true, short: true },
  { tag: "phone-short", width: 390, height: 844, touch: true, reduced: false, short: true },
  { tag: "phone-short-reduced", width: 390, height: 844, touch: true, reduced: true, short: true },
];
try {
  for (const run of runs) {
    const context = await browser.newContext({ viewport: { width: run.width, height: run.height }, hasTouch: run.touch, isMobile: run.touch,
      reducedMotion: run.reduced ? "reduce" : "no-preference" });
    const page = await context.newPage();
    turns[8].items = run.short ? [...runningShort] : [...running];
    turns[8]._yuzunoIndex = run.footer || undefined;
    await page.addInitScript(() => {
      // The event stream, spoken for Core by this check: a fresh one starts with `reset`, and
      // __announce says Sora's conversation changed, which the app answers with a read.
      let id = 0;
      const streams = [];
      window.EventSource = class {
        constructor() {
          this.readyState = 0;
          streams.push(this);
          setTimeout(() => {
            if (this.readyState === 2) return;
            this.readyState = 1;
            this.onopen?.({});
            this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
          }, 0);
        }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
      window.__announce = () => streams.findLast((s) => s.readyState === 1)
        ?.onmessage?.({ data: JSON.stringify({ type: "agent.changed", agentId: "c" }), lastEventId: String(++id) });
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    });
    page.on("pageerror", (error) => report.errors.push(`${run.tag}: ${error.message}`));
    await page.route("http://yuzuno-current-pin.test/**", serve);
    try {
      await page.goto("http://yuzuno-current-pin.test/");
      const composer = page.locator('[data-composer-input][aria-label="Message Sora"]');
      if (!(await composer.isVisible().catch(() => false))) {
        if (run.touch && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
        await page.locator('.agent-row .agent-select[aria-label="Open Sora"]').click();
      }
      await composer.waitFor();
      // At the latest, the request and its follow-up are up out of view: the pin holds them.
      const scroller = page.locator(".main-panel .conversation-scroll");
      await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const pin = page.locator('.main-panel .current-turn-prompt[data-pinned="true"]');
      await pin.waitFor();
      await page.waitForTimeout(400);
      const summary = pin.locator(":scope > summary");
      const press = run.touch ? "tap" : "press";
      // A short request's pin and list change less: only a real change is asked there.
      const least = run.short ? 1 : 20, list = run.short ? 5 : 20;
      const closedBody = await pin.evaluate((el) => el.getBoundingClientRect().height - el.querySelector(":scope > summary").getBoundingClientRect().height);
      const all = [];

      /** One toggle, sampled: what the pin was before, every frame after, and where it settled. */
      async function toggle(what, act) {
        const before = await pin.evaluate((el) => el.open);
        await page.evaluate(startSampling, 700);
        await act();
        await page.waitForFunction(() => window.__pinDone);
        const frames = await page.evaluate(() => window.__pinFrames);
        report.frames[`${run.tag}: ${what}`] = frames;
        all.push(...frames);
        const after = frames.filter((f) => f.open !== before);
        const first = after[0];
        const final = after.at(-1);
        const between = after.filter((f) => f.body > Math.min(first.body, final.body) + 1 && f.body < Math.max(first.body, final.body) - 1);
        // The whole pin from the last frame before the toggle on: opening, it only grows; closing, it only shrinks;
        // and it never goes past where it ends or back past where it began. A short request's pin changes little,
        // so there only the direction and a real change are asked.
        const wholes = [frames.filter((f) => f.open === before).at(-1)?.whole, ...after.map((f) => f.whole)];
        const [from, to] = [wholes[0], wholes.at(-1)];
        const steady = wholes.every((h, i) => i === 0 || (before ? h <= wholes[i - 1] + 1 : h >= wholes[i - 1] - 1))
          && wholes.every((h) => h >= Math.min(from, to) - 1 && h <= Math.max(from, to) + 1)
          && (before ? to < from - least : to > from + least);
        return { before, after: after.length, first: first?.body, final: final?.body, between: between.length, settledOpen: final && final.open,
          steady, whole: [wholes[0], Math.min(...wholes), Math.max(...wholes), wholes.at(-1)] };
      }
      const wholeRow = (name, seen) => ok(`${run.tag}: ${name}`, seen.after > 0 && seen.steady, { whole: seen.whole });
      const overFrames = (seen, opening) => seen.after > 0 && seen.settledOpen === opening && seen.between >= 2
        && (opening ? seen.final - seen.first > list : seen.first - seen.final > list);
      const atOnce = (seen, opening) => seen.after > 0 && seen.settledOpen === opening && Math.abs(seen.final - seen.first) <= 1
        && (opening ? seen.final - closedBody > list : Math.abs(seen.final - closedBody) <= 1);
      const judge = (name, seen, opening) => run.reduced
        ? ok(`${run.tag}: ${name}, in the first frame`, atOnce(seen, opening), seen)
        : ok(`${run.tag}: ${name}, over frames`, overFrames(seen, opening), seen);

      const opened = await toggle(`${press} opens`, () => (run.touch ? summary.tap() : summary.click()));
      judge(`a ${press} on the pin opens it, its request unfolding`, opened, true);
      wholeRow(`opened by a ${press}, the whole pin only grows, from where it began to where it ends`, opened);
      const listed = await pin.locator(".current-turn-messages").innerText();
      if (run.short) ok(`${run.tag}: the open pin reads the one short request`, listed.includes(short) && !listed.includes("Follow-up"), listed.slice(0, 200));
      else
        ok(`${run.tag}: the open pin reads the request and its follow-up`,
          listed.includes("run the layout check") && listed.includes("larger reading size"), listed.slice(0, 200));
      // Settled open, the pin ends just after its last part, that part's own margin, and its padding and border:
      // the height CurrentTurnPrompt keeps room for while it opens.
      const ends = await pin.evaluate((el) => {
        const last = el.lastElementChild, style = getComputedStyle(el), r = el.getBoundingClientRect();
        const margin = parseFloat(getComputedStyle(last).marginBottom);
        const reached = last.getBoundingClientRect().bottom - r.top + margin + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
        return { last: last.tagName, text: last.textContent.slice(0, 60), margin, reached: Math.round(reached * 10) / 10,
          height: Math.round(r.height * 10) / 10 };
      });
      ok(`${run.tag}: settled open, the pin ends just after its last part${run.footer ? ", the preview's footer," : ""} and that part's margin`,
        Math.abs(ends.reached - ends.height) <= 1
          && (run.footer ? ends.last === "P" && ends.text.includes("View in conversation") : ends.last === "OL"), ends);
      const closed = await toggle(`${press} closes`, () => (run.touch ? summary.tap() : summary.click()));
      judge(`a second ${press} closes it, folding`, closed, false);
      wholeRow(`closed by a second ${press}, the whole pin only shrinks, from where it began to where it ends`, closed);
      const entered = await toggle("Enter opens", async () => {
        await summary.focus();
        await page.keyboard.press("Enter");
      });
      judge("Enter on its summary opens it", entered, true);
      wholeRow("opened by Enter, the whole pin only grows, from where it began to where it ends", entered);
      const escaped = await toggle("Escape closes", () => page.keyboard.press("Escape"));
      wholeRow("closed by Escape, the whole pin only shrinks, from where it began to where it ends", escaped);
      const focusBack = await summary.evaluate((el) => document.activeElement === el);
      if (run.reduced) ok(`${run.tag}: Escape closes it in the first frame, and focus is back on the summary`, atOnce(escaped, false) && focusBack, { ...escaped, focusBack });
      else ok(`${run.tag}: Escape closes it over frames, and focus is back on the summary`, overFrames(escaped, false) && focusBack, { ...escaped, focusBack });
      const tops = [...new Set(all.map((f) => f.top))];
      const pinnedAll = all.every((f) => f.pinned === "true");
      ok(`${run.tag}: throughout, the conversation does not scroll and the pin stays pinned`,
        Math.max(...tops) - Math.min(...tops) <= 1 && pinnedAll, { tops, pinnedAll, frames: all.length });
      await page.screenshot({ path: resolve(output, `${run.tag}-closed.png`) });

      // Open, a follow-up arrives: the pin takes it in one step, and nothing in it plays again.
      await summary.focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      await page.evaluate(startSampling, 900);
      const held = await pin.locator(".current-turn-messages > li").count();
      turns[8].items.push(later);
      await page.evaluate(() => window.__announce());
      await pin.locator(".current-turn-messages > li").nth(held).waitFor();
      await page.waitForFunction(() => window.__pinDone);
      const arrival = await page.evaluate(() => window.__pinFrames);
      report.frames[`${run.tag}: a follow-up arrives`] = arrival;
      const from = arrival[0].whole, to = arrival.at(-1).whole;
      const midway = arrival.filter((f) => f.whole > Math.min(from, to) + 1 && f.whole < Math.max(from, to) - 1).length;
      ok(`${run.tag}: while it is open, a follow-up that arrives grows the pin in one step, and nothing in it plays`,
        to > from + 5 && midway === 0 && arrival.every((f) => f.open && f.playing === 0), { from, to, midway,
          playing: Math.max(...arrival.map((f) => f.playing)) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);

      // A jump made as the pin opens: Turn 8 from the turn dock, 40 ms after the press. The pane's scroll
      // padding follows the pin's height, so the jump must still end below the pin once it has opened.
      if (!run.touch) {
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(400);
        await page.locator('.turn-dock-stop[data-turn-choice="t7"]').waitFor({ state: "attached" });
        await page.evaluate(startSampling, 900);
        await page.evaluate(() => {
          document.querySelector(".main-panel .current-turn-prompt > summary").click();
          setTimeout(() => document.querySelector('.turn-dock-stop[data-turn-choice="t7"]').click(), 40);
        });
        await page.waitForFunction(() => window.__pinDone);
        const jump = await page.evaluate(() => window.__pinFrames);
        report.frames[`${run.tag}: a jump as it opens`] = jump;
        const landed = jump.findIndex((f) => f.top !== jump[0].top);
        const final = jump.at(-1).whole;
        const seen = await page.evaluate(() => {
          const pin = document.querySelector(".main-panel .current-turn-prompt");
          const target = document.getElementById("turn-t7");
          const p = pin.getBoundingClientRect(), r = target.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 6);
          return { open: pin.open, pinned: pin.dataset.pinned, pinBottom: Math.round(p.bottom * 10) / 10,
            targetTop: Math.round(r.top * 10) / 10, onTop: !!hit && target.contains(hit) };
        });
        // Still opening: its list had not yet reached its height (a short request's whole pin changes little,
        // and its list only a few lines, so there any real change left counts).
        const detail = { atJump: landed >= 0 ? jump[landed].whole : null, final, listAtJump: landed >= 0 ? jump[landed].body : null,
          listFinal: jump.at(-1).body, ...seen };
        if (!run.reduced)
          ok(`${run.tag}: the jump came while the pin was still opening`, landed > 0 && jump[landed].body < jump.at(-1).body - (run.short ? 1 : 5), detail);
        ok(`${run.tag}: a turn jump made as the pin opens ends below the open pin, with nothing over it`,
          landed > 0 && seen.open && seen.pinned === "true" && seen.targetTop >= seen.pinBottom - 1 && seen.onTop, detail);
      }
    } catch (error) {
      ok(`${run.tag}: the sequence ran to its end`, false, String(error?.message ?? error).slice(0, 400));
    }
    await context.close();
  }
  ok("no page errors", report.errors.length === 0, report.errors);
  ok("writes: none but the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
} finally {
  await browser.close();
  report.unknownGets = [...new Set(report.unknownGets)];
  await writeFile(resolve(output, "motion-current-pin-check.json"), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
