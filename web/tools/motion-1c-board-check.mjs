// T-19 batch 1c, the task board (WK:CB-09, with CB-04/TD-01/MS-01 and CB-13
// covered in collaboration-ui.test.mjs): in Chromium on a production build of
// the app with a synthetic Workspace whose board has three tasks, never
// written to. Opening a task turns the cards into rows beside it: the rows
// that take over fade in once over small from 0.4 (collab-list-flip), so the
// list is never gone; frames held at 0 % and 50 % of it are saved for review.
// The cards coming back after a close are not read here. Under reduced motion nothing fades. A
// narrow window is run too. The board's Core calls are reads; one in WRITES
// would be recorded and fail the check. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1c-board-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1c-board");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], reads: [], writes: [], frames: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const user = { kind: "user", id: "user", name: "You" };
const task = (n, status) => ({ id: `T-${n}`, title: `Synthetic task ${n}`, description: "", status, assigneeAgentId: "a",
  assignee: { kind: "agent", id: "a", name: "Mori" }, progress: "", blocker: "", result: null, version: 1, createdBy: user, updatedBy: user,
  createdAt: "2026-11-01T10:00:00Z", updatedAt: `2026-11-01T1${n}:00:00Z` });
const tasks = [task(1, "doing"), task(2, "review"), task(3, "todo")];
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs, "/api/ci": noCiRuns,
  "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
};
// The board's reads: POST, as it asks Core (CollaborationBoard.tsx `call`).
const reads = {
  task_list: () => ({ tasks, hasMore: false, counts: { doing: 1, review: 1, todo: 1 } }),
  task_get: (body) => ({ task: tasks.find((t) => t.id === body.taskId) || tasks[0], activities: [], executions: [], hasMore: false }),
  peer_read: () => ({ messages: [], hasMore: false }),
  workspaces: (body) => ({ taskId: body.taskId, repositories: [], workspaces: [] }),
  github_links: () => ({ links: [], repositories: [] }),
  delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "m" } }),
  peers_list: () => ({ peers: [] }),
  task_research_list: () => ({ records: [] }),
};
// What changes something in Core; the check never asks for any of it.
const WRITES = /^(task_(create|update|comment|dispatch|submit_result|claim|result_ack|research_add)|peer_send|github_pr_submit|github_links_link|review_start|delivery_(enable|continue|stop)|ci_subscribe|job_)/;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    const operation = url.pathname.startsWith("/api/collaboration/") ? url.pathname.slice("/api/collaboration/".length) : null;
    if (operation !== null && request.method() === "POST" && !WRITES.test(operation)) {
      report.reads.push(operation);
      const body = request.postData() ? JSON.parse(request.postData()) : {};
      const answer = reads[operation.split("?")[0]];
      return route.fulfill({ json: answer ? answer(body) : {} });
    }
    if (request.method() === "GET") {
      const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
      if (operation !== null) report.reads.push(`GET ${operation}`);
      return route.fulfill({ json: hit ? gets[hit] : operation?.startsWith("pr-") ? { reviews: [], operations: [], repositories: [], hasMore: false, nextBefore: null } : {} });
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

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "narrow", viewport: { width: 760, height: 900 }, reducedMotion: "no-preference" },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.goto("http://yuzuno-motion.test/");
  await page.locator(".agent-row").first().waitFor();
  await page.locator(".collab-nav").first().click();
  await page.locator(".collab-task-card").first().waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  // What the list is, and what it plays, in every frame from a click.
  await page.evaluate(() => {
    window.__frames = [];
    window.__list = () => {
      const list = document.querySelector(".collab-groups, .collab-cards");
      return { as: list ? (list.classList.contains("collab-groups") ? "rows" : "cards") : null, visible: !!list?.getClientRects().length,
        plays: list ? list.getAnimations().map((a) => `${a.animationName}:${a.effect.getTiming().duration}`) : [],
        opacity: list ? Number(getComputedStyle(list).opacity) : null };
    };
    addEventListener("click", () => {
      const t0 = performance.now();
      const frame = () => {
        window.__frames.push({ t: Math.round(performance.now() - t0), ...window.__list() });
        if (performance.now() - t0 < 500) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { capture: true, once: true });
  });
  const cards = await page.evaluate(() => window.__list());
  await page.locator(".collab-task-card").first().click();
  await page.waitForTimeout(700);
  const frames = await page.evaluate(() => window.__frames);
  report.frames[`${tag}: open`] = frames;
  const rows = frames.filter((f) => f.as === "rows" && f.visible);
  if (run.name === "narrow" && !rows.length) {
    // A narrow window shows the task in place of the list (quickClose): no flip to judge there.
    ok(`${tag}: the task opens without the list beside it, so nothing flips`, frames.every((f) => f.as !== "rows" || !f.plays.length), frames.slice(0, 3));
  } else if (reduced) {
    ok(`${tag}: under reduced motion the rows take over at once, with nothing playing`, rows.length > 0 && rows.every((f) => !f.plays.length && f.opacity === 1), rows.slice(0, 2));
  } else {
    ok(`${tag}: the cards (${cards.as}) become rows that fade in once over small (collab-list-flip 180 ms) from 0.4, never gone`,
      cards.as === "cards" && rows.length > 0 && rows[0].plays.includes("collab-list-flip:180") && rows[0].opacity < 1 &&
        rows.every((f) => f.opacity >= 0.39), rows.slice(0, 2));
    const settled = rows.at(-1);
    ok(`${tag}: and are done after it, fully shown, with nothing left playing`, !!settled && !settled.plays.length && settled.opacity === 1, settled);
  }
  if (!reduced && run.name !== "narrow") {
    await page.screenshot({ path: join(output, `${tag}-rows.png`) });
    // The fade itself, held: close the task, open another, and stop its fade at 0 % and at 50 %.
    await page.locator('[aria-label="Close task"]').first().click();
    await page.locator(".collab-cards").first().waitFor({ timeout: 3000 });
    await page.waitForTimeout(400);
    await page.locator(".collab-task-card").nth(2).click();
    const held = [];
    for (const at of [0, 90]) {
      const state = await page.evaluate((at) => new Promise((done) => {
        const find = () => document.querySelector(".collab-groups.collab-list-flip")?.getAnimations().find((a) => a.animationName === "collab-list-flip");
        const hold = () => {
          const animation = find();
          if (!animation) return requestAnimationFrame(hold);
          animation.pause();
          animation.currentTime = at;
          requestAnimationFrame(() => done({ at, opacity: Number(getComputedStyle(document.querySelector(".collab-groups")).opacity) }));
        };
        hold();
      }), at);
      await page.screenshot({ path: join(output, `${tag}-flip-${at}ms.png`) });
      held.push(state);
    }
    await page.evaluate(() => document.querySelector(".collab-groups")?.getAnimations().forEach((a) => a.play()));
    report.frames[`${tag}: held`] = held;
    ok(`${tag}: held at 0 % the rows show at 0.4, at 50 % between (screenshots ${tag}-flip-0ms.png, ${tag}-flip-90ms.png)`,
      Math.abs(held[0]?.opacity - 0.4) < 0.02 && held[1]?.opacity > 0.4 && held[1]?.opacity < 1, held);
  }
  await context.close();
}
await browser.close();
ok("the board only read: no write left the page", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1c-board-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors, writes: report.writes }));
process.exit(report.passed ? 0 : 1);
