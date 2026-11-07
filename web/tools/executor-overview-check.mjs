// T-43 S3: an executor's session tabs and its Overview in Chromium (the
// user's t43-templates preview), with every API answered here (no Core, no
// CLI, no daily configuration) and synthetic executors: one at work with a
// PR in review, one waiting for your approval, one archived with its result.
// At 1440 and 390 (a phone, touch), light and dark, English and Chinese:
// - an executor opens on its Overview, the tab bar above it; its
//   Conversation and the composer are hidden, not gone;
// - nothing in the Overview is wider than it, no step's label runs into
//   its record, and every card is inside the pane;
// - the steps show five, then all on request;
// - the waiting executor's request card is in its Overview only;
// - on a phone each tab, the task link and the steps toggle are 44 px tall;
// - its Conversation shows the composer again; back to the Overview.
// Screenshots of each, for the design Ask.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-overview-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-43 S3", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], measures: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-overview.test";

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const head = "7d10aa".padEnd(40, "3");
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "codex", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle" };
const lifecycle = (id, key, title, template, extra = {}) => ({ state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead 2" },
  task: { id: key, title }, template, dispatchedAt: ago(72.5), since: ago(6.5), ...extra });
const RED = { id: "red-first", label: "Red first" }, DESIGN = { id: "design-first", label: "Design first" };
// Synthetic executors (names and texts made up for this check).
const agents = [
  { ...base, id: "lead", name: "Dev Lead 2", kind: "lead", status: "working", workSummary: { kind: "progress", source: "agent", text: "Merging #702" } },
  { ...base, id: "yn22", name: "YN-22 · Red first", kind: "executor", status: "working",
    workSummary: { kind: "progress", source: "agent", text: "Review round 1 running on #688 at 7d10aa" },
    executor: lifecycle("yn22", "YN-22", "Fix the selection that jumps after a refresh", RED) },
  { ...base, id: "yn21", name: "YN-21 · Design first", kind: "executor", status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Allow npm run build", requestId: "q1" },
    executor: lifecycle("yn21", "YN-21", "Export and import device preferences", DESIGN) },
  { ...base, id: "yn29", name: "YN-29 · Small fix", kind: "executor", closedAt: ago(30), releasedAt: ago(30), releasedBy: "user",
    executor: lifecycle("yn29", "YN-29", "Status bar wording", { id: "small-fix", label: "Small fix" }, { state: "archived", since: ago(30) }) },
];
const approval = { id: "q1", agentId: "yn21", method: "item/commandExecution/requestApproval", createdAt: ago(12),
  params: { command: "npm run build", cwd: "/fixture/app/.worktrees/yn-21", reason: "Build the design note's preview" } };
const materials = (worktree, acceptance) => ({ capturedAt: ago(72), acceptance, repository: "owner/repo", baseSha: "635caab1".padEnd(40, "0"),
  worktree, returnRequirements: "Red then green; PR at a frozen head; evidence Job", handoverVersion: 3,
  contextSummary: "The selection jumps to the first row after a refresh when the list is filtered. Reproduced with a synthetic list of 40 rows." });
const overview = {
  yn22: {
    agentId: "yn22", lifecycle: agents[1].executor, task: { id: "YN-22", title: agents[1].executor.task.title, status: "doing" },
    template: { ...RED, deliveryMode: "pr" }, materials: materials("/fixture/app/.worktrees/yn-22", "A failing test first; the fix leaves the test as it is; two review rounds"),
    steps: [
      { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
      { kind: "job", label: "Write the failing test, record it red", state: "done", ref: { kind: "job", id: "j1", name: "red 1/1", status: "failed" } },
      { kind: "work", label: "Fix (the test unchanged)", state: "done" },
      { kind: "job", label: "Green", state: "done", ref: { kind: "job", id: "j2", name: "green 24/24", status: "succeeded" } },
      { kind: "pr", label: "PR at a frozen head", state: "done", ref: { kind: "pr", number: 688, url: "https://github.com/owner/repo/pull/688", state: "open" } },
      { kind: "review", rounds: 2, state: "doing", ref: { kind: "review", id: "r1", round: 1, conclusion: null, forCurrentHead: true } },
      { kind: "ci", state: "done", ref: { kind: "ci", state: "success", headSha: head } },
      { kind: "merge", label: "Merge (Dev 9 / the merge queue)", state: "todo" },
    ],
    jobs: [{ id: "j2", name: "green 24/24", status: "succeeded", finishedAt: ago(20) }, { id: "j1", name: "red 1/1 (the assertion \"selected stays\")", status: "failed", reason: "exit-code", finishedAt: ago(40) }],
    pullRequest: { number: 688, url: "https://github.com/owner/repo/pull/688", title: "Keep the selection after a refresh", state: "open", headSha: head,
      ci: { state: "success", headSha: head }, latestReview: { reviewId: "r1", round: 1, status: "running", conclusion: null, forCurrentHead: true },
      changes: { additions: 46, deletions: 9, files: 3 } },
    merge: null, result: null,
  },
  yn21: {
    agentId: "yn21", lifecycle: agents[2].executor, task: { id: "YN-21", title: agents[2].executor.task.title, status: "doing" },
    template: { ...DESIGN, deliveryMode: "pr" }, materials: materials("/fixture/app/.worktrees/yn-21", "Export and import cover appearance, language and notifications; older files import"),
    steps: [
      { kind: "materials", state: "done", ref: { kind: "mail", readAt: ago(70) } },
      { kind: "result", label: "Design note as a result", state: "done", ref: { kind: "result", id: "2b7e41c09d", reportedAt: ago(30) } },
      { kind: "gate", label: "Approve the design note", approver: "user", state: "blocked" },
      { kind: "work", label: "Slices (3)", state: "todo" },
      { kind: "job", label: "An evidence Job each", state: "todo" },
      { kind: "pr", state: "todo" }, { kind: "review", rounds: 2, state: "todo" }, { kind: "ci", state: "todo" }, { kind: "merge", state: "todo" },
    ],
    jobs: [], pullRequest: null, merge: null,
    result: { id: "2b7e41c09d", summary: "Design note: 3 interfaces, 2 states, the evidence format. Read-only until approved.", reportedAt: ago(30), status: "submitted" },
  },
  yn29: {
    agentId: "yn29", lifecycle: agents[3].executor, task: { id: "YN-29", title: "Status bar wording", status: "done" },
    template: { id: "small-fix", label: "Small fix", deliveryMode: "pr" }, materials: null,
    steps: [{ kind: "materials", state: "done" }, { kind: "work", label: "Change one line", state: "done" },
      { kind: "job", label: "Focused check", state: "done", ref: { kind: "job", id: "j9", name: "statusbar words", status: "succeeded" } },
      { kind: "pr", state: "done", ref: { kind: "pr", number: 705 } }, { kind: "review", state: "done", ref: { kind: "review", round: 1, conclusion: "no_findings" } },
      { kind: "ci", state: "done", ref: { kind: "ci", state: "success" } }, { kind: "merge", state: "done", ref: { kind: "merge", id: "m5", state: "merged" } }],
    jobs: [{ id: "j9", name: "statusbar words", status: "succeeded", finishedAt: ago(50) }],
    pullRequest: { number: 705, url: "https://github.com/owner/repo/pull/705", title: "Status bar wording", state: "merged", ci: { state: "success" },
      latestReview: { reviewId: "r9", round: 1, status: "completed", conclusion: "no_findings", forCurrentHead: true }, changes: { additions: 1, deletions: 1, files: 1 } },
    merge: { id: "m5", state: "merged", reason: null },
    result: { id: "r29", summary: "One line changed; the focused check passed; merged as #705.\nNo behaviour change, so no red test.", reportedAt: ago(35), status: "accepted" },
  },
};
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const home = () => ({ generatedAt: ago(0), order: ["p1"], needsYou: [], projects: [{ project: { id: "p1", name: "Yuzuno" },
  agents: { working: 2, idle: 0, waiting: 1, error: 0, offline: 0, total: 4 }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 1, history: [], sections: [] } }] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function route(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    if (op === "task_list") return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false, nextAfterSeq: null } });
    if (op === "github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (method !== "GET") return route.fulfill({ json: {} });
  const read = path.match(/^\/api\/agents\/([^/]+)\/executor$/);
  if (read) return overview[read[1]] ? route.fulfill({ json: overview[read[1]] }) : route.fulfill({ status: 404, json: { error: "This Agent is no executor", code: "not_executor" } });
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: detail[1] === "yn21" ? [approval] : [],
    messageReceipts: [], artifacts: [], turns: [] } });
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-overview" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home(), "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/executors/live": { executors: {} },
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
}

// The Overview as drawn: overflow, steps whose label runs into their record, cards outside the pane, target heights.
const measure = (page) => page.evaluate(() => {
  const panel = document.querySelector("#executor-overview");
  const box = panel.getBoundingClientRect();
  const steps = [...panel.querySelectorAll(".executor-overview-steps .step")].map((s) => {
    const label = s.querySelector(".label").getBoundingClientRect(), ref = s.querySelector(".ref").getBoundingClientRect();
    return { text: s.querySelector(".label").textContent, overlap: ref.width > 0 && label.right > ref.left + 1 && label.bottom > ref.top + 1 && label.top < ref.bottom - 1 };
  });
  const wide = [...panel.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
  }).map((el) => el.className || el.tagName);
  const height = (selector) => [...document.querySelectorAll(selector)].map((el) => Math.round(el.getBoundingClientRect().height));
  const shown = (selector) => { const el = document.querySelector(selector); return !!el && el.getClientRects().length > 0; };
  return {
    overflowX: panel.scrollWidth > panel.clientWidth + 1, wide, overlaps: steps.filter((s) => s.overlap).map((s) => s.text), steps: steps.length,
    tabs: height(".executor-tabs [role=tab]"), link: height(".executor-overview-chips .chip.link"), more: height(".executor-overview-card .more"),
    conversation: shown(".conversation-body"), composer: shown(".composer-area"), cards: panel.querySelectorAll(".pending-card").length,
    bodyCards: document.querySelectorAll(".conversation-body .pending-card").length,
  };
});

async function run({ width, height, theme, lang = "en" }) {
  const phone = width < 600;
  const tag = `${width}-${theme}-${lang}`;
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail: 240 }));
    localStorage.setItem("yuzuno.archivedExecutorsOpen.ws-executor-overview", JSON.stringify(["all"]));
    // The task board is its own check's: a task link is counted, not opened.
    window.__tasks = [];
    window.addEventListener("yuzuno:open-task-review", (event) => { window.__tasks.push(event.detail?.taskId ?? null); event.stopImmediatePropagation(); });
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const open = async (id) => {
    // A phone shows one at a time: back to its list first.
    if (phone && await page.locator(".phone-back").isVisible()) await press(page.locator(".phone-back"));
    // An archived one opened shows the closed Agents: back to the open ones for an open one.
    if (!agents.find((a) => a.id === id).closedAt && !(await page.locator(`.agent-list article[data-agent-id="${id}"]`).count()))
      await press(page.locator(".agent-scope button").first());
    await press(page.locator(`.agent-list article[data-agent-id="${id}"] .agent-select`));
    await page.locator("#executor-overview .executor-overview-head").waitFor({ timeout: 10_000 });
    await page.mouse.move(0, 0);
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(output, `${tag}-${name}.png`) });
    report.screenshots.push(`${tag}-${name}`);
  };
  try {
    await page.goto(`https://${HOST}/`);
    await page.locator('.agent-list article[data-agent-id="yn29"]').waitFor({ timeout: 15_000 });
    for (const id of ["yn22", "yn21", "yn29"]) {
      await open(id);
      const m = await measure(page);
      report.measures[`${tag}-${id}`] = m;
      assert.equal(m.overflowX, false, `${tag} ${id}: nothing wider than the Overview`);
      assert.deepEqual(m.wide, [], `${tag} ${id}: every part inside the pane`);
      assert.deepEqual(m.overlaps, [], `${tag} ${id}: no step's label runs into its record`);
      assert.equal(m.conversation, false, `${tag} ${id}: its Conversation hidden`);
      assert.equal(m.composer, false, `${tag} ${id}: the composer is the Conversation's`);
      assert.equal(m.steps, Math.min(5, overview[id].steps.length), `${tag} ${id}: five steps, then the rest on request`);
      if (phone) for (const [name, heights] of [["tabs", m.tabs], ["task link", m.link], ["steps toggle", m.more]])
        assert.ok(heights.every((h) => h >= 44), `${tag} ${id}: each ${name} 44 px tall on a phone (${heights})`);
      if (id === "yn21") {
        assert.equal(m.cards, 1, `${tag}: its request's card in its Overview`);
        assert.equal(m.bodyCards, 0, `${tag}: and not also in its hidden Conversation`);
      }
      await shot(`${id}-overview`);
      check(`${tag} ${id}: its Overview, inside the pane, nothing overlapping`);
    }
    // yn22: all its steps, then its Conversation and back.
    await open("yn22");
    await press(page.locator("#executor-overview .executor-overview-card .more"));
    await page.waitForFunction(() => document.querySelectorAll("#executor-overview .executor-overview-steps .step").length === 8);
    const all = await measure(page);
    assert.deepEqual(all.overlaps, [], `${tag}: all steps, none overlapping`);
    await page.locator("#executor-overview .executor-overview-steps").scrollIntoViewIfNeeded();
    await shot("yn22-all-steps");
    check(`${tag}: all eight steps on request`);
    await press(page.getByRole("tab", { name: lang === "zh" ? "会话" : "Conversation" }));
    await page.locator(".composer-area").waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await page.locator("#executor-overview").count(), 0);
    assert.equal(await page.getByRole("tab", { name: lang === "zh" ? "会话" : "Conversation" }).getAttribute("aria-selected"), "true");
    await shot("yn22-conversation");
    await press(page.getByRole("tab", { name: lang === "zh" ? "概览" : "Overview" }));
    await page.locator("#executor-overview .executor-overview-head").waitFor({ timeout: 5_000 });
    check(`${tag}: its Conversation shows the composer; back to its Overview`);
    // Its task, from the header.
    await press(page.locator("#executor-overview .chip.link"));
    assert.deepEqual(await page.evaluate(() => window.__tasks), ["YN-22"]);
    check(`${tag}: its task opens from the header`);
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const theme of ["light", "dark"]) {
    await run({ width: 1440, height: 900, theme });
    await run({ width: 390, height: 844, theme });
  }
  await run({ width: 1440, height: 900, theme: "light", lang: "zh" });
  await run({ width: 390, height: 844, theme: "light", lang: "zh" });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "no collaboration write: a check only reads");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
