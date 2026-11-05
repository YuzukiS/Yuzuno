// Where a jump lands settles once (T-19 M4), in the app against an explicit synthetic fixture (no Core):
// - SH:C18, a search result chosen: its message is marked and its ring plays once over settle; the same result
//   chosen again rings again (its mark was still on it), and another result rings on its own message.
// - SH:M14, Back to your reply (a Home reply's Open on Home, then the way back from Home's arrival note): the reply
//   is marked and its ring plays once.
// Under reduced motion each is marked with nothing playing. Desktop 1280×860 and phone 390×844, each with normal and
// reduced motion. Chromium only.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/landing-settle-check.mjs
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { emptyHome, idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

if (!process.env.YUZUNO_UI_DIST) throw new Error("Use an isolated build (YUZUNO_UI_DIST)");
const dist = await realpath(process.env.YUZUNO_UI_DIST);
if (dist === (await realpath("dist").catch(() => null))) throw new Error("Use an isolated build, never web/dist.");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/landing-settle");

const WORKSPACE = "ws-landing-settle";
const base = { cwd: "/fixture", model: "test", color: "green", status: "idle", createdAt: "2026-10-12", updatedAt: "2026-10-12",
  unreadCount: 0, pendingCount: 0, lastSeq: 30, reviewedSeq: 30, harness: "codex", settings: {} };
const agents = [{ ...base, id: "a", name: "Mori", goal: "Landing fixture", projectId: "p1" }];
const projects = [{ id: "p1", name: "Atlas notes", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const filler = "An unrelated loaded message for reading and scrolling. ".repeat(14);
const turns = Array.from({ length: 8 }, (_, i) => ({
  id: `t${i}`, status: "completed",
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `User ${i}: ${filler}` }] },
    { id: `r${i}`, type: "agentMessage", phase: "final_answer", text: `Reply ${i}: ${filler}` },
  ],
}));
turns[2].items[1] = { id: "r2", type: "agentMessage", phase: "final_answer", text: `The LandingToken reply. ${filler}` };
turns[5].items[1] = { id: "r5", type: "agentMessage", phase: "final_answer", text: `Another LandingToken reply. ${filler}` };
const snapshot = { format: 1, projectName: "Atlas notes", sectionKind: "ask", title: "Export paging", question: "How many rows per page?",
  options: [{ id: "fifty", label: "50 rows" }], choice: { id: "fifty", label: "50 rows" }, text: null, form: null };
turns[3].items[0] = { id: "home-reply", type: "userMessage", _yuzunoInput: "home",
  _yuzunoHome: { projectId: "p1", key: "export-paging", version: 3, workspaceId: WORKSPACE, snapshot },
  content: [{ type: "text", text: "Reply from the user on Home: 50 rows." }] };
const detail = { agent: agents[0], turns, pending: [], artifacts: [] };
const owner = { agentId: "a", name: "Mori", state: "active" };
const section = { key: "export-paging", kind: "ask", title: "Export paging", version: 4, owner, updatedAt: "2026-10-12T11:00:00Z",
  updatedTurnId: null, attachments: [], refs: {}, seen: null, history: false,
  body: { root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text: "How many rows per page, now?" } } } },
  ask: { question: "How many rows per page, now?", state: "open", reply: { options: [{ id: "fifty", label: "50 rows" }], freeText: true } } };
const home = { ...emptyHome, order: ["p1"], projects: [{ project: { id: "p1", name: "Atlas notes" },
  agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 }, errors: [], pending: [], jobs: [],
  brief: { version: 9, sections: [section], history: [] }, unseen: 0, missing: [] }] };

const report = { dist, checks: [], failures: [], errors: [], writes: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": fixture\n\n");
        return;
      }
      for await (const _ of request);
      // Answered and not writes: the app's own saves of where an Agent was read, and its read of the linked
      // repositories (a POST). Any other write is one this check refuses.
      const repositories = request.method === "POST" && url.pathname === "/api/collaboration/github_repositories";
      if (request.method !== "GET" && !repositories && !(request.method === "PUT" && url.pathname === "/api/agents/a/reading"))
        report.writes.push(`${request.method} ${url.pathname}`);
      const body = url.pathname === "/api/workspace"
        ? { workspace: { id: WORKSPACE }, projects, agents, runtime: { connected: true }, defaultCwd: "/fixture" }
        : url.pathname === "/api/home" ? home
          : url.pathname === "/api/updates" ? unmanagedUpdates
          : url.pathname === "/api/jobs" ? noJobs
          : url.pathname === "/api/jobs/live" ? noLiveJobs
          : url.pathname === "/api/jobs/budget" ? idleJobsBudget
          : url.pathname === "/api/ci/runs" ? noCiRuns
          : url.pathname === "/api/reviews" ? noReviews
          : url.pathname === "/api/catchup" ? { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } }
          : url.pathname === "/api/agents/a" ? detail
          : url.pathname === "/api/collaboration/github_repositories" ? { repositories: [], links: [] }
            : request.method === "PUT" ? { accepted: true } : {};
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(dist + sep)) throw new Error("outside");
    const content = await readFile(file);
    response.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[extname(file)] || "application/octet-stream" });
    response.end(content);
  } catch (error) {
    response.writeHead(404);
    response.end(String(error));
  }
});

// The focused element: where the jump landed, its mark and the settle ring on it, if one plays.
const landing = (page) => page.evaluate(() => {
  const el = document.activeElement;
  const ring = el?.getAnimations?.().find((a) => a.animationName === "settle-ring" && a.playState !== "finished") ?? null;
  return { item: el?.dataset?.itemId ?? null, marked: !!el?.classList?.contains("source-highlight"),
    ring: ring ? { state: ring.playState, t: Math.round(ring.currentTime ?? -1), duration: ring.effect?.getTiming?.().duration ?? null } : null };
});
const frames = (page, n) => page.evaluate((n) => new Promise((done) => { const f = (k) => k ? requestAnimationFrame(() => f(k - 1)) : done(); f(n); }), n);
/** What a landing showed: right as it landed, then once the settle's time is up. */
async function watch(page, item) {
  await page.waitForFunction((item) => document.activeElement?.dataset?.itemId === item, item, { timeout: 10_000 });
  await frames(page, 2);
  const at = await landing(page);
  await page.waitForTimeout(1400);
  return { at, after: await landing(page) };
}
/** Marked; its ring playing once from the landing over settle (1200 ms), or nothing under reduced motion; and once
    the settle's time is up nothing plays and the mark stays. */
const settled = (seen, item, reduced) => !!seen && seen.at.item === item && seen.at.marked && seen.after.marked
  && !seen.after.ring && (reduced ? !seen.at.ring : !!seen.at.ring && seen.at.ring.duration === 1200 && seen.at.ring.t < 400);

let browser;
try {
  await mkdir(output, { recursive: true });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
  for (const run of [
    { name: "desktop", viewport: { width: 1280, height: 860 }, reduced: false },
    { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reduced: true },
    { name: "phone", viewport: { width: 390, height: 844 }, reduced: false, phone: true },
    { name: "phone-reduced", viewport: { width: 390, height: 844 }, reduced: true, phone: true },
  ]) {
    const tag = run.name;
    const motion = (normal, reduced) => (run.reduced ? reduced : normal);
    const measured = (report.measured[tag] = {});
    const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reduced ? "reduce" : "no-preference",
      locale: "en-US", hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem("yuzuno.selected", JSON.stringify("a")));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      // A phone may open on its Agent list: then Mori is opened from it.
      await page.locator('.app.phone-list .agent-row, [data-item-id="r7"]').first().waitFor({ timeout: 15_000 });
      if (await page.locator(".app.phone-list").count()) await page.locator(".app.phone-list .agent-row").first().click();
      await page.locator('[data-item-id="r7"]').waitFor({ timeout: 15_000 });
      const trigger = page.getByRole("button", { name: "Search conversation", exact: true });
      const dialog = page.getByRole("dialog", { name: "Search conversation" });
      const choose = async (index, item) => {
        await trigger.click();
        await dialog.getByRole("searchbox").fill("landingtoken");
        await dialog.locator(".conversation-search-result").nth(index).click();
        await dialog.waitFor({ state: "detached" });
        return watch(page, item);
      };
      const step = async (key, fn) => { try { measured[key] = await fn(); } catch (error) { measured[key] = { error: String(error).slice(0, 300) }; } };

      await step("first", () => choose(0, "r2"));
      ok(`${tag}: a search result chosen lands on its message, marked, ${motion("its ring playing once over settle", "with nothing playing")} (C18)`,
        settled(measured.first, "r2", run.reduced), measured.first);
      await step("again", () => choose(0, "r2"));
      ok(`${tag}: the same result chosen again, its mark still there, ${motion("rings again", "is marked with nothing playing")} (C18)`,
        settled(measured.again, "r2", run.reduced), measured.again);
      await step("another", () => choose(1, "r5"));
      ok(`${tag}: another result ${motion("rings on its own message", "is marked with nothing playing")} (C18)`,
        settled(measured.another, "r5", run.reduced), measured.another);

      // Back near the reply's Turn, then its Open on Home, and Back to your reply from Home's note.
      await step("back", async () => {
        await choose(0, "r2");
        const reply = page.locator('[data-item-id="home-reply"]');
        await reply.scrollIntoViewIfNeeded();
        await reply.getByRole("button", { name: "Open on Home" }).click();
        const back = page.getByRole("button", { name: "Back to your reply" });
        await back.waitFor({ timeout: 10_000 });
        await back.click();
        return watch(page, "home-reply");
      });
      ok(`${tag}: Back to your reply lands on the reply, marked, ${motion("its ring playing once over settle", "with nothing playing")} (M14)`,
        settled(measured.back, "home-reply", run.reduced), measured.back);
    } catch (error) {
      ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
    }
    await page.screenshot({ path: resolve(output, `${tag}-end.png`) }).catch(() => {});
    await context.close();
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
ok("no page errors", report.errors.length === 0, report.errors);
ok("writes: none but the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
await writeFile(resolve(output, "landing-settle-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exit(1);
