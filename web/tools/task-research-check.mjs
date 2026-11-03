// Research records (T-17), in a browser: a task's methods and claims as its
// activity shows them, and a Home research desk whose definition is a Task
// method record. Desktop light and dark, and a 390 px phone.
// - Each record shows as written: its type, id, the author's status, its
//   conditions and limits, the method version it was made with, and each
//   source's identity (a Job artifact, a task record with its producer, an
//   external source as stated). Nothing is called verified.
// - What holds now is read only on request (task_research_get), by keyboard,
//   and says that a Job source's file itself is not read.
// - Its words are readable (contrast at least 4.5:1); nothing scrolls sideways.
// - A comparison (slice 2) shows every entry, left out or not, each with
//   why, and says what its included entries share; no difference is computed.
// - Reads only: no write leaves the page, and every read it makes is one
//   this fixture answers on purpose (none falls through to an empty {}).
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or real Agent. Screenshots and report.json go to
// YUZUNO_BROWSER_OUTPUT.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { layoutStudy, layoutStudyRecords } from "./research-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/task-research");
await mkdir(output, { recursive: true });
const HOST = "yuzuno-task-research.test";
const report = { checks: [], failures: [], errors: [], unexpected: [], writes: [], reads: [], shots: [] };
let page;
async function step(name, run) {
  try {
    const extra = (await run()) || {};
    report.checks.push({ name, ...extra });
    console.log(`PASS ${name}`);
  } catch (error) {
    const file = `fail-${report.failures.length + 1}.png`;
    report.failures.push({ name, error: error.stack || String(error), screenshot: file });
    console.log(`FAIL ${name}: ${String(error.message).split("\n")[0]}`);
    await page?.screenshot({ path: resolve(output, file) }).catch(() => {});
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(what, test, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

// ---------------------------------------------------------------- fixture
const at = "2026-11-02T09:00:00Z";
const mina = { kind: "agent", id: "mina", name: "Mina" };
const iris = { kind: "agent", id: "iris", name: "Iris" };
const attempt = "00000000-0000-4000-8000-000000000017";
const methodV1 = { schema: "research/1", type: "method", id: "timing", title: "Timing protocol", field: "systems",
  text: "Time each layout with ten iterations in one process.", limits: ["One machine; no cross-machine run yet"] };
const methodV2 = { ...methodV1, text: "Time each layout in ten fresh processes; iterations in one process are not independent runs.",
  revises: { activitySeq: 3, reason: "Iterations in one process share caches and memory layout." } };
const claim = { schema: "research/1", type: "claim", id: "faster", title: "Layout B is faster on the small inputs", field: "systems",
  text: "Layout B runs the small inputs about 4% faster than layout A.", status: "conditional",
  conditions: ["Small inputs only", "Process-level repeats, not iterations"], limits: ["The large inputs were not run"],
  method: { activitySeq: 3, id: "timing", title: "Timing protocol" },
  sources: [
    { kind: "job", label: "Raw timings", jobId: "job-synthetic", attempt, path: "out/timings.json", sha256: "5f3c".padEnd(64, "0"), bytes: 4096, recorded: "recorded_match" },
    { kind: "task", taskId: "T-2", activitySeq: 9, record: { kind: "research", type: "observation", id: "ranking", title: "Ranking flips with link order" }, producer: iris, at },
    { kind: "external", label: "Upstream benchmark notes", url: "https://example.invalid/bench", version: "v3", observedAt: "2026-11-01", coverage: "Small inputs only; the large set was not exported", checked: false },
  ] };
// Two comparisons on the same study: one whose included entries share unit,
// definition, level and method; one whose included entries do not.
const entries = [
  { id: "processes", label: "Fresh processes", status: "included", unit: "%", level: "process", n: 10, definition: "median of runs",
    method: { activitySeq: 6, id: "timing", title: "Timing protocol" }, value: { value: -1.2, low: -3.5, high: 1.1 },
    source: { kind: "job", label: "Process timings", jobId: "job-synthetic", attempt, path: "out/processes.json", sha256: "7a1e".padEnd(64, "0"), bytes: 2048, recorded: "recorded_match" } },
  { id: "again", label: "Fresh processes, second run", status: "included", unit: "%", level: "process", n: 10, definition: "median of runs",
    method: { activitySeq: 6, id: "timing", title: "Timing protocol" }, value: { value: -0.8, low: -2.9, high: 1.3 } },
  { id: "large", label: "Large inputs", status: "missing", reason: "The large set was not exported." },
  { id: "second-machine", label: "Second machine", status: "not_done", reason: "No second machine yet." },
  { id: "warm", label: "Warm cache run", status: "excluded", reason: "The cache was left warm between runs, so its runs are not independent.", value: { value: -9 } },
];
const counts = { included: 2, excluded: 1, missing: 1, not_done: 1 };
const aligned = { schema: "research/1", type: "comparison", id: "layouts", title: "Layout B vs A, fresh processes", field: "systems",
  text: "Runtime change of layout B against layout A.", entries,
  comparability: { aligned: true, shared: { unit: "%", definition: "median of runs", level: "process", method: 6 }, differs: [], unknown: [], counts } };
const mixed = { ...aligned, id: "layouts-mixed", title: "Layout B vs A, two methods",
  entries: [entries[0], { ...entries[1], unit: "ms", level: undefined, method: { activitySeq: 3, id: "timing", title: "Timing protocol" } }, ...entries.slice(2)],
  comparability: { aligned: false, shared: { definition: "median of runs" }, differs: ["unit", "method"], unknown: ["level"], counts } };
const task = { id: "T-1", title: "Is layout B faster? (synthetic)", description: "Compare two layouts under a fixed timing method.",
  status: "doing", version: 3, projectId: "p1", progress: "", blocker: "", github: [], assigneeAgentId: "mina", assignee: mina,
  createdAt: at, updatedAt: at, createdBy: mina, updatedBy: mina, result: null };
const activities = [
  { seq: 1, taskId: "T-1", kind: "created", actor: mina, at },
  { seq: 3, taskId: "T-1", kind: "comment", body: "Method v1.", actor: mina, at, research: methodV1 },
  { seq: 4, taskId: "T-1", kind: "comment", body: "Claim with its sources.", actor: mina, at, research: claim },
  { seq: 6, taskId: "T-1", kind: "comment", body: "Method v2.", actor: mina, at, research: methodV2 },
  { seq: 7, taskId: "T-1", kind: "comment", body: "Compared.", actor: mina, at, research: aligned },
  { seq: 8, taskId: "T-1", kind: "comment", body: "Compared again.", actor: mina, at, research: mixed },
];
const now = { job: { state: "recorded_match", file: "not_read", jobStatus: "succeeded", downloadable: true, index: 0 }, task: { state: "readable" }, external: { state: "stated" } };
const view = (seq) => {
  if (seq === 4) return { taskId: "T-1", activitySeq: 4, version: 1, revisedBy: null, latestActivitySeq: 4,
    research: { ...claim, sources: claim.sources.map((source) => ({ ...source, now: now[source.kind] })) },
    method: { taskId: "T-1", activitySeq: 3, version: 1, revisedBy: 6, latestActivitySeq: 6, research: methodV1, method: null } };
  if (seq === 7 || seq === 8) {
    const record = seq === 7 ? aligned : mixed;
    return { taskId: "T-1", activitySeq: seq, version: 1, revisedBy: null, latestActivitySeq: seq,
      research: { ...record, entries: record.entries.map((entry) => (entry.source ? { ...entry, source: { ...entry.source, now: now.job } } : entry)) }, method: null };
  }
  if (seq === 3) return { taskId: "T-1", activitySeq: 3, version: 1, revisedBy: 6, latestActivitySeq: 6, research: methodV1, method: null };
  return { taskId: "T-1", activitySeq: 6, version: 2, revisedBy: null, latestActivitySeq: 6, research: methodV2, method: null };
};
// A Home desk on the same study: each version of its timing definition cites
// its own Task method record (activity 3, then 6), with no attachment.
const desk = layoutStudy;
const research = (version) => ({ key: desk.key, version, elementId: "desk", values: {}, sources: layoutStudyRecords(at) });
const agents = [mina, iris].map((a) => ({ ...a, projectId: "p1", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
  createdAt: at, updatedAt: at, status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null }));
const projects = [{ id: "p1", name: "Layouts (synthetic)", defaultDirs: {}, archivedAt: null, createdAt: at, updatedAt: at }];
const home = () => ({
  generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [],
  projects: [{ project: { id: "p1", name: "Layouts (synthetic)" }, agents: { working: 0, idle: 2, waiting: 0, error: 0, offline: 0, total: 2 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [],
    brief: { version: 5, history: [], sections: [{ key: desk.key, kind: "report", title: desk.title, version: 3,
      owner: { agentId: "mina", name: "Mina", state: "active" }, body: desk.body, attachments: [], refs: {},
      seen: { version: 3, at }, history: false, updatedTurnId: null, updatedAt: at }] } }],
});
const READS = ["task_get", "task_list", "task_research_get", "github_links", "github_refresh", "github_repositories", "delivery_get", "peers_list"];

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  const path = url.pathname;
  if (path.startsWith("/api/collaboration/")) {
    const operation = path.split("/").at(-1);
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (!READS.includes(operation)) report.writes.push(`${request.method()} ${path}`);
    report.reads.push(operation);
    const answer = {
      task_list: () => ({ tasks: [task], hasMore: false, counts: { doing: 1 } }),
      task_get: () => ({ task, activities, executions: [], hasMore: false }),
      task_research_get: () => view(body.activitySeq),
      peers_list: () => ({ peers: [] }),
      delivery_get: () => ({ flow: null, settings: { harness: "codex", model: "test" } }),
    }[operation];
    return route.fulfill({ json: answer ? answer() : { links: [], repositories: [], refreshing: false } });
  }
  if (request.method() !== "GET" && path.startsWith("/api/")) {
    report.writes.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (/^\/api\/projects\/p1\/brief\/research\/[^/]+\/desk$/.test(path)) return route.fulfill({ json: research(Number(url.searchParams.get("version"))) });
  const json = {
    "/api/workspace": () => ({ workspace: { id: "ws" }, projects, projectUsage: { p1: { agents: 2, tasks: 1 } }, agents, runtime: { connected: true }, defaultCwd: "/fixture" }),
    "/api/home": home,
    "/api/machine-load": () => ({ at, cpu: { cores: 8, totalPct: 5, jobsPct: 0, agentsPct: null, otherPct: null },
      memory: { totalMiB: 16000, usedMiB: 4000, availableMiB: 12000, jobsMiB: 0, agentsMiB: null }, gpus: [], jobs: [] }),
    "/api/projects/p1/repo-activity": () => ({ observedAt: at, repositories: [] }),
    "/api/updates": () => unmanagedUpdates,
    "/api/jobs/budget": () => idleJobsBudget,
    "/api/jobs": () => noJobs,
    "/api/jobs/live": () => noLiveJobs,
    "/api/ci/live": () => ({ agents: {} }),
    "/api/ci": () => noCiRuns,
    "/api/reviews": () => noReviews,
    "/api/backlog": () => ({ observedAt: at, agents: {} }),
    // The task pane's own reads, answered in their real empty shapes (Lead
    // 2784: #479's check answered them {} and listed them as unexpected).
    "/api/tasks/T-1/workspaces": () => ({ taskId: "T-1", repositories: [], workspaces: [] }),
    "/api/pr-reviews": () => ({ reviews: [], hasMore: false, nextBefore: null }),
    "/api/pr-operations": () => ({ operations: [], repositories: [], hasMore: false, nextBefore: null }),
    "/api/machines": () => ({ machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" }] }),
    "/api/models": () => ({ models: [] }),
  }[path];
  if (json) return route.fulfill({ json: json() });
  if (path.startsWith("/api/agents/")) return route.fulfill({ json: path.endsWith("/reading") ? { handoff: null } : { agent: agents[0], pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (path.startsWith("/api/")) {
    report.unexpected.push(path);
    return route.fulfill({ json: {} });
  }
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)] || "application/octet-stream",
  });
}

async function open(width, height, theme) {
  page = await browser.newPage({ viewport: { width, height }, locale: "en-US", reducedMotion: "reduce", hasTouch: width < 600 });
  await page.addInitScript((theme) => {
    window.EventSource = class {
      constructor() { setTimeout(() => this.onopen?.(), 50); }
      addEventListener() {}
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
  }, theme);
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`console: ${message.text()}`));
  await page.route("**/*", serve);
  await page.goto(`https://${HOST}/`);
}
async function openTask() {
  await page.getByRole("button", { name: "Tasks & messages", exact: true }).first().click();
  await page.locator('button[data-task-id="T-1"]').first().click();
  await page.locator(".task-research").first().waitFor();
  await sleep(150);
}
/** Each piece of the record's own words, with the contrast against what is behind it. */
const contrast = () =>
  page.evaluate(() => {
    const rgb = (text) => (text.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const behind = (el) => {
      for (let node = el; node; node = node.parentElement) {
        const color = rgb(getComputedStyle(node).backgroundColor);
        if (color.length >= 3 && (color.length < 4 || color[3] > 0.95)) return color;
      }
      return [255, 255, 255];
    };
    const rows = [];
    for (const el of document.querySelectorAll(".task-research, .task-research *")) {
      if (![...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
      const fg = lum(rgb(getComputedStyle(el).color)), bg = lum(behind(el));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      rows.push({ what: el.className || el.tagName, text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100 });
    }
    return rows;
  });
const sideways = () =>
  page.evaluate(() => {
    const scroller = document.scrollingElement;
    const cards = [...document.querySelectorAll(".task-research")];
    return { page: scroller.scrollWidth > scroller.clientWidth + 1,
      inside: cards.flatMap((card) => [...card.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > card.getBoundingClientRect().right + 1).map((el) => el.className)).slice(0, 5) };
  });

for (const [width, height, theme, name] of [[1440, 960, "light", "desktop-light"], [1440, 960, "dark", "desktop-dark"], [390, 844, "light", "phone"]]) {
  await step(`${name}: each record shows as written, with its sources' identity, and nothing is called verified`, async () => {
    report.reads.length = 0;
    await open(width, height, theme);
    await openTask();
    const cards = page.locator(".task-research");
    assert.equal(await cards.count(), 5);
    const claimCard = cards.nth(1);
    const text = await claimCard.innerText();
    for (const expected of ["CLAIM", "faster", "Layout B is faster on the small inputs", "Holds under conditions", "the author's judgement",
      "Made with the method “Timing protocol” as written in activity 3", "Small inputs only", "The large inputs were not run",
      "out/timings.json", "Matched this task's recorded Job check when written", "T-2 · activity 9", "by Iris",
      "Upstream benchmark notes", "As its author stated it; Yuzuno did not check it"])
      assert.ok(text.includes(expected), `${expected}: ${text}`);
    assert.ok(!/verified/i.test(await page.locator(".collab-activity").innerText()));
    assert.ok((await cards.nth(2).innerText()).includes("Revises activity 3"), "the revision and its reason");
    assert.ok(!report.reads.includes("task_research_get"), "nothing is read until asked");
    const wide = await sideways();
    assert.ok(!wide.page && wide.inside.length === 0, JSON.stringify(wide));
    await claimCard.scrollIntoViewIfNeeded();
    await claimCard.screenshot({ path: resolve(output, `${name}-claim.png`) });
    report.shots.push(`${name}-claim.png`);
    return { sideways: wide };
  });
  await step(`${name}: what holds now is read on request, by keyboard, and says the file itself is not read`, async () => {
    const claimCard = page.locator(".task-research").nth(1);
    // Found by its place, not its name: the name says what it does next ("Hide" once open).
    const toggle = claimCard.locator(".task-research-toggle");
    assert.equal(await toggle.innerText(), "Version and sources now");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await until("the record's state now", async () => (await claimCard.innerText()).includes("Version 1 of this record"));
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    const text = await claimCard.innerText();
    assert.ok(/Read /.test(text), "when it was read");
    for (const expected of ["This is the newest version", "The method as cited is version 1; a newer version is activity 6",
      "Now: the Job's record still lists this file and hash; the file itself was not read", "Now: Record readable", "Now: Not checked"])
      assert.ok(text.includes(expected), `${expected}: ${text}`);
    assert.deepEqual(report.reads.filter((read) => read === "task_research_get"), ["task_research_get"]);
    const rows = await contrast();
    const low = rows.filter((row) => row.ratio < 4.5);
    assert.deepEqual(low, [], "every word of the card is readable");
    await claimCard.screenshot({ path: resolve(output, `${name}-claim-now.png`) });
    report.shots.push(`${name}-claim-now.png`);
    await page.screenshot({ path: resolve(output, `${name}-task.png`) });
    report.shots.push(`${name}-task.png`);
    return { lowestContrast: Math.min(...rows.map((row) => row.ratio)), measured: rows.length };
  });
  await step(`${name}: a comparison shows every entry, left out or not, with why, and what its included entries share; no difference is computed`, async () => {
    const cards = page.locator(".task-research");
    const [first, second] = [cards.nth(3), cards.nth(4)];
    for (const card of [first, second]) {
      const text = await card.innerText();
      for (const expected of ["COMPARISON", "Fresh processes", "Included", "Large inputs", "Missing", "The large set was not exported.",
        "Second machine", "Not done", "No second machine yet.", "Warm cache run", "Excluded", "so its runs are not independent",
        "2 included · 1 excluded · 1 missing · 1 not done", "Yuzuno computes no difference", "out/processes.json"])
        assert.ok(text.includes(expected), `${expected}: ${text}`);
      assert.equal(await card.locator(".task-research-entry").count(), 5, "nothing left out is dropped");
      assert.ok(!/−0\.4|0\.4 %|difference of/i.test(text), "no difference between entries is shown");
      assert.ok(!/verified/i.test(text));
    }
    assert.match(await first.innerText(), /−1\.2 \[−3\.5, 1\.1\] %/, "a value as its author gave it");
    assert.match(await first.innerText(), /The included entries share unit \(%\), definition \(median of runs\), sample level \(process\), method \(method in activity 6\)/);
    assert.match(await second.innerText(), /Side by side only: the included entries differ in unit, method; sample level is not given for every entry/);
    // An entry's own source says what holds now, read on request like a record's.
    const reads = report.reads.filter((read) => read === "task_research_get").length;
    const toggle = first.locator(".task-research-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await until("the comparison's state now", async () => (await first.innerText()).includes("Version 1 of this record"));
    assert.ok((await first.locator(".task-research-entry").first().innerText()).includes("the file itself was not read"), "the entry's source now");
    assert.equal(report.reads.filter((read) => read === "task_research_get").length, reads + 1);
    const wide = await sideways();
    assert.ok(!wide.page && wide.inside.length === 0, JSON.stringify(wide));
    const rows = await contrast();
    const low = rows.filter((row) => row.ratio < 4.5);
    assert.deepEqual(low, [], "every word of every card is readable");
    for (const [card, file] of [[first, `${name}-comparison.png`], [second, `${name}-comparison-mixed.png`]]) {
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: resolve(output, file) });
      report.shots.push(file);
    }
    return { sideways: wide, lowestContrast: Math.min(...rows.map((row) => row.ratio)), measured: rows.length };
  });
  await page.close();
}

await step("desktop: a Home research desk's definition versions each show their own Task method record, with no attachment", async () => {
  await open(1440, 960, "light");
  if (!(await page.locator(".home-view").isVisible())) await page.locator(".toolbar-nav .catchup-nav").first().click();
  const toggle = page.locator('.home-view .home-panel-toggle[aria-expanded="false"]');
  await page.locator(".home-view .home-panel-toggle").first().waitFor();
  if (await toggle.count()) await toggle.first().click();
  const deskBlock = page.locator(`.home-view [data-section-key="${desk.key}"] .research-desk`);
  await deskBlock.waitFor();
  await deskBlock.locator('[role="radiogroup"][aria-label="Views of this desk"] [role="radio"]', { hasText: "Definitions" }).click();
  await until("the task records", async () => (await deskBlock.innerText()).includes("Task record T-1 · activity 6"));
  const text = await deskBlock.innerText();
  for (const expected of ["Method “Timing protocol” · version 2", "by Mina", "the record's identity, not a check of it"])
    assert.ok(text.includes(expected), `${expected}: ${text}`);
  // Version 1 keeps the record it was written with, after version 2 replaced it.
  const versions = await deskBlock.locator(".research-versions > li").allInnerTexts();
  assert.ok(versions.some((item) => item.includes("Ten iterations in one process.") && item.includes("activity 3") && item.includes("version 1")), versions.join(" | "));
  assert.ok(versions.some((item) => item.includes("Ten fresh processes") && item.includes("activity 6") && item.includes("version 2")), versions.join(" | "));
  assert.ok(!/verified|checked by/i.test(text));
  await deskBlock.scrollIntoViewIfNeeded();
  await deskBlock.screenshot({ path: resolve(output, "desktop-desk-definition.png") });
  report.shots.push("desktop-desk-definition.png");
  await page.close();
});

await browser.close();
await step("reads only: nothing is written, no other host is asked, and every read is one the fixture answers", async () => {
  assert.deepEqual(report.writes, []);
  // Every request the page made was answered by this fixture on purpose.
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
});
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(report.failures.length ? `FAILED ${report.failures.length}` : `PASSED ${report.checks.length}`);
process.exit(report.failures.length ? 1 : 0);
