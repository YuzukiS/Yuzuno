// YN-65: Settings → Data & storage → the build output cleanup after an
// executor's release, in Chromium, with every API answered here (no Core, no
// daily configuration or data). Through the real Settings:
//  - off, in Chinese: the switch, the days kept, the note;
//  - turned on: what earlier releases left is counted first, then the choice;
//    confirmed only for later releases, one PUT against the version read;
//  - on, with the latest cleanups (removed, kept, waiting, given up), in
//    Chinese, in English, and in a 360 px wide window;
//  - nothing else is written to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/build-cleanup-check.mjs
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
const report = { task: "YN-65", checks: [], reads: [], writes: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-build-cleanup.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const overview = { format: 1, readAt: "2026-11-09T03:00:00Z", dataDir: "/home/someone/.local/share/yuzuno/workspace", entries: [], unreadable: null,
  database: { pageSize: 4096, pages: 768, freePages: 10 }, jobs: { total: 0, unfinished: 0 }, native: [], notInBackup: [] };
const GIB = 2 ** 30;
const outcome = (state, executor, results, nextTryAt = null) => ({ state, nextTryAt, updatedAt: "2026-11-10T02:15:00Z",
  executor: { id: executor, name: `${executor} · 设计先行`, releasedAt: "2026-11-09T01:00:00Z" }, taskId: executor, results });
const recent = [
  outcome("done", "YN-56", [
    { path: ".worktrees/yn56/target/debug", how: ["it worked there"], state: "removed", reasons: [], bytes: 8.3 * GIB },
    { path: ".worktrees/yn56-shots/target/debug", how: ["its Jobs ran there"], state: "kept", reasons: ["It holds what Cargo does not make: shots"], bytes: null },
  ]),
  outcome("waiting", "YN-57", [{ path: ".worktrees/yn57-s2a/target/debug", how: ["on its pull request's branch"], state: "waiting", reasons: ["Cargo is building here now"], bytes: 7 * GIB }], "2026-11-10T03:15:00Z"),
  outcome("gaveUp", "YN-43", [{ path: ".worktrees/yn43/target/debug", how: ["it worked there"], state: "waiting", reasons: ["Process 4242 (yuzuno-workspace) uses it: it runs a program from there"], bytes: 3.1 * GIB }]),
];
let policy = { enabled: false, keepDays: 1, since: null, version: 0, changedAt: null };
let showRecent = false;
const cleanup = () => ({ policy, maxKeepDays: 30, recent: showRecent ? recent : [], waiting: showRecent ? 1 : 0 });
const backlog = { executors: 4, checked: 4, complete: true, folders: 2, bytes: 9.4 * GIB, kept: 1,
  items: [{ executor: "YN-60 · 红测先行", path: ".worktrees/yn60/target/debug", bytes: 4.3 * GIB }, { executor: "YN-57 · 设计先行", path: "target/yn57-s4a/debug", bytes: 5.1 * GIB }] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
  if (localStorage.getItem("seeded")) return;
  localStorage.setItem("seeded", "1");
  localStorage.setItem("yuzuno.language", JSON.stringify({ language: "zh-Hans" }));
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method === "POST" && path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false } });
  if (method === "POST" && path === "/api/build-cleanup/backlog") return route.fulfill({ json: backlog });
  if (method === "PUT" && path === "/api/build-cleanup") {
    const body = request.postDataJSON();
    report.writes.push({ method, path, body });
    if (body.expectedVersion !== policy.version) return route.fulfill({ status: 400, json: { error: "version_conflict" } });
    policy = { ...policy, enabled: body.enabled, keepDays: body.keepDays, version: policy.version + 1, since: body.enabled ? (body.earlier ? null : "2026-11-09T03:00:00Z") : policy.since };
    return route.fulfill({ json: cleanup() });
  }
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-build-cleanup" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/storage": overview, "/api/build-cleanup": cleanup(),
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

async function openStorage() {
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: /Settings and updates|设置与更新/ }).click({ timeout: 10_000 });
    await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("构建输出自动清理");
  const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "构建输出自动清理" }) }).first();
  await card.locator("button").click({ timeout: 10_000 });
  const box = page.locator("#settings-editor-storage");
  await box.waitFor({ timeout: 10_000 });
  const part = box.locator('[aria-labelledby="storage-task-folders"]');
  await part.locator("[role=switch]").waitFor({ timeout: 10_000 });
  await part.scrollIntoViewIfNeeded();
  return part;
}
const shot = async (part, name) => {
  await part.screenshot({ path: join(output, `${name}.png`) });
  return `${name}.png`;
};
const writes = () => report.writes.map((w) => `${w.method} ${w.path}`);

try {
  await page.goto(`https://${HOST}/`);
  let part = await openStorage();
  assert.equal(await part.locator("[role=switch]").getAttribute("aria-checked"), "false");
  const off = await part.textContent();
  assert.match(off, /执行者释放后自动清理/);
  assert.match(off, /关：不会自动删除任何东西。只有你能在这里打开；Agent 没有改它的工具。/);
  assert.match(off, /释放后保留0–30 天，从执行者关闭时算起。/);
  assert.match(off, /手动清理一个任务的目录/);
  assert.equal(await part.locator("#build-cleanup-days").inputValue(), "1");
  check("off by default, in Chinese: switch, days kept and note; cleanup by hand below", { screenshot: await shot(part, "zh-off") });

  await part.locator("[role=switch]").click();
  await part.locator("[data-backlog]").waitFor({ timeout: 10_000 });
  const confirm = await part.locator("[role=group]").textContent();
  assert.match(confirm, /之前释放的执行者留下 2 个可清理的 debug 目录，约 9\.4 GiB；另有 1 个里面有不是 Cargo 生成的文件，会保留。/);
  assert.match(confirm, /只是统计：还没有检查是否有人在用，也没有删除任何东西。/);
  assert.ok(await part.getByRole("button", { name: "打开并清理" }).isVisible(), "cleaning the earlier ones is the default");
  assert.deepEqual(writes(), [], "counting writes nothing");
  check("turning it on counts what earlier releases left first, and asks", { screenshot: await shot(part, "zh-confirm") });

  await part.getByLabel("只清理以后释放的").check();
  await part.getByRole("button", { name: "打开", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="storage-task-folders"] [role=switch]')?.getAttribute("aria-checked") === "true", null, { timeout: 10_000 });
  assert.deepEqual(report.writes.map((w) => w.body), [{ enabled: true, keepDays: 1, earlier: false, expectedVersion: 0 }]);
  check("confirmed for later releases only: one PUT against the version read, then on");

  // On, with the latest cleanups (as a later read shows them).
  showRecent = true;
  await page.reload();
  part = await openStorage();
  await part.locator("[data-recent]").waitFor({ timeout: 10_000 });
  const rows = await part.locator("[data-recent] li").evaluateAll((items) => items.map((li) => [li.dataset.result, li.textContent]));
  assert.deepEqual(rows.map(([state]) => state), ["removed", "kept", "waiting", "gaveUp"]);
  assert.match(rows[0][1], /^已清理 YN-56 · \.worktrees\/yn56\/target\/debug8\.3 GiBYN-56 · 设计先行 · 它在这里工作 · /);
  assert.match(rows[1][1], /^保留 .*大小未知.*It holds what Cargo does not make: shots/, "Core's reason as it comes");
  assert.match(rows[2][1], /^稍后再试 .*它的 PR 分支 · Cargo is building here now · 下次尝试 /);
  assert.match(rows[3][1], /^已放弃 .*一周内一直在用：保持原样/);
  assert.match(await part.textContent(), /已打开，适用于 .+ 之后释放的执行者。/);
  check("on, with the latest cleanups in Chinese; Core's reasons as they come", { screenshot: await shot(part, "zh-on-recent") });

  await page.evaluate(() => localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" })));
  await page.reload();
  await page.locator(".settings-search input").waitFor({ timeout: 10_000 }).catch(() => {});
  if (!(await page.locator(".settings-search input").isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
  }
  await page.locator(".settings-search input").fill("build output cleanup");
  await page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: "Automatic build output cleanup" }) }).first().locator("button").click({ timeout: 10_000 });
  part = page.locator('#settings-editor-storage [aria-labelledby="storage-task-folders"]');
  await part.locator("[data-recent]").waitFor({ timeout: 10_000 });
  const en = await part.textContent();
  assert.match(en, /Clean up after an executor is released/);
  assert.match(en, /On for executors released since .+\. What is in use is tried again every hour for a week\./);
  assert.match(en, /Removed YN-56 · .*Kept .*Will retry .*Given up/);
  await part.scrollIntoViewIfNeeded();
  check("the same in English", { screenshot: await shot(part, "en-on-recent") });

  await page.setViewportSize({ width: 360, height: 800 });
  await part.scrollIntoViewIfNeeded();
  const overflow = await part.evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, `nothing wider than the pane at 360 px (${overflow} px over)`);
  check("360 px wide: rows wrap, nothing wider than the pane", { overflow, screenshot: await shot(part, "en-narrow") });

  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(writes(), ["PUT /api/build-cleanup"], "the one change was the user's");
  check("nothing else was written to Core; no page errors");
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
