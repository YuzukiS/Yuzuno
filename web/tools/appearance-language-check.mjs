// T-189: Appearance and Move preferences in the interface language, in
// Chromium (en-US), with every API answered here (no Core, no daily
// configuration or data). In the production build's real Settings:
//  - an Appearance import previewed in English, a setting unticked, then
//    简体中文 chosen: the open preview is Chinese, with the same file, the
//    same ticks; a save the browser refuses is said not saved in Chinese and
//    changes nothing; applied, it says so in Chinese and saves only the
//    ticked settings;
//  - the Appearance file exported in Chinese has the same format, version
//    and fields as the one exported in English;
//  - Move preferences in Chinese: a file that isn't JSON and a clock this
//    version doesn't have are said in Chinese; switched back to English,
//    the same lines are English;
//  - the clock format and time zone are left as they were; nothing is
//    written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/appearance-language-check.mjs
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
const report = { task: "T-189", checks: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-appearance-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const TIME = '{"clock":"h24","timeZone":"America/New_York"}';
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
// A file another device exported: three settings differ from the defaults.
const appearanceFile = JSON.stringify({ format: "yuzuno-appearance", version: 1, exportedAt: "2026-10-24T12:00:00.000Z", appearance: { palette: "pine", theme: "dark", fontSize: 18 } });
const badClockFile = JSON.stringify({ format: "yuzuno-device-preferences", version: 1, sending: { sendKey: "enter" }, time: { clock: "h36" } });

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", acceptDownloads: true });
const page = await context.newPage();
await page.addInitScript((TIME) => {
  window.EventSource = class { close() {} };
  if (sessionStorage.getItem("seeded")) return;
  sessionStorage.setItem("seeded", "1");
  localStorage.setItem("yuzuno.time", TIME);
}, TIME);
page.on("pageerror", (error) => report.errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-appearance-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
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

async function openSettings() {
  if (await page.locator(".settings-search input").isVisible()) return;
  await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
  await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
}
/** An editor, opened from its card as Settings' search finds it. */
async function openEditor(query, title, editor) {
  await openSettings();
  await page.locator(".settings-search input").fill(query);
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator(`#settings-editor-${editor}`);
  await box.waitFor({ timeout: 10_000 });
  return box;
}
async function chooseLanguage(value, query, title) {
  const box = await openEditor(query, title, "language");
  await box.locator(`input[name="interface-language"][value="${value}"]`).check();
}
const appearanceBox = () => page.locator("#settings-editor-appearance");
async function toAppearance(tab) {
  await openSettings();
  await page.locator('[role="tab"]', { hasText: tab }).click();
  await appearanceBox().waitFor({ timeout: 10_000 });
  return appearanceBox();
}
const stored = (key) => page.evaluate((key) => localStorage.getItem(key), key);
const refuse = (key, refused) => page.evaluate(({ key, refused }) => {
  const storage = Storage.prototype;
  window.realSetItem ||= storage.setItem;
  storage.setItem = refused
    ? function (name, ...rest) {
        if (name === key) throw new DOMException("Refused here.", "QuotaExceededError");
        return window.realSetItem.call(this, name, ...rest);
      }
    : window.realSetItem;
}, { key, refused });
/** The preview as shown: its label, first line, rows and the Apply button. */
const preview = (box) => box.evaluate((el) => {
  const group = el.querySelector(".appearance-file-preview");
  if (!group) return null;
  return {
    label: group.getAttribute("aria-label"),
    lead: group.querySelector("p")?.textContent ?? null,
    rows: [...group.querySelectorAll("li")].map((li) => ({
      name: li.querySelector(".appearance-file-name")?.textContent.trim(),
      ticked: li.querySelector("input[type=checkbox]")?.checked ?? null,
      cells: [...li.querySelectorAll(":scope > span")].map((span) => span.textContent),
    })),
    apply: group.querySelector(".appearance-file-buttons button")?.textContent ?? null,
  };
});
async function exported(box, label) {
  const [download] = await Promise.all([page.waitForEvent("download"), box.getByRole("button", { name: label, exact: true }).first().click()]);
  return JSON.parse(await readFile(await download.path(), "utf8"));
}
const shape = (file) => ({ format: file.format, version: file.version, keys: Object.keys(file).sort(), fields: Object.keys(file.appearance).sort() });

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });

  // English: export, then import and untick Theme.
  let box = await toAppearance("Appearance & interaction");
  assert.equal(await box.locator("#settings-appearance-title").textContent(), "Appearance");
  assert.equal(await box.getAttribute("lang"), "en");
  const englishFile = await exported(box, "Export to a file");
  await box.locator('.appearance-file input[type="file"]').setInputFiles({ name: "appearance.json", mimeType: "application/json", buffer: Buffer.from(appearanceFile) });
  await box.locator(".appearance-file-preview").waitFor({ timeout: 10_000 });
  await box.locator(".appearance-file-preview li", { hasText: "Theme" }).locator("input[type=checkbox]").uncheck();
  const before = await preview(box);
  assert.equal(before.label, "Import preview");
  assert.equal(before.apply, "Apply 2 selected");
  check("English: Appearance exported, a file previewed and Theme unticked", { before });

  // 简体中文, chosen elsewhere in Settings: the open preview is Chinese, with the same file and ticks.
  await chooseLanguage("zh-Hans", "language", "Language");
  box = await toAppearance("外观与交互");
  assert.equal(await box.getAttribute("lang"), "zh-Hans");
  assert.equal(await box.locator("#settings-appearance-title").textContent(), "外观");
  const after = await preview(box);
  assert.equal(after.label, "导入预览");
  assert.equal(after.lead, "来自 appearance.json，导出于 " + after.lead.split("导出于 ")[1]);
  assert.match(after.lead, /。勾选的设置取自文件，其他的保持不变。$/);
  assert.deepEqual(after.rows.map((row) => [row.name, row.ticked]), [["配色", true], ["主题", false], ["文字大小", true]]);
  assert.deepEqual(after.rows.map((row) => row.ticked), before.rows.map((row) => row.ticked), "the same ticks");
  assert.deepEqual(after.rows[0].cells, ["当前：花园", "文件：松林"]);
  assert.equal(after.apply, "应用所选的 2 项");
  await page.screenshot({ path: join(output, "appearance-preview-zh.png") });
  check("switched to Chinese, the open preview is Chinese: the same file, the same ticks", { after });

  // A refused save, in Chinese: nothing changes.
  const appearanceBefore = await stored("yuzuno.appearance");
  await refuse("yuzuno.appearance", true);
  await box.locator(".appearance-file-preview .appearance-file-buttons button").first().click();
  const refusedLine = await box.locator(".appearance-file [role=alert]").textContent();
  assert.equal(refusedLine, "未导入：此浏览器为 Yuzuno 保留的存储空间已满。没有更改任何内容，你的外观保持不变。");
  assert.equal(await stored("yuzuno.appearance"), appearanceBefore);
  check("a save the browser refuses is said not saved in Chinese and changes nothing", { refusedLine });

  // Applied: said in Chinese; only the ticked settings saved.
  await refuse("yuzuno.appearance", false);
  await box.locator(".appearance-file-preview .appearance-file-buttons button").first().click();
  const doneLine = await box.locator(".appearance-file [role=status]").textContent();
  assert.equal(doneLine, "已从 appearance.json 导入 2 项设置，并保存到此设备。");
  const saved = JSON.parse(await stored("yuzuno.appearance"));
  assert.deepEqual([saved.palette, saved.fontSize, saved.theme], ["pine", 18, "light"], "Theme, unticked, is as it was");
  check("applied: said in Chinese, and only the ticked settings are saved", { doneLine });

  // The file exported in Chinese: the same format, version and fields.
  const chineseFile = await exported(box, "导出到文件");
  assert.deepEqual(shape(chineseFile), shape(englishFile));
  assert.deepEqual([chineseFile.appearance.palette, chineseFile.appearance.fontSize], ["pine", 18]);
  check("the Appearance file exported in Chinese has the same format, version and fields as in English", { shape: shape(chineseFile) });

  // Move preferences, in Chinese: refusals said in Chinese, then English after a switch.
  box = await openEditor("把偏好", "把偏好移到另一台设备", "transfer");
  assert.equal(await box.getAttribute("lang"), "zh-Hans");
  assert.equal(await box.locator("#settings-transfer-title").textContent(), "把偏好移到另一台设备");
  await box.locator('input[type="file"]').setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("not json") });
  const notJson = await box.locator("[role=alert]").textContent();
  assert.equal(notJson, "此文件不是 JSON，因此不是偏好导出文件。没有更改任何内容。");
  await box.locator('input[type="file"]').setInputFiles({ name: "device.json", mimeType: "application/json", buffer: Buffer.from(badClockFile) });
  const timeGroup = box.locator('.device-transfer-group[aria-label="时间显示"]');
  await timeGroup.waitFor({ timeout: 10_000 });
  const clockZh = await timeGroup.locator(".appearance-file-error").textContent();
  assert.match(clockZh, /^无法应用：文件中是此版本没有的时钟格式：.*h36.*。保持当前。$/);
  assert.equal(await box.locator('.device-transfer-group[aria-label="发送消息"] button').textContent(), "应用发送消息");
  check("Move preferences in Chinese: a file that isn't JSON and a clock this version doesn't have are said in Chinese", { notJson, clockZh });

  await chooseLanguage("en", "语言", "界面语言");
  box = await openEditor("transfer", "Move preferences to another device", "transfer");
  const clockEn = await box.locator('.device-transfer-group[aria-label="Time display"] .appearance-file-error').textContent();
  assert.match(clockEn, /^Can’t be applied: the file holds a clock format this version doesn’t have: .*h36.*\. Kept as now\.$/);
  assert.equal(await box.locator('.device-transfer-group[aria-label="Sending messages"] button').textContent(), "Apply Sending messages");
  check("switched back to English, the same preview's lines are English", { clockEn });

  assert.equal(await stored("yuzuno.time"), TIME, "the clock format and time zone are as they were");
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
