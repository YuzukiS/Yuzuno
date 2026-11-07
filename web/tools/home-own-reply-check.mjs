// YN-21 in Chromium, every API answered here (no Core, no daily configuration), through the production build, at
// 1440 px and a phone (390 px), in English and in Simplified Chinese, light and dark, and twice under reduced motion:
//  - the user answers an open Ask on Home by an option: as soon as Core has the reply (answered here as Core does,
//    the ask marked replied before the receipt), the card is the small answer card, with no height held for the card
//    it was and no blank area; it collapsed to it (one height animation on the card; none under reduced motion); the
//    card below moved up; focus is on the card; its place on the deck is kept;
//  - its height is within 3 px of the same answer card at a fresh visit (a reload), at the same width;
//  - Reply again, sent, closes the opened card back to its answer card, the new reply on it, again with no blank;
//  - nothing is wider than the window, and nothing is sent but reads and those two replies.
// Before and after pictures of the deck go to the output directory, with SHA256SUMS.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-own-reply-check.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-21", runs: [], replies: [], posts: [], unexpected: [], errors: [] };
// A secure origin, as Core's own: a reply needs crypto.randomUUID. Every request is answered here.
const HOST = "localhost:47393";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = { harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/orchard", projectId: "p-orch" };
const agents = [{ ...base, id: "l", name: "lead-1" }, { ...base, id: "r", name: "runner-3" }];
const projects = [{ id: "p-orch", name: "orchard-sim", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "lead-1", state: "active" };
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (props, top, elements) => ({ root: "body", elements: { body: node("BriefBody", props, top), ...elements } });
const text = {
  en: {
    title: "Run the 7B baseline overnight?", question: "Run the 7B baseline overnight, on the free queue after 22:00?",
    body: ["The queue is free after 22:00 and the shard rebuild finished this afternoon.",
      "A full run takes about six hours on four GPUs; the eval set is the one from last week, so the numbers compare.",
      "If it waits, the next free slot is Thursday night."],
    // Long enough to wrap where the card is one column wide, not where it spans its row.
    yes: "Yes", no: "Not tonight", again: "Run it, but stop at 40k steps and keep the checkpoint; I will look at the curve in the morning.",
    plan: "Which tokenizer plan?", planQuestion: "Plan A or plan B for the rebuild?",
    replied: "Replied · waiting for lead-1", next: "Next: lead-1 acts on your reply", replyAgain: "Reply again", send: "Send",
  },
  "zh-Hans": {
    title: "今晚跑 7B 基线吗？", question: "今晚 22:00 之后队列空闲时跑 7B 基线吗？",
    body: ["22:00 之后队列空闲，分片重建今天下午已经完成。", "完整跑一次在四张 GPU 上大约六小时；评测集用上周那套，结果可以对比。", "如果不跑，下一个空档是周四晚上。"],
    yes: "跑", no: "今晚不跑", again: "跑，但到 40k 步就停，保留检查点；我明早看完曲线再决定要不要接着把它跑完。",
    plan: "分词器用哪个方案？", planQuestion: "重建用方案 A 还是方案 B？",
    replied: "已回复 · 等 lead-1 处理", next: "下一步：lead-1 按你的回复处理", replyAgain: "再次回复", send: "发送",
  },
};
let id = 300;
const section = (key, kind, title, body, extra = {}) => ({ id: id++, key, kind, title, version: 2, owner, updatedAt: at(30),
  updatedTurnId: "t1", body, attachments: [], refs: {}, seen: null, history: false, ...extra });
// One Workspace's Home, as Core holds it for one run: the Ask the user answers, then another open Ask (a full row
// below it), a status and two reports.
function fixture(language) {
  const w = text[language];
  const sections = [
    section("overnight", "ask", w.title, spec({}, ["a", "b", "c"], { a: md(w.body[0]), b: md(w.body[1]), c: md(w.body[2]) }), {
      ask: { question: w.question, state: "open", reply: { options: [{ id: "yes", label: w.yes }, { id: "no", label: w.no }], freeText: true } },
    }),
    section("plan", "ask", w.plan, spec({}, ["q"], { q: md("A: keep the old vocabulary. B: the new one.") }), {
      ask: { question: w.planQuestion, state: "open", reply: { freeText: true } },
    }),
    section("release", "status", "Release train", spec({ summary: { lead: "lead", visual: "m", size: "wide" } }, ["lead", "m"], {
      lead: md("Two changes wait for main; main CI is green."),
      m: node("Metrics", { items: [{ label: "Waiting", value: 2, unit: "PRs" }, { label: "main CI", value: "green" }, { label: "Queue", value: 1 }] }),
    }), { status: { asOf: at(20), validFor: 86400, stale: false } }),
    section("notes", "report", "Field notes", spec({}, ["a"], { a: md("The tokenizer drops one character in 0.02 % of lines; the fix lands with the next shard rebuild.") })),
    section("eval", "report", "Eval summary", spec({ summary: { lead: "lead", size: "small" } }, ["lead"], { lead: md("Accuracy 71.4 % on the held-out set, up 0.6 points.") })),
  ];
  const state = {
    sections,
    needsYou: [
      { kind: "ask", projectId: "p-orch", agentId: "l", agentName: "lead-1", sectionKey: "overnight", title: w.title, since: at(30) },
      { kind: "ask", projectId: "p-orch", agentId: "l", agentName: "lead-1", sectionKey: "plan", title: w.plan, since: at(30) },
    ],
  };
  // As Core: the reply marks that version of the ask replied before its receipt (home.rs mark_replied).
  state.reply = (body) => {
    const s = sections.find((entry) => entry.key === body.key);
    if (!s?.ask || s.version !== body.askVersion) return;
    const label = s.ask.reply.options?.find((option) => option.id === body.choice)?.label;
    s.ask = { ...s.ask, state: "replied", repliedAt: new Date().toISOString(), replyText: label && body.text ? `${label}: ${body.text}` : label ?? body.text };
    state.needsYou = state.needsYou.filter((item) => item.sectionKey !== body.key);
  };
  state.home = () => ({
    generatedAt: at(0), order: ["p-orch"], needsYou: state.needsYou,
    projects: [{ project: { id: "p-orch", name: "orchard-sim" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
      errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
  });
  return state;
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const theme of ["light", "dark"])
    for (const [width, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["phone-390", { width: 390, height: 844 }, true]])
      runs.push({ name: `${language}-${theme}-${width}`, language, theme, phone, viewport, reduced: false });
runs.push({ name: "en-light-1440-reduced", language: "en", theme: "light", phone: false, viewport: { width: 1440, height: 1000 }, reduced: true });
runs.push({ name: "zh-Hans-dark-phone-390-reduced", language: "zh-Hans", theme: "dark", phone: true, viewport: { width: 390, height: 844 }, reduced: true });
let failure = null;
try {
  for (const run of runs) await check(run);
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await writeFile(join(output, "home-own-reply-check.json"), `${JSON.stringify(report, null, 2)}\n`);
  const files = (await readdir(output)).filter((name) => name !== "SHA256SUMS").sort();
  const sums = await Promise.all(files.map(async (name) => `${createHash("sha256").update(await readFile(join(output, name))).digest("hex")}  ${name}`));
  await writeFile(join(output, "SHA256SUMS"), `${sums.join("\n")}\n`);
}
if (failure) throw failure;
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads and the replies");
assert.deepEqual(report.replies.map((r) => r.run), runs.flatMap((r) => [r.name, r.name]), "two replies in each run");
console.log(`home-own-reply-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [], measured: {} };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = text[run.language];
  const state = fixture(run.language);
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC", colorScheme: run.theme,
    reducedMotion: run.reduced ? "reduce" : "no-preference",
    ...(run.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addInitScript(([language, theme]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    if (!localStorage.getItem("yuzuno.selected.ws-own")) localStorage.setItem("yuzuno.selected.ws-own", JSON.stringify("r"));
    // Every animation the page starts, by the element it is on, for the collapse checks.
    const animate = Element.prototype.animate;
    window.__animations = [];
    Element.prototype.animate = function (frames, options) {
      window.__animations.push({ id: this.id, frames: JSON.stringify(frames), duration: typeof options === "number" ? options : options?.duration ?? null });
      return animate.call(this, frames, options);
    };
  }, [run.language, run.theme]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && path === "/api/projects/p-orch/brief/reply") {
      const body = JSON.parse(request.postData() || "{}");
      report.replies.push({ run: run.name, body });
      state.reply(body);
      return route.fulfill({ json: { input: { ...body, expectedTurnId: null, question: null }, status: "accepted", turnId: "t-own", error: null } });
    }
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-own" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": path === "/api/home" ? state.home() : null,
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
  const card = (key) => page.locator(`#home-section-p-orch-${key}`);
  const deck = page.locator('[data-home-project="p-orch"] .home-brief').first();
  const press = (locator) => (run.phone ? locator.tap() : locator.click());
  const deckShot = async (name) => {
    const file = `${run.name}-${name}.png`;
    await deck.scrollIntoViewIfNeeded();
    await deck.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  // A card as laid out: its box, what is held on it, and the room under its last shown child (its blank area).
  const measure = (key) => page.evaluate((key) => {
    const el = document.getElementById(`home-section-p-orch-${key}`);
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    let bottom = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    for (const child of el.children) {
      const shown = getComputedStyle(child);
      if (child.hidden || shown.display === "none") continue;
      const r = child.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, r.bottom + (parseFloat(shown.marginBottom) || 0));
    }
    const inner = box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    return {
      height: Math.round(box.height * 10) / 10, width: Math.round(box.width), top: Math.round(box.top + scrollY), blank: Math.round(inner - bottom),
      minHeight: el.style.minHeight, answer: el.classList.contains("is-answer"), open: el.classList.contains("is-open"), size: el.dataset.cardSize ?? null,
      kind: el.querySelector(".home-kind")?.textContent.trim() ?? null, reply: el.querySelector(".home-answer-reply")?.textContent ?? null,
      next: el.querySelector(".home-answer-next")?.textContent ?? null, focused: document.activeElement === el, running: el.getAnimations().length,
    };
  }, key);
  const topOf = (key) => page.evaluate((key) => Math.round(document.getElementById(`home-section-p-orch-${key}`).getBoundingClientRect().top + scrollY), key);
  const order = () => deck.locator("[data-section-key]").evaluateAll((els) => els.map((el) => el.dataset.sectionKey));
  const collapses = () => page.evaluate(() => window.__animations.filter((a) => a.id === "home-section-p-orch-overnight" && /height/.test(a.frames)));
  const openHome = async () => {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await card("overnight").waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
  };
  try {
    await openHome();
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language, "Home in the chosen language");
    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));

    // ---- Before: the open Ask's full card, the Ask below it.
    await card("overnight").scrollIntoViewIfNeeded();
    const before = await measure("overnight");
    const belowBefore = await topOf("plan");
    const placed = await order();
    assert.ok(!before.answer && before.size === null, `an open Ask's card: ${JSON.stringify(before)}`);
    await deckShot("before-reply");

    // ---- The user answers by an option: the answer card as soon as Core has the reply.
    await page.evaluate(() => (window.__animations.length = 0));
    await press(card("overnight").locator(".home-ask-options").getByRole("button", { name: w.yes, exact: true }));
    await page.waitForFunction(() => document.getElementById("home-section-p-orch-overnight")?.classList.contains("is-answer"), null, { timeout: 5000 });
    const landed = await measure("overnight");
    await page.waitForTimeout(450);
    const after = await measure("overnight");
    const belowAfter = await topOf("plan");
    const played = await collapses();
    result.measured.first = { before, landed, after, belowBefore, belowAfter, played };
    await deckShot("after-reply");
    assert.ok(after.answer && after.size === "small" && !after.open, `the answer card: ${JSON.stringify(after)}`);
    assert.equal(after.kind, w.replied);
    assert.match(after.reply, new RegExp(`${w.yes}$`));
    assert.equal(after.next, w.next);
    assert.equal(after.minHeight, "", "no height held for the card it was");
    assert.ok(after.blank <= 12, `no blank area: ${after.blank} px`);
    assert.ok(after.height < before.height - 40, `shorter than the card it was: ${before.height} → ${after.height}`);
    assert.ok(belowAfter < belowBefore - 40, `the card below moved up: ${belowBefore} → ${belowAfter}`);
    assert.deepEqual(await order(), placed, "its place on the deck kept");
    assert.ok(after.focused, "focus on the card");
    if (run.reduced) assert.equal(played.length, 0, `no animation under reduced motion: ${JSON.stringify(played)}`);
    else {
      assert.equal(played.length, 1, `one collapse: ${JSON.stringify(played)}`);
      const frames = JSON.parse(played[0].frames);
      assert.ok(parseFloat(frames[0].height) > parseFloat(frames[1].height), `from the card it was to the answer card: ${played[0].frames}`);
      // From the card as it was when Core's read came (its reply shown in place of the controls, as before), no taller than before.
      assert.ok(parseFloat(frames[0].height) <= before.height + 1 && parseFloat(frames[0].height) > after.height + 40, `from the card it was: ${played[0].frames} vs ${before.height}`);
      assert.ok(Math.abs(parseFloat(frames[1].height) - after.height) < 1, `to the answer card's own height: ${played[0].frames} vs ${after.height}`);
    }
    assert.equal(after.running, 0, "settled");
    pass(`answered by an option: the small answer card as soon as Core has it, nothing held, no blank; ${run.reduced ? "at once (reduced motion)" : "collapsed to it"}; the card below moved up; place kept; focus on the card`,
      { before: before.height, after: after.height, blank: after.blank, below: [belowBefore, belowAfter] });

    // ---- A fresh visit (a reload): the same answer card, at the same width, is as tall.
    await openHome();
    await card("overnight").scrollIntoViewIfNeeded();
    const fresh = await measure("overnight");
    result.measured.fresh = fresh;
    assert.ok(fresh.answer && fresh.size === "small", JSON.stringify(fresh));
    assert.ok(Math.abs(fresh.width - after.width) <= 2, `the same width: ${after.width} vs ${fresh.width}`);
    assert.ok(Math.abs(fresh.height - after.height) <= 3, `as tall as at a fresh visit: ${after.height} vs ${fresh.height}`);
    assert.ok(Math.abs(fresh.blank - after.blank) <= 3, `the same room inside: ${after.blank} vs ${fresh.blank}`);
    await deckShot("fresh-visit");
    pass("as tall as the same answer card at a fresh visit, at the same width", { after: after.height, fresh: fresh.height });

    // ---- Reply again: opened, sent, closed back to the answer card with the new reply.
    await page.evaluate(() => (window.__animations.length = 0));
    await press(card("overnight").locator(".home-answer-again"));
    const field = card("overnight").locator(".home-card-body textarea");
    await field.waitFor({ timeout: 5000 });
    await field.fill(w.again);
    await press(card("overnight").locator(".home-card-body button", { hasText: w.send }).first());
    await page.waitForFunction((again) => {
      const el = document.getElementById("home-section-p-orch-overnight");
      return el && !el.classList.contains("is-open") && el.querySelector(".home-answer-reply")?.textContent.endsWith(again);
    }, w.again, { timeout: 5000 });
    await page.waitForTimeout(450);
    const again = await measure("overnight");
    const replayed = await collapses();
    result.measured.again = { again, replayed };
    await deckShot("after-reply-again");
    assert.ok(again.answer && again.size === "small" && !again.open, JSON.stringify(again));
    assert.equal(again.minHeight, "");
    assert.ok(again.blank <= 12, `no blank area: ${again.blank} px`);
    assert.ok(again.focused, "focus on the card");
    assert.equal(replayed.length, run.reduced ? 0 : 1, JSON.stringify(replayed));
    // To where the deck puts it: closed by the card's own state, it is packed before it is measured.
    if (!run.reduced) assert.ok(Math.abs(parseFloat(JSON.parse(replayed[0].frames)[1].height) - again.height) < 1, `to its own height: ${replayed[0].frames} vs ${again.height}`);
    pass("Reply again, sent: closed back to the answer card with the new reply, no blank", { height: again.height, blank: again.blank });
    assert.deepEqual(report.replies.filter((r) => r.run === run.name).map((r) => [r.body.key, r.body.choice ?? null, r.body.askVersion]),
      [["overnight", "yes", 2], ["overnight", null, 2]]);
  } finally {
    await context.close();
  }
}
