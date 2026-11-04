// T-19 CV:CX-44 and CV:CX-65 (F2): after an action removes the pressed button, focus never falls to the
// page. In Chromium on a production build of the app with a synthetic Workspace that is never written to;
// the usage-limit notice's own actions are answered here, as Core would answer them.
// - CX-44, the usage-limit notice of a local Claude Agent (Mika) stopped at its limit. Don't continue
//   (Core answers cancelled), Continue now (sending) and Continue automatically after the reset (waiting,
//   so Continue now and Don't continue appear) each remove or replace the pressed button: focus is then on
//   the notice, never on Continue now. Refused, the error shows and the buttons stay. If the person has
//   gone to the composer while Core's answer is on its way, focus stays there.
// - CX-65, Answer again on a Codex (Sora), a Claude (Rin) and an OpenCode (Ao) question card, each holding
//   an answer from this browser that got no reply (its draft kept as attempted, as after a lost reply):
//   focus is then on that card, its answer can be sent again, and nothing is sent by itself.
// Desktop 1280×860 (a click) and phone 390×844 (a tap), and Enter on the focused button in each. Core's
// answers come 300 ms late, so where focus is while the pressed button is disabled is recorded too.
// Nothing here animates, so reduced motion is not varied. Writes: only the notice's three actions and the
// app's own saves of where an Agent was read; any other write is refused and listed. Reads the fixture does
// not know are answered {} and listed. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/focus-after-answer-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/focus-after-answer");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], readingSaves: [], unknownGets: [], cases: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)}`}`);
};

const WORKSPACE = "ws-focus";
const agent = (id, name, harness, status, pendingCount) => ({ id, name, status, goal: "", cwd: "/fixture", model: "m", color: "sage",
  createdAt: "", updatedAt: "1", unreadCount: 0, pendingCount, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness, connectionState: "connected" });
const agents = [
  agent("m", "Mika", "claude", "error", 0),
  agent("s", "Sora", "codex", "waiting", 1),
  agent("r", "Rin", "claude", "waiting", 1),
  agent("o", "Ao", "opencode", "waiting", 1),
];
const turn = (status, text) => [{ id: "t1", status, items: [
  { id: "u1", type: "userMessage", content: [{ type: "text", text }] },
  { id: "a1", type: "agentMessage", text: "Working on it." },
] }];
// One question per harness, each answered from this browser with no reply in time: its draft is kept as
// attempted (request-draft.ts), so the card opens closed, with Answer again.
const pending = {
  s: { id: "req-s", agentId: "s", method: "item/tool/requestUserInput", createdAt: "",
    params: { threadId: "th-s", turnId: "t1", itemId: "ask-s", questions: [{ id: "why", question: "Why this one?" }] } },
  r: { id: "req-r", agentId: "r", method: "claude/canUseTool", createdAt: "",
    params: { toolName: "AskUserQuestion", requestId: "native-r", turnId: "t1",
      input: { questions: [{ question: "Which fruit?", options: [{ label: "Yuzu" }, { label: "Peach" }] }, { question: "Why?" }] } } },
  o: { id: "req-o", agentId: "o", method: "opencode/question", createdAt: "",
    params: { id: "que_o", sessionID: "ses_o", _runtimeGeneration: 1, _opencodeSession: "ses_o",
      questions: [{ question: "Which fruit?", header: "Fruit", options: [{ label: "Yuzu", description: "citrus" }, { label: "Peach", description: "" }] }] } },
};
const drafts = { version: 1, entries: {
  [JSON.stringify(["s", "codex", "th-s", "t1", "ask-s"])]: { answers: { why: "Because it is smaller." }, attempted: true, at: 1 },
  [JSON.stringify(["r", "claude", "native-r"])]: { answers: { answers: { "Which fruit?": ["Yuzu"] }, free: { "Why?": "Sweet enough." } }, attempted: true, at: 2 },
  [JSON.stringify(["o", "opencode", "ses_o", "que_o"])]: { answers: { answers: { 0: [] }, free: { 0: "Kumquat" } }, attempted: true, at: 3 },
} };
// Mika's usage-limit stop, and what Core answers each action with (QuotaResume.tsx's view).
const reset = Math.floor(Date.now() / 1000) + 3600;
const stopped = { turnId: "t1", resetsAt: reset, limitType: "five_hour" };
const intent = (state, reason = null) => ({ id: "i1", turnId: "t1", resetsAt: reset, dueAt: reset + 60, limitType: "five_hour", attempt: 1,
  state, reason, sentTurn: null });
const views = {
  waiting: { workspace: false, agent: true, enabled: true, intent: intent("waiting"), stopped },
  cancelled: { workspace: false, agent: true, enabled: true, intent: intent("cancelled", "You chose not to continue automatically"), stopped },
  sending: { workspace: false, agent: true, enabled: true, intent: intent("sending"), stopped },
  off: { workspace: false, agent: false, enabled: false, intent: null, stopped },
  // Rin, the other Claude Agent, was not stopped: no notice.
  none: { workspace: false, agent: false, enabled: false, intent: null, stopped: null },
};
const usage = {
  revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [],
};
const mcp = { state: "observed", reason: "", generation: 1, more: 0, servers: [] };
const claudeMcp = { state: "unavailable", reason: "not_observed", generation: null, sessionId: null, checkedAt: null, stale: false,
  freshForSeconds: 0, observation: null };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents, projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/m": { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns: turn("failed", "Tidy the fixture notes.") },
  "/api/agents/s": { agent: agents[1], pending: [pending.s], messageReceipts: [], artifacts: [], turns: turn("inProgress", "Pick the smaller one.") },
  "/api/agents/r": { agent: agents[2], pending: [pending.r], messageReceipts: [], artifacts: [], turns: turn("inProgress", "Choose a fruit.") },
  "/api/agents/o": { agent: agents[3], pending: [pending.o], messageReceipts: [], artifacts: [], turns: turn("inProgress", "Choose a fruit.") },
  "/api/agents/s/codex/usage": usage, "/api/agents/s/codex/mcp": mcp,
  "/api/agents/m/claude/mcp-status": claudeMcp, "/api/agents/r/claude/mcp-status": claudeMcp,
  "/api/agents/r/claude/auto-continue": views.none,
  ...Object.fromEntries(["m", "s", "r", "o"].map((id) => [`/api/agents/${id}/conversation/inputs`, noConversationInputs])),
  "/api/backlog": { observedAt: "2026-11-04T00:00:00Z", agents: {} },
  "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
  "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const NOTICE = "/api/agents/m/claude/auto-continue";
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Serves one page: `state.notice` is Mika's view now, and the notice's actions are answered after `state.late` ms. */
function server(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname.startsWith("/api/")) {
      if (/^\/api\/agents\/[msro]\/reading$/.test(url.pathname)) {
        if (method === "GET") return route.fulfill({ json: { handoff: null } });
        report.readingSaves.push(url.pathname);
        return route.fulfill({ json: { accepted: true, sourceSeq: 0 } });
      }
      if (method === "POST" && url.pathname === "/api/collaboration/github_repositories")
        return route.fulfill({ json: { repositories: [], links: [] } });
      if (url.pathname === NOTICE && method === "GET") return route.fulfill({ json: state.notice });
      if (method === "POST" && [NOTICE, `${NOTICE}/cancel`, `${NOTICE}/now`].includes(url.pathname)) {
        state.actions.push(`${url.pathname.slice(NOTICE.length) || "/"} ${request.postData()}`);
        await wait(state.late);
        if (state.refuse) return route.fulfill({ status: 409, json: { error: "Core refused: the continue changed meanwhile." } });
        state.notice = views[state.answer];
        return route.fulfill({ json: state.notice });
      }
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
  };
}

/** Where focus is, in words a row can test. */
function focusNow() {
  const a = document.activeElement;
  return {
    body: !a || a === document.body,
    notice: !!a?.matches(".quota-resume-notice"),
    card: a?.matches(".pending-card") ? a.id : null,
    button: a?.tagName === "BUTTON" ? a.textContent.trim() : null,
    composer: !!a?.matches("[data-composer-input]"),
    what: a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}${a.className && typeof a.className === "string" ? `.${a.className.trim().split(/\s+/).join(".")}` : ""}` : null,
  };
}
/** Where an element is in the window, and the conversation's scroll. */
function placeOf(selector) {
  const el = document.querySelector(selector);
  const r = el?.getBoundingClientRect();
  const scroller = document.querySelector(".main-panel .conversation-scroll");
  return { top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null, height: innerHeight,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null };
}
const inView = (p) => p.top !== null && p.bottom > 0 && p.top < p.height;

const browser = await launchBrowser();
const runs = [
  { tag: "desktop", width: 1280, height: 860, touch: false },
  { tag: "phone", width: 390, height: 844, touch: true },
];
const inputs = ["pointer", "Enter"];
const noticeCases = [
  { tag: "Don't continue", start: "waiting", button: "Don’t continue automatically", answer: "cancelled", action: "/cancel",
    shows: (n) => n.getByText("Automatic continue was cancelled", { exact: false }) },
  { tag: "Continue now", start: "waiting", button: "Continue now", answer: "sending", action: "/now",
    shows: (n) => n.getByText("Continuing after Claude’s usage limit reset", { exact: false }) },
  { tag: "Continue automatically after the reset", start: "off", button: "Continue automatically after the reset", answer: "waiting", action: "/",
    shows: (n) => n.getByRole("button", { name: "Continue now", exact: true }) },
  { tag: "refused", start: "waiting", button: "Don’t continue automatically", refuse: true, action: "/cancel",
    shows: (n) => n.getByRole("alert") },
  { tag: "composer meanwhile", start: "waiting", button: "Don’t continue automatically", answer: "cancelled", action: "/cancel", composer: true,
    shows: (n) => n.getByText("Automatic continue was cancelled", { exact: false }) },
];
const cards = [
  { tag: "a Codex question", agent: "s", name: "Sora" },
  { tag: "a Claude question", agent: "r", name: "Rin" },
  { tag: "an OpenCode question", agent: "o", name: "Ao" },
];

/** A fresh page on `name`'s conversation. */
async function open(run, state, name) {
  const context = await browser.newContext({ viewport: { width: run.width, height: run.height }, hasTouch: run.touch, isMobile: run.touch });
  const page = await context.newPage();
  await page.addInitScript(({ key, saved }) => {
    // The event stream, spoken for Core by this check: a fresh one starts with `reset`.
    let id = 0;
    window.EventSource = class {
      constructor() {
        this.readyState = 0;
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
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem(key, saved);
  }, { key: `yuzuno.request-drafts.v1:${JSON.stringify([WORKSPACE])}`, saved: JSON.stringify(drafts) });
  page.on("pageerror", (error) => report.errors.push(`${run.tag} ${name}: ${error.message}`));
  await page.route("http://yuzuno-focus.test/**", server(state));
  await page.goto("http://yuzuno-focus.test/");
  const composer = page.locator(`[data-composer-input][aria-label="Message ${name}"]`);
  if (!(await composer.isVisible().catch(() => false))) {
    if (run.touch && !(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
    await page.locator(`.agent-row .agent-select[aria-label="Open ${name}"]`).click();
  }
  await composer.waitFor();
  return { context, page, composer };
}
/** A click (a tap on a phone), or Enter on the button once it has focus. */
async function press(run, input, button) {
  if (input === "Enter") {
    await button.focus();
    await button.press("Enter");
  } else if (run.touch) await button.tap();
  else await button.click();
}
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));

try {
  for (const run of runs) for (const input of inputs) {
    const how = `${run.tag}, ${input === "Enter" ? "Enter" : run.touch ? "a tap" : "a click"}`;
    for (const c of noticeCases) {
      const state = { notice: views[c.start], answer: c.answer, refuse: !!c.refuse, late: 300, actions: [] };
      const { context, page, composer } = await open(run, state, "Mika");
      const name = `${how}: ${c.tag}`;
      try {
        const notice = page.locator(".main-panel .quota-resume-notice");
        const button = notice.getByRole("button", { name: c.button, exact: true });
        await button.waitFor();
        const before = await page.evaluate(placeOf, ".main-panel .quota-resume-notice");
        await press(run, input, button);
        await page.waitForTimeout(100);
        // While Core's answer is on its way the pressed button is disabled: where focus is then.
        const meanwhile = await page.evaluate(focusNow);
        if (c.composer) await composer.focus();
        await c.shows(notice).waitFor();
        await settle(page);
        const after = await page.evaluate(focusNow);
        const place = await page.evaluate(placeOf, ".main-panel .quota-resume-notice");
        const left = await notice.getByRole("button").allTextContents();
        report.cases[name] = { before, meanwhile, after, place, left, actions: state.actions };
        const detail = { meanwhile, after, left, actions: state.actions };
        ok(`${name}: Core was asked once, and its answer shows`, state.actions.length === 1 && state.actions[0].startsWith(c.action), detail);
        if (c.composer) ok(`${name}: focus stays in the composer the person went to`, after.composer, detail);
        else if (c.refuse) ok(`${name}: the buttons stay, and focus is not on the page`, left.includes(c.button) && !after.body, detail);
        else if (c.answer === "waiting")
          ok(`${name}: focus is on the notice, not on Continue now`, after.notice && after.button === null, detail);
        else ok(`${name}: focus is on the notice`, after.notice, detail);
        ok(`${name}: the notice is still in view`, inView(place), { before, place });
      } catch (error) {
        ok(`${name}: the sequence ran to its end`, false, String(error?.message ?? error).slice(0, 400));
      }
      await context.close();
    }
    for (const c of cards) {
      const state = { notice: views.none, late: 0, actions: [] };
      const { context, page } = await open(run, state, c.name);
      const name = `${how}: Answer again on ${c.tag}`;
      const id = `request-${pending[c.agent].id}`;
      try {
        const card = page.locator(`#${id}`);
        const again = card.getByRole("button", { name: "Answer again", exact: true });
        const send = card.getByRole("button", { name: "Send answer", exact: true });
        await again.waitFor();
        const closed = { noReply: /No reply from Core within 60 seconds/.test(await card.textContent()), sendDisabled: await send.isDisabled() };
        const before = await page.evaluate(placeOf, `#${id}`);
        await press(run, input, again);
        await again.waitFor({ state: "detached" });
        await settle(page);
        const after = await page.evaluate(focusNow);
        const place = await page.evaluate(placeOf, `#${id}`);
        const reopened = { sendDisabled: await send.isDisabled() };
        report.cases[name] = { closed, before, after, place, reopened };
        ok(`${name}: the card opened closed, saying the answer got no reply`, closed.noReply && closed.sendDisabled, closed);
        ok(`${name}: focus is on that card`, after.card === id, after);
        ok(`${name}: its answer can be sent again, and nothing was sent`, !reopened.sendDisabled && report.writes.length === 0, { reopened, writes: report.writes });
        ok(`${name}: the card is still in view`, inView(place), { before, place });
      } catch (error) {
        ok(`${name}: the sequence ran to its end`, false, String(error?.message ?? error).slice(0, 400));
      }
      await context.close();
    }
  }
  ok("no page errors", report.errors.length === 0, report.errors);
  ok("writes: none but the notice's actions and the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
} finally {
  await browser.close();
  report.unknownGets = [...new Set(report.unknownGets)];
  await writeFile(resolve(output, "focus-after-answer-check.json"), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
