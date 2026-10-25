// T-189: Workspace service in the interface language, in Chromium (en-US),
// with every API answered here (no Core; nothing is checked, downloaded,
// prepared, applied, cancelled or restarted). Through the real Settings:
//  - in English: an update chosen in this browser, accepted by Core and now
//    waiting for the agents (Core's blocker reason and how each pause request
//    went), its steps, the version details and the Desktop app section;
//  - the language changed in another window: the page is Chinese; versions,
//    release IDs, the release's source, names and Core's reason as they came;
//    the chosen update kept as it was saved; nothing sent;
//  - back to English in another window: the page is as it was.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/updates-language-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews } from "./browser-fixtures.mjs";

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
const HOST = "yuzuno-updates-language.test";

const agent = { id: "a", name: "Mori", status: "working", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// Synthetic releases and what Core says about them, as it would say it.
const release = (id) => ({
  releaseId: `workspace-${id}-20261025`, version: `2026.10.${id}`, gitSha: id.repeat(40).slice(0, 40), builtAt: "2026-10-25T00:00:00Z",
  platform: "linux-x86_64", protocol: 1, schema: { writes: 2, readsMin: 2, readsMax: 2 }, records: { writes: 1, readsMin: 0, readsMax: 1 },
  notes: "Synthetic release notes.", bytes: 12 * 1024 * 1024, source: "Reviewed local build",
});
const BLOCKER = "Turn is still running";
const status = {
  managed: true, current: release("a"), candidates: [release("b")], preparedReleaseId: "workspace-b-20261025", acceptingWork: false,
  operation: { id: "op-wait", releaseId: "workspace-b-20261025", phase: "waiting", startedAt: "2026-10-25T08:00:00Z", updatedAt: "2026-10-25T08:00:05Z", deadline: "2026-10-25T08:30:00Z" },
  blockers: [{ agentId: "a", name: "Mori", reason: BLOCKER }],
  waitNotices: [{ agentId: "a", name: "Mori", messageId: "m1", turnId: "t1", delivery: "delivered", idle: false, active: true }],
  storage: { releaseBytes: 48 * 1024 * 1024, backupBytes: 1024, retainedReleases: 2, keepReleases: 3 },
};
// The update chosen here, which Core accepted (the operation above is its own).
const intent = { releaseId: "workspace-b-20261025", version: "2026.10.b", requestId: "req-synthetic", from: "prepare",
  accepted: { step: "apply", at: Date.now(), operationId: "op-wait" } };
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
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    // Anything sent would check, download, prepare, apply or cancel.
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-updates-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": status, "/api/jobs/budget": idleJobsBudget,
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

async function elsewhere(language, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await page.locator("#settings-updates-title", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
const state = () => page.evaluate(() => {
  const box = document.querySelector("#settings-editor-updates");
  const texts = (selector) => [...box.querySelectorAll(selector)].map((el) => el.textContent);
  return {
    lang: box.getAttribute("lang"),
    heading: box.querySelector("#settings-updates-title").textContent,
    title: box.querySelector(".update-card-title").textContent,
    line: box.querySelector(".update-card-line").textContent,
    deadline: box.querySelector(".updates-deadline")?.textContent ?? null,
    steps: [...box.querySelectorAll(".update-steps li")].map((li) => `${li.querySelector(".update-step-label").textContent}:${li.className}`),
    waits: texts(".updates-blockers li"),
    buttons: texts(".update-card-action button"),
    details: texts(".update-details dt, .update-details dd"),
    desktop: box.querySelector("#settings-desktop").textContent,
    intent: localStorage.getItem("yuzuno.update-intent:ws-updates-language"),
  };
});

try {
  await other.goto(`https://${HOST}/other.html`);
  // The choice is kept per Workspace (T-195): this fixture's.
  await other.evaluate((intent) => localStorage.setItem("yuzuno.update-intent:ws-updates-language", JSON.stringify(intent)), intent);
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
  // Settings opens on Workspace service.
  await page.locator("#settings-editor-updates .updates-blockers li").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);

  // ---- In English.
  const en = await state();
  assert.deepEqual([en.lang, en.heading, en.title], ["en", "Workspace service", "Updating to 2026.10.b"]);
  assert.match(en.line, /^Waiting for your agents\. Active agents are asked to save progress/);
  assert.deepEqual(en.waits, [`Mori${BLOCKER} · Pause request delivered`]);
  assert.deepEqual(en.steps, ["Download:is-reused", "Verify:is-reused", "Prepare:is-done", "Wait for agents:is-current", "Install:is-next"]);
  assert.deepEqual(en.buttons, ["Cancel update"]);
  assert.match(en.desktop, /^Desktop appThe Windows app is updated separately/);
  assert.deepEqual(report.posts, [], "opening Settings mid-update sends nothing");
  check("Workspace service in English: an update chosen here waits for the agents, with its steps, Core's reason and the Desktop app", { en });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", "Workspace 服务");
  const zh = await state();
  assert.deepEqual([zh.lang, zh.heading, zh.title], ["zh-Hans", "Workspace 服务", "正在更新到 2026.10.b"]);
  assert.match(zh.line, /^正在等待你的 Agent。活跃的 Agent 会被要求保存进度并完成当前 Turn。/);
  assert.match(zh.deadline, /^等待截止于 \S/);
  assert.deepEqual(zh.waits, [`Mori${BLOCKER} · 暂停请求已送达`], "Core's reason as it came");
  assert.deepEqual(zh.steps, ["下载:is-reused", "验证:is-reused", "准备:is-done", "等待 Agent:is-current", "安装:is-next"]);
  assert.deepEqual(zh.buttons, ["取消更新"]);
  assert.deepEqual(zh.details.slice(0, 4), ["已安装", "2026.10.aworkspace-a-20261025aaaaaaaa", "运行方式", "Workspace 服务 · Core + Web UI · Linux / WSL"]);
  assert.ok(zh.details.includes("已准备"), "the prepared release");
  assert.ok(zh.details.some((d) => d.includes("linux-x86_64 · API 1 · 数据 2 · 记录 1Reviewed local build")), "its source as written");
  assert.ok(zh.details.some((d) => /^Core 主机上 48 MB · 已保留 2 个发行版 · 最多保留 3 个用于恢复$/.test(d)));
  assert.match(zh.desktop, /^桌面应用Windows 应用单独更新，需在该应用自己的设置中进行。/);
  assert.equal(zh.intent, en.intent, "the chosen update as it was saved");
  assert.deepEqual(meanwhile.filter((read) => !read.startsWith("GET ")), [], "nothing sent");
  await page.screenshot({ path: join(output, "updates-zh.png") });
  check("changed to Chinese in another window: the page is Chinese; versions, release IDs, the source, names and Core's reason as they came; the chosen update kept; nothing sent", { zh, meanwhile });

  // ---- Back to English in another window.
  meanwhile = await elsewhere("en", "Workspace service");
  assert.deepEqual(await state(), en, "as it was in English");
  assert.deepEqual(meanwhile.filter((read) => !read.startsWith("GET ")), []);
  check("back to English in another window: the page is as it was, nothing sent", { meanwhile });

  assert.deepEqual(report.posts, [], "nothing checked, downloaded, prepared, applied or cancelled");
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
