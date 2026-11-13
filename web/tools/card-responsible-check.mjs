// YN-86 S2b in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, on a Project's page:
//  - a card bound to a task says at its foot who answers for it and in what
//    state, with its task's key, Reply, Open session and Reassign;
//  - Reply opens with the card's responsible Agent chosen;
//  - Done, opened, shows the card archived with its task, with who did it;
//  - at 1440 and a phone (390), English and Chinese: nothing is wider than
//    the window, and every line stays inside its card;
//  - nothing is sent but the reads (the linked repositories' list is a read sent as POST).
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/card-responsible-check.mjs
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
const report = { task: "YN-96", slice: "YN-86 S2b", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "localhost:47394";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = {
  harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/atlas", projectId: "p-dev",
};
// Synthetic names: a long one, to see the line wrap between its parts on a phone.
const agents = [
  { ...base, id: "l", name: "lead-1", kind: "lead" },
  { ...base, id: "t", name: "YN-90 · 设置页排版与文案口语化", kind: "executor", status: "working",
    executor: { state: "running", agentId: "t", task: { id: "YN-90", title: "Settings layout and plain copy", shortName: "设置页排版" }, dispatchedAt: at(50) } },
  { ...base, id: "r", name: "YN-88 · 发布", kind: "executor", closedAt: at(120),
    executor: { state: "archived", agentId: "r", task: { id: "YN-88", title: "Release core.32", shortName: "发布" }, dispatchedAt: at(900), since: at(120) } },
];
const projects = [{ id: "p-dev", name: "Atlas dev", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = (agentId, name) => ({ agentId, name, state: "active" });
const lead = owner("l", "lead-1");
const node = (type, props, children) => (children ? { type, props, children } : { type, props });
const md = (text) => node("Markdown", { text });
const spec = (top, elements) => ({ root: "body", elements: { body: node("BriefBody", {}, top), ...elements } });
const settings = { id: "YN-90", title: "Settings layout and plain copy", shortName: "设置页排版", status: "doing", archived: false };
const release = { id: "YN-88", title: "Release core.32", shortName: "发布", status: "done", archived: false };
const designer = { agentId: "t", name: "YN-90 · 设置页排版与文案口语化", kind: "executor", state: "running" };
let id = 300;
const section = (key, kind, title, body, extra = {}) => ({
  id: id++, key, kind, title, version: 2, owner: lead, updatedAt: at(30),
  updatedTurnId: "t1", body, attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const sections = [
  section("settings", "ask", "Which grouping for the settings page?", spec(["q"], { q: md("Two groupings were drawn; the first keeps the common controls together.") }), {
    ask: { question: "Which grouping for the settings page?", state: "open", reply: { options: [{ id: "a", label: "Grouping A" }, { id: "b", label: "Grouping B" }], freeText: true } },
    card: { task: settings, responsible: designer },
  }),
  section("layout", "status", "Settings page: layout in progress", spec(["s"], { s: md("Two groupings drawn; the copy is being made plainer.") }), {
    status: { asOf: at(20), validFor: 86_400, stale: false }, card: { task: settings, responsible: designer },
  }),
  section("layout/findings", "report", "What the first grouping keeps together", spec(["a"], { a: md("The account controls stay one level down.") }), {
    owner: owner("t", "YN-90 · 设置页排版与文案口语化"), card: { task: settings, responsible: designer },
  }),
  section("notes", "report", "Unbound notes", spec(["a"], { a: md("A report bound to no task, as before.") }), { seen: { version: 2, at: at(10) } }),
  section("checks", "report", "Release checks", spec(["a"], { a: md("All passed; not read yet.") }), { card: { task: release, responsible: null } }),
];
const history = [
  section("release", "status", "core.32 release", spec(["s"], { s: md("Published and checked.") }), {
    history: true, historyReason: "archived", status: { asOf: at(200), validFor: 3600, stale: true },
    card: { task: release, responsible: { agentId: "l", name: "lead-1", kind: "lead", state: "idle" } },
  }),
];
const home = () => ({
  generatedAt: at(0),
  order: ["p-dev"],
  needsYou: [{ kind: "ask", projectId: "p-dev", agentId: "l", agentName: "lead-1", sectionKey: "settings", title: "Which grouping for the settings page?", since: at(30) }],
  projects: [{
    project: { id: "p-dev", name: "Atlas dev" },
    agents: { working: 1, idle: 1, waiting: 0, error: 0, offline: 0, total: 2 },
    contentEditors: { version: 1, editorAgentIds: ["l"] },
    errors: [], pending: [], jobs: [], unseen: 3, missing: [], brief: { version: 9, history, sections },
  }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = {
  en: { label: "Responsible", working: "Working", archived: "Done · Archived", actions: ["Reply", "Open session", "Reassign"], ended: "Task done, archived" },
  "zh-Hans": { label: "负责人", working: "在做", archived: "完成 · 已归档", actions: ["回复", "打开会话", "改派"], ended: "任务完成，已归档" },
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const [name, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["390", { width: 390, height: 844 }, true]])
    runs.push({ name: `${language}-${name}`, viewport, phone, language });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "card-responsible-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`card-responsible-check: ${report.runs.length} runs, ${report.runs.reduce((n, run) => n + run.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport,
    locale: run.language === "en" ? "en-US" : "zh-CN",
    timezoneId: "UTC",
    ...(run.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript((language) => {
    if (window !== window.top) return;
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  }, run.language);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.host !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/workspace") {
      return route.fulfill({ json: { workspace: { id: "ws-cards" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" } });
    }
    if (path === "/api/home") return route.fulfill({ json: home() });
    // A list read, though sent as POST (home-api.ts readLinkedRepositories): no repositories linked here.
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w+)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((agent) => agent.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
      "/api/machine-load": {
        at: at(0),
        cpu: { cores: 16, totalPct: 10, jobsPct: 4, agentsPct: null, otherPct: null },
        memory: { totalMiB: 65536, usedMiB: 16000, availableMiB: 49536, jobsMiB: 2048, agentsMiB: null },
        gpus: null, jobs: [],
      },
      "/api/machine-live": { machines: [] },
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
  const shot = async (name, locator = null) => {
    const file = `${run.name}-${name}.png`;
    if (locator) await locator.screenshot({ path: join(output, file) });
    else await page.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const card = (key) => page.locator(`.project-home [data-section-key="${key}"]`).first();
  // Every responsible line inside its card, and the page no wider than the window.
  const fits = () => page.evaluate(() => {
    const out = { page: document.scrollingElement.scrollWidth, window: innerWidth, view: document.querySelector(".home-view")?.scrollWidth, over: [] };
    for (const line of document.querySelectorAll(".home-card-responsible")) {
      const box = line.getBoundingClientRect();
      if (!box.width) continue;
      const frame = line.closest(".home-section")?.getBoundingClientRect();
      for (const part of line.querySelectorAll("*")) {
        const at = part.getBoundingClientRect();
        if (at.width && frame && (at.right > frame.right + 1 || at.left < frame.left - 1))
          out.over.push({ card: line.closest("[data-section-key]")?.dataset.sectionKey, part: part.className || part.tagName, right: Math.round(at.right), frame: Math.round(frame.right) });
      }
    }
    return out;
  });
  try {
    await page.goto(`http://${HOST}/#/home?w=ws-cards&p=p-dev`);
    await page.locator('[data-project-home="p-dev"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelectorAll(".home-card-responsible").length >= 3, null, { timeout: 15_000 });
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language);
    // The status card bound to YN-90: who answers for it, its state as the rail says it, its key and actions.
    const line = card("layout").locator(".home-card-responsible");
    await line.scrollIntoViewIfNeeded();
    assert.equal((await line.locator(".home-card-responsible-label").innerText()).trim(), w.label);
    assert.equal((await line.locator(".home-card-responsible-name strong").innerText()).trim(), "YN-90 · 设置页排版与文案口语化");
    assert.equal((await line.locator(".home-card-responsible-state").innerText()).trim(), w.working);
    assert.equal((await line.locator(".home-card-task").innerText()).trim(), "YN-90");
    assert.deepEqual((await line.locator(".home-card-responsible-actions button").allInnerTexts()).map((text) => text.trim()), w.actions);
    let fit = await fits();
    assert.ok(fit.page <= fit.window + 1 && fit.view <= fit.window + 1, JSON.stringify(fit));
    assert.deepEqual(fit.over, [], "every line inside its card");
    await shot("project");
    await shot("layout-card", card("layout"));
    pass("a bound card's foot names who answers for it, in the rail's words, with its key and actions; nothing overflows", { widths: fit });
    // Reply opens with the card's executor chosen.
    await line.locator(".home-reply-open").click();
    const to = card("layout").locator(".home-card-reply .home-reply-target select");
    await to.waitFor({ timeout: 10_000 });
    assert.equal(await to.inputValue(), "t");
    fit = await fits();
    assert.ok(fit.page <= fit.window + 1, JSON.stringify(fit));
    pass("Reply goes to the card's responsible executor by default");
    // The ask bound to the same task: its reply goes to the executor too.
    assert.equal(await card("settings").locator(".home-ask-reply .home-reply-target select").inputValue(), "t");
    pass("an Ask on the card replies to its responsible executor by default");
    // Done, opened: the report waiting to be read and the card archived with its task, with who did it.
    const done = page.locator(".project-deck-done");
    await page.locator(".project-deck-done > summary").click();
    await page.waitForFunction(() => document.querySelector(".project-deck-done")?.open);
    const archived = card("release");
    await archived.scrollIntoViewIfNeeded();
    assert.equal((await archived.locator(".home-task-ended").innerText()).trim(), w.ended);
    assert.equal(await archived.locator(".home-changed").count(), 0, "an archived card is never New");
    assert.equal((await archived.locator(".home-card-responsible-name strong").innerText()).trim(), "YN-88 · 发布");
    assert.equal((await archived.locator(".home-card-responsible-state").innerText()).trim(), w.archived);
    assert.equal(await archived.locator(".home-card-reassign").count(), 0);
    assert.ok(await done.evaluate((el) => !!el.querySelector('[data-section-key="checks"]')), "the unread report of the done task is in Done");
    fit = await fits();
    assert.ok(fit.page <= fit.window + 1 && fit.view <= fit.window + 1, JSON.stringify(fit));
    assert.deepEqual(fit.over, [], "every line inside its card, in Done too");
    await shot("done");
    await shot("release-card", archived);
    pass("Done shows the card archived with its task, with its executor and no Reassign; nothing overflows", { widths: fit });
  } finally {
    await context.close();
  }
}
