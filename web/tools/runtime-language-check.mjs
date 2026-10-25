// T-189: Runtime & versions in the interface language, in Chromium (en-US),
// with every API answered here (no Core, no CLI, no SSH, no daily
// configuration). Through the real Settings:
//  - in English: Check models pressed (one catalog listed, one failing), a
//    Codex Agent chosen for MCP services;
//  - the language changed in another window: the section is Chinese, with
//    versions, releases, paths, accounts, sign-in methods, the SDK registry
//    and what Core or a CLI said as they came; the chosen Agent and the model
//    results kept; the Agent's MCP report still English, marked lang=en;
//    nothing read again, no model listed, no MCP report asked for;
//  - back to English in another window: the section is as it was;
//  - nothing is written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/runtime-language-check.mjs
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
const HOST = "yuzuno-runtime-language.test";
const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const agent = (id, name, harness) => ({ id, name, status: "idle", harness, cwd: "/fixture", model: "m", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" });
const agents = [agent("c1", "Mori", "claude"), agent("x1", "Kiri", "codex")];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const SSH_ERROR = "ssh: connect to host box.test port 22: Connection timed out";
const CLAUDE_ERROR = "Claude Code could not start: fixture";
const machines = [
  { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: {
    machineId: "local", startedAt: ago(5 * MIN), checkedAt: ago(5 * MIN), durationMs: 900, reachable: true,
    harnesses: [
      { harness: "codex", supported: true, found: true, version: "codex-cli 0.162.1", executable: "/usr/bin/codex" },
      { harness: "claude", supported: true, found: true, version: "2.1.296 (Claude Code)", signIn: { state: "signedIn", method: "claude.ai" } },
    ] } },
  { id: "box", name: "Build box", kind: "ssh", target: "builder@box.test", defaultCwd: "/srv", limitMode: "strict", lastCheck: {
    machineId: "box", startedAt: ago(2 * 60 * MIN), checkedAt: ago(2 * 60 * MIN), durationMs: 10_000, reachable: false, error: SSH_ERROR, harnesses: [] } },
];
const answers = {
  "/api/health": { version: "2026.10.24-core.17", releaseId: "core-20261024-c215011", apiReady: true, storageReady: true },
  "/api/machines": { machines },
  "/api/workspace": { workspace: { id: "ws-runtime-language" }, agents, projects, runtime: { connected: true, account: "person@example.test" }, defaultCwd: "/fixture" },
  "/api/jobs/budget": { ...idleJobsBudget, machine: { ...idleJobsBudget.machine, name: "Core host", scope: "Only jobs managed by this Core share this budget." } },
  "/api/claude-sdk": {
    format: 1, readAt: "2026-10-24T12:00:00Z", runtime: { kind: "release", release: "core-20261024-c215011" },
    sdk: { state: "locked", version: "0.3.296", registry: "registry.npmjs.org" },
    copy: { state: "inUse", copy: { version: "0.3.296", source: { from: "release", release: "core-20261020-aaaaaaa" }, at: "2026-10-24T11:00:00Z" } },
  },
  "/api/models": { models: [{ id: "m1", model: "gpt-6", displayName: "GPT-6", isDefault: true }, { id: "m2", model: "gpt-6-mini", displayName: "GPT-6 mini" }] },
  "/api/agents/x1/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0,
    servers: [{ name: "github", status: "ready", error: null, failureReason: null, observedAt: ago(MIN) }] },
  "/api/home": home, "/api/updates": unmanagedUpdates, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
};
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
  // The Claude catalog fails as a CLI that can't start would; Mori's last MCP report can't be read.
  if (key === "/api/models?harness=claude") return route.fulfill({ status: 500, json: { error: CLAUDE_ERROR } });
  if (path === "/api/agents/c1/claude/mcp-status") return route.fulfill({ status: 500, json: { error: "no report" } });
  const json = answers[path];
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
// What only this section reads: Core's health, the SDK, model catalogs and
// MCP reports; and anything not a GET.
const sectionReads = (reads) => reads.filter((read) => /\/api\/(health|claude-sdk|models|agents\/[^/]+\/(claude|codex)\/mcp)/.test(read) || !read.startsWith("GET "));
const state = (box) => box.evaluate((el) => {
  const facts = (root) => Object.fromEntries([...root.querySelectorAll(":scope > dl .runtime-fact, :scope > dl > .runtime-fact")].map((f) => [f.querySelector("dt").textContent, f.querySelector("dd").textContent]));
  const machine = (name) => [...el.querySelectorAll(".runtime-machine")].find((m) => m.querySelector("h5").textContent === name);
  const harness = (m, name) => [...m.querySelectorAll(".runtime-harness")].find((h) => h.querySelector("h6").textContent === name);
  const host = machine("Core host"), box = machine("Build box");
  const mcp = el.querySelector(".runtime-mcp");
  const english = mcp.querySelector('[lang="en"]');
  return {
    lang: el.getAttribute("lang"),
    heading: el.querySelector("h3").textContent,
    groups: [...el.querySelectorAll(".runtime-group > h4")].map((h) => h.textContent),
    core: facts(el.querySelector(".runtime-group")),
    host: { where: host.querySelector(".runtime-where").textContent, checked: host.querySelector(".runtime-checked").textContent, facts: facts(host) },
    codex: facts(harness(host, "Codex")),
    claude: facts(harness(host, "Claude Code")),
    box: { where: box.querySelector(".runtime-where").textContent, checked: box.querySelector(".runtime-checked").textContent, facts: facts(box) },
    modelsButton: host.querySelector(".runtime-models-check button").textContent,
    chosen: mcp.querySelector("select").value,
    options: [...mcp.querySelectorAll("select option")].map((o) => o.textContent),
    mcpEnglish: !!english,
    mcpText: english?.textContent ?? null,
  };
});

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- In English: models checked, Kiri chosen for MCP services.
  let box = await openEditor("runtime", "Runtime & versions", "runtime");
  await box.locator(".runtime-machine").first().waitFor({ timeout: 10_000 });
  await box.getByRole("button", { name: "Check models" }).click();
  await box.locator(".runtime-fact", { hasText: "2 models" }).waitFor({ timeout: 10_000 });
  await box.locator(".runtime-mcp select").selectOption("x1");
  await box.locator(".runtime-mcp", { hasText: "github" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const en = await state(box);
  assert.deepEqual([en.lang, en.heading, en.chosen], ["en", "Runtime & versions", "x1"]);
  assert.match(en.codex.Models, /^Yes2 modelsDefault GPT-6 · checked .+$/);
  assert.match(en.claude.Models, new RegExp(`^NoCouldn't list models.*${CLAUDE_ERROR}.* · checked .+$`));
  assert.match(en.host.checked, /^Last checked 5 min ago \(.+\)$/);
  assert.ok(en.mcpEnglish && /Ready at startup/.test(en.mcpText), "Kiri's MCP report");
  check("Runtime & versions in English: models checked, an Agent chosen for MCP services", { codexModels: en.codex.Models });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", box, "运行环境与版本");
  const zh = await state(box);
  assert.deepEqual([zh.lang, zh.heading], ["zh-Hans", "运行环境与版本"]);
  assert.deepEqual(zh.groups, ["Workspace 服务", "此设备", "机器", "MCP 服务"]);
  assert.equal(zh.core["版本"], "是2026.10.24-core.17", "the version as Core gave it");
  assert.equal(zh.core["发布"], "是core-20261024-c215011");
  assert.equal(zh.core["状态"], "是已就绪");
  assert.match(zh.core["Claude Agent SDK"], /^是已锁定 0\.3\.296按发布 core-20261024-c215011 中的 claude-agent-sdk\.json 锁定，来自 registry\.npmjs\.org。Core 读取于 .+。$/);
  assert.deepEqual([zh.host.where, zh.box.where], ["Core 主机", "builder@box.test"]);
  assert.match(zh.host.checked, /^上次检查：5 分钟前（.+）$/);
  assert.match(zh.box.checked, /^上次检查：2 小时前（.+） · 超过一小时$/);
  assert.equal(zh.box.facts["连通"], `否未连到${SSH_ERROR}`, "the SSH error as it came");
  assert.equal(zh.codex.CLI, "是已找到 · codex-cli 0.162.1/usr/bin/codex", "version and path as they came");
  assert.equal(zh.codex["登录"], "是已登录person@example.test");
  assert.equal(zh.claude["登录"], "是已登录claude.ai", "the sign-in method as it came");
  assert.match(zh.codex["模型"], /^是2 个模型默认 GPT-6 · 检查于 .+$/, "the model check kept");
  assert.match(zh.claude["模型"], new RegExp(`^否无法列出模型.*${CLAUDE_ERROR}.* · 检查于 .+$`), "its error as the CLI said it");
  assert.equal(zh.modelsButton, "检查模型");
  assert.deepEqual([zh.chosen, zh.options], ["x1", ["Mori · Claude Code · Core 主机", "Kiri · Codex · Core 主机"]], "the chosen Agent kept");
  assert.ok(zh.mcpEnglish, "the MCP report is marked lang=en");
  assert.equal(zh.mcpText, en.mcpText, "the MCP report as it was, in English");
  assert.deepEqual(sectionReads(meanwhile), []);
  await page.screenshot({ path: join(output, "runtime-zh.png") });
  check("changed to Chinese in another window: the section is Chinese, Core's and the CLIs' values as they came, the model check and chosen Agent kept, the MCP report English; nothing read", { meanwhile });

  // ---- Back to English in another window.
  meanwhile = await elsewhere("en", box, "Runtime & versions");
  assert.deepEqual(await state(box), en, "as it was in English");
  assert.deepEqual(sectionReads(meanwhile), []);
  check("back to English in another window: the section is as it was, nothing read", { meanwhile });

  const count = (prefix) => report.reads.filter((read) => read.startsWith(prefix)).length;
  report.counts = { health: count("GET /api/health"), sdk: count("GET /api/claude-sdk"), codexModels: count("GET /api/models"), mcp: count("GET /api/agents/") };
  // Opening reads once; Check models lists each catalog once and reads the section again.
  assert.deepEqual([count("GET /api/health"), count("GET /api/claude-sdk"), count("GET /api/models?harness=claude")], [2, 2, 1]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "nothing written to Core");
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
