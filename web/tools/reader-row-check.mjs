// T-19, a row the reader opens at the end of a followed conversation stays where they pressed it (Lead 3812,
// B), in Chromium on a production build of the app, with every API answered here (no Core).
// The conversation scrolls and is followed: its end is in view. Then:
// - a tool row near the end is opened by a pointer (desktop) or a tap (phone), by Enter and by Space on its
//   focused summary: the row stays where it was, however much it grows below;
// - once a pointer or a tap has opened it, a live update to the Turn does not move it either; Back to latest
//   shows, since the end is out of view; pressed, the end is in view again, and a row that arrives after
//   that is followed;
// - guards for following itself: a row that arrives while nothing was pressed keeps the end in view, and so
//   does a composer that grows by three lines.
// Desktop 1280×860 and phone 390×844, each with normal and reduced motion. Writes: none but the app's own
// saves of where an Agent was read. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/reader-row-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/reader-row");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], readingSaves: 0, measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "working", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "codex", connectionState: "connected" };
const shell = (id, command, status = "completed") => ({ id, type: "commandExecution", command, status, ...(status === "completed" ? { exitCode: 0 } : {}),
  aggregatedOutput: `$ ${command}\n` + Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n") });
let live;
const fresh = () => {
  live = { id: "live", status: "inProgress", items: [
    { id: "ask", type: "userMessage", content: [{ type: "text", text: "Check the build, then run the tests again." }] },
    { id: "progress", type: "agentMessage", phase: "commentary", text: "Reading the build first." },
    shell("tool-a", "npm run build"),
    shell("tool-b", "npm test"),
  ] };
};
const detail = () => ({ agent, pending: [], messageReceipts: [], artifacts: [], turns: [
  ...Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, status: "completed", items: [
    { id: `old-ask-${i}`, type: "userMessage", content: [{ type: "text", text: `Round ${i + 1}` }] },
    { id: `old-reply-${i}`, type: "agentMessage", text: "Checked.\n\n" + "Tool activity and the reading place stay steady. ".repeat(10) },
  ] })),
  live,
] });
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": { agents: {} }, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": detail(),
  "/api/agents/a/reading": { handoff: null },
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
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
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
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  /** The app on agent a, its conversation followed at its end. */
  const open = async () => {
    fresh();
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(() => {
      window.EventSource = class { constructor() { window.testEvents = this; } addEventListener() {} close() {} };
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
    });
    await page.goto("http://127.0.0.1:4322/");
    // A phone may open on the Agent list: open Mori's conversation from it.
    if (run.phone && !(await page.locator("#item-tool-b").count()))
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click({ timeout: 5000 }).catch(() => {});
    await page.locator("#item-tool-b").waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    return page;
  };
  const gap = (page) => page.locator(".conversation-scroll").evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const top = (page, selector) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().top * 10) / 10);
  /** Core says the Turn changed (the app reads it again), and `item` is in it. */
  const arrive = async (page, item) => {
    live.items.push(item);
    const read = page.waitForResponse((r) => r.url().endsWith("/api/agents/a"));
    await page.evaluate(() => window.testEvents.onmessage?.({ data: "{}" }));
    await read;
    await page.locator(`#item-${item.id}`).waitFor({ state: "attached", timeout: 10_000 });
    await page.waitForTimeout(500);
  };
  const SUMMARY = "#item-tool-b > summary";
  const press = async (page, how) => {
    const summary = page.locator(SUMMARY);
    if (how === "pointer") return summary.click();
    if (how === "touch") return summary.tap();
    await summary.focus();
    await page.keyboard.press(how === "Enter" ? "Enter" : " ");
  };
  const hows = run.phone ? ["touch", "Enter", "Space"] : ["pointer", "Enter", "Space"];
  try {
    // Guard: following itself, with nothing pressed.
    {
      const page = await open();
      const before = await gap(page);
      await arrive(page, shell("tool-c", "npm run lint"));
      const after = await gap(page);
      ok(`${tag}: following, a row that arrives keeps the end in view (gap ${before} -> ${after} px)`, before <= 1 && after <= 1, { before, after });
      await page.close();
    }
    for (const how of hows) {
      const page = await open();
      const at = await gap(page);
      const before = await top(page, SUMMARY);
      await press(page, how);
      await page.waitForTimeout(700);
      const opened = await page.locator("#item-tool-b").evaluate((el) => el.open);
      const after = await top(page, SUMMARY);
      report.measures[`${tag}: ${how}`] = { at, before, after, opened, gap: await gap(page) };
      ok(`${tag}: a row at the end opened by ${how === "pointer" || how === "touch" ? `a ${how === "pointer" ? "pointer" : "tap"}` : how}: it stays where it was (top ${before} -> ${after} px, opened ${opened})`,
        at <= 1 && opened && Math.abs(after - before) <= 1, { at, before, after, opened });
      if (how === "pointer" || how === "touch") {
        // Then a live update to the Turn: the reader's row stays, and Back to latest shows.
        await arrive(page, shell("tool-d", "npm run typecheck"));
        const later = await top(page, SUMMARY);
        ok(`${tag}: after the reader opened a row, a live update does not move it (top ${before} -> ${later} px)`, Math.abs(later - before) <= 1, { before, later });
        const latest = page.locator(".jump-latest");
        const shown = await latest.isVisible();
        let back = null;
        if (shown) {
          await latest.click();
          await page.waitForTimeout(400);
          const atEnd = await gap(page);
          await arrive(page, shell("tool-e", "npm run format"));
          back = { atEnd, followed: await gap(page) };
        }
        ok(`${tag}: Back to latest shows; pressed, the end is in view and a row that arrives then is followed (${JSON.stringify({ shown, back })})`,
          shown && !!back && back.atEnd <= 1 && back.followed <= 1, { shown, back });
      }
      await page.close();
    }
    // Guard: a composer that grows keeps the followed end in view.
    {
      const page = await open();
      const before = await gap(page);
      await page.getByRole("textbox", { name: "Message Mori" }).fill("First line\nSecond line\nThird line\nFourth line");
      await page.waitForTimeout(400);
      const after = await gap(page);
      ok(`${tag}: following, a composer that grows by three lines keeps the end in view (gap ${before} -> ${after} px)`, before <= 1 && after <= 1, { before, after });
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
ok("writes: none but the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "reader-row-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
