// T-189: the shell's operation areas in the interface language, in Chromium
// (en-US), with every API answered here (no Core; nothing is reconnected,
// interrupted or disconnected). Through the real app:
//  - in English: the status bar, an Agent's actions menu and Reconnect all,
//    opened on synthetic Agents (one connected and idle, one offline);
//  - the language changed in another window while Reconnect all is open:
//    the dialog and the status bar are Chinese, Agent and machine names as
//    they came, the dialog kept open; the menu and the Disconnect
//    confirmation it opens are Chinese, cancelled; nothing sent;
//  - back to English in another window: the menu is as it was.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/ops-language-check.mjs
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
const HOST = "yuzuno-ops-language.test";

const agent = (id, name, status, connectionState, extra = {}) => ({
  id, name, status, harness: "codex", threadId: `native-${id}`, cwd: "/fixture", model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState, ...extra,
});
const agents = [agent("a", "Mori", "idle", "connected"), agent("c", "Pine", "offline", "disconnected")];
const home = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
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
  if (/^\/api\/agents\/[ac]\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    // A reconnect, interrupt or disconnect would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const one = path.match(/^\/api\/agents\/([ac])$/);
  const json = one
    ? { agent: agents.find((a) => a.id === one[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] }
    : {
        "/api/workspace": { workspace: { id: "ws-ops-language" }, agents, projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
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

const setLanguage = (language) => other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
// The actions menu of one Agent's row, opened from its "…" button: each entry by what it does.
async function menuOf(id) {
  await page.locator(`.agent-row[data-agent-id="${id}"] .agent-actions-button`).click();
  const menu = page.locator(".agent-actions-menu");
  await menu.waitFor({ timeout: 10_000 });
  return menu.evaluate((el) => ({
    lang: el.getAttribute("lang"),
    label: el.getAttribute("aria-label"),
    items: Object.fromEntries([...el.querySelectorAll("[data-action]")].map((item) => [item.dataset.action, item.textContent.trim()])),
  }));
}
const dialog = () => page.locator('[role="dialog"]');
const dialogState = () => dialog().evaluate((el) => ({
  lang: el.getAttribute("lang"),
  title: el.querySelector("h2")?.textContent ?? el.querySelector("[id^=radix]")?.textContent,
  close: el.querySelector(".modal-heading button")?.getAttribute("aria-label"),
  rows: [...el.querySelectorAll(".batch-row")].map((row) => [row.querySelector(".batch-name").textContent, row.querySelector(".batch-machine").textContent, row.querySelector(".batch-state").textContent]),
  buttons: [...el.querySelectorAll(".modal-actions button")].map((b) => b.textContent.trim()),
}));
const statusbar = () => page.locator(".event-connection-status").textContent();

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });

  // ---- In English.
  assert.match(await statusbar(), /^Live updates (connecting|reconnecting)$/);
  const enMenu = await menuOf("a");
  assert.equal(enMenu.label, "Mori actions");
  assert.equal(enMenu.items.disconnect, "Disconnect…");
  assert.equal(enMenu.items.manage, "Manage…");
  await page.keyboard.press("Escape");
  const pineMenu = await menuOf("c");
  assert.equal(pineMenu.items.reconnect, "Reconnect");
  await page.keyboard.press("Escape");
  const reconnectButton = page.locator(".rail-reconnect");
  assert.equal(await reconnectButton.getAttribute("aria-label"), "Reconnect agents: 1 not connected");
  await reconnectButton.click();
  await dialog().waitFor({ timeout: 10_000 });
  const enDialog = await dialogState();
  assert.deepEqual(enDialog.rows, [["Pine", "Core host", "Offline"]]);
  assert.deepEqual(enDialog.buttons, ["Select all", "Reconnect"]);
  check("in English: the status bar, Mori's and Pine's actions menus, Reconnect all", { enMenu, pineMenu, enDialog });

  // ---- Changed to Chinese in another window, Reconnect all open.
  await setLanguage("zh-Hans");
  await page.locator('[role="dialog"] .batch-row .batch-state', { hasText: "离线" }).waitFor({ timeout: 10_000 });
  const zhDialog = await dialogState();
  assert.equal(zhDialog.lang, "zh-Hans");
  assert.equal(zhDialog.close, "关闭对话框");
  assert.deepEqual(zhDialog.rows, [["Pine", "Core 主机", "离线"]], "the name as it came");
  assert.deepEqual(zhDialog.buttons, ["全选", "重新连接"]);
  assert.match(await dialog().textContent(), /重新连接 Agent/);
  assert.match(await statusbar(), /^实时更新正在(连接|重新连接)$/);
  assert.equal(await reconnectButton.getAttribute("aria-label"), "重新连接 Agent：1 个未连接");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  const zhMenu = await menuOf("a");
  assert.deepEqual([zhMenu.lang, zhMenu.label], ["zh-Hans", "Mori 的操作"]);
  assert.equal(zhMenu.items.disconnect, "断开连接…");
  assert.equal(zhMenu.items.settings, "Agent 设置…");
  assert.equal(zhMenu.items.manage, "管理…");
  assert.deepEqual(Object.keys(zhMenu.items), Object.keys(enMenu.items), "the same entries");
  // Disconnect opens its confirmation; Cancel sends nothing.
  await page.locator('.agent-actions-menu [data-action="disconnect"]').click();
  await dialog().waitFor({ timeout: 10_000 });
  const confirm = await dialogState();
  assert.equal(confirm.lang, "zh-Hans");
  assert.match(await dialog().textContent(), /断开 Mori 的连接？/);
  assert.match(await dialog().textContent(), /这会停止此 Agent 在此电脑上的 Codex 会话。/);
  assert.deepEqual(confirm.buttons, ["取消", "断开连接"]);
  await dialog().getByRole("button", { name: "取消" }).click();
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  assert.deepEqual(report.posts, [], "nothing reconnected, interrupted or disconnected");
  await page.screenshot({ path: join(output, "ops-zh.png") });
  check("changed to Chinese in another window: Reconnect all, the status bar, the actions menu and Disconnect's confirmation are Chinese, names as they came; nothing sent", { zhDialog, zhMenu, confirm });

  // ---- Back to English in another window.
  await setLanguage("en");
  await page.locator(".event-connection-status", { hasText: "Live updates" }).waitFor({ timeout: 10_000 });
  assert.deepEqual(await menuOf("a"), enMenu, "the menu as it was in English");
  await page.keyboard.press("Escape");
  check("back to English in another window: the menu as it was");

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
