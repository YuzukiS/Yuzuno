// T-189: the interface language in Chromium, with every API answered here
// (no Core, no daily configuration or data). In the production build's real
// Settings (search → Language → a choice):
//  - en-US: English as before; 简体中文 turns Settings' dialog, categories,
//    directory and search, and the Language, Sending messages, Clock & time
//    zone and Keyboard shortcuts pages Chinese at once; key names, Agent
//    names and time zones stay as written; Workspace service is Chinese
//    too; the clock format and time zone are
//    left as they were; search finds entries by English or Chinese words;
//  - a reload keeps it; a choice the browser refuses applies in this window,
//    is said not saved in Chinese, and is gone after a reload; Restore
//    defaults removes it and System is English again;
//  - ja-JP: System is English, and says Japanese isn't available;
//  - zh-CN: System is Chinese, with nothing saved.
// Nothing is written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/language-check.mjs
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
const report = { task: "T-189", checks: [], states: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = [{ id: "t0", status: "completed", items: [
  { id: "u0", type: "userMessage", content: [{ type: "text", text: "Is the build green?" }] },
  { id: "r0", type: "agentMessage", text: "Yes, every job passed." },
] }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const TIME = '{"clock":"h24","timeZone":"America/New_York"}';
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function open(locale, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((TIME) => {
    window.EventSource = class { close() {} };
    // Once: a reload keeps what the page stored since.
    if (sessionStorage.getItem("language-seeded")) return;
    sessionStorage.setItem("language-seeded", "1");
    localStorage.setItem("yuzuno.time", TIME);
  }, TIME);
  page.on("pageerror", (error) => report.errors.push(`${label}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method !== "GET") {
      report.writes.push({ case: label, method, path });
      return route.fulfill({ json: {} });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
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
  await page.goto(`https://${HOST}/`);
  await page.locator("button.workspace-settings").waitFor({ timeout: 10_000 });
  return { context, page };
}

const dialog = (page) => page.getByRole("dialog");
async function openSettings(page) {
  if (await page.locator(".settings-search input").isVisible()) return;
  await page.locator("button.workspace-settings").click({ timeout: 10_000 });
  await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
}
async function closeSettings(page) {
  await dialog(page).locator(".modal-heading .icon-button").click();
  await dialog(page).waitFor({ state: "detached", timeout: 10_000 });
}
/** Settings' shell as shown: its title, close button, categories and lang. */
const shell = (page) => dialog(page).evaluate((box) => ({
  title: box.querySelector(".modal-heading h2")?.textContent ?? null,
  close: box.querySelector(".modal-heading .icon-button")?.getAttribute("aria-label") ?? null,
  // Each category's full name: the tab's name, beside its short one (T-187).
  tabs: [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.querySelector(".sr-only").textContent),
  lang: box.querySelector(".settings-center")?.getAttribute("lang") ?? null,
  search: box.querySelector(".settings-search input")?.getAttribute("placeholder") ?? null,
}));
/** The search's cards: each title, as shown. */
async function search(page, query) {
  await openSettings(page);
  await page.locator(".settings-search input").fill(query);
  await page.locator(".settings-catalog-heading [role=status]").waitFor({ timeout: 10_000 });
  return page.locator(".settings-catalog-card h4").allTextContents();
}
/** An editor, opened as its search finds it; its heading, lang and save line. */
async function openEditor(page, query, title, editor) {
  const cards = await search(page, query);
  assert.ok(cards.includes(title), `${query}: ${JSON.stringify(cards)}`);
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
  await card.locator("button").click();
  const box = page.locator(`#settings-editor-${editor}`);
  await box.waitFor({ timeout: 10_000 });
  return box;
}
const editorState = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3")?.textContent ?? null,
  status: el.querySelector(".save-status [role=status]")?.textContent.trim() ?? null,
  alert: el.querySelector(".save-status [role=alert]")?.textContent.trim() ?? null,
  checked: [...el.querySelectorAll("input[type=radio]:checked")].map((input) => input.value),
}));
const choose = async (box, value) => box.locator(`input[name="interface-language"][value="${value}"]`).check();
const stored = (page, key) => page.evaluate((key) => localStorage.getItem(key), key);
const refuseLanguage = (page, refuse) => page.evaluate((refuse) => {
  const storage = Storage.prototype;
  window.languageStorage ||= { setItem: storage.setItem };
  if (!refuse) return Object.assign(storage, window.languageStorage);
  storage.setItem = function (key, ...rest) {
    if (key === "yuzuno.language") throw new DOMException("Refused here.", "QuotaExceededError");
    return window.languageStorage.setItem.call(this, key, ...rest);
  };
}, refuse);
const EN_TABS = ["Appearance & interaction", "Notifications & attention", "Agents & runtime", "Connections & devices", "Projects & collaboration", "Jobs & resources", "Data, privacy & recovery", "Updates & about"];
const ZH_TABS = ["外观与交互", "通知与提醒", "Agent 与运行环境", "连接与设备", "项目与协作", "Job 与资源", "数据、隐私与恢复", "更新与关于"];

try {
  // ---- en-US
  {
    const { context, page } = await open("en-US", "en-US");
    await openSettings(page);
    const english = await shell(page);
    assert.deepEqual(english, { title: "Settings", close: "Close dialog", tabs: EN_TABS, lang: "en", search: "Search settings…" });
    let box = await openEditor(page, "language", "Language", "language");
    const before = await editorState(box);
    assert.deepEqual(before.checked, ["system"]);
    assert.equal(before.status, "Using the defaults; nothing is saved on this device yet");
    check("unset in an English browser: Settings is in English as before, and Language is found and opened from its search", { english });

    await choose(box, "zh-Hans");
    const chinese = await shell(page);
    assert.deepEqual(chinese, { title: "设置", close: "关闭对话框", tabs: ZH_TABS, lang: "zh-Hans", search: "搜索设置…" });
    const language = await editorState(box);
    assert.deepEqual(language, { lang: "zh-Hans", heading: "界面语言", status: "已保存到此设备", alert: null, checked: ["zh-Hans"] });
    const coverage = await box.locator(".input-preferences-fixed").textContent();
    assert.match(coverage, /“界面语言”、“发送消息”、“时钟与时区”、“键盘快捷键”、“主题、文字与布局”、“把偏好移到另一台设备”、“数据与存储概览”、“复制诊断信息”、“通知偏好”、“关于与帮助”、“Home 展示”、“代码审查”、“手机与远程访问”、“运行环境与版本”、“新 Agent 默认值”、“Workspace 备份与恢复”、“历史与内存信息”、“草稿存储”、“版本与更新”/);
    assert.match(coverage, /仍为英文/);
    assert.match(coverage, /系统通知（包括测试通知）也仍为英文/);
    assert.match(coverage, /“项目”窗口也会随之显示：项目列表、新建项目、项目页面及其中的“新 Agent 默认值”、“代码审查”/);
    assert.equal(await stored(page, "yuzuno.language"), '{"language":"zh-Hans"}');
    assert.equal(await stored(page, "yuzuno.time"), TIME, "the clock format and time zone are left as they were");
    await page.screenshot({ path: join(output, "language-zh.png") });
    check("简体中文 turns Settings' dialog, categories, search and the Language page Chinese at once, saves it on this device, and leaves the time preferences alone", { chinese, coverage });

    // Search, by either language's words; cards in Chinese.
    assert.deepEqual(await search(page, "时区"), ["时钟与时区"]);
    assert.deepEqual(await search(page, "clock"), ["时钟与时区"]);
    assert.deepEqual(await search(page, "sending"), ["发送消息"]);
    const cardText = await page.locator(".settings-catalog-card").first().textContent();
    assert.match(cardText, /范围：此设备 · 此站点/);
    assert.match(cardText, /打开发送消息/);
    check("search finds entries by English or Chinese words, its cards in Chinese");

    // The device's pages, in Chinese; names, keys and zones as written.
    box = await openEditor(page, "时区", "时钟与时区", "time");
    const time = await editorState(box);
    assert.deepEqual([time.lang, time.heading, time.checked], ["zh-Hans", "时钟与时区", ["h24"]]);
    assert.equal(await box.getByRole("combobox", { name: "时区" }).inputValue(), "America/New_York");
    assert.match(await box.textContent(), /24 小时制/);
    box = await openEditor(page, "发送键", "发送消息", "input");
    const input = await editorState(box);
    assert.deepEqual([input.lang, input.heading, input.checked], ["zh-Hans", "发送消息", ["auto"]]);
    assert.match(await box.locator(".settings-current").textContent(), /^Return：发送$/);
    box = await openEditor(page, "快捷键", "键盘快捷键", "shortcuts");
    const help = await box.evaluate((el) => ({
      heading: el.querySelector("h3").textContent,
      groups: [...el.querySelectorAll(".shortcut-group h4")].map((h) => h.textContent),
      keys: [...new Set([...el.querySelectorAll("kbd")].map((k) => k.textContent))],
    }));
    assert.equal(help.heading, "键盘快捷键");
    assert.deepEqual(help.groups, ["任何地方", "撰写消息", "阅读会话", "Home", "列表与对话框"]);
    for (const key of ["Ctrl", "Return", "Shift", "Esc", "Tab"]) assert.ok(help.keys.includes(key), key);
    // New Agent defaults has had model and reasoning defaults since #266.
    const models = await search(page, "推理");
    assert.deepEqual(models, ["模型、推理与权限", "新 Agent 默认值"]);
    const agentsListed = await page.locator(".settings-catalog-card select option").allTextContents();
    assert.deepEqual(agentsListed, ["选择一个 Agent…", "Mori"], "an Agent's name stays as it was written");
    check("Clock & time zone, Sending messages and Keyboard shortcuts are in Chinese; key names, Agent names and time zones stay as written", { help });

    // Workspace service (Versions & updates), the last editor translated: Chinese, marked so.
    await page.locator('[role="tab"]', { hasText: "更新与关于" }).click();
    box = page.locator("#settings-editor-updates");
    await box.waitFor({ timeout: 10_000 });
    const updates = await editorState(box);
    assert.equal(updates.lang, "zh-Hans");
    assert.equal(updates.heading, "Workspace 服务");
    check("Workspace service, translated with the rest of Settings, is Chinese, marked lang=zh-Hans", { updates });

    // Kept after a reload.
    await closeSettings(page);
    await page.reload();
    await page.locator("button.workspace-settings").waitFor({ timeout: 10_000 });
    await openSettings(page);
    assert.deepEqual((await shell(page)).tabs, ZH_TABS);
    check("the choice is kept after a reload");

    // Refused, in Chinese: in effect here, said not saved, gone after a reload.
    box = await openEditor(page, "语言", "界面语言", "language");
    await choose(box, "en");
    assert.deepEqual((await shell(page)).tabs, EN_TABS);
    assert.equal(await stored(page, "yuzuno.language"), '{"language":"en"}');
    await refuseLanguage(page, true);
    await choose(box, "zh-Hans");
    const refused = await editorState(box);
    assert.equal(refused.status, null, "never Saved");
    assert.equal(refused.alert, "未保存到此设备：此浏览器为 Yuzuno 保留的存储空间已满。你的选择在此窗口中生效，直到关闭或重新加载它。");
    assert.deepEqual((await shell(page)).tabs, ZH_TABS, "it applies in this window");
    assert.equal(await stored(page, "yuzuno.language"), '{"language":"en"}');
    await page.screenshot({ path: join(output, "language-refused.png") });
    await closeSettings(page);
    await page.reload();
    await page.locator("button.workspace-settings").waitFor({ timeout: 10_000 });
    await openSettings(page);
    assert.deepEqual((await shell(page)).tabs, EN_TABS, "gone after a reload");
    check("a choice the browser refuses applies in this window, is said not saved in Chinese, and is gone after a reload", { alert: refused.alert });

    // Restore defaults: removed; System, here English.
    await refuseLanguage(page, false);
    box = await openEditor(page, "language", "Language", "language");
    await choose(box, "zh-Hans");
    await box.getByRole("button", { name: "恢复默认" }).click();
    const restored = await editorState(box);
    assert.deepEqual([restored.checked, restored.status, restored.heading], [["system"], "Defaults restored on this device", "Language"]);
    assert.equal(await stored(page, "yuzuno.language"), null);
    assert.equal(await stored(page, "yuzuno.time"), TIME);
    assert.deepEqual(await shell(page), english);
    check("Restore defaults removes this device's choice; System is English here, the time preferences as they were");
    await context.close();
  }

  // ---- ja-JP: System is English, saying why.
  {
    const { context, page } = await open("ja-JP", "ja-JP");
    await openSettings(page);
    assert.deepEqual((await shell(page)).tabs, EN_TABS);
    const box = await openEditor(page, "language", "Language", "language");
    const note = await box.locator('label:has(input[value="system"]) small').textContent();
    assert.match(note, /^This browser asks for Japanese.*which this version doesn’t have, so English is shown\.$/);
    assert.equal(await box.locator('label:has(input[value="system"]) strong').textContent(), "System · English");
    check("a browser in Japanese: System shows English and says Japanese isn't available", { note });
    await context.close();
  }

  // ---- zh-CN: System is Chinese, nothing saved.
  {
    const { context, page } = await open("zh-CN", "zh-CN");
    await openSettings(page);
    assert.deepEqual(await shell(page), { title: "设置", close: "关闭对话框", tabs: ZH_TABS, lang: "zh-Hans", search: "搜索设置…" });
    const box = await openEditor(page, "语言", "界面语言", "language");
    const state = await editorState(box);
    assert.deepEqual([state.checked, state.status], [["system"], "正在使用默认值；此设备上还没有保存任何选择"]);
    assert.equal(await stored(page, "yuzuno.language"), null);
    check("a browser in Simplified Chinese: System shows Settings in Chinese with nothing saved");
    await context.close();
  }

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
