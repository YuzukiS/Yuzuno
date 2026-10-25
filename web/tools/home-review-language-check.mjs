// T-189: Home presentation and Code review in the interface language, in
// Chromium (en-US), with every API answered here (no Core, no daily
// configuration or data, no model run, no review). Through the real Settings:
//  - Home presentation with an unsaved change, then the language changed in
//    another window: the open page is Chinese, the change still there and
//    still unsaved, the note and what Agents receive as written, nothing read
//    or saved again;
//  - Code review in Chinese with another model chosen and not saved: the
//    harness and model names, a model's own description and the built-in
//    reviewer as they come; changed to English in another window, the choice
//    still there, the models not listed again;
//  - nothing is written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/home-review-language-check.mjs
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
const report = { task: "T-189", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-home-review-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// What Core keeps and says, written as it would be: a note in the user's own
// words (here mixed), and the English Agents receive.
const NOTE = "Charts first · 先给图表";
const AGENT_TEXT = "The user prefers visuals first: lead with a chart, screenshot or sketch where it fits. Their note: Charts first · 先给图表";
const presentation = { style: "visual", note: NOTE, updatedAt: "2026-10-24T20:00:00Z", scope: "workspace", agentText: AGENT_TEXT };
const reviewSettings = { harness: "claude", model: "fixture-opus", source: "workspace", builtIn: { harness: "codex", model: "gpt-6.1-sol" } };
const models = [
  { id: "m1", model: "fixture-opus", displayName: "Fixture Opus", description: "Most capable fixture model for long reviews.", isDefault: true },
  { id: "m2", model: "fixture-sonnet", displayName: "Fixture Sonnet", description: "Faster fixture model.", isDefault: false },
];
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
  // The other window is a plain page of the same site, not the app.
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}${url.search}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-home-review-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/home/presentation": presentation, "/api/pr-reviews/settings": reviewSettings, "/api/models": { models },
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

async function openSettings() {
  if (await page.locator(".settings-search input").isVisible()) return;
  await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
  await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
}
async function openEditor(query, title, editor) {
  await openSettings();
  await page.locator(".settings-search input").fill(query);
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator(`#settings-editor-${editor}`);
  await box.waitFor({ timeout: 10_000 });
  return box;
}
/** The language changed in the other window; this one follows it. Returns
 * what this page asked Core meanwhile, once `shown` (a line in the new
 * language) is there. */
async function elsewhere(language, shown) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await shown.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
const pageOwn = (reads) => reads.filter((read) => /\/api\/(home\/presentation|pr-reviews|models)/.test(read) || !read.startsWith("GET "));
const homeState = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  current: el.querySelector(".settings-current").textContent,
  titles: [...el.querySelectorAll(".settings-row-title")].map((t) => t.textContent),
  style: el.querySelector("select").value,
  styles: [...el.querySelectorAll("select option")].map((o) => o.textContent),
  note: el.querySelector("textarea").value,
  noteHelp: el.querySelector("textarea").previousElementSibling.textContent,
  agentText: el.querySelector(".home-presentation-text").textContent,
  buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
}));
const reviewState = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  source: el.querySelector(".review-settings-source").textContent,
  current: el.querySelector(".settings-current").textContent,
  harness: el.querySelectorAll("select")[0].value,
  harnesses: [...el.querySelectorAll("select")[0].options].map((o) => o.textContent),
  model: el.querySelectorAll("select")[1].value,
  models: [...el.querySelectorAll("select")[1].options].map((o) => o.textContent),
  modelHelp: el.querySelectorAll(".settings-row")[1].querySelector(".settings-row-help").textContent,
  buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
}));

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- Home presentation, changed in English and not saved.
  let box = await openEditor("home presentation", "Home presentation", "home");
  await box.locator("textarea").waitFor({ timeout: 10_000 });
  await box.locator("select").selectOption("default");
  await box.locator("textarea").fill("Tables for numbers");
  const homeEn = await homeState(box);
  assert.deepEqual([homeEn.lang, homeEn.heading, homeEn.current, homeEn.style, homeEn.note], ["en", "Home", "Visual first · with your note", "default", "Tables for numbers"]);
  assert.equal(homeEn.agentText, AGENT_TEXT);
  assert.deepEqual(homeEn.buttons, ["Restore default", "Save Home preference"]);
  check("Home presentation in English, changed and not saved", { buttons: homeEn.buttons });

  let meanwhile = await elsewhere("zh-Hans", box.locator(".settings-row-title", { hasText: "展示方式" }));
  const homeZh = await homeState(box);
  assert.deepEqual([homeZh.lang, homeZh.heading, homeZh.current], ["zh-Hans", "Home", "视觉优先 · 附你的备注"]);
  assert.deepEqual(homeZh.titles, ["展示方式", "你的备注（可选）", "Agent 现在收到的内容（按原文显示）"]);
  assert.deepEqual(homeZh.styles, ["默认", "视觉优先"]);
  assert.deepEqual([homeZh.style, homeZh.note], ["default", "Tables for numbers"], "the unsaved change stays");
  assert.equal(homeZh.noteHelp, "用你自己的话补充这项偏好。18/300");
  assert.equal(homeZh.agentText, AGENT_TEXT, "what Agents receive, as Core wrote it");
  assert.deepEqual(homeZh.buttons, ["恢复默认", "保存 Home 偏好"]);
  assert.deepEqual(pageOwn(meanwhile), []);
  await page.screenshot({ path: join(output, "home-zh.png") });
  check("changed to Chinese in another window: Home is Chinese, the unsaved change and what Agents receive as they were, nothing read or saved", { titles: homeZh.titles, meanwhile });

  // ---- Code review, in Chinese, another model chosen and not saved.
  box = await openEditor("代码审查", "代码审查", "review");
  await box.locator("select").nth(1).locator("option", { hasText: "Fixture Sonnet" }).waitFor({ state: "attached", timeout: 10_000 });
  const listed = report.reads.filter((read) => read.startsWith("GET /api/models")).length;
  await box.locator("select").nth(1).selectOption("fixture-sonnet");
  const reviewZh = await reviewState(box);
  assert.deepEqual([reviewZh.lang, reviewZh.heading, reviewZh.current], ["zh-Hans", "代码审查", "Claude Code · Fixture Opus"]);
  assert.equal(reviewZh.source, "已为此 Workspace 设置。内置：Codex · GPT-6.1 Sol。");
  assert.deepEqual(reviewZh.harnesses, ["Codex", "Claude Code"]);
  assert.deepEqual([reviewZh.harness, reviewZh.model], ["claude", "fixture-sonnet"]);
  assert.deepEqual(reviewZh.models, ["Fixture Opus · 默认", "Fixture Sonnet"]);
  assert.equal(reviewZh.modelHelp, "Faster fixture model.", "a model's own description, as it comes");
  assert.deepEqual(reviewZh.buttons, ["使用内置", "保存审查设置"]);
  await page.screenshot({ path: join(output, "review-zh.png") });
  check("Code review in Chinese: harness and model names, a model's description and the built-in reviewer as they come", { source: reviewZh.source, models: reviewZh.models });

  meanwhile = await elsewhere("en", box.locator("h3", { hasText: "Code review" }));
  const reviewEn = await reviewState(box);
  assert.equal(reviewEn.source, "Set for this Workspace. Built in: Codex · GPT-6.1 Sol.");
  assert.deepEqual([reviewEn.lang, reviewEn.harness, reviewEn.model, reviewEn.modelHelp], ["en", "claude", "fixture-sonnet", "Faster fixture model."], "the unsaved choice stays");
  assert.deepEqual(reviewEn.models, ["Fixture Opus · default", "Fixture Sonnet"]);
  assert.deepEqual(reviewEn.buttons, ["Use built-in", "Save review settings"]);
  assert.equal(report.reads.filter((read) => read.startsWith("GET /api/models")).length, listed, "the models not listed again");
  assert.deepEqual(pageOwn(meanwhile), []);
  check("changed to English in another window: Code review is English, the unsaved choice stays, nothing read or saved", { meanwhile });

  // Home, back in English: as it was, the change still unsaved.
  box = await openEditor("home presentation", "Home presentation", "home");
  assert.deepEqual(await homeState(box), homeEn, "Home as it was in English");
  check("Home presentation, back in English, is as it was, its change still unsaved");

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "nothing was written to Core");
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
