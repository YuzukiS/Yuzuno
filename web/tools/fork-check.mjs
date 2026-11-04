// T-10 Fork, OpenCode's "Fork" in Chromium on a production build of the app, with no Core: the reads this check
// knows are answered here; any other gets {} and is listed in the report (unknownGets). Mori is an idle OpenCode
// Agent with three completed turns; Hana a Codex one. On desktop 1280×860 and phone 390×844:
// - each completed turn of Mori's shows Fork beside Rewind, in view, overlapping nothing;
// - Fork on the second turn previews that very turn: the preview asked for it, "Keeps 2 turns, through this one";
// - the keyboard: the new agent's name has the focus, Escape closes the dialog with nothing asked, and Enter in the
//   name forks once;
// - the fork opens the new Agent, Mori (fork), with nothing sent to it;
// - a fork whose answer comes after Hana was shown opens nothing: Hana stays.
// Writes: none but the preview and the fork asked, and the app's own saves of where an Agent was read. Served from
// http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/fork-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/fork-check");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], previews: [], forks: [], measures: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "deepseek/deepseek-flash", color: "green", status: "idle", createdAt: "",
  updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: null, harness: "opencode", connectionState: "connected",
  settings: { reasoningEffort: "high", approvalPolicy: "on-request", sandbox: "workspace-write" } };
const hana = { ...agent, id: "b", name: "Hana", color: "blue", harness: "codex" };
const forked = { ...agent, id: "c", name: "Mori (fork)" };
const turn = (id, ask, answer) => ({ id, status: "completed", items: [
  { id: `${id}-ask`, type: "userMessage", content: [{ type: "text", text: ask }] },
  { id: `${id}-reply`, type: "agentMessage", text: answer },
] });
const turns = [turn("t1", "Start", "Started."), turn("t2", "Go on", "Went on."), turn("t3", "Finish", "Finished.")];
const detail = (who, held) => ({ agent: who, pending: [], messageReceipts: [], artifacts: [], turns: held });
const noInputs = { inputs: [], hasBefore: false, total: 0 };
let agents, hold, release;
// Each page asks afresh: what it previewed and forked is its own (kept in each check's detail).
const fresh = () => { agents = [agent, hana]; hold = false; release = undefined; report.previews = []; report.forks = []; };
const gets = () => ({
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": { agents: {} }, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents, projects: [], runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": detail(agent, turns),
  "/api/agents/b": detail(hana, [turn("h-0", "Read the notes.", "Read.")]),
  "/api/agents/c": detail(forked, [turn("c-1", "Start", "Started."), turn("c-2", "Go on", "Went on.")]),
  "/api/agents/a/opencode/fork": { state: "none" },
  "/api/agents/a/rewind/attempt": { attempt: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
  "/api/machines": { machines: [] },
  ...Object.fromEntries(["a", "b", "c"].flatMap((id) => [[`/api/agents/${id}/reading`, { handoff: null }],
    [`/api/agents/${id}/conversation/inputs`, noInputs]])),
});
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: { accepted: true } });
      if (request.method() === "POST" && path === "/api/agents/a/opencode/fork/preview") {
        const body = request.postDataJSON();
        report.previews.push(body.turnId);
        const kept = turns.findIndex((t) => t.id === body.turnId) + 1;
        return route.fulfill({ json: { turnId: body.turnId, keptTurns: kept, laterTurns: turns.length - kept, messages: kept * 2, cwd: "/w",
          name: "Mori (fork)", model: agent.model, variant: "high" } });
      }
      if (request.method() === "POST" && path === "/api/agents/a/opencode/fork") {
        const body = request.postDataJSON();
        report.forks.push(body);
        if (hold) await new Promise((resolve) => { release = resolve; });
        if (!agents.includes(forked)) agents = [...agents, forked];
        return route.fulfill({ json: { state: "completed", requestId: body.requestId, agent: forked, connected: true, warnings: [] } });
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
  { name: "desktop", viewport: { width: 1280, height: 860 } },
  { name: "phone", viewport: { width: 390, height: 844 }, phone: true },
];
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const open = async () => {
    fresh();
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 300)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(() => {
      window.EventSource = class { constructor() {} addEventListener() {} close() {} };
      localStorage.clear();
      localStorage.setItem("yuzuno.selected.fixture", JSON.stringify("a"));
    });
    await page.goto("http://127.0.0.1:4324/");
    if (run.phone && !(await page.locator('[data-turn-id="t3"]').count()))
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click({ timeout: 5000 }).catch(() => {});
    await page.locator('[data-turn-id="t3"]').waitFor({ timeout: 15_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    return page;
  };
  const shown = (page) => page.locator(".agent-row.selected").first().getAttribute("data-agent-id").catch(() => null);
  try {
    {
      const page = await open();
      // Fork beside Rewind on each completed turn, in view, overlapping nothing.
      const placed = [];
      for (const id of ["t1", "t2", "t3"]) {
        const at = page.locator(`[data-turn-id="${id}"]`);
        await at.scrollIntoViewIfNeeded();
        const fork = await at.locator(".fork-open").boundingBox();
        const rewind = await at.locator(".rewind-open").boundingBox();
        const others = await at.locator(".reply-actions > :not(.fork-open)").evaluateAll((els) => els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, name: el.className };
        }));
        placed.push({ id, fork, rewind, clash: fork ? others.filter((o) => o.width && overlaps(fork, o)).map((o) => o.name) : null });
      }
      report.measures[`${tag}: placed`] = placed;
      ok(`${tag}: Fork beside Rewind on each completed turn, in the window and overlapping nothing`,
        placed.every((p) => p.fork && p.rewind && p.fork.width > 0 && p.fork.x >= 0 && p.fork.x + p.fork.width <= run.viewport.width && p.clash.length === 0),
        placed);
      // The turn it is on is the boundary previewed.
      await page.locator('[data-turn-id="t2"] .fork-open').click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Keeps 2 turns, through this one").waitFor({ timeout: 10_000 });
      ok(`${tag}: Fork on the second turn previews that turn`, report.previews.at(-1) === "t2", report.previews);
      // The keyboard: the name has the focus; Escape closes with nothing asked.
      const focused = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') ? document.activeElement.tagName : null);
      ok(`${tag}: the new agent's name has the focus`, focused === "INPUT", focused);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached", timeout: 5000 });
      ok(`${tag}: Escape closes the dialog, nothing asked`, report.forks.length === 0, report.forks);
      // Enter in the name forks once, and the new Agent opens with nothing sent to it.
      await page.locator('[data-turn-id="t2"] .fork-open').click();
      await dialog.getByText("Keeps 2 turns, through this one").waitFor({ timeout: 10_000 });
      await page.keyboard.press("End");
      await page.keyboard.type(" again");
      await page.keyboard.press("Enter");
      await page.locator('[data-turn-id="c-2"]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(400);
      ok(`${tag}: Enter forks once, from that turn, with the name typed`,
        report.forks.length === 1 && report.forks[0].turnId === "t2" && report.forks[0].name === "Mori (fork) again", report.forks);
      ok(`${tag}: the new Agent opens`, (await shown(page)) === "c", await shown(page));
      ok(`${tag}: nothing written but the preview and the fork`, report.writes.length === 0, report.writes);
      await page.screenshot({ path: join(output, `${tag}-forked.png`) });
      await page.close();
    }
    {
      const page = await open();
      hold = true;
      await page.locator('[data-turn-id="t1"] .fork-open').click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Keeps 1 turn, through this one").waitFor({ timeout: 10_000 });
      await page.screenshot({ path: join(output, `${tag}-dialog.png`) });
      await dialog.getByRole("button", { name: "Fork", exact: true }).click();
      for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
      ok(`${tag}: the fork is asked once`, report.forks.length === 1 && !!release, report.forks);
      // Hana is shown while its answer is out; when it comes, nothing opens.
      await page.evaluate(() => [...document.querySelectorAll('.agent-row[data-agent-id="b"] .agent-select')].at(-1)?.click());
      await page.locator('[data-turn-id="h-0"]').waitFor({ timeout: 10_000 });
      release?.();
      await page.waitForTimeout(800);
      ok(`${tag}: a fork that ends after Hana was shown opens nothing: Hana stays`, (await shown(page)) === "b", await shown(page));
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
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "fork-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
