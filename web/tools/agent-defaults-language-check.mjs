// T-189: New Agent defaults in the interface language, in Chromium (en-US),
// with every API answered here (no Core, no CLI, no daily configuration).
// Through the real Settings:
//  - in English: a permission and an effort changed and not saved, the
//    Claude Code model's choice opened (its catalog read once, failing);
//  - the language changed in another window: the editor is Chinese with the
//    same unsaved choices; model names, efforts, Core's sentence about where
//    a model applies and the catalog's error as they came; no catalog read
//    again, nothing written;
//  - back to English in another window: the editor is as it was.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/agent-defaults-language-check.mjs
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
const HOST = "yuzuno-agent-defaults-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// What Core says, as it would say it.
const APPLIES = "Codex Agents created on the Core host (fixture: Core's own sentence).";
const CLAUDE_ERROR = "Claude Code could not start: fixture";
const defaults = {
  saved: { harness: "claude", codexModel: "gpt-6" },
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default", codexModel: null, codexReasoningEffort: null, claudeModel: null },
  modelAppliesTo: APPLIES,
  effective: {
    harness: { value: "claude", source: "workspace" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
    codexModel: { value: "gpt-6", source: "workspace" },
    codexReasoningEffort: { value: null, source: "builtin" },
    claudeModel: { value: null, source: "builtin" },
  },
};
const codexModels = { models: [{ id: "m1", model: "gpt-6", displayName: "GPT-6", isDefault: true, defaultReasoningEffort: "high",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] }] };
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
  const key = path + (path === "/api/models" ? url.search : "");
  if (path.startsWith("/api/")) report.reads.push(`${method} ${key}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  if (key === "/api/models?harness=claude") return route.fulfill({ status: 500, json: { error: CLAUDE_ERROR } });
  const json = {
    "/api/workspace": { workspace: { id: "ws-agent-defaults-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/agent-defaults": defaults, "/api/models": codexModels,
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
async function elsewhere(language, box, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await box.locator("h3", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
// What only this editor reads or writes: its defaults and the two catalogs.
const editorReads = (reads) => reads.filter((read) => /\/api\/(agent-defaults|models)/.test(read) || !read.startsWith("GET "));
const count = (read) => report.reads.filter((r) => r === read).length;
// The editor's selects, in order: harness, Codex and Claude Code permissions,
// Codex model and effort, Claude Code model.
const state = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  current: el.querySelector(".settings-current").textContent,
  titles: [...el.querySelectorAll(".settings-row-title")].map((t) => t.textContent),
  sources: [...el.querySelectorAll(".agent-default-source")].map((s) => s.textContent),
  helps: [...el.querySelectorAll(".settings-row-help:not(.agent-default-source):not(.updates-error)")].map((s) => s.textContent),
  selects: [...el.querySelectorAll("select")].map((s) => [s.getAttribute("aria-label"), s.value, [...s.options].map((o) => o.textContent)]),
  alerts: [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
  buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
}));

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- In English: two unsaved choices, the Claude Code model's choice opened.
  let box = await openEditor("new agent", "New Agent defaults", "agent-defaults");
  await box.locator('select[aria-label="Codex reasoning effort for new Agents"]:not([disabled])').waitFor({ timeout: 10_000 });
  await box.locator('select[aria-label="Codex permissions for new Agents"]').selectOption("full");
  await box.locator('select[aria-label="Codex reasoning effort for new Agents"]').selectOption("low");
  await box.locator('select[aria-label="Claude Code model for new Agents"]').focus();
  await box.locator('[role="alert"]', { hasText: "Claude Code models" }).waitFor({ timeout: 10_000 });
  const en = await state(box);
  assert.deepEqual([en.lang, en.heading, en.current], ["en", "New Agent defaults", "Claude Code · Ask before actions"]);
  assert.deepEqual(en.selects.map(([, value]) => value), ["claude", "full", "", "gpt-6", "low", ""]);
  assert.ok(en.helps.includes(APPLIES), "Core's sentence about where a model applies");
  assert.ok(en.alerts.some((a) => a.startsWith("Couldn’t read this Core host’s Claude Code models: ") && a.includes(CLAUDE_ERROR)), en.alerts.join("|"));
  assert.deepEqual(en.buttons, ["Use built-in for all", "Save"]);
  check("New Agent defaults in English: two unsaved choices, the Claude Code catalog read once and failing", { selects: en.selects.map(([label, value]) => [label, value]) });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", box, "新 Agent 默认值");
  const zh = await state(box);
  assert.deepEqual([zh.lang, zh.heading, zh.current], ["zh-Hans", "新 Agent 默认值", "Claude Code · 操作前询问"]);
  assert.deepEqual(zh.titles, ["Harness", "Codex 权限", "Claude Code 权限", "Core 主机上的 Codex 模型", "Codex 推理强度", "Core 主机上的 Claude Code 模型"]);
  assert.deepEqual(zh.sources, [
    "已为此 Workspace 设置：Claude Code。创建对话框会以它开始；你可以为每个 Agent 另选。",
    "内置：请求批准。",
    "内置：操作前询问。",
    "已为此 Workspace 设置：gpt-6。",
    "内置：Claude Code 自己的默认值。",
  ]);
  assert.deepEqual(zh.selects.map(([, value]) => value), en.selects.map(([, value]) => value), "the unsaved choices stay");
  assert.deepEqual(zh.selects[1][2], ["内置 · 请求批准", "跟随 Codex 配置", "请求批准", "替我批准", "完全访问"]);
  assert.deepEqual(zh.selects[3][2], ["内置 · Codex 自己的默认值", "GPT-6"], "the model's name as the catalog gives it");
  assert.deepEqual(zh.selects[4][2], ["模型自己的 · high", "low", "high"], "efforts as Codex names them");
  assert.ok(zh.helps.includes(APPLIES), "Core's sentence as it came");
  assert.ok(zh.alerts.some((a) => a.startsWith("无法读取此 Core 主机的 Claude Code 模型：") && a.includes(CLAUDE_ERROR)), zh.alerts.join("|"));
  assert.deepEqual(zh.buttons, ["全部使用内置", "保存"]);
  assert.deepEqual(editorReads(meanwhile), []);
  await page.screenshot({ path: join(output, "agent-defaults-zh.png") });
  check("changed to Chinese in another window: the editor is Chinese, the unsaved choices kept, names, efforts, Core's sentence and the catalog error as they came; nothing read or written", { sources: zh.sources, meanwhile });

  // ---- Back to English in another window.
  meanwhile = await elsewhere("en", box, "New Agent defaults");
  assert.deepEqual(await state(box), en, "as it was in English");
  assert.deepEqual(editorReads(meanwhile), []);
  check("back to English in another window: the editor is as it was, nothing read or written", { meanwhile });

  report.counts = { defaults: count("GET /api/agent-defaults"), codex: count("GET /api/models"), claude: count("GET /api/models?harness=claude") };
  assert.deepEqual([report.counts.defaults, report.counts.codex, report.counts.claude], [1, 1, 1], "each read once");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "nothing saved");
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
