// T-189: an Agent's own panels and dialogs in the interface language, in
// Chromium (en-US), with every API answered here (no Core; nothing is saved,
// moved or reconnected). Through the real app, on synthetic Agents (Mori
// connected, Pine offline) and one project:
//  - in English: the context panel, and Agent settings with another effort
//    chosen and a context window typed;
//  - changed to Chinese in another window: the dialog, its permissions and
//    the context panel are Chinese; the model's name, the chosen effort and
//    the typed window as they were; closed with Escape, nothing saved;
//  - Manage, in Chinese, with another project chosen; changed back to English
//    in another window: the dialog stays open with that choice, in English;
//  - Pine's offline notice in English, then in Chinese, nothing reconnected;
//  - nothing posted but the reading place.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/agent-panels-language-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

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
const HOST = "yuzuno-agent-panels-language.test";

const settings = { reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write", permissionPreset: "ask" };
const agent = (id, name, status, connectionState) => ({
  id, name, status, harness: "codex", threadId: `native-${id}`, cwd: `/fixture/${name.toLowerCase()}`, model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState, settings,
});
const agents = [agent("a", "Mori", "idle", "connected"), agent("c", "Pine", "offline", "disconnected")];
const projects = [{ id: "p1", name: "Orchard", defaultDirs: {}, archivedAt: null, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] };
const now = new Date().toISOString();
const models = {
  models: [{
    id: "gpt-6", model: "gpt-6", displayName: "GPT-6 Fixture", description: "A synthetic model for this check", isDefault: true, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fixture low effort" },
      { reasoningEffort: "medium", description: "Fixture medium effort" },
      { reasoningEffort: "high", description: "Fixture high effort" },
    ],
  }],
  permissions: { presets: ["config", "ask", "auto", "full"].map((id) => ({
    id, available: true,
    permissions: { approvalPolicy: id === "full" ? "never" : "on-request", approvalsReviewer: id === "auto" ? "auto_review" : "user", sandbox: id === "full" ? "danger-full-access" : "workspace-write", profile: null },
  })) },
  context: { supported: true, settingsSubmitted: false, canApply: false, observedWindowTokens: 272000, requestedWindowTokens: null, observedStale: false, inheritedContextWindow: 272000, inheritedAutoCompactTokenLimit: null },
};
const usage = {
  revision: 1, status: "ready", account: { type: "chatgpt", label: "Fixture account", planType: "plus" }, accountId: "acct-fixture",
  source: { generation: "1", label: "Core host", machineId: null, runtimeId: null }, checkedAt: now, observedAt: now, ordinaryUsageAllowed: true, error: null,
  buckets: [{ limitId: "codex", limitName: "Codex", planType: "plus", observedAt: now, credits: null,
    primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600, observedAt: now }, secondary: null }],
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
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
    // A save, a move, a reconnect or a usage refresh would be one of these.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const one = path.match(/^\/api\/agents\/([ac])$/);
  const json = one
    ? { agent: agents.find((a) => a.id === one[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] }
    : {
        "/api/workspace": { workspace: { id: "ws-agent-panels-language" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
        "/api/agents/a/models": models,
        "/api/agents/a/codex/usage": usage,
        "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates,
        "/api/jobs": { jobs: [], liveJobs: [], hasMore: false, nextBefore: null }, "/api/jobs/live": { agents: {} },
        "/api/ci": { runs: [], subscriptions: [], hasMore: false, nextBefore: null }, "/api/ci/live": { runs: [], subscriptions: [], hasMore: false, nextBefore: null },
        "/api/reviews": { reviews: [], hasMore: false, nextBefore: null },
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
const dialog = () => page.locator('[role="dialog"]');
const dialogHead = () => dialog().evaluate((el) => ({
  lang: el.getAttribute("lang"),
  title: el.querySelector("h2")?.textContent,
  close: el.querySelector(".modal-heading button")?.getAttribute("aria-label"),
}));
// The context panel's own labels, and the folder as it came.
const panel = () => page.locator("#context-panel").evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector(".inspector-heading span")?.textContent,
  labels: [...el.querySelectorAll(".purpose-section dt")].map((dt) => dt.textContent),
  folder: el.querySelector(".purpose-section dd")?.textContent,
}));

try {
  await other.goto(`https://${HOST}/other.html`);
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').click();
  await page.locator("#context-panel .inspector-heading").waitFor({ timeout: 10_000 });

  // ---- In English: the panel, then Agent settings with a changed form.
  const enPanel = await panel();
  assert.equal(enPanel.heading, "At a glance");
  assert.deepEqual(enPanel.labels.slice(0, 4), ["Working folder", "Harness", "Location", "Session"]);
  assert.equal(enPanel.folder, "mori");
  await page.locator(".agent-settings-button").click();
  await dialog().waitFor({ timeout: 10_000 });
  await page.locator('input[name="agent-effort"][value="high"]').waitFor({ state: "attached", timeout: 10_000 });
  assert.equal((await dialogHead()).title, "Mori · Agent settings");
  // The chip, as a person chooses it (its radio is drawn by the chip).
  await dialog().locator('label.choice-chip[data-value="high"]').click();
  assert.equal(await page.locator('input[name="agent-effort"][value="high"]').isChecked(), true);
  await page.locator('input[aria-label="Context window tokens"]').fill("200000");
  check("in English: the context panel, and Agent settings with effort high and a window typed", { enPanel });

  // ---- Changed to Chinese in another window, the form open.
  await setLanguage("zh-Hans");
  await dialog().locator("h2", { hasText: "Mori · Agent 设置" }).waitFor({ timeout: 10_000 });
  const zhHead = await dialogHead();
  assert.deepEqual([zhHead.lang, zhHead.close], ["zh-Hans", "关闭对话框"]);
  assert.equal(await page.locator('input[name="agent-effort"][value="high"]').isChecked(), true, "the chosen effort kept");
  assert.equal(await page.locator('input[aria-label="上下文窗口 token 数"]').inputValue(), "200000", "the typed window kept");
  const zhDialog = await dialog().textContent();
  for (const words of ["推理强度", "上下文窗口", "权限", "请求审批", "执行机器：Core 主机", "保存"])
    assert.ok(zhDialog.includes(words), words);
  for (const raw of ["GPT-6 Fixture", "Fixture high effort"]) assert.ok(zhDialog.includes(raw), `${raw}, as it came`);
  const zhPanel = await panel();
  assert.equal(zhPanel.lang, "zh-Hans");
  assert.equal(zhPanel.heading, "概览");
  assert.deepEqual(zhPanel.labels.slice(0, 4), ["工作文件夹", "Harness", "位置", "会话"]);
  assert.equal(zhPanel.folder, "mori", "the folder as it came");
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  check("in Chinese: Agent settings and the context panel; the model, the chosen effort and the typed window kept; closed unsaved", { zhHead, zhPanel });

  // ---- Manage, a project chosen, then back to English.
  await page.locator('.agent-row[data-agent-id="a"] .agent-actions-button').click();
  await page.locator('.agent-actions-menu [data-action="manage"]').click();
  await dialog().locator("h2", { hasText: "会话操作" }).waitFor({ timeout: 10_000 });
  const picker = page.locator(".agent-project-picker");
  assert.match(await picker.textContent(), /项目.*无项目.*Orchard.*移动.*只改变 Mori 列在哪里/s);
  await picker.locator("select").selectOption("p1");
  await setLanguage("en");
  await dialog().locator("h2", { hasText: "Conversation actions" }).waitFor({ timeout: 10_000 });
  assert.equal(await picker.locator("select").inputValue(), "p1", "the chosen project kept");
  assert.equal(await picker.locator("button").textContent(), "Move");
  assert.equal(await picker.locator("button").isEnabled(), true);
  const enManage = await dialog().textContent();
  for (const words of ["Close agent", "Delete agent…", "Mark all as read", "Changes only where Mori is listed."])
    assert.ok(enManage.includes(words), words);
  await page.keyboard.press("Escape");
  await dialog().waitFor({ state: "detached", timeout: 10_000 });
  check("Manage in Chinese with Orchard chosen; back in English the dialog stays open with that choice; nothing moved");

  // ---- Pine's offline notice, in English and then in Chinese.
  await page.locator('.agent-row[data-agent-id="c"]').click();
  const notice = page.locator(".recovery-notice");
  await notice.waitFor({ timeout: 10_000 });
  assert.match(await notice.textContent(), /This agent’s session isn’t connected\. Reconnect to open the same session; nothing is sent\./);
  assert.equal(await notice.locator("button").textContent(), "Reconnect");
  await setLanguage("zh-Hans");
  await notice.locator("button", { hasText: "重新连接" }).waitFor({ timeout: 10_000 });
  assert.match(await notice.textContent(), /此 Agent 的会话未连接。/);
  assert.equal(await notice.getAttribute("lang"), "zh-Hans");
  check("Pine's offline notice in English, then in Chinese; nothing reconnected");

  assert.deepEqual(report.posts, [], "nothing saved, moved or reconnected");
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  check("nothing posted, nothing outside the fixture, no page errors", { reads: report.reads.length });
  await page.screenshot({ path: join(output, "agent-panels-language.png") });
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
