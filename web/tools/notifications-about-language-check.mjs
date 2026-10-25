// T-189: Notification preferences and About & help in the interface
// language, in Chromium (en-US), with every API answered here and the
// browser's Notification replaced by a fake that only records (no Core, no
// daily configuration or data, no real notification). Through the real
// Settings:
//  - Notifications set up in English (asked from the click, muted, a test
//    sent), then the language changed in another window: the open page is
//    Chinese with the same choices, the same test result, nothing asked,
//    shown or saved again; a test sent in Chinese says what it said in English;
//  - About & help in Chinese: versions, the release ID and commit, the
//    release notes, links and a license text as they are; changed to English
//    in another window, the opened license and the failed read stay, worded
//    in English, nothing read again;
//  - nothing is written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/notifications-about-language-check.mjs
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
const HOST = "yuzuno-notifications-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const COMMIT = "c215011" + "9".repeat(33);
const NOTES = "Fixture notes for this release.\n- Settings gains Runtime & versions.";
const updates = { ...unmanagedUpdates, current: { ...unmanagedUpdates.current, releaseId: "core-20261024-c215011", version: "2026.10.24-core.17", gitSha: COMMIT, notes: NOTES } };
const TEST = { title: "Yuzuno", body: "A test notification from your Workspace.", tag: "yuzuno:test" };
const LICENSE = await readFile(join(dist, "licenses/LICENSE"), "utf8");
const types = { "": "text/plain", ".txt": "text/plain", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
  // Records what the page asks of the browser; shows nothing.
  window.asked = 0;
  window.shown = [];
  window.Notification = class {
    static permission = "default";
    static requestPermission() {
      window.asked += 1;
      window.Notification.permission = "granted";
      return Promise.resolve("granted");
    }
    constructor(title, options = {}) {
      window.shown.push({ title, body: options.body, tag: options.tag });
      setTimeout(() => this.onshow?.());
    }
    close() {}
  };
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  // The other window is a plain page of the same site, not the app.
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/") || path.startsWith("/licenses/")) report.reads.push(`${method} ${path}`);
  if (path === "/licenses/LICENSE-NotoSansSC.txt") return route.abort();
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-notifications-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": updates, "/api/jobs/budget": idleJobsBudget,
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
 * what this page read meanwhile, once `heading` shows. */
async function elsewhere(language, box, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await box.locator("h3", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
const browserState = () => page.evaluate(() => ({ asked: window.asked, shown: window.shown, saved: localStorage.getItem("yuzuno.notifications") }));
const notifications = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  current: el.querySelector(".settings-current").textContent,
  access: el.querySelector(".notification-access").textContent,
  rows: [...el.querySelectorAll("label.settings-row")].map((row) => [row.querySelector(".settings-row-title").textContent, row.querySelector("input").checked]),
  test: el.querySelector(".notification-test-result")?.textContent ?? null,
  outcome: el.querySelector(".notification-test-result")?.dataset.outcome ?? null,
  button: el.querySelector(".settings-row-action button").textContent,
}));
const about = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  current: el.querySelector(".settings-current").textContent,
  version: el.querySelector(".about-version").textContent,
  codes: [...el.querySelectorAll(".about-version code")].map((code) => [code.textContent, code.getAttribute("title")]),
  notesSummary: el.querySelector(".updates-notes:not(.about-license) summary").textContent,
  notes: el.querySelector(".updates-release-notes:not(.about-license-text)").textContent,
  links: [...el.querySelectorAll("a.about-link")].map((a) => [a.textContent, a.href]),
  licenses: [...el.querySelectorAll("details.about-license")].map((d) => ({
    title: d.querySelector("summary").textContent,
    open: d.open,
    text: d.querySelector("pre")?.textContent ?? null,
    alert: d.querySelector("[role=alert]")?.textContent ?? null,
  })),
}));
const pageOwn = (reads) => reads.filter((read) => read.includes("/licenses/") || read.endsWith(" /api/updates") || !read.startsWith("GET "));
const count = (path) => report.reads.filter((read) => read === `GET ${path}`).length;
const LINKS = [
  `https://github.com/YuzukiS/Yuzuno/releases`,
  `https://github.com/YuzukiS/Yuzuno/blob/${COMMIT}/README.md`,
  `https://github.com/YuzukiS/Yuzuno/issues/new/choose`,
  `https://github.com/YuzukiS/Yuzuno/security/advisories/new`,
];

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- Notifications, set up in English.
  await openSettings();
  await page.locator('[role="tab"]', { hasText: "Notifications & attention" }).click();
  let box = page.locator("#settings-editor-notifications");
  await box.waitFor({ timeout: 10_000 });
  assert.equal((await notifications(box)).access, "Not asked yet");
  // Clicked, not check(): the switch turns on only once the browser answers.
  await box.locator("label.settings-row", { hasText: "Notify me on this device" }).locator("input").click();
  await box.locator(".notification-access", { hasText: "Allowed" }).waitFor({ timeout: 10_000 });
  await box.locator("label.settings-row", { hasText: "Mute on this device" }).locator("input").click();
  await box.locator(".settings-current", { hasText: "Muted" }).waitFor({ timeout: 10_000 });
  await box.getByRole("button", { name: "Send a test" }).click();
  await box.locator(".notification-test-result").waitFor({ timeout: 10_000 });
  const en = await notifications(box);
  const set = await browserState();
  assert.deepEqual([en.lang, en.heading, en.current, en.access, en.outcome], ["en", "Notifications", "Muted", "Allowed", "shown"]);
  assert.match(en.test, /^Your browser reports it was shown\./);
  assert.deepEqual([set.asked, set.shown], [1, [TEST]]);
  check("Notifications in English: asked from the click, muted, a test sent", { rows: en.rows, saved: set.saved });

  // Changed to Chinese in another window, the page open.
  let meanwhile = await elsewhere("zh-Hans", box, "通知");
  const zh = await notifications(box);
  assert.deepEqual([zh.lang, zh.heading, zh.current, zh.access, zh.outcome, zh.button], ["zh-Hans", "通知", "已静音", "已允许", "shown", "发送测试"]);
  assert.match(zh.test, /^你的浏览器报告已显示。/);
  assert.deepEqual(zh.rows.map(([, on]) => on), en.rows.map(([, on]) => on), "the same choices");
  assert.deepEqual(zh.rows.map(([title]) => title), ["在此设备上通知我", "有 Agent 需要你", "Turn 失败", "Turn 完成", "每日备份失败", "显示所写的内容", "在此设备上静音"]);
  assert.deepEqual(await browserState(), set, "nothing asked, shown or saved");
  assert.deepEqual(pageOwn(meanwhile), []);
  await page.screenshot({ path: join(output, "notifications-zh.png") });
  check("changed to Chinese in another window: the open Notifications page is Chinese, the same choices and test result; nothing asked, shown or saved", { rows: zh.rows, test: zh.test, meanwhile });

  await box.getByRole("button", { name: "发送测试" }).click();
  await page.waitForFunction(() => window.shown.length === 2, null, { timeout: 10_000 });
  const again = await browserState();
  assert.deepEqual([again.asked, again.shown, again.saved], [1, [TEST, TEST], set.saved]);
  check("a test sent from the Chinese page is the same English notification", { shown: again.shown[1] });

  // ---- About & help, in Chinese.
  box = await openEditor("关于", "关于与帮助", "about");
  await box.locator(".about-version").waitFor({ timeout: 10_000 });
  const aboutZh = await about(box);
  assert.deepEqual([aboutZh.lang, aboutZh.heading, aboutZh.current], ["zh-Hans", "关于与帮助", "2026.10.24-core.17"]);
  assert.equal(aboutZh.version, `Workspace 服务 2026.10.24-core.17core-20261024-c215011${COMMIT.slice(0, 8)}`);
  assert.deepEqual(aboutZh.codes, [["core-20261024-c215011", null], [COMMIT.slice(0, 8), COMMIT]]);
  assert.equal(aboutZh.notesSummary, "2026.10.24-core.17 的更新内容");
  assert.equal(aboutZh.notes, NOTES, "the release notes as they are");
  assert.deepEqual(aboutZh.links.map(([, href]) => href), LINKS);
  assert.deepEqual(aboutZh.links.map(([label]) => label), ["所有已发布的版本", "此版本的 README", "报告问题或请求功能", "私下报告安全问题"]);
  assert.deepEqual(aboutZh.licenses.map((license) => license.title), ["Yuzuno · Apache License 2.0", "Noto Sans SC 字体 · SIL Open Font License 1.1", "此页面的第三方声明"]);
  assert.equal(count("/licenses/LICENSE"), 0, "not read before it is opened");
  await box.locator("details.about-license summary", { hasText: "Apache License 2.0" }).click();
  await box.locator("details.about-license pre").waitFor({ timeout: 10_000 });
  await box.locator("details.about-license summary", { hasText: "SIL Open Font License" }).click();
  await box.locator("details.about-license [role=alert]").waitFor({ timeout: 10_000 });
  const opened = await about(box);
  assert.equal(opened.licenses[0].text, LICENSE, "the license text as the build serves it");
  const failed = opened.licenses[1].alert;
  assert.match(failed, /^无法从 Workspace 服务读取：\S/);
  const browserMessage = failed.slice("无法从 Workspace 服务读取：".length);
  assert.deepEqual([count("/licenses/LICENSE"), count("/licenses/LICENSE-NotoSansSC.txt")], [1, 1]);
  await page.screenshot({ path: join(output, "about-zh.png") });
  check("About & help in Chinese: versions, release ID, commit, notes, links and the license text as they are; a failed read keeps the browser's words", { version: aboutZh.version, failed });

  // Changed to English in another window, About open with a license read.
  meanwhile = await elsewhere("en", box, "About & help");
  const aboutEn = await about(box);
  assert.deepEqual([aboutEn.lang, aboutEn.notesSummary, aboutEn.notes], ["en", "What’s in 2026.10.24-core.17", NOTES]);
  assert.equal(aboutEn.version, `Workspace service 2026.10.24-core.17core-20261024-c215011${COMMIT.slice(0, 8)}`);
  assert.deepEqual(aboutEn.links, [["Every published release", LINKS[0]], ["Read me for this version", LINKS[1]], ["Report a problem or request a feature", LINKS[2]], ["Report a security problem privately", LINKS[3]]]);
  assert.deepEqual(aboutEn.licenses.map(({ open, text }) => [open, text]), [[true, LICENSE], [true, null], [false, null]], "the same ones open");
  assert.equal(aboutEn.licenses[1].alert, `Couldn’t read it from the Workspace service: ${browserMessage}`);
  assert.deepEqual([count("/licenses/LICENSE"), count("/licenses/LICENSE-NotoSansSC.txt")], [1, 1], "nothing read again");
  assert.deepEqual(pageOwn(meanwhile), []);
  check("changed to English in another window: About is English, the opened license and the failed read stay, nothing read again", { failed: aboutEn.licenses[1].alert, meanwhile });

  await page.locator('[role="tab"]', { hasText: "Notifications & attention" }).click();
  box = page.locator("#settings-editor-notifications");
  await box.locator("h3", { hasText: "Notifications" }).waitFor({ timeout: 10_000 });
  assert.deepEqual(await notifications(box), en, "Notifications as it was in English");
  assert.deepEqual((await browserState()).shown.length, 2);
  check("Notifications, back in English, is as it was, its test result included");

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
