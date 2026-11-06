// T-51 plan item 7, the task board's own motion (T-19 WK:CB-03, GL-07, CB-12, MS-03, GH-06): in Chromium on a
// production build of the app with a synthetic Workspace whose board has thirteen tasks and sixteen messages, every
// API answered by the check (no Core, no Agent). Desktop 1280×860 and phone 390×844, each with normal and reduced
// motion:
// - CB-03: another Show filter keeps the cards shown, dimmed to 0.5 and aria-busy, while Core's answer is held, and
//   nothing says "Gathering…"; the answer's list fades in once over small from 0.4 (collab-list-flip), at once under
//   reduced motion.
// - GL-07: Refresh tasks, while that read is on its way, is aria-busy and says "Refreshing tasks…".
// - CB-12: a task's status saved from its detail moves its row up to another group, above the rows in view: the list
//   scrolls up to it, and it settles once. On a phone the list is behind the task: nothing settles there, and Back
//   shows the row, in view, with the focus.
// - MS-03: a reply's "Reply to an earlier message" lands on the message it answers, out of view before; that message
//   settles once it has landed.
// - GH-06: a review's mail's "Open review" opens its task, the review in view; it settles once the task's detail has
//   come in.
// The settle is the app's own (settle.ts, styles.css): a tint fading over --motion-settle, or a still tint under
// reduced motion taken off after the settle's time. The board's Core calls are reads but for CB-12's one
// task_update; any other write would be recorded and fail the check. The page is https (a secure context): a save
// names itself with crypto.randomUUID. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/board-motion-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/board-motion");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const user = { kind: "user", id: "user", name: "You" };
const system = { kind: "system", id: "core", name: "Yuzuno" };
const mori = { kind: "agent", id: "a", name: "Mori" };
const at = (minutes) => new Date(Date.parse("2026-11-01T12:00:00Z") - minutes * 60_000).toISOString();
// review 1–2, doing 3–8, todo 9–13, each newer than the next; done 14 shows under All tasks only.
const status = (n) => (n <= 2 ? "review" : n <= 8 ? "doing" : n <= 13 ? "todo" : "done");
const task = (n) => ({ id: `T-${n}`, title: `Synthetic task ${n}`, description: `What task ${n} is for.`, status: status(n),
  assigneeAgentId: "a", assignee: mori, progress: "", blocker: "", result: null, version: 1, createdBy: user, updatedBy: user,
  createdAt: at(600), updatedAt: at(n * 10) });
let tasks = [];
const review = { id: "r-1", requestedHarness: "claude", requestedModel: "opus", actualHarness: "claude", actualModel: "claude-opus",
  linkId: "7:pull:124", repository: "example/app", number: 124, status: "completed", phase: "completed", baseSha: "b".repeat(40),
  headSha: "a".repeat(40), mergeBaseSha: "b".repeat(40), conclusion: "no_findings", error: null, createdAt: at(30), outdated: false,
  findings: [], cursor: 1, round: 1, rawReport: "No findings." };
// Newest first: m-16 replies to m-2, near the end; m-15 is a review's result mail for T-1.
const message = (n) => ({ id: `m-${n}`, seq: n, priority: "normal", threadId: `th-${n}`, createdAt: at(200 - n * 10),
  body: n === 15 ? "The review of example/app#124 finished: no findings." : `Synthetic note ${n}: ${"a few words on the work ".repeat(4)}`,
  sender: n === 15 ? system : n % 2 ? user : mori, recipient: n % 2 ? mori : { kind: "user", id: "user", name: "You" },
  taskId: n === 15 ? "T-1" : null, reviewId: n === 15 ? "r-1" : null, replyTo: n === 16 ? "m-2" : null,
  firstReadAt: at(1), delivery: { state: "delivered" } });
const messages = Array.from({ length: 16 }, (_, i) => message(16 - i));

// A held read: the next task_list waits until the check lets it go.
let hold = null;
const holdNext = () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  hold = gate;
  return release;
};
const counts = () => Object.fromEntries(["review", "doing", "todo", "done"].map((s) => [s, tasks.filter((t) => t.status === s).length]));
const reads = {
  task_list: async (body) => {
    const gate = hold;
    hold = null;
    if (gate) await gate;
    const listed = tasks.filter((t) => (body.statuses ? body.statuses.includes(t.status) : body.status ? t.status === body.status : true));
    return { tasks: listed, hasMore: false, counts: counts() };
  },
  task_get: (body) => ({ task: tasks.find((t) => t.id === body.taskId) || tasks[0], activities: [], executions: [], hasMore: false }),
  peer_read: () => ({ messages, hasMore: false }),
  workspaces: (body) => ({ taskId: body.taskId, repositories: [], workspaces: [] }),
  github_links: () => ({ links: [], repositories: [] }),
  github_repositories: () => ({ repositories: [] }),
  delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "m" } }),
  peers_list: () => ({ peers: [] }),
  task_research_list: () => ({ records: [] }),
};
// CB-12's save: the one write the check answers.
const saves = {
  task_update: (body) => {
    const old = tasks.find((t) => t.id === body.taskId);
    const next = { ...old, ...body.patch, version: old.version + 1, updatedAt: new Date().toISOString(), updatedBy: user };
    tasks = tasks.map((t) => (t.id === next.id ? next : t));
    return { task: next };
  },
};
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs, "/api/ci": noCiRuns,
  "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    const operation = url.pathname.startsWith("/api/collaboration/") ? url.pathname.slice("/api/collaboration/".length) : null;
    if (operation !== null && request.method() === "POST") {
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      if (saves[operation]) {
        report.writes.push(operation);
        return route.fulfill({ json: saves[operation](body) });
      }
      if (reads[operation]) return route.fulfill({ json: await reads[operation](body) });
      if (!/^(task_|peer_send|github_pr|review_|delivery_(enable|continue|stop)|ci_|job_)/.test(operation)) return route.fulfill({ json: {} });
    }
    if (request.method() === "GET") {
      if (url.pathname === "/api/pr-reviews") return route.fulfill({ json: { settings: { harness: "claude", model: "opus" },
        reviews: url.searchParams.get("taskId") === "T-1" ? [review] : [], hasMore: false, nextBefore: null } });
      if (url.pathname === "/api/pr-reviews/r-1") return route.fulfill({ json: review });
      const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
      return route.fulfill({ json: hit ? gets[hit] : {} });
    }
    report.writes.push(`${request.method()} ${url.pathname}`);
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

// In the page: what is shown, frame by frame, and when a settle comes and goes.
function probe() {
  const scroller = (el) => {
    for (let node = el?.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    }
    return document.scrollingElement;
  };
  window.__inView = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const port = scroller(el).getBoundingClientRect();
    return box.height > 0 && box.top >= port.top - 1 && box.bottom <= port.bottom + 1;
  };
  window.__plays = (el) => (el ? el.getAnimations().map((a) => `${a.animationName || a.transitionProperty}:${a.effect.getTiming().duration}`) : []);
  window.__list = () => {
    const list = document.querySelector(".collab-cards, .collab-groups");
    const refresh = document.querySelector('button[aria-label="Refresh tasks"]');
    return { cards: list ? list.querySelectorAll(".collab-task-card").length : null, done: !!document.querySelector('.collab-task-card[data-task-id="T-14"]'),
      opacity: list ? Number(getComputedStyle(list).opacity) : null, busy: list?.getAttribute("aria-busy") ?? null, plays: window.__plays(list),
      gathering: !!document.querySelector(".collab-loading"),
      refresh: refresh ? { busy: refresh.getAttribute("aria-busy"), title: refresh.getAttribute("title") } : null };
  };
  window.__sample = (ms) => {
    window.__frames = [];
    const t0 = performance.now();
    const frame = () => {
      window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__list() });
      if (performance.now() - t0 < ms) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  // Every settle put on or taken off, with what it plays and whether it is in view.
  window.__settles = [];
  window.__t0 = performance.now();
  window.__scrolledAt = 0;
  addEventListener("scroll", () => { window.__scrolledAt = performance.now(); }, { capture: true, passive: true });
  window.__detailIn = [];
  addEventListener("animationend", (event) => {
    if (event.animationName === "collab-detail-in") window.__detailIn.push(Math.round(performance.now()));
  }, true);
  new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target;
      const on = el.hasAttribute("data-settle");
      if (on === (record.oldValue !== null)) continue;
      const name = el.dataset.taskId || el.id || el.className;
      window.__settles.push({ at: Math.round(performance.now()), on, name, scrolledAt: Math.round(window.__scrolledAt),
        plays: on ? window.__plays(el) : [], inView: window.__inView(el) });
      if (on) requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__settles.push({ at: Math.round(performance.now()), on: "playing", name, plays: window.__plays(el), inView: window.__inView(el) });
      }));
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-settle"], attributeOldValue: true });
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const settleShown = (settles, name, reduced) => {
  const on = settles.find((s) => s.on === true && s.name === name);
  const playing = settles.find((s) => s.on === "playing" && s.name === name);
  const off = settles.find((s) => s.on === false && s.name === name);
  const others = settles.filter((s) => s.on === true && s.name !== name);
  const plays = playing?.plays || [];
  const fine = !!on && !!off && !others.length && (reduced ? !plays.length && off.at - on.at >= 1000 : plays.includes("settle-tint:1200"));
  return { fine, on, playing, off, others };
};
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, still) => (reduced ? still : normal);
  tasks = Array.from({ length: 14 }, (_, i) => task(i + 1));
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.addInitScript(probe);
  try {
    await page.goto("https://yuzuno-board.test/");
    await page.locator(".agent-row").first().waitFor();
    await page.evaluate(() => document.querySelector(".collab-nav").click());
    await page.locator(".collab-task-card").first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);

    // CB-03 and GL-07: All tasks, its answer held.
    const release = holdNext();
    await page.evaluate(() => window.__sample(1400));
    await page.locator(".collab-field", { hasText: "Show" }).locator("select").selectOption("all");
    await page.waitForTimeout(500);
    release();
    await page.waitForTimeout(1000);
    const frames = await page.evaluate(() => window.__frames);
    const held = frames.filter((f) => !f.done);
    const after = frames.filter((f) => f.done);
    report.frames[`${tag}: CB-03`] = frames;
    ok(`${tag}: another Show filter keeps the cards shown, dimmed to 0.5 and busy, while Core's answer is on its way; nothing says Gathering (CB-03)`,
      held.length > 5 && held.every((f) => f.cards === 13 && !f.gathering) && held.slice(3).every((f) => f.opacity === 0.5 && f.busy === "true"), held.slice(0, 6));
    ok(`${tag}: Refresh tasks, while that read is on its way, says it is busy (aria-busy, "Refreshing tasks…") (GL-07)`,
      held.slice(3).every((f) => f.refresh?.busy === "true" && f.refresh.title === "Refreshing tasks…") && after.at(-1)?.refresh?.busy === null && after.at(-1)?.refresh.title === "Refresh tasks",
      { held: held.slice(3, 5).map((f) => f.refresh), after: after.at(-1)?.refresh });
    ok(`${tag}: Core's answer takes over, its list ${motion("fading in once over small from 0.4 (collab-list-flip 180 ms)", "at once, nothing playing")}, then fully shown and not busy (CB-03)`,
      after.length > 0 && after[0].cards === 14 && (reduced ? after.every((f) => !f.plays.length && f.opacity === 1)
        : after[0].plays.includes("collab-list-flip:180") && after[0].opacity < 1 && after.every((f) => f.opacity >= 0.39))
        && after.at(-1).opacity === 1 && after.at(-1).busy === null && !after.at(-1).plays.length, after.slice(0, 3).concat(after.slice(-1)));

    // CB-12: T-13, the oldest todo at the end of the list, saved as doing, which puts it near the top.
    await page.locator('.collab-task-card[data-task-id="T-13"]').click();
    await page.locator(".collab-detail").first().waitFor();
    await page.waitForTimeout(500);
    await page.locator(".collab-detail button", { hasText: "Edit task" }).click();
    await page.locator(".collab-detail .collab-field", { hasText: "Task status" }).locator("select").selectOption("doing");
    const before = await page.evaluate(() => {
      window.__settles = [];
      const row = document.querySelector('.collab-task-card[data-task-id="T-13"]');
      return { inView: window.__inView(row), shown: !!row?.getClientRects().length, scrollTop: Math.round(document.querySelector(".collab-task-list")?.scrollTop ?? 0) };
    });
    await page.evaluate(() => [...document.querySelectorAll(".collab-detail button")].find((b) => b.textContent.includes("Save changes")).click());
    await page.waitForTimeout(2200);
    const saved = await page.evaluate(() => {
      const row = document.querySelector('.collab-task-card[data-task-id="T-13"]');
      const group = row?.closest(".collab-group");
      return { settles: window.__settles, inView: window.__inView(row), group: group ? [...group.classList].find((c) => c.startsWith("group-")) : null,
        scrollTop: Math.round(document.querySelector(".collab-task-list")?.scrollTop ?? 0) };
    });
    report.frames[`${tag}: CB-12`] = { before, ...saved };
    if (!run.phone) {
      const shown = settleShown(saved.settles, "T-13", reduced);
      ok(`${tag}: a status saved from the task's detail moves its row up to another group, above the rows in view: the list scrolls up to it, and it settles once, ${motion("its tint fading over the settle's time", "a still tint taken off after the settle's time")} (CB-12)`,
        before.shown && before.inView && saved.group === "group-doing" && saved.scrollTop < before.scrollTop && saved.inView && shown.fine && shown.on.inView,
        { before, ...shown, group: saved.group, scrollTop: saved.scrollTop });
    } else {
      await page.locator(".collab-back").first().click();
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => {
        const row = document.querySelector('.collab-task-card[data-task-id="T-13"]');
        return { inView: window.__inView(row), focused: document.activeElement === row };
      });
      ok(`${tag}: with the list behind the task, a status saved settles nothing there; Back shows the row moved, in view, with the focus (CB-12)`,
        !before.shown && !saved.settles.some((s) => s.on === true) && back.inView && back.focused, { before, settles: saved.settles, back });
      report.frames[`${tag}: CB-12`].back = back;
    }

    // MS-03: the newest message replies to m-2, near the end of the mailbox.
    await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].find((b) => b.textContent.includes("Messages")).click());
    await page.locator("#peer-message-m-2").waitFor();
    await page.waitForTimeout(400);
    const away = await page.evaluate(() => { window.__settles = []; return window.__inView(document.getElementById("peer-message-m-2")); });
    await page.evaluate(() => document.querySelector("#peer-message-m-16 .collab-reply-label").click());
    await page.waitForTimeout(2600);
    const reply = await page.evaluate(() => ({ settles: window.__settles, inView: window.__inView(document.getElementById("peer-message-m-2")),
      focused: document.activeElement?.id }));
    report.frames[`${tag}: MS-03`] = { away, ...reply };
    const replied = settleShown(reply.settles, "peer-message-m-2", reduced);
    ok(`${tag}: Reply to an earlier message lands on the message it answers, out of view before, which settles once it has landed, ${motion("its tint fading over the settle's time", "a still tint taken off after the settle's time")} (MS-03)`,
      away === false && reply.inView && reply.focused === "peer-message-m-2" && replied.fine && replied.on.inView && (reduced || replied.on.at >= replied.on.scrolledAt),
      { away, ...replied, focused: reply.focused });

    // GH-06: the review's result mail opens its task with the review.
    const opened = await page.evaluate(() => {
      window.__settles = [];
      window.__detailIn = [];
      const t0 = Math.round(performance.now());
      [...document.querySelectorAll("#peer-message-m-15 .collab-message-task")].find((b) => b.textContent.includes("Open review")).click();
      return t0;
    });
    await page.locator(".pr-review-run.focused").waitFor({ timeout: 5000 });
    await page.waitForTimeout(2400);
    const deep = await page.evaluate(() => ({ settles: window.__settles, detailIn: window.__detailIn,
      inView: window.__inView(document.querySelector(".pr-review-run.focused")) }));
    report.frames[`${tag}: GH-06`] = { opened, ...deep };
    const run6 = settleShown(deep.settles.map((s) => ({ ...s, name: s.name.includes("pr-review-run") ? "review" : s.name })), "review", reduced);
    ok(`${tag}: Open review opens its task with the review in view, which settles once the task's detail has come in${motion(" (after collab-detail-in ends)", "")}, ${motion("its tint fading over the settle's time", "a still tint taken off after the settle's time")} (GH-06)`,
      deep.inView && run6.fine && run6.on.inView && (reduced ? !deep.detailIn.length : deep.detailIn.length > 0 && run6.on.at >= deep.detailIn[0]),
      { ...run6, detailIn: deep.detailIn, opened });
    await page.screenshot({ path: join(output, `${tag}-end.png`) });
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
  }
  await context.close();
}
await browser.close();
ok("no page errors", report.errors.length === 0, report.errors);
ok("the board wrote only CB-12's saves, one a run", report.writes.length === runs.length && report.writes.every((w) => w === "task_update"), report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "board-motion-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
process.exit(report.passed ? 0 : 1);
