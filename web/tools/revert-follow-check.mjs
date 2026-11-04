// T-10, an OpenCode revert's dialog over a followed conversation leaves it followed (Lead 4153, 4154), in
// Chromium on a production build of the app, with no Core: the reads this check knows are answered here; any
// other gets {} and is listed in the report (unknownGets). The dialog is portaled out of the conversation's
// scroller but under it in React, so what the reader does in it reaches the scroller's handlers through React.
// Mori is an idle OpenCode Agent whose conversation scrolls and is followed: its end is in view. Then:
// - the revert of its last turn is previewed; its long original input is opened and, inside it, scrolled by
//   wheel up and down and by Home, PageUp, End, PageDown, ArrowUp and ArrowDown (desktop), or by swipes up and
//   down (phone): no read of the conversation is made meanwhile (nothing sends it to its end or holds it);
// - the dialog closed, a turn that arrives is followed: the end stays in view, read as the latest;
// - control: in the conversation itself, a wheel up (desktop) or a swipe toward the start (phone) does take
//   the reader's window, so a turn that arrives then is not followed. The reader-row check keeps the rest of
//   the conversation's own gestures.
// Desktop 1280×860 and phone 390×844. Writes: none but the preview, and the app's own saves of where an Agent
// was read. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/revert-follow-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/revert-follow");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], previews: 0, readingSaves: 0, measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "opencode", connectionState: "connected" };
const hana = { ...agent, id: "b", name: "Hana", color: "blue", harness: "codex" };
const turn = (id, ask, answer) => ({ id, status: "completed", items: [
  { id: `${id}-ask`, type: "userMessage", content: [{ type: "text", text: ask }] },
  { id: `${id}-reply`, type: "agentMessage", text: answer },
] });
const long = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of what was asked, long enough to scroll in its own box.`).join("\n");
let turns;
/** Each read of Mori's conversation on the page now open: "latest", or the Turn its window starts at. */
let reads = [];
const fresh = () => {
  reads = [];
  turns = [
    ...Array.from({ length: 6 }, (_, i) => turn(`old-${i}`, `Round ${i + 1}`, "Checked.\n\n" + "The reading place stays steady. ".repeat(12))),
    turn("last", long, "Done."),
  ];
};
const detail = () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns, conversation: {
  index: turns.map((t, i) => ({ ...t, number: i + 1, itemCount: t.items.length, items: [t.items[0]] })),
  questions: [], nativeClientIds: [],
  start: JSON.stringify([turns[0].id, turns[0].items[0].id]),
  end: JSON.stringify([turns.at(-1).id, turns.at(-1).items.at(-1).id]),
  hasBefore: false, hasAfter: false, totalItems: turns.reduce((n, t) => n + t.items.length, 0),
} });
const hanaDetail = { agent: hana, pending: [], messageReceipts: [], artifacts: [], turns: [turn("h-0", "Read the notes.", "Read.")] };
const preview = () => ({ previewId: "revert_1", available: true, removedTurns: 1, keptTurns: turns.length - 1, draft: long, files: [] });
const noInputs = { inputs: [], hasBefore: false, total: 0 };
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": { agents: {} }, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent, hana], projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": detail(),
  "/api/agents/b": hanaDetail,
  "/api/agents/a/reading": { handoff: null },
  "/api/agents/b/reading": { handoff: null },
  "/api/agents/a/conversation/inputs": noInputs,
  "/api/agents/b/conversation/inputs": noInputs,
  "/api/agents/a/rewind/attempt": { attempt: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
  "/api/machines": { machines: [] },
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) {
        report.readingSaves++;
        return route.fulfill({ json: { accepted: true } });
      }
      if (request.method() === "POST" && path === "/api/agents/a/rewind/preview") {
        report.previews++;
        return route.fulfill({ json: preview() });
      }
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    if (path === "/api/agents/a") reads.push(url.searchParams.get("turnId") ? `turnId=${url.searchParams.get("turnId")}` : "latest");
    const known = gets()[path];
    if (known !== undefined) return route.fulfill({ json: known });
    if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
    return route.fulfill({ json: {} });
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

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 } },
  { name: "phone", viewport: { width: 390, height: 844 }, phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  /** The app on Mori, its conversation followed at its end. */
  const open = async () => {
    fresh();
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(() => {
      window.EventSource = class { constructor() { window.testEvents = this; } addEventListener() {} close() {} };
      if (!sessionStorage.getItem("revert-follow-started")) {
        localStorage.clear();
        sessionStorage.setItem("revert-follow-started", "1");
      }
      localStorage.setItem("yuzuno.selected.fixture", JSON.stringify("a"));
    });
    await page.goto("http://127.0.0.1:4323/");
    if (run.phone && !(await page.locator('[data-turn-id="last"]').count()))
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click({ timeout: 5000 }).catch(() => {});
    await page.locator('[data-turn-id="last"]').waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    return page;
  };
  const gap = (page) => page.locator(".conversation-scroll").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  /** Core says Mori changed (the app reads it again), and a new turn is in it. */
  const arrive = async (page, id) => {
    turns.push(turn(id, "And one more thing.", "Done too."));
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/agents/a");
    await page.evaluate(() => window.testEvents.onmessage?.({ data: "{}" }));
    await read;
    await page.locator(`[data-turn-id="${id}"]`).waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(600);
  };
  /** A finger's swipe over `box`, by `dy` px a step, through Chromium's input pipeline. */
  const swipe = async (page, box, dy) => {
    const cdp = await context.newCDPSession(page);
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * dy }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(400);
  };
  try {
    // The revert's dialog, and what the reader does inside its long original input.
    {
      const page = await open();
      const followed = await gap(page);
      await page.locator('[data-turn-id="last"] .rewind-open').click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Revert", exact: true }).waitFor({ timeout: 10_000 });
      const summary = dialog.locator("summary", { hasText: "Original input" });
      if (run.phone) await summary.tap(); else await summary.click();
      const text = dialog.locator(".rewind-input");
      await text.waitFor();
      const before = reads.length;
      const inner = () => text.evaluate((el) => ({ top: Math.round(el.scrollTop), height: el.scrollHeight, shown: el.clientHeight }));
      const start = await inner();
      if (run.phone) {
        const box = await text.boundingBox();
        await swipe(page, box, -25);
        await swipe(page, box, 25);
      } else {
        await text.hover();
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(300);
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(300);
        await summary.focus();
        for (const key of ["End", "PageDown", "ArrowDown", "Home", "PageUp", "ArrowUp"]) await page.keyboard.press(key);
      }
      await page.waitForTimeout(500);
      const moved = await inner();
      const during = reads.slice(before);
      report.measures[`${tag}: in the dialog`] = { followed, start, moved, during };
      ok(`${tag}: the original input scrolls within the dialog (${JSON.stringify({ start, moved })})`, moved.height > moved.shown, { start, moved });
      ok(`${tag}: nothing done in the dialog reads the conversation, to its end or anywhere else (${JSON.stringify(during)})`, during.length === 0, { during });
      // The dialog's own Close, among its actions (its corner's close button has the same name).
      await dialog.locator(".modal-actions").getByRole("button", { name: "Close" }).click();
      await dialog.waitFor({ state: "detached", timeout: 5000 });
      await page.waitForTimeout(300);
      const closed = await gap(page);
      await arrive(page, "after-dialog");
      const after = { followed, closed, gap: await gap(page), read: reads.at(-1), reads: [...reads] };
      report.measures[`${tag}: after the dialog`] = after;
      ok(`${tag}: the dialog closed, a turn that arrives is followed and read as the latest (${JSON.stringify({ followed, closed, gap: after.gap, read: after.read })})`,
        followed <= 1 && after.gap <= 1 && after.read === "latest", after);
      await page.close();
    }
    // Control: the conversation's own gesture does take the reader's window.
    {
      const page = await open();
      if (run.phone) {
        const box = await page.locator(".conversation-scroll").boundingBox();
        await swipe(page, { ...box, height: box.height / 2 }, 40);
      } else {
        await page.locator('[data-turn-id="old-5"]').hover();
        await page.mouse.wheel(0, -500);
      }
      await page.waitForTimeout(500);
      await arrive(page, "after-own");
      const own = { gap: await gap(page), read: reads.at(-1), reads: [...reads] };
      report.measures[`${tag}: own gesture`] = own;
      ok(`${tag}: control, the conversation's own gesture toward its start takes the reader's window: a turn that arrives then is not followed (${JSON.stringify({ gap: own.gap, read: own.read })})`,
        own.gap > 1 && own.read === "turnId=old-0", own);
      await page.close();
    }
  } catch (error) {
    report.failures.push({ name: `${tag}: sequence ran to its end`, detail: String(error?.stack || error).slice(0, 1200) });
    console.log(`FAIL ${tag}: sequence ran to its end: ${String(error).slice(0, 300)}`);
  } finally {
    await context.close();
  }
}
await browser.close();
ok("writes: none but the preview and the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "revert-follow-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
