// T-189: the window's frame in the interface language, in Chromium (en-US),
// with every API answered here (no Core, no Agent run). Through the real app:
//  - in English: the toolbar, the Agent list (grouped by project, one Agent
//    of each state, one closed, one waiting for you), the project menu and
//    the Core pill; an Agent chosen and a search typed;
//  - the language changed in another window: the frame is Chinese; Agent,
//    project and workspace names as they came, data-core-status still the
//    English key; the chosen Agent and the search kept; nothing sent;
//  - back to English in another window: the frame is as it was;
//  - Core refusing the workspace read, reloaded in Chinese: the connection
//    banner is Chinese with Core's reason as it came, then English again.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/shell-language-check.mjs
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
const report = { task: "T-189", checks: [], reads: [], posts: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-shell-language.test";

// Synthetic Agents: one per state, one closed, one waiting for you.
const agent = (id, name, status, projectId, extra = {}) => ({
  id, name, status, harness: "codex", cwd: "/fixture", model: "gpt-6", projectId, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected", ...extra,
});
const agents = [
  agent("a", "Mori", "idle", "p1", { pendingCount: 1 }),
  agent("b", "Cedar", "working", "p1"),
  agent("c", "Pine", "offline", null),
  agent("d", "Rowan", "error", null),
  agent("e", "Elm", "idle", "p1", { closedAt: "2026-10-20T00:00:00Z" }),
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// Core's own words when it refuses the workspace read.
const REFUSAL = "Synthetic workspace refusal";
let refuse = false;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (/^\/api\/agents\/[a-e]\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  if (path === "/api/workspace" && refuse) return route.fulfill({ status: 500, json: { error: REFUSAL } });
  const one = path.match(/^\/api\/agents\/([a-e])$/);
  const json = one
    ? { agent: agents.find((a) => a.id === one[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] }
    : {
        "/api/workspace": { workspace: { id: "ws-shell-language" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
        "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
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
page.on("pageerror", (error) => report.errors.push(error.message));
const other = await context.newPage();

async function elsewhere(language, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await page.locator(".rail-heading > span", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
const frame = () => page.evaluate(() => {
  const texts = (selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent.trim());
  const attr = (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null;
  return {
    lang: [attr("header.toolbar", "lang"), attr("aside.rail", "lang")],
    nav: texts(".toolbar-nav .toolbar-nav-label"),
    workspace: document.querySelector(".workspace-name").textContent,
    core: { text: document.querySelector(".connection").textContent, status: attr(".connection", "data-core-status") },
    settings: attr("button.workspace-settings", "aria-label"),
    heading: document.querySelector(".rail-heading > span").textContent,
    scope: texts(".agent-scope button"),
    groups: texts(".project-group-name"),
    rows: Object.fromEntries([...document.querySelectorAll(".agent-row")].map((row) => [row.querySelector(".agent-name").textContent, [row.querySelector(".agent-runtime").textContent, row.querySelector(".needs-you")?.textContent ?? null]])),
    selected: attr('.agent-select[aria-current="true"]', "aria-label"),
    search: document.querySelector(".agent-search input")?.value ?? null,
    searchPlaceholder: attr(".agent-search input", "placeholder"),
    empty: document.querySelector(".rail-empty")?.textContent ?? null,
    newAgent: document.querySelector(".add-agent").textContent,
    switcher: document.querySelector(".workspace-scope-text").textContent,
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });
  await page.locator('.agent-row[data-agent-id="b"] .agent-select').click();
  await page.locator('.agent-row[data-agent-id="b"] .agent-select[aria-current="true"]').waitFor({ timeout: 10_000 });

  // ---- In English.
  let en = await frame();
  assert.deepEqual(en.nav, ["Home", "Tasks & messages", "Jobs"]);
  assert.deepEqual(en.core, { text: "Core connected", status: "Core connected" });
  assert.deepEqual([en.heading, en.scope, en.groups], ["YOUR AGENTS", ["Active 4", "Closed 1"], ["Yuzuno", "No project"]]);
  assert.deepEqual(en.rows, { Mori: ["Ready", "1 needs you"], Cedar: ["Working", null], Pine: ["Offline", null], Rowan: ["Needs a look", null] });
  assert.equal(en.selected, "Open Cedar");
  // A search typed, matching no Agent: the list's empty state.
  await page.locator(".rail-heading").getByRole("button", { name: "Search agents" }).click();
  await page.locator(".agent-search input").fill("zz");
  await page.locator(".rail-empty").waitFor({ timeout: 10_000 });
  en = await frame();
  assert.equal(en.empty, "No agents match your search.");
  assert.deepEqual(report.posts, [], "nothing sent");
  check("the frame in English: toolbar, Agent list by project with each state, the project menu and Core; an Agent chosen and a search typed", { en });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", "你的 Agent");
  const zh = await frame();
  assert.deepEqual(zh.lang, ["zh-Hans", "zh-Hans"]);
  assert.deepEqual(zh.nav, ["Home", "任务与消息", "Job"]);
  assert.equal(zh.workspace, "个人 Workspace");
  assert.deepEqual(zh.core, { text: "Core 已连接", status: "Core connected" }, "data-core-status keeps its English key");
  assert.equal(zh.settings, "设置与更新");
  assert.deepEqual([zh.heading, zh.scope], ["你的 Agent", ["活跃 4", "已关闭 1"]]);
  assert.equal(zh.search, "zz", "the search is kept");
  assert.equal(zh.searchPlaceholder, "查找 Agent 或粘贴链接…");
  assert.equal(zh.empty, "没有与搜索匹配的 Agent。");
  assert.equal(zh.newAgent, "新建 AgentCtrl N");
  assert.equal(zh.switcher, "所有项目个人 Workspace");
  // Clear the search: the rows in Chinese, names as they came; the choice kept.
  await page.locator(".agent-search input").fill("");
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });
  const rows = await frame();
  assert.deepEqual(rows.groups, ["Yuzuno", "无项目"]);
  assert.deepEqual(rows.rows, { Mori: ["就绪", "1 项需要你"], Cedar: ["工作中", null], Pine: ["离线", null], Rowan: ["需要查看", null] });
  assert.equal(rows.selected, "打开 Cedar", "the chosen Agent is kept");
  assert.deepEqual(meanwhile.filter((read) => !read.startsWith("GET ")), [], "nothing sent");
  await page.screenshot({ path: join(output, "shell-zh.png") });
  check("changed to Chinese in another window: the frame is Chinese, names as they came, data-core-status English; the chosen Agent and the search kept; nothing sent", { zh: rows, meanwhile });

  // ---- Back to English in another window (the search typed again).
  await page.locator(".agent-search input").fill("zz");
  meanwhile = await elsewhere("en", "YOUR AGENTS");
  assert.deepEqual(await frame(), en, "as it was in English");
  assert.deepEqual(meanwhile.filter((read) => !read.startsWith("GET ")), []);
  check("back to English in another window: the frame is as it was, nothing sent");

  // ---- Core refuses the workspace read; reloaded in Chinese.
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" })));
  refuse = true;
  await page.reload();
  const banner = page.locator(".core-connection-banner");
  await banner.waitFor({ timeout: 15_000 });
  const zhBanner = await banner.evaluate((el) => ({ lang: el.getAttribute("lang"), text: el.querySelector("strong").textContent, line: el.querySelector("span").textContent, retry: el.querySelector("button").textContent.trim() }));
  assert.deepEqual([zhBanner.lang, zhBanner.text, zhBanner.retry], ["zh-Hans", "Core 更新失败", "重试"]);
  assert.equal(zhBanner.line, `Workspace 请求返回 HTTP 500（${REFUSAL}）。草稿会保留；下一次刷新会再试。`, "Core's reason as it came");
  assert.equal(await page.locator(".connection").getAttribute("data-core-status"), "Core update failed");
  await other.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await page.locator(".core-connection-banner strong", { hasText: "Core update failed" }).waitFor({ timeout: 10_000 });
  const enBanner = await banner.evaluate((el) => el.querySelector("span").textContent);
  assert.equal(enBanner, `Workspace request returned HTTP 500. ${REFUSAL} Drafts are kept; the next refresh will try again.`);
  check("Core refusing the workspace read: the banner in Chinese with Core's reason as it came, then English again", { zhBanner, enBanner });

  assert.deepEqual(report.posts, [], "nothing sent at all");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(output, "check-report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
