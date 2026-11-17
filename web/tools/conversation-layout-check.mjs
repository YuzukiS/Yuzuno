// YN-204 (R-16): the conversation's head, the end of the conversation and the
// bottom of the window, on a production build with every API answered here.
// The user's screen is an opened folding phone held upright, the web app
// added to its home screen: 669x951 CSS px by touch, with an 82px status bar
// and a 34px home indicator inset (both read off the user's screenshot, not
// off a device). Also a long name there, the keyboard up, the phone held
// sideways, a 1280x800 desktop and a 390px phone. Synthetic content only: a
// Claude Agent, ready, 101 Turns, the last two started by Claude after a
// background task, 13 jobs running and 4 background shells left running.
// An emulated screen is not the device: no iOS Safari, no real keyboard.
//   YUZUNO_UI_DIST=<isolated build> node tools/conversation-layout-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/conversation-layout");
await mkdir(output, { recursive: true });
const report = { task: "YN-204", at: new Date().toISOString(), views: [], checks: [], failures: [], errors: [] };
const check = (ok, name, extra = {}) => {
  report.checks.push({ name, ok, ...extra });
  if (!ok) report.failures.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(extra)}`}`);
};

const now = Date.parse("2026-11-17T12:57:00Z");
function fixture({ name = "Paddle-track", unrecognized = 0 } = {}) {
  const iso = (ms) => new Date(now + ms).toISOString();
  const sec = (ms) => Math.floor((now + ms) / 1000);
  const cwd = "/home/demo/WF/paddle-track";
  const agent = {
    id: "a", name, status: "idle", harness: "claude", cwd, model: "opus", color: "coral",
    createdAt: iso(-86_400_000), updatedAt: iso(-60_000), unreadCount: 0, pendingCount: 0,
    lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: "p1", threadId: "s-a",
  };
  const agents = [agent, { ...agent, id: "b", name: "Court-notes" }];
  const projects = [{ id: "p1", name: "paddle-track", defaultDirs: { local: cwd }, createdAt: iso(-86_400_000), updatedAt: iso(-86_400_000) }];
  const replies = [
    "Still in progress. C2 has finished its squash val replays and is now running padel and paddle tennis tracks.",
    "Still in progress. Padel is running for C2, and its paddle replay is waiting for memory behind the B run's jobs, which seem to have started. Next update when either finishes.",
  ];
  const count = 101;
  const turns = Array.from({ length: count }, (_, i) => {
    const last2 = i >= count - 2;
    const started = -((count - i) * 120_000) - 1_000;
    return {
      id: `t${i}`, status: "completed", startedAt: sec(started), completedAt: sec(started + 1_000),
      ...(last2 ? { _yuzunoOrigin: "task-notification" } : {}),
      items: [
        ...(last2 ? [] : [{ id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 步：看看 C2 的回放。` }] }]),
        { id: `r${i}`, type: "agentMessage", text: last2 ? replies[i - (count - 2)] : `Step ${i + 1} is queued behind the replays.` },
      ],
    };
  });
  const resources = { cpuMillis: 2000, memoryMiB: 4096 };
  const job = (i, status) => ({
    id: `j${i}`, name: `replay-${i}`, status, reason: null, agentId: "a", agent: { name }, taskRef: null, cwd,
    machine: { name: "core-host" }, resources, reservation: resources, exclusive: false, createdAt: iso(-3_600_000),
    startedAt: iso(-3_000_000), finishedAt: status === "running" ? null : iso(-60_000), reserved: status === "running",
    cursor: i, requestId: `r${i}`,
  });
  const jobs = [
    ...Array.from({ length: 13 }, (_, i) => job(i, "running")),
    ...Array.from({ length: unrecognized }, (_, i) => ({ ...job(100 + i, "running"), status: "mystery" })),
    ...Array.from({ length: 6 }, (_, i) => job(50 + i, "succeeded")),
  ];
  const detail = {
    agent, pending: [], messageReceipts: [], artifacts: [], turns,
    backgroundShells: { state: "known", count: 4, checkedAt: sec(-20_000) },
    contextUsage: { usedTokens: 62_000, windowTokens: 200_000, usedPercent: 31, turnId: `t${count - 1}`, updatedAt: iso(-60_000), stale: false },
  };
  return { agent, agents, projects, detail, jobs };
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const browser = await launchBrowser();

async function open(view, fx, motion = "reduce") {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height }, hasTouch: view.touch, isMobile: view.touch,
    reducedMotion: motion, locale: "zh-CN", timezoneId: "UTC",
  });
  await context.addInitScript((v) => {
    window.EventSource = class { close() {} };
    // An on-screen keyboard as far as keyboard-viewport.ts can tell: the
    // visual viewport window.__keyboard px shorter than the window.
    const height = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height");
    Object.defineProperty(VisualViewport.prototype, "height", {
      configurable: true,
      get() { return window.__keyboard ? innerHeight - window.__keyboard : height.get.call(this); },
    });
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    addEventListener("DOMContentLoaded", () => {
      // The system's insets, without a device: the app reads --safe-*.
      document.documentElement.style.setProperty("--safe-top", `${v.safeTop}px`);
      document.documentElement.style.setProperty("--safe-bottom", `${v.safeBottom}px`);
    });
  }, view);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(now));
  page.on("pageerror", (e) => report.errors.push(`${view.name}: ${e.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: fx.projects, projectUsage: {}, agents: fx.agents, runtime: { connected: true }, defaultCwd: "/home/demo" } });
    if (path === "/api/agents/a") return route.fulfill({ json: fx.detail });
    if (path === "/api/agents/b") return route.fulfill({ json: { ...fx.detail, agent: fx.agents[1], turns: fx.detail.turns.slice(0, 3) } });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: fx.jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try {
      return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] || "application/octet-stream" });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await page.goto("https://yn204.test/");
  await page.locator(".app").waitFor({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  if (view.width <= 520) {
    // A phone opens on the Agent list.
    await page.locator(".agent-row", { hasText: fx.agent.name }).first().click();
  } else {
    // The user's screen had the Agent sidebar hidden.
    const hide = page.getByRole("button", { name: "隐藏 Agent 侧栏" });
    if (await hide.count()) await hide.first().click();
  }
  await page.locator(".conversation-header").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);
  return { context, page };
}

// Geometry in CSS px from the window's top left.
const measure = (page) => page.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right, cy: r.y + r.height / 2 };
  };
  const ink = (el) => {
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
    return { top, bottom, cy: (top + bottom) / 2 };
  };
  const q = (s) => document.querySelector(s);
  const actions = [...document.querySelectorAll(".reply-actions")];
  const last = actions.at(-1);
  const kids = last ? [...last.children].map((c) => ({ cls: String(c.className), text: c.textContent.trim(), ...box(c) })) : [];
  const scroll = q(".conversation-scroll");
  const css = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
  return {
    head: box(q(".conversation-header")),
    h1: box(q(".conversation-heading h1")), status: box(q(".conversation-header .status-label")),
    work: box(q(".work-activity-entry")), workInk: ink(q(".work-activity-entry .work-activity-counts")),
    index: box(q(".conversation-index-entry")), indexInk: ink(q(".conversation-index-entry > span")),
    tools: box(q(".conversation-actions")),
    toolButtons: [...document.querySelectorAll(".conversation-actions button")].map(box).filter((b) => b && b.w > 0),
    replyRows: actions.map((a) => box(a).h),
    lastActions: { ...box(last), kids },
    composer: box(q(".composer")),
    composerArea: { ...box(q(".composer-area")), marginBottom: css(q(".composer-area"), "margin-bottom") },
    footnoteInk: ink(q(".composer-footnote .conversation-metadata")),
    appPaddingBottom: css(q(".app"), "padding-bottom"),
    pill: box(q(".jump-latest")),
    scroll: { ...box(scroll), atEnd: Math.abs(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop) < 2, marginBottom: css(scroll, "margin-bottom") },
    keyboard: document.documentElement.hasAttribute("data-keyboard"),
    focus: document.activeElement?.closest?.(".composer") ? "composer" : document.activeElement?.tagName,
    draft: q(".composer .cm-content")?.textContent ?? "",
    window: { w: innerWidth, h: innerHeight },
  };
});

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const DUO = { name: "duo-669x951", width: 669, height: 951, touch: true, safeTop: 82, safeBottom: 34 };

async function head(view, m, tag) {
  const controls = [m.work, m.index, m.tools].filter(Boolean);
  check(controls.length === 3 && controls.every((c) => near(c.h, controls[0].h, 0.5)), `${tag}: the two entries and the tools are one height`, { heights: controls.map((c) => c.h) });
  check(near(m.workInk?.cy, m.work?.cy, 1), `${tag}: the work entry's words are centred in it`, { ink: m.workInk?.cy, box: m.work?.cy });
  check(near(m.indexInk?.cy, m.index?.cy, 1), `${tag}: the reading entry's words are centred in it`, { ink: m.indexInk?.cy, box: m.index?.cy });
  check(near(m.work?.cy, m.tools?.cy, 0.5) && near(m.index?.cy, m.tools?.cy, 0.5), `${tag}: the entries and the tools share one centre line`, { work: m.work?.cy, index: m.index?.cy, tools: m.tools?.cy });
  check(m.toolButtons.length >= 3 && m.toolButtons.every((b) => b.h >= (view.touch ? 34 : 32)), `${tag}: every tool keeps its height`, { heights: m.toolButtons.map((b) => b.h) });
}

try {
  // 1. The user's screen, at the end of the conversation.
  {
    const { context, page } = await open(DUO, fixture());
    const m = await measure(page);
    report.views.push({ name: "duo-end", m });
    await page.screenshot({ path: `${output}/duo-end.png` });
    await head(DUO, m, "duo");
    check(near(m.h1?.cy, m.tools?.cy, 1) && near(m.status?.cy, m.tools?.cy, 1), "duo: the name and its status are on the controls' centre line", { h1: m.h1?.cy, status: m.status?.cy, tools: m.tools?.cy });
    check(m.head?.h <= 51.5, "duo: the head is no taller than it was (51px)", { h: m.head?.h });
    const kids = m.lastActions.kids;
    const bottom = Math.max(...kids.map((k) => k.bottom));
    const gap = m.composer.y - bottom;
    check(m.scroll.atEnd && !m.pill, "duo: opened at the end, Back to latest not shown", { atEnd: m.scroll.atEnd, pill: m.pill });
    check(gap > 0 && gap <= 34, "duo: the last reply's actions sit at most 34px above the input box (85.7 before)", { gap });
    const footer = kids.find((k) => k.cls.includes("turn-footer"));
    const rewind = kids.find((k) => k.text.includes("Rewind"));
    check(!!footer && !!rewind && near(footer.cy, rewind.cy, 4), "duo: Rewind shares a line with the time and shells, never a line of its own", { footer: footer?.cy, rewind: rewind?.cy });
    check(!!rewind && near(rewind.right, m.lastActions.right, 1), "duo: Rewind ends at the right of the actions", { rewind: rewind?.right, actions: m.lastActions.right });
    check(!!footer && footer.text.includes("4 个 shell 仍在运行"), "duo: the background shells are still said, apart from the Turn's end", { text: footer?.text });
    const fitted = m.replyRows.slice(0, -1);
    check(fitted.length > 0 && fitted.every((h) => h <= 30), "duo: a reply whose time and Rewind fit beside its actions keeps one line", { rows: fitted });
    check(m.appPaddingBottom === "34px" && m.composerArea.marginBottom === "0px", "duo: the input area's own bottom margin goes inside the 34px inset, not on top of it", { app: m.appPaddingBottom, area: m.composerArea.marginBottom });
    const below = m.window.h - m.footnoteInk.bottom;
    check(below <= 47 && below >= 34, "duo: from the footnote's words to the window's bottom, 34px of inset and its row's own half (58.5 before)", { below });
    await context.close();
  }
  // 2. Reading older messages, then back to the end by the wheel, as a reader
  // does, with motion and without: the band comes with Back to latest only,
  // what is being read stays put as it comes, and at the end it closes (over
  // --motion-small with motion) and leaves the end where opening it did, with
  // no room held at the column's end (useReadingHold).
  for (const motion of ["reduce", "no-preference"]) {
    const tag = `duo, ${motion === "reduce" ? "reduced motion" : "motion"}`;
    const { context, page } = await open(DUO, fixture(), motion);
    await page.mouse.move(334, 500);
    // Up by the wheel to ~700px from the end, then the place being read: the
    // block a quarter down the pane.
    for (let i = 0; i < 40; i++) {
      const gap = await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); return s.scrollHeight - s.clientHeight - s.scrollTop; });
      if (gap >= 700) break;
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    const read = () => page.evaluate(() => {
      const s = document.querySelector(".conversation-scroll"), box = s.getBoundingClientRect();
      const y = box.top + box.height / 4;
      const block = [...document.querySelectorAll(".conversation-inner [data-item-id], .conversation-inner .turn-divider")]
        .find((el) => { const r = el.getBoundingClientRect(); return r.top <= y && r.bottom > y; });
      if (block && !block.id) block.id = "yn204-read";
      return block ? { id: block.id, top: block.getBoundingClientRect().top } : null;
    });
    const before = await read();
    const up = await measure(page);
    report.views.push({ name: `reading-up-${motion}`, m: up });
    await page.screenshot({ path: `${output}/duo-reading-up-${motion}.png` });
    check(!!up.pill && up.scroll.marginBottom === "44px", `${tag}, reading older messages: Back to latest shows and the pane gives it its 44px band`, { pill: up.pill, margin: up.scroll.marginBottom });
    check(!!up.pill && up.pill.y >= up.scroll.bottom - 0.5 && up.pill.bottom <= up.composer.y, `${tag}, reading older messages: Back to latest lies between the pane and the input box, over no text`, { pill: up.pill, pane: up.scroll.bottom, composer: up.composer.y });
    await page.waitForTimeout(400);
    const still = await page.evaluate((id) => document.getElementById(id)?.getBoundingClientRect().top, before?.id);
    check(!!before && near(still, before.top, 1), `${tag}, reading older messages: what is being read does not move as the band comes`, { before: before?.top, after: still });
    // Back down by the wheel, frame times recorded while the band closes.
    await page.evaluate(() => {
      window.__frames = [];
      let last = performance.now();
      const tick = (now) => { window.__frames.push(now - last); last = now; if (window.__frames.length < 120) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 60; i++) {
      const gap = await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); return s.scrollHeight - s.clientHeight - s.scrollTop; });
      if (gap < 1) break;
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(600);
    const back = await measure(page);
    const frames = await page.evaluate(() => window.__frames.slice(1));
    report.views.push({ name: `back-by-wheel-${motion}`, m: back, longestFrameMs: Math.round(Math.max(...frames)) });
    const bottom = Math.max(...back.lastActions.kids.map((k) => k.bottom));
    const room = await page.evaluate(() => document.querySelector(".conversation-inner").style.paddingBottom);
    check(!back.pill && back.scroll.marginBottom === "0px" && back.scroll.atEnd, `${tag}, back at the end by the wheel: Back to latest and its band are gone`, { pill: back.pill, margin: back.scroll.marginBottom, atEnd: back.scroll.atEnd });
    check(near(back.composer.y - bottom, 32.7, 2) && !room, `${tag}, back at the end by the wheel: the end sits as it did when opened, with no room held below it`, { gap: back.composer.y - bottom, room });
    console.log(`  ${tag}: longest frame while the band closed ${Math.round(Math.max(...frames))}ms (headless Chromium, not a device)`);
    // And Back to latest itself, from reading older messages again.
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(500);
    await page.locator(".jump-latest").click();
    await page.waitForTimeout(900);
    const pressed = await measure(page);
    const end = Math.max(...pressed.lastActions.kids.map((k) => k.bottom));
    check(!pressed.pill && pressed.scroll.atEnd && near(pressed.composer.y - end, 32.7, 2), `${tag}, Back to latest: one press ends at the end, as opened`, { pill: pressed.pill, atEnd: pressed.scroll.atEnd, gap: pressed.composer.y - end });
    await context.close();
  }
  // 3. A long name and an unrecognised job: the entries take a second row, and the tools come down to it.
  {
    const { context, page } = await open(DUO, fixture({ name: "Paddle-track · 回放与验收（第二轮）", unrecognized: 2 }));
    const m = await measure(page);
    report.views.push({ name: "duo-long-name", m });
    await page.screenshot({ path: `${output}/duo-long-name.png` });
    await head(DUO, m, "duo, long name");
    check(m.h1.bottom <= m.work.y, "duo, long name: the name has the first row to itself", { h1: m.h1.bottom, work: m.work.y });
    check(m.tools.y >= m.h1.bottom - 1, "duo, long name: the tools are on the controls' row, not between rows", { tools: m.tools.y, h1: m.h1.bottom });
    await context.close();
  }
  // 4. The keyboard up over the home indicator.
  {
    const { context, page } = await open(DUO, fixture());
    await page.locator(".composer .cm-content").first().click();
    await page.keyboard.insertText("C2 的回放先整理成表");
    await page.evaluate(() => { window.__keyboard = 380; visualViewport.dispatchEvent(new Event("resize")); });
    await page.waitForTimeout(600);
    const m = await measure(page);
    report.views.push({ name: "duo-keyboard", m });
    await page.screenshot({ path: `${output}/duo-keyboard.png` });
    check(m.keyboard, "duo, keyboard: the app follows the keyboard", { keyboard: m.keyboard });
    check(m.appPaddingBottom === "0px" && m.composerArea.marginBottom === "12px", "duo, keyboard: no inset is kept under the keyboard; the input area keeps its own 12px", { app: m.appPaddingBottom, area: m.composerArea.marginBottom });
    check(m.composerArea.bottom <= m.window.h - 380 - 11.5, "duo, keyboard: the input area ends above the keyboard", { area: m.composerArea.bottom, keyboardTop: m.window.h - 380 });
    check(m.focus === "composer" && m.draft.includes("C2 的回放先整理成表"), "duo, keyboard: the draft and the focus stay in the input box", { focus: m.focus, draft: m.draft });
    await context.close();
  }
  // 5. Held sideways, a desktop, a phone: the same head; the desktop bottom as it was.
  for (const view of [
    { name: "duo-951x669", width: 951, height: 669, touch: true, safeTop: 0, safeBottom: 21 },
    { name: "desktop-1280x800", width: 1280, height: 800, touch: false, safeTop: 0, safeBottom: 0 },
    { name: "phone-390x844", width: 390, height: 844, touch: true, safeTop: 59, safeBottom: 34 },
  ]) {
    const { context, page } = await open(view, fixture());
    const m = await measure(page);
    report.views.push({ name: view.name, m });
    await page.screenshot({ path: `${output}/${view.name}.png` });
    await head(view, m, view.name);
    if (view.name.startsWith("desktop")) {
      check(m.composerArea.marginBottom === "15px", `${view.name}: with no inset the input area keeps its 15px`, { area: m.composerArea.marginBottom });
      check(m.replyRows.every((h) => h <= 30), `${view.name}: every reply's actions, time and Rewind keep one line`, { rows: m.replyRows });
    }
    if (view.name.startsWith("phone")) check(m.head.h <= 93.5, `${view.name}: the head is no taller than it was (93px)`, { h: m.head.h });
    if (view.name.startsWith("duo-951")) {
      const kids = m.lastActions.kids;
      const footer = kids.find((k) => k.cls.includes("turn-footer")), rewind = kids.find((k) => k.text.includes("Rewind"));
      check(!!footer && !!rewind && near(footer.cy, rewind.cy, 4), `${view.name}: Rewind shares a line with the time`, { footer: footer?.cy, rewind: rewind?.cy });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}
check(report.errors.length === 0, "no page errors", { errors: report.errors });
console.log(`${report.checks.length - report.failures.length}/${report.checks.length} passed; ${output}/report.json`);
process.exit(report.failures.length ? 1 : 0);
