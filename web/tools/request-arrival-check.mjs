// YN-226 in a browser, every API answered here (no Core, no daily configuration), through the production build, on a
// Project's page: what the user types in the dock's composer lands as its request's block, once.
//  - The send button turns ready once as the draft first has words, and stays so while the user writes on and while
//    an input method composes (Chromium only: its IME events); Return presses it.
//  - While the words go nothing lands; the field takes more words at its own contrast, and the focus stays in it.
//    Under reduced motion "Sending…" says so where the spinner stands still.
//  - Core's answer draws the new block at once, in its place: it arrives from below with its gap opening (one
//    animation of its opacity and one of its height), its edge in the send button's colour, which goes after settle.
//    A follow-up only marks its request's block; one not in sight (scrolled past, the conversation shown, a phone's
//    keyboard) says where it went above the composer and marks the block once it comes into sight; Show lands on it.
//  - Out of order, on the page itself: a read that lists the request before Core's answer, a read that started before
//    Core kept it and answers after, the same client ID sent again after a lost answer, and an answer without the
//    whole request: each one block, never taken off the page, marked once, arrived at most once.
//  - A send that fails lands nothing and keeps the draft; Core keeps one it did not deliver: its block says so.
//  - Reading the page again lands nothing; under reduced motion nothing moves and the mark is a still edge; a
//    focused control in a marked block keeps its own outline.
// The phone's keyboard is simulated: the window is shortened as the shell is (keyboard-viewport.ts), not a device's.
// Frames: the arrival paused at each time (frames/); with YUZUNO_ARRIVAL_VIDEO=1 also a recording of the page.
// With YUZUNO_WEBKIT_WS it runs in Playwright's Linux WebKit instead (browser-engine.mjs). Linux WebKit is not iOS.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/request-arrival-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { engine, launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
const frames = join(output, "frames");
await mkdir(frames, { recursive: true });
const report = { task: "YN-226", engine, keyboard: "simulated (window shortened)", runs: [], unexpected: [], errors: [], console: [] };
const HOST = "localhost:47399";
const PROJECT = "p-next";
const NOW = Date.now();
const at = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Synthetic names and words.
const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/next", projectId: PROJECT,
};
const agents = [{ ...base, id: "lead", name: "Dev Lead", kind: "lead" }];
const projects = [{ id: PROJECT, name: "yuzuno-next", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const lead = { agentId: "lead", name: "Dev Lead", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const overview = {
  id: 904, key: "development", kind: "status", title: "开发状态", version: 12, owner: lead, updatedAt: at(75), updatedTurnId: "t",
  body: { root: "body", elements: { body: node("BriefBody", {}, ["a"]), a: node("Markdown", { text: "开发状态。" }) } },
  attachments: [], refs: {}, seen: null, history: false, status: { asOf: at(75), validFor: 86_400, stale: false },
};
const TOPICS = ["首页底部间距", "Jobs 分步计量", "Codex 收件标签", "导航栏布局", "发布说明", "备份提速", "日志折叠", "设置搜索", "图片预览", "主题切换"];
/** A request Core keeps: delivered, waiting for the front desk (In progress), unless said otherwise. */
const keptRequest = (n, text, minutes, extra = {}) => ({
  id: `req-${n}`, n, text, textBlocks: null, images: [], files: [], title: extra.title ?? null, createdAt: at(minutes), frontAgentId: "lead",
  messageId: `m${n}`, delivery: "accepted", replies: [], notes: [], routes: [], cards: [], state: "waiting",
  progress: { cards: 0, ended: 0 }, lines: [], ...extra,
});
const firstRequests = () => TOPICS.map((title, i) => keptRequest(20 - i, `${title}，看一下。`, 60 + i * 90, { title }));

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { recorded: (n) => `Recorded as R-${n}`, undelivered: (n) => `Recorded as R-${n} · not confirmed delivered`, added: (n) => `Added to R-${n}`,
    show: "Show", sending: "Sending…", follow: "Follow up", unconfirmed: "Not confirmed delivered", chat: "Conversation" },
  "zh-Hans": { recorded: (n) => `已记下为 R-${n}`, undelivered: (n) => `已记下为 R-${n} · 没确认送达`, added: (n) => `已追加到 R-${n}`,
    show: "查看", sending: "发送中…", follow: "追问", unconfirmed: "没确认送达", chat: "对话" },
};
const SAID = { en: ["Tidy last week's release notes into one page", "Also the phone's bottom spacing"], "zh-Hans": ["把上周的发布说明整理成一页", "顺便看一下手机底部的间距"] };

const browser = await launchBrowser();
const runs = [
  { name: "en-1440", viewport: { width: 1440, height: 900 }, language: "en", motion: "no-preference" },
  { name: "en-1440-reduced", viewport: { width: 1440, height: 900 }, language: "en", motion: "reduce" },
  { name: "zh-390", viewport: { width: 390, height: 844 }, language: "zh-Hans", motion: "no-preference", phone: true },
];
try {
  for (const run of runs) await check(run);
  if (process.env.YUZUNO_ARRIVAL_VIDEO === "1") await recording();
} finally {
  await browser.close();
  await writeFile(join(output, "request-arrival-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`request-arrival-check (${engine}): ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

/** A context answering for Core, with what the page did to blocks recorded from the document's start. */
async function stage(run, contextOptions = {}) {
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    reducedMotion: run.motion,
    ...(run.phone ? { isMobile: engine === "chromium", hasTouch: true } : {}),
    ...contextOptions,
  });
  await context.addInitScript((language) => {
    if (window !== window.top || location.protocol === "about:") return;
    // Core's live changes, open and quiet (no polls): __announce sends what Core sends once it keeps a request
    // (project_requests.rs announce), and Home reads the requests again.
    window.EventSource = class {
      constructor() {
        window.__stream = this;
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: "resumed" }), lastEventId: "" });
        }, 0);
      }
      addEventListener() {}
      close() {}
    };
    window.__announce = () =>
      window.__stream?.onmessage?.({ data: JSON.stringify({ type: "workspace.changed", scope: "requests", projectId: "p-next" }), lastEventId: "" });
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    // What happened to each block and to the words in the conversation: drawn, taken off, marked, animated.
    const seen = { added: {}, removed: {}, marks: [], animations: [], states: [], css: [] };
    window.__seen = seen;
    document.addEventListener("animationstart", (event) => seen.css.push(event.animationName), true);
    const id = (el) => el?.dataset?.requestBlock ?? (el?.dataset?.words ? `w${el.dataset.words}` : el?.dataset?.reply ? `f${el.dataset.reply}` : null);
    const blocks = (el) => (el.nodeType === 1 ? [el, ...el.querySelectorAll("[data-request-block]")].filter((b) => b.dataset.requestBlock) : []);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const el of record.addedNodes) for (const b of blocks(el)) seen.added[b.dataset.requestBlock] = (seen.added[b.dataset.requestBlock] ?? 0) + 1;
          for (const el of record.removedNodes) for (const b of blocks(el)) seen.removed[b.dataset.requestBlock] = (seen.removed[b.dataset.requestBlock] ?? 0) + 1;
        } else if (record.attributeName === "data-arriving" && record.target.hasAttribute("data-arriving")) {
          seen.marks.push(id(record.target));
        } else if (record.attributeName === "data-state" && record.target.matches?.(".project-talk-compose")) {
          seen.states.push(record.target.dataset.state);
        }
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-arriving", "data-state"] });
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const who = id(this);
      if (who) seen.animations.push({ who, properties: Object.keys(keyframes?.[0] ?? {}).sort().join(","), duration: options?.duration ?? null });
      return animate.call(this, keyframes, options);
    };
  }, run.language);
  // Core as this check plays it: the requests it keeps, how it answers a send, and reads it holds.
  const state = { requests: firstRequests(), next: 21, post: "ok", postDelay: 300, holdRead: null, stale: null, posts: [], reads: 0 };
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") return route.fulfill({ json: { workspace: { id: "ws-arrival" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    if (path === "/api/home") return route.fulfill({ json: { generatedAt: at(0), order: [PROJECT], needsYou: [], projects: [{
      project: { id: PROJECT, name: "yuzuno-next" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      contentEditors: { version: 1, editorAgentIds: ["lead"] }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
      brief: { version: 1, sections: [overview], history: [] } }] } });
    if (path === `/api/projects/${PROJECT}/front-desk`) return route.fulfill({ json: { version: 1, agentId: "lead", effectiveAgentId: "lead" } });
    if (path === `/api/projects/${PROJECT}/requests` && method === "GET") {
      state.reads += 1;
      // A read held (YN-226 order): it answers, when let go, with the requests as they were before the send.
      if (state.holdRead) {
        const { gate, list } = state.holdRead;
        state.holdRead = null;
        await gate;
        return route.fulfill({ json: { requests: list, hasMore: false } }).catch(() => {});
      }
      return route.fulfill({ json: { requests: state.requests, hasMore: false } });
    }
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w+\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      const sent = JSON.parse(request.postData() || "{}");
      state.posts.push({ path, text: sent.text, clientMessageId: sent.clientMessageId });
      const receipt = { input: { text: sent.text, clientMessageId: sent.clientMessageId }, status: state.post === "undelivered" ? "uncertain" : "accepted", turnId: "t2", error: null };
      if (path === `/api/projects/${PROJECT}/requests`) {
        if (state.post === "refuse") {
          await sleep(state.postDelay);
          return route.fulfill({ status: 503, json: { error: "core_busy: try again" } });
        }
        // Kept at once, as project_requests.rs keeps it before sending it on, and listed from then on.
        let made = state.requests.find((r) => r.messageId === sent.clientMessageId);
        if (!made) {
          made = keptRequest(state.next++, sent.text, 0, { messageId: sent.clientMessageId, delivery: receipt.status, createdAt: new Date().toISOString() });
          state.requests = [made, ...state.requests];
        }
        await sleep(state.postDelay);
        // The answer lost on its way (the same client ID is sent again next).
        if (state.post === "lose") {
          state.post = "ok";
          return route.abort("failed");
        }
        return route.fulfill({ json: { request: state.post === "short" ? { n: made.n } : made, receipt } });
      }
      const follow = path.match(new RegExp(`^/api/projects/${PROJECT}/requests/(\\d+)/replies$`));
      if (follow) {
        const target = state.requests.find((r) => r.n === Number(follow[1]));
        let reply = target.replies.find((r) => r.messageId === sent.clientMessageId);
        if (!reply) {
          reply = { n: target.replies.length + 1, text: sent.text, textBlocks: null, images: [], files: [], at: new Date().toISOString(),
            messageId: sent.clientMessageId, deliveredTo: [{ agentId: "lead", delivery: "accepted" }] };
          target.replies = [...target.replies, reply];
        }
        await sleep(state.postDelay);
        return route.fulfill({ json: { reply, receipts: [receipt] } });
      }
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    // An Agent's own reads a live page makes (Codex usage, MCP, kept inputs): not in this fixture, as brief-tabs-check
    // answers them; an empty object would not be one of their answers.
    if (/^\/api\/agents\/\w+\/(codex\/usage|codex\/mcp|conversation\/inputs)$/.test(path))
      return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": { at: at(0), cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null }, gpus: null, jobs: [] },
      "/api/machine-live": { machines: [] },
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  // What the page said went wrong, kept to tell a failed step's cause (an error boundary catches render errors).
  page.on("console", (message) => {
    if (message.type() === "error") report.console.push(`${run.name}: ${message.text()}`);
  });
  return { context, page, state };
}

/** The page's own words and controls, as the user meets them. */
function driver(page, state, run) {
  const w = words[run.language];
  const open = async () => {
    Object.assign(state, { requests: firstRequests(), next: 21, post: "ok", postDelay: 300, holdRead: null, posts: [] });
    const url = `http://${HOST}/#/home?w=ws-arrival&p=${PROJECT}`;
    // Each step from a clean page: no draft, no words kept for a retry, the Requests view (the language comes back with
    // the page's own start).
    if (page.url() === url) {
      await page.evaluate(() => localStorage.clear());
      await page.reload();
    } else await page.goto(url);
    await page.locator('[data-request-block="20"]').waitFor({ timeout: 15_000 });
    await page.locator(".home-dock .project-talk-compose").waitFor();
    await page.evaluate(() => {
      Object.assign(window.__seen, { added: {}, removed: {}, marks: [], animations: [], states: [], css: [] });
    });
  };
  const field = page.locator(".home-dock [data-composer-input]");
  const form = page.locator(".home-dock .project-talk-compose");
  const seen = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__seen)));
  const say = async (text) => {
    await field.click();
    await page.keyboard.type(text);
  };
  // Return sends on a computer; on a touch screen Return is a new line and the user taps Send (device-preferences.ts).
  const send = () => (run.phone ? page.locator(".home-dock .project-talk-send").tap() : page.keyboard.press("Enter"));
  const landed = (n, timeout = 5000) => page.waitForFunction((n) => window.__seen.marks.includes(String(n)) || document.querySelector(".project-talk-notice")?.textContent.includes(`R-${n}`), n, { timeout });
  const idle = () => page.waitForFunction(() => document.querySelector(".home-dock .project-talk-compose")?.dataset.state !== "sending", null, { timeout: 8000 });
  const text = () => field.evaluate((el) => el.textContent);
  const notice = () => page.evaluate(() => document.querySelector(".project-talk-notice-text")?.textContent ?? "");
  const facts = (n) => page.evaluate((n) => {
    const block = document.querySelector(`[data-request-block="${n}"]`);
    return block && {
      group: block.closest(".request-group")?.dataset.group ?? null,
      fact: block.querySelector(".request-block-fact-line")?.textContent.trim() ?? "",
      count: document.querySelectorAll(`[data-request-block="${n}"]`).length,
      marked: block.hasAttribute("data-arriving"),
      first: block === block.parentElement.querySelector("[data-request-block]"),
    };
  }, n);
  const entrances = (all, who) => all.animations.filter((a) => a.who === String(who));
  return { w, open, field, form, seen, say, send, landed, idle, text, notice, facts, entrances };
}

async function check(run) {
  const result = { run: run.name, checks: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${engine} ${run.name}] ${name}`);
  };
  const { context, page, state } = await stage(run);
  const d = driver(page, state, run);
  const reduced = run.motion === "reduce";
  const said = SAID[run.language];
  try {
    // 1. Ready once; Return presses; nothing lands while the words go; the field takes more at its contrast.
    await d.open();
    state.postDelay = 1500;
    await d.say(said[0]);
    assert.deepEqual((await d.seen()).states, ["ready"], "ready once, however many keys");
    if (engine === "chromium" && !run.phone) {
      // An input method composing after the words: the state does not change while it does.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
      await cdp.send("Input.imeSetComposition", { text: "nih", selectionStart: 3, selectionEnd: 3 });
      await cdp.send("Input.insertText", { text: "你好" });
      for (let i = 0; i < 2; i++) await page.keyboard.press("Backspace");
      assert.deepEqual((await d.seen()).states, ["ready"], "still ready while the input method composes");
      pass("the send button turns ready once and stays so while an input method composes");
    }
    await d.send();
    await page.waitForFunction(() => document.querySelector(".home-dock .project-talk-compose").dataset.state === "sending");
    const pressed = (await d.seen()).css.filter((name) => name === "talk-send-press");
    assert.deepEqual(pressed, reduced ? [] : ["talk-send-press"], "Return (or a tap) presses the button");
    const sending = await page.evaluate(() => {
      const slot = document.querySelector(".home-dock .project-talk-arrival");
      const pill = slot.querySelector(".project-talk-notice");
      return { shown: !!pill && getComputedStyle(pill).display !== "none", text: slot.textContent, opacity: getComputedStyle(document.querySelector(".home-dock .home-composer")).opacity };
    });
    assert.equal(sending.shown, reduced, reduced ? "Sending… said where the spinner stands still" : "the spinner says it");
    assert.equal(sending.text, d.w.sending);
    assert.equal(sending.opacity, "1", "the draft keeps its contrast");
    // Back in the field (a tap on Send leaves it on a touch screen), at its end.
    await d.field.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(run.language === "en" ? " and the logo" : "，还有图标");
    const meanwhile = await d.seen();
    assert.deepEqual(meanwhile.marks, [], "nothing lands while the words go");
    assert.ok(!(await d.facts(21)), "no block before Core answers");
    pass("Return presses Send; while the words go nothing lands and the field takes more", { reduced });

    // 2. Core's answer: R-21 drawn at once in its place, arrived once, marked once; the words sent leave the field,
    // those written meanwhile stay, with the focus.
    await d.landed(21);
    const arrived = await d.facts(21);
    assert.deepEqual([arrived.group, arrived.count, arrived.first, arrived.marked], ["doing", 1, true, true]);
    const all = await d.seen();
    assert.deepEqual(all.marks, ["21"]);
    const motion = d.entrances(all, 21).map((a) => `${a.properties}:${a.duration}`).sort();
    assert.deepEqual(motion, reduced ? [] : ["height,marginTop:240", "opacity,transform:310"], "risen 8px and its gap opened, or nothing under reduced motion");
    assert.equal(await d.notice(), "", "in sight: no notice");
    await d.idle();
    assert.equal((await d.text()).trim(), run.language === "en" ? "and the logo" : "，还有图标", "the words written meanwhile stay");
    assert.ok(await page.evaluate(() => document.querySelector(".home-dock .project-talk-field").contains(document.activeElement)), "the focus stays in the field");
    const edge = await page.evaluate(() => {
      const block = document.querySelector('[data-request-block="21"]');
      const probe = document.createElement("div");
      probe.style.color = "var(--home-arrival)";
      block.append(probe);
      const arrival = getComputedStyle(probe).color;
      probe.remove();
      return { border: getComputedStyle(block).borderTopColor, shadow: getComputedStyle(block).boxShadow, arrival };
    });
    if (reduced) assert.equal(edge.border, edge.arrival, "a still edge in the send button's colour");
    assert.equal(edge.shadow, "none", "an edge, not a ring");
    // A focused control in the marked block keeps its own outline.
    await page.locator('[data-request-block="21"] .request-block-title').focus();
    const outline = await page.evaluate(() => {
      const title = document.activeElement;
      return { style: getComputedStyle(title).outlineStyle, width: getComputedStyle(title).outlineWidth, color: getComputedStyle(title).outlineColor };
    });
    assert.notEqual(outline.style, "none", "the title's focus outline shows");
    assert.notEqual(outline.color, edge.arrival, "another colour than the mark");
    await page.waitForFunction(() => !document.querySelector("[data-arriving]"), null, { timeout: 4000 });
    pass("Core's answer draws R-21 at once in its place; it arrives once, its edge marked, then goes", { motion, edge, outline });
    if (!reduced && !run.phone) await framesOf(page, run);

    // 3. A follow-up marks its request only; the next new request arrives on its own, the first left as it was.
    await d.open();
    await page.locator('[data-request-block="20"] .request-block-action[data-action="follow"]').click();
    await d.say(said[1]);
    await d.send();
    await d.landed(20);
    await d.idle();
    let now = await d.seen();
    assert.deepEqual(now.marks, ["20"]);
    assert.deepEqual(d.entrances(now, 20), [], "a follow-up moves nothing");
    assert.equal(await d.notice(), "");
    await d.say(said[0]);
    await d.send();
    await d.landed(21);
    await d.idle();
    await d.say(said[1]);
    await d.send();
    await d.landed(22);
    await d.idle();
    now = await d.seen();
    assert.deepEqual(now.marks, ["20", "21", "22"], "each once");
    assert.equal(d.entrances(now, 21).length, reduced ? 0 : 2);
    assert.equal(d.entrances(now, 22).length, reduced ? 0 : 2);
    assert.deepEqual([now.removed["21"] ?? 0, now.removed["22"] ?? 0], [0, 0], "never taken off");
    pass("a follow-up only marks its request; two sends in a row arrive once each");

    // 4. Not in sight: the notice says where it went, marks the block once it is in sight; Show lands on it.
    await d.open();
    await page.evaluate(() => {
      const view = document.querySelector(".home-view");
      view.scrollTop = view.scrollHeight;
    });
    await d.say(said[0]);
    await d.send();
    await d.landed(21);
    await d.idle();
    assert.equal(await d.notice(), d.w.recorded(21));
    now = await d.seen();
    assert.deepEqual([now.marks, d.entrances(now, 21)], [[], []], "nothing plays out of sight");
    assert.ok(!(await page.evaluate(() => document.querySelector(".project-talk-notice")?.contains(document.activeElement))), "no focus taken");
    if (run.phone) await shot(page, run, "out-of-sight-notice");
    await page.evaluate(() => {
      document.querySelector(".home-view").scrollTop = 0;
    });
    await page.waitForFunction(() => window.__seen.marks.includes("21"), null, { timeout: 4000 });
    assert.equal(await d.notice(), "", "the notice goes once the block is in sight");
    pass("out of sight, the notice says where it went; scrolled into sight, the block is marked once");

    // 5. In the conversation: its words arrive, the notice says where the request is, Show lands on its block.
    await d.open();
    await page.locator('.project-view-tabs [data-tab="chat"]').click();
    await d.say(said[0]);
    await d.send();
    await d.landed(21);
    await d.idle();
    await page.waitForFunction(() => window.__seen.marks.includes("w21"), null, { timeout: 4000 });
    now = await d.seen();
    assert.deepEqual(d.entrances(now, "w21").map((a) => a.properties), reduced ? [] : ["opacity,transform"], "the words rise, no gap to open");
    assert.equal(await d.notice(), d.w.recorded(21));
    assert.equal(await page.locator('.project-view-tabs [data-tab="chat"]').getAttribute("aria-selected"), "true", "the view stays");
    await shot(page, run, "conversation-notice");
    await page.locator(".project-talk-notice .talk-link").click();
    await page.waitForFunction(() => document.querySelector('[data-request-block="21"][data-home-highlight]'), null, { timeout: 6000 });
    pass("in the conversation the words arrive; the notice's Show lands on the request's block");

    // 6. Out of order: the read lists it before Core's answer; then a read from before the send answers after it.
    await d.open();
    state.postDelay = 1200;
    await d.say(said[0]);
    await d.send();
    await page.waitForFunction(() => document.querySelector(".home-dock .project-talk-compose").dataset.state === "sending");
    await sleep(150);
    await page.evaluate(() => window.__announce());
    await page.waitForFunction(() => window.__seen.marks.includes("21"), null, { timeout: 4000 });
    assert.equal(await page.evaluate(() => document.querySelector(".home-dock .project-talk-compose").dataset.state), "sending", "listed before the answer");
    await d.idle();
    await sleep(300);
    now = await d.seen();
    assert.deepEqual([now.marks, now.removed["21"] ?? 0, (await d.facts(21)).count], [["21"], 0, 1]);
    assert.equal(d.entrances(now, 21).length, reduced ? 0 : 2, "arrived once");
    pass("a read that lists the request before Core's answer: one block, arrived once");

    await d.open();
    state.postDelay = 900;
    let letGo;
    const before = structuredClone(state.requests);
    await d.say(said[0]);
    await d.send();
    await page.waitForFunction(() => document.querySelector(".home-dock .project-talk-compose").dataset.state === "sending");
    state.holdRead = { gate: new Promise((done) => (letGo = done)), list: before };
    await page.evaluate(() => window.__announce());
    await d.landed(21);
    await d.idle();
    await sleep(400);
    letGo();
    await sleep(600);
    now = await d.seen();
    assert.deepEqual([now.marks, now.removed["21"] ?? 0, (await d.facts(21))?.count], [["21"], 0, 1], "the late read takes nothing off");
    pass("a read from before the send that answers after Core's answer: R-21 stays, arrived once");

    // 7. The answer lost, the same words sent again under the same client ID; an answer without the whole request.
    await d.open();
    state.post = "lose";
    await d.say(said[0]);
    await d.send();
    await page.locator('.home-dock .project-talk-compose [role="alert"]').waitFor();
    now = await d.seen();
    assert.deepEqual([now.marks, await d.facts(21)], [[], null], "nothing lands from a send without an answer");
    assert.equal((await d.text()).trim(), said[0], "the draft stays");
    await d.field.click();
    await d.send();
    await d.landed(21);
    await d.idle();
    assert.equal(state.posts[1].clientMessageId, state.posts[0].clientMessageId, "the same message");
    now = await d.seen();
    assert.deepEqual([now.marks, (await d.facts(21)).count, now.removed["21"] ?? 0], [["21"], 1, 0]);
    pass("the same client ID sent again after a lost answer: one R-21, arrived once");

    await d.open();
    state.post = "short";
    await d.say(said[0]);
    await d.send();
    await d.landed(21);
    await d.idle();
    now = await d.seen();
    assert.deepEqual([now.marks, (await d.facts(21)).count], [["21"], 1]);
    assert.equal(d.entrances(now, 21).length, reduced ? 0 : 2);
    pass("an answer without the whole request: the read draws it, arrived once");

    // 8. Refused: nothing lands, the draft stays. Kept, not delivered: its block says so in Needs you.
    await d.open();
    state.post = "refuse";
    await d.say(said[0]);
    await d.send();
    await page.locator('.home-dock .project-talk-compose [role="alert"]').waitFor();
    assert.deepEqual((await d.seen()).marks, []);
    assert.equal((await d.text()).trim(), said[0]);
    pass("a send Core refuses lands nothing and keeps the draft");

    await d.open();
    state.post = "undelivered";
    await d.say(said[0]);
    await d.send();
    await d.landed(21);
    const undelivered = await d.facts(21);
    assert.deepEqual([undelivered.group, undelivered.fact], ["needs", d.w.unconfirmed]);
    pass("kept but not delivered: its block arrives in Needs you, saying so");

    // 9. Reading the page again lands nothing.
    await d.open();
    const reads = state.reads;
    await page.evaluate(() => window.__announce());
    for (let i = 0; i < 40 && state.reads === reads; i++) await sleep(50);
    assert.ok(state.reads > reads, "read again");
    await sleep(500);
    now = await d.seen();
    assert.deepEqual([now.marks, now.animations.filter((a) => /^\d+$/.test(a.who))], [[], []]);
    pass("reading the page again lands nothing");

    // 10. A phone's keyboard (simulated: the window shortened): sent with the top of the page under it.
    if (run.phone) {
      await d.open();
      await d.field.click();
      await page.setViewportSize({ width: run.viewport.width, height: 470 });
      await page.evaluate(() => {
        const view = document.querySelector(".home-view");
        view.scrollTop = view.scrollHeight;
      });
      await page.keyboard.type(said[0]);
      await d.send();
      await d.landed(21);
      await d.idle();
      assert.equal(await d.notice(), d.w.recorded(21));
      // The tap left the focus on Send, as the conversation's composer does; nothing of the arrival takes it.
      const focus = await page.evaluate(() => ({
        inComposer: !!document.querySelector(".home-dock .project-talk-compose")?.contains(document.activeElement),
        inNotice: !!document.querySelector(".project-talk-notice")?.contains(document.activeElement),
      }));
      assert.deepEqual(focus, { inComposer: true, inNotice: false }, "the focus stays with the composer");
      await shot(page, run, "keyboard-notice");
      await page.setViewportSize(run.viewport);
      pass("with the keyboard up and the block out of sight, the notice above the field; the focus stays with the composer", { keyboard: "simulated" });
    }
  } catch (error) {
    await page.screenshot({ path: join(output, `${engine}-${run.name}-failed.png`) }).catch(() => {});
    for (const line of report.console.filter((entry) => entry.startsWith(`${run.name}:`))) console.error(`console ${line}`);
    throw error;
  } finally {
    await context.close();
  }
}

async function shot(page, run, name) {
  await page.screenshot({ path: join(output, `${engine}-${run.name}-${name}.png`) });
}

/** The arrival paused at each time: R-21's region, in this run's window. */
async function framesOf(page, run) {
  await page.evaluate(() => {
    window.__frozen = null;
    const watch = new MutationObserver(() => {
      if (!document.querySelector('[data-request-block="22"][data-arriving]')) return;
      watch.disconnect();
      const list = document.getAnimations().filter((a) => a.animationName !== "spin" && a.animationName !== "talk-send-press");
      for (const a of list) a.pause();
      window.__frozen = list;
    });
    watch.observe(document, { subtree: true, attributes: true, attributeFilter: ["data-arriving"] });
  });
  const field = page.locator(".home-dock [data-composer-input]");
  await field.click();
  await page.keyboard.type(SAID[run.language][1]);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__frozen, null, { timeout: 5000 });
  const set = (t) => page.evaluate((t) => { for (const a of window.__frozen) a.currentTime = t; }, t);
  await set(1200);
  const box = await page.locator('[data-request-block="22"]').boundingBox();
  const clip = { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 36), width: box.width + 32, height: box.height * 2 + 56 };
  for (const t of [0, 40, 80, 120, 160, 200, 240, 310, 500, 800, 1100, 1200]) {
    await set(t);
    await page.screenshot({ path: join(frames, `${engine}-${run.name}-${String(t).padStart(4, "0")}ms.png`), clip });
  }
  await page.evaluate(() => { for (const a of window.__frozen) a.finish(); });
}

/** A recording of the page in real time: a request, two in a row, a follow-up, one out of sight, one in the conversation. */
async function recording() {
  const run = { name: "video", viewport: { width: 1280, height: 800 }, language: "zh-Hans", motion: "no-preference" };
  const videoDir = join(output, "video");
  await mkdir(videoDir, { recursive: true });
  const { context, page, state } = await stage(run, { recordVideo: { dir: videoDir, size: run.viewport } });
  const d = driver(page, state, run);
  const said = SAID[run.language];
  const typeSlowly = async (text) => {
    await d.field.click();
    for (const ch of text) await page.keyboard.type(ch, { delay: 55 });
  };
  try {
    await d.open();
    await sleep(800);
    await typeSlowly(said[0]);
    await sleep(400);
    await d.send();
    await d.landed(21);
    await sleep(1800);
    await typeSlowly(said[1]);
    await d.send();
    await d.landed(22);
    await sleep(1600);
    await page.locator('[data-request-block="20"] .request-block-action[data-action="follow"]').click();
    await typeSlowly("加一列平均值");
    await d.send();
    await d.landed(20);
    await sleep(1800);
    await page.evaluate(() => document.querySelector(".home-view").scrollTo({ top: 1e6, behavior: "smooth" }));
    await sleep(900);
    await typeSlowly("日志折叠的默认行数调小");
    await d.send();
    await d.landed(23);
    await sleep(1500);
    await page.evaluate(() => document.querySelector(".home-view").scrollTo({ top: 0, behavior: "smooth" }));
    await sleep(2000);
    await page.locator('.project-view-tabs [data-tab="chat"]').click();
    await sleep(600);
    await typeSlowly("设置页加一个搜索框");
    await d.send();
    await d.landed(24);
    await sleep(1500);
    await page.locator(".project-talk-notice .talk-link").click();
    await sleep(2500);
    state.postDelay = 2200;
    await typeSlowly("慢网时的样子");
    await d.send();
    await d.landed(25, 8000);
    await sleep(2000);
  } finally {
    await context.close();
  }
  const [file] = (await readdir(videoDir)).filter((name) => name.endsWith(".webm"));
  await rename(join(videoDir, file), join(output, `${engine}-request-arrival.webm`));
  report.video = `${engine}-request-arrival.webm`;
}
