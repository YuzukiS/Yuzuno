// T-189: Data & storage and Copy diagnostics in the interface language, in
// Chromium (en-US), with every API answered here (no Core, no daily
// configuration or data). Through the real Settings:
//  - 简体中文 chosen on the Language page: Data & storage is Chinese; what
//    Core reports (a reason, a path, a listed item) and names stay as they
//    come;
//  - the language changed in another window while Data & storage is open:
//    it rewrites itself without reading Core's overview again;
//  - Copy diagnostics previewed in Chinese: the report itself stays as it
//    is; changed to English in another window, the lines are English, the
//    same text is shown and nothing is gathered again;
//  - clearing recorded errors refused, then done: said in Chinese;
//  - nothing is written to Core (Data & storage's task choice reads Core's
//    task list, a read sent as POST: T-193).
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/storage-language-check.mjs
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
const HOST = "yuzuno-storage-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const DATA_DIR = "/home/someone/.local/share/yuzuno/workspace";
const overview = {
  format: 1,
  readAt: "2026-10-24T22:00:00Z",
  dataDir: DATA_DIR,
  entries: [
    { name: "claude-runtime", what: "claudeRuntime", kind: "folder", backup: "excluded", backupReason: "A cache of the Claude runtime, which Core rebuilds" },
    { name: "input-images", what: "inputImages", kind: "folder", backup: "copied", backupReason: null },
    { name: "new-thing", what: "somethingNew", kind: "folder", backup: "notCopied", backupReason: null },
    { name: "workspace.sqlite", what: "database", kind: "file", bytes: 3145728, diskBytes: 3149824, modifiedAt: null, backup: "copied", backupReason: null },
  ],
  unreadable: null,
  database: { pageSize: 4096, pages: 768, freePages: 10 },
  jobs: { total: 12, unfinished: 1 },
  native: [{ harness: "codex", machine: null, agents: 3, closed: 1 }],
  notInBackup: ["Native session histories kept by Codex, Claude Code and OpenCode outside the Workspace"],
};
const ERROR_RECORD = JSON.stringify({ errors: [{ kind: "render", name: "TypeError", codes: [], summary: "x is not a function", where: [], first: "2026-10-24T12:00:00.000Z", last: "2026-10-24T12:00:00.000Z", count: 1 }] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript((ERROR_RECORD) => {
  window.EventSource = class { close() {} };
  if (localStorage.getItem("seeded")) return;
  localStorage.setItem("seeded", "1");
  localStorage.setItem("yuzuno.diagnostics.v1", ERROR_RECORD);
}, ERROR_RECORD);
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method === "POST" && path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [{ id: "T-7", title: "Build cache", status: "done" }], hasMore: false } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-storage-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/storage": overview,
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
// Another window of the same site: where the language is changed while the
// first keeps its page open.
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
/** The language changed in the other window: this one follows it. */
async function elsewhere(language) {
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
}
const count = (prefix) => report.reads.filter((read) => read.startsWith(prefix)).length;
const CJK = /[㐀-鿿！-｠]/;

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/`);

  // 简体中文 on the Language page.
  let box = await openEditor("language", "Language", "language");
  await box.locator('input[name="interface-language"][value="zh-Hans"]').check();
  box = await openEditor("数据与存储", "数据与存储概览", "storage");
  await box.locator('[data-entry="workspace.sqlite"]').waitFor({ timeout: 10_000 });
  assert.equal(await box.getAttribute("lang"), "zh-Hans");
  const zh = await box.evaluate((el) => ({
    heading: el.querySelector("#settings-storage-title").textContent,
    preferences: el.querySelector('[data-group="preferences"]')?.textContent ?? null,
    excluded: el.querySelector('[data-entry="claude-runtime"]').textContent,
    unknown: el.querySelector('[data-entry="new-thing"]').textContent,
    database: el.querySelector('[data-entry="workspace.sqlite"]').textContent,
    never: [...el.querySelectorAll(".storage-list li")].map((li) => li.textContent),
    tasks: el.querySelector('[aria-labelledby="storage-task-folders"]').textContent,
    text: el.textContent,
  }));
  assert.equal(zh.heading, "数据与存储");
  assert.match(zh.preferences, /^此设备的偏好约 .+\d+ 项 · 外观、发送方式、面板宽度和 Home 布局。$/);
  assert.match(zh.excluded, /^Claude 运行环境缓存大小未知claude-runtime · 不在备份中：A cache of the Claude runtime, which Core rebuilds$/, "Core's reason as it comes");
  assert.match(zh.unknown, /^somethingNew大小未知new-thing · 不在备份中$/, "a name this version doesn't know, as it comes");
  assert.match(zh.database, /^Workspace 数据库3\.0 MiB · 磁盘上 3\.0 MiBworkspace\.sqlite · 在 Workspace 备份中，作为一致的副本$/);
  assert.deepEqual(zh.never, ["Native session histories kept by Codex, Claude Code and OpenCode outside the Workspace"]);
  assert.ok(zh.text.includes(DATA_DIR), "the path as it is");
  assert.match(zh.text, /12 条 Job 记录，1 条未完成。/);
  assert.match(zh.text, /Codex · Core 主机大小未知3 个 Agent（1 个已关闭） · 由 Codex 保存在那台电脑上它自己的文件夹中。/);
  assert.doesNotMatch(zh.text, /size unknown|Not in a backup|entries ·/);
  assert.match(zh.tasks, /^任务工作目录中的构建输出任务已登记工作目录中由 Cargo 生成的构建输出.+不会预览或移除任何内容。已归档的任务不在此列出。任务选择任务…T-7 · Build cache · done打开它的 Workspace 部分$/, "a task by its ID, its title as it comes");
  await page.screenshot({ path: join(output, "storage-zh.png") });
  check("Data & storage in Chinese; Core's reason, path and listed item, and a name this version doesn't know, as they come", { heading: zh.heading });

  // Changed in another window, Data & storage open: rewritten, Core not read again.
  const storageReads = count("GET /api/storage");
  await elsewhere("en");
  await page.waitForFunction(() => document.querySelector("#settings-storage-title")?.textContent === "Data & storage", null, { timeout: 10_000 });
  const en = await box.evaluate((el) => el.querySelector('[data-entry="claude-runtime"]').textContent);
  assert.equal(en, "Claude runtime cachesize unknownclaude-runtime · Not in a backup: A cache of the Claude runtime, which Core rebuilds");
  assert.equal(count("GET /api/storage"), storageReads, "no new read of Core's overview");
  check("the language changed in another window: the open Data & storage page is English, Core's overview not read again", { storageReads });
  await elsewhere("zh-Hans");
  await page.waitForFunction(() => document.querySelector("#settings-storage-title")?.textContent === "数据与存储", null, { timeout: 10_000 });

  // Copy diagnostics in Chinese: the report itself as it is.
  box = await openEditor("复制诊断", "复制诊断信息", "diagnostics");
  assert.equal(await box.getAttribute("lang"), "zh-Hans");
  assert.match(await box.locator(".diagnostics-clear .diagnostics-note").first().textContent(), /^此浏览器为此站点保存了 1 条已记录的错误。清除只会删除这些错误记录/);
  await box.getByRole("button", { name: "预览诊断信息" }).click();
  await box.locator("textarea").waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector("#settings-diagnostics [role=status]")?.textContent.includes("这就是全部文本"), null, { timeout: 10_000 });
  const reportText = await box.locator("textarea").inputValue();
  assert.ok(reportText.length > 50);
  assert.doesNotMatch(reportText, CJK, "the report itself is not translated");
  assert.equal(await box.locator("textarea").getAttribute("aria-label"), "诊断信息");
  const gathered = count("GET /api/health") + count("GET /api/diagnostics/memory");
  check("Copy diagnostics previewed in Chinese; the report's text stays as it is", { reportStart: reportText.split("\n")[0] });

  // Changed in another window, preview open: the same text, nothing gathered again.
  await elsewhere("en");
  await page.waitForFunction(() => document.querySelector("#settings-diagnostics [role=status]")?.textContent === "This is the whole text. Nothing has been copied, saved or sent.", null, { timeout: 10_000 });
  assert.equal(await box.locator("textarea").inputValue(), reportText, "the same text, not gathered again");
  assert.equal(count("GET /api/health") + count("GET /api/diagnostics/memory"), gathered, "nothing gathered again");
  assert.equal(await box.getByRole("button", { name: "Preview again" }).count(), 1);
  check("the language changed in another window: the open preview's lines are English, the same text, nothing gathered again");
  await elsewhere("zh-Hans");
  await page.waitForFunction(() => document.querySelector("#settings-diagnostics h3")?.textContent === "诊断信息", null, { timeout: 10_000 });

  // Clearing: refused, then done, said in Chinese.
  await page.evaluate(() => {
    window.realSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, ...rest) {
      if (name === "yuzuno.diagnostics.v1") throw new DOMException("Refused here.", "QuotaExceededError");
      return window.realSetItem.call(this, name, ...rest);
    };
  });
  await box.getByRole("button", { name: "清除已记录的错误" }).click();
  const refused = await box.locator(".diagnostics-clear [role=alert]").textContent();
  assert.match(refused, /^没有清除任何内容：此浏览器拒绝保存这次更改（.+）。已记录的错误保持原样。$/);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.realSetItem;
  });
  await box.getByRole("button", { name: "清除已记录的错误" }).click();
  const cleared = await box.locator(".diagnostics-clear [role=status]").textContent();
  assert.equal(cleared, "已从此浏览器为此站点清除 1 条已记录的错误。");
  assert.equal(await box.locator("#settings-diagnostics > [role=status]").last().textContent(), "此文本是在清除已记录的错误之前收集的。重新预览可查看当前的记录。");
  await page.screenshot({ path: join(output, "diagnostics-zh.png") });
  check("clearing the recorded errors refused, then done: both said in Chinese", { refused, cleared });

  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "nothing was written to Core");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, "check-report.json"), JSON.stringify(report, null, 1));
  await browser.close();
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
