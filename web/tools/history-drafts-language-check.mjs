// T-189: History and Drafts in the interface language, in Chromium (en-US),
// with every API answered here (no Core) and synthetic drafts saved for this
// site. Through the real Settings:
//  - in English: the stored history measured once; a draft ticked, shown
//    whole and its .txt asked for;
//  - the language changed in another window: both pages are Chinese, Core's
//    numbers and names and the draft as they were, the choice and the shown
//    draft kept, the download only said to be asked for; nothing measured
//    again, no draft read or written, nothing downloaded;
//  - back to English in another window: both pages are as they were.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/history-drafts-language-check.mjs
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
const report = { task: "T-189", checks: [], reads: [], posts: [], downloads: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-history-drafts-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const MiB = 1024 * 1024;
const part = (rows, bytes) => ({ rows, bytes });
// A synthetic GET /api/diagnostics/memory/history report: one held Agent.
const parts = { items: part(40, 3 * MiB), payloads: part(2, 12 * MiB), turns: part(3, 6144), metadata: part(1, 2048), previews: part(2, 8192) };
const history = { format: 1, readAt: "2026-10-23T08:00:00+00:00", available: true, heldAgents: 1,
  agents: [{ agentId: "a", name: "Mori", unwrittenChanges: true, stored: true, layout: 1, ...parts }], total: parts };
// A synthetic draft saved for this site, with one pasted text.
const drafts = {
  "yuzuno.composer.v1:a": JSON.stringify({ version: 1, nextNumber: 2, parts: [{ kind: "text", text: "Synthetic draft words " }, { kind: "paste", id: "p1", number: 1, bodyId: "b1" }] }),
  "yuzuno.paste.v1:a:b1": "SYNTHETIC PASTED line one\nline two",
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", acceptDownloads: true });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
  // Every read and write of a draft in this window, kept apart from the page.
  const draftKey = (key) => /^yuzuno\.(composer\.v1:|paste\.v1:|drafts$)/.test(String(key));
  const seen = { reads: [], writes: [] };
  Object.defineProperty(window, "__drafts", { value: seen });
  const { getItem, setItem, removeItem } = Storage.prototype;
  Storage.prototype.getItem = function (key) {
    if (draftKey(key)) seen.reads.push(key);
    return getItem.call(this, key);
  };
  Storage.prototype.setItem = function (key, value) {
    if (draftKey(key)) seen.writes.push(`set ${key}`);
    return setItem.call(this, key, value);
  };
  Storage.prototype.removeItem = function (key) {
    if (draftKey(key)) seen.writes.push(`remove ${key}`);
    return removeItem.call(this, key);
  };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-history-drafts-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/diagnostics/memory/history": history,
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
page.on("download", (download) => report.downloads.push(download.suggestedFilename()));
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
const measured = () => report.reads.filter((read) => read === "GET /api/diagnostics/memory/history").length;
const draftUse = () => page.evaluate(() => ({ reads: window.__drafts.reads.length, writes: [...window.__drafts.writes] }));
async function elsewhere(language, heading) {
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await page.locator("#settings-drafts h3", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}
// Both pages as shown: History stays mounted, hidden, while Drafts is open.
const state = () => page.evaluate(() => {
  const history = document.querySelector("#settings-history"), drafts = document.querySelector("#settings-drafts");
  const texts = (root, selector) => [...root.querySelectorAll(selector)].map((el) => el.textContent);
  return {
    lang: [history.closest("[lang]").getAttribute("lang"), drafts.closest("[lang]").getAttribute("lang")],
    history: {
      heading: history.querySelector("h3").textContent,
      head: texts(history, "thead th"),
      rows: [...history.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent)),
      caption: history.querySelector("caption").textContent,
      legend: texts(history, ".history-legend li"),
      button: history.querySelector("header button").textContent,
    },
    drafts: {
      heading: drafts.querySelector("h3").textContent,
      row: drafts.querySelector('[data-agent="a"]').textContent,
      ticked: drafts.querySelector('[data-agent="a"] input[type="checkbox"]').checked,
      status: texts(drafts, '[role="status"]'),
      shown: drafts.querySelector("textarea").value,
      label: drafts.querySelector("textarea").getAttribute("aria-label"),
    },
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  await other.evaluate((drafts) => { for (const [key, value] of Object.entries(drafts)) localStorage.setItem(key, value); }, drafts);
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });

  // ---- In English.
  const historyBox = await openEditor("history", "History & memory information", "history");
  assert.equal(measured(), 0, "opening History reads nothing");
  await historyBox.getByRole("button", { name: "Measure" }).click();
  await historyBox.locator("table").waitFor({ timeout: 10_000 });
  const draftsBox = await openEditor("draft", "Draft storage", "drafts");
  await draftsBox.locator('[data-agent="a"]').waitFor({ timeout: 10_000 });
  await draftsBox.locator('[data-agent="a"] input[type="checkbox"]').check();
  await draftsBox.getByRole("button", { name: "Show the draft for Mori" }).click();
  await draftsBox.locator("textarea").waitFor({ timeout: 10_000 });
  await draftsBox.getByRole("button", { name: "Download .txt" }).click();
  await draftsBox.getByText(/^Your browser was asked to save yuzuno-draft-Mori-/).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const en = await state();
  assert.deepEqual(en.lang, ["en", "en"]);
  assert.deepEqual(en.history.rows, [
    ["Mori *", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "2.0 KiB (1)", "15.0 MiB", "8.0 KiB (2)"],
    ["All held", "3.0 MiB (40)", "12.0 MiB (2)", "6.0 KiB (3)", "2.0 KiB (1)", "15.0 MiB", "8.0 KiB (2)"],
  ]);
  assert.match(en.drafts.row, /^Mori22 characters of text, 1 pasted text Show$/);
  assert.match(en.drafts.shown, /^Yuzuno draft for Mori\n[^]*Synthetic draft words \n\[Pasted text #1, 2 lines\]\nSYNTHETIC PASTED line one\nline two\n\[End of pasted text #1\]\n$/);
  assert.equal(measured(), 1);
  assert.equal(report.downloads.length, 1, "the one .txt asked for");
  check("History and Drafts in English: measured once; a draft ticked, shown whole and its file asked for", { history: en.history.rows, downloads: report.downloads });

  // ---- Changed to Chinese in another window.
  const before = { use: await draftUse(), reads: report.reads.length };
  await elsewhere("zh-Hans", "此设备上的草稿");
  const zh = await state();
  assert.deepEqual(zh.lang, ["zh-Hans", "zh-Hans"]);
  assert.deepEqual(zh.history.heading, "Core 持有的 Agent 的已存储历史");
  assert.deepEqual(zh.history.head, ["Agent", "条目文本", "大型载荷", "Turn", "元数据", "记录", "预览"]);
  assert.deepEqual(zh.history.rows, [en.history.rows[0], ["全部持有", ...en.history.rows[1].slice(1)]], "Core's numbers and names as they came");
  assert.match(zh.history.caption, /^已存储字节（行数），读取于 \S/);
  assert.deepEqual(zh.history.legend, ["条目文本", "大型载荷", "Turn", "元数据"]);
  assert.equal(zh.history.button, "测量");
  assert.equal(zh.drafts.row, "Mori文本 22 个字符，粘贴的文本 1 段 显示");
  assert.equal(zh.drafts.ticked, true, "the choice stays");
  assert.deepEqual(zh.drafts.status.map((s) => s.replace(/yuzuno-draft-Mori-[\dTZ-]+\.txt/, "FILE")), [
    "已选择 1 份草稿。只有在下载时才会读取它们粘贴的文本。",
    "已请求浏览器保存 FILE。如果没有出现文件，请选中下方文字并复制。",
  ], "the download said to be asked for, not saved");
  assert.equal(zh.drafts.shown, en.drafts.shown, "the shown draft as it was");
  assert.equal(zh.drafts.label, "Mori 已保存的草稿");
  const meanwhile = report.reads.slice(before.reads);
  assert.deepEqual(meanwhile.filter((read) => read.includes("/api/diagnostics/memory/history") || !read.startsWith("GET ")), [], "nothing measured or sent");
  assert.deepEqual(await draftUse(), before.use, "no draft read or written");
  assert.equal(report.downloads.length, 1, "nothing downloaded");
  await page.screenshot({ path: join(output, "drafts-zh.png") });
  check("changed to Chinese in another window: both pages Chinese, Core's numbers, names and the draft as they came, the choice and the shown draft kept; nothing measured, read, written or downloaded", { zh, meanwhile });

  // ---- Back to English in another window.
  await elsewhere("en", "Drafts on this device");
  assert.deepEqual(await state(), en, "as it was in English");
  assert.deepEqual(await draftUse(), before.use);
  assert.deepEqual([measured(), report.downloads.length], [1, 1]);
  check("back to English in another window: both pages as they were, nothing measured, read, written or downloaded");

  assert.deepEqual(report.posts, [], "nothing sent");
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
