// T-189: Workspace backup in the interface language, in Chromium (en-US),
// with every API answered here (no Core, no backup, removal or schedule
// ever run). Through the real Settings:
//  - in English: the daily backup with automatic removal on and a run whose
//    cleanup removed part of what it could; a folder typed and not used;
//    a retention preview with one backup's removal being confirmed;
//  - the language changed in another window: the page is Chinese, the run
//    and its cleanup said apart, at most 20 at a time and the manifests'
//    sizes said as before; names, paths and what Core says as they came;
//    the typed folder, the preview and the open confirmation kept; nothing
//    read or sent;
//  - back to English in another window: the page is as it was;
//  - nothing but the one preview asked for is sent to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/backup-language-check.mjs
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
const HOST = "yuzuno-backup-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
const GIB = 1024 ** 3;
// What Core says, as it would say it (synthetic names and folders).
const SKIPPED = "yuzuno-backup-20261019T0300Z changed since the preview; preview again";
const schedule = {
  enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-10-29T03:00:00Z", retentionNote: null,
  retention: { keep: 2, folder: "/backups/daily", confirmedAt: "2026-10-27T10:00:00Z" },
  lastRun: {
    slot: "2026-10-28T03:00:00Z", missed: 0, startedAt: "2026-10-28T03:00:05Z", to: "/backups/daily/yuzuno-backup-20261028T0300Z",
    operationId: "op9", state: "succeeded", error: null, finishedAt: "2026-10-28T03:01:00Z",
    cleanup: {
      state: "succeeded", keep: 2, folder: "/backups/daily", decidedAt: "2026-10-28T03:01:30Z", operationId: "op10", reason: null, error: null,
      finishedAt: "2026-10-28T03:02:00Z",
      result: {
        removed: [{ name: "yuzuno-backup-20261020T0300Z", freedEstimateBytes: 3 * GIB }], skipped: [{ name: "yuzuno-backup-20261019T0300Z", reason: SKIPPED }],
        left: 1, removedEstimateBytes: 3 * GIB, keptCheckedName: "yuzuno-backup-20261028T0300Z", sizeBasis: "…",
      },
    },
  },
};
const view = {
  canChange: true, workspaceId: "ws-synthetic", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 3 * 1024 * 1024,
  current: null, recent: [], notCovered: ["Native CLI accounts, keys and configuration (Codex, Claude Code, OpenCode)"],
  replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped; it is not offered here", schedule,
};
const preview = (keep) => ({
  folder: "/backups/daily", keep, unreadableNames: 0, removableEstimateBytes: 2 * GIB, removableUnknownSizes: 0,
  sizeBasis: "Sizes are what each backup's manifest declares for its database and files.",
  entries: [
    { name: "yuzuno-backup-20261028T0300Z", path: "/backups/daily/yuzuno-backup-20261028T0300Z", verdict: "keep", reason: `One of the latest ${keep}`,
      createdAt: "2026-10-28T03:00:30Z", estimateBytes: 2 * GIB, manifestSha256: "a".repeat(64) },
    { name: "yuzuno-backup-20261021T0300Z", path: "/backups/daily/yuzuno-backup-20261021T0300Z", verdict: "remove", reason: `Older than the latest ${keep}`,
      createdAt: "2026-10-21T03:00:30Z", estimateBytes: 2 * GIB, lastCheckedAt: "2026-10-22T09:00:00Z", manifestSha256: "b".repeat(64) },
  ],
});
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
    report.posts.push({ method, path, body: request.postDataJSON() });
    // A preview only reads; anything else would start or change something.
    if (path === "/api/workspace/backup/retention/preview") return route.fulfill({ json: preview(request.postDataJSON().keep) });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-backup-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/workspace/backup": view,
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
async function elsewhere(language, box, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await box.locator("#settings-backup h3", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
// What only this page reads or sends: the backup view and its operations, previews and changes.
const pageOwn = (reads) => reads.filter((read) => read.includes("/api/workspace/backup") || read.includes("/api/workspace/restore") || !read.startsWith("GET "));
const state = (box) => box.evaluate((el) => {
  const section = el.querySelector("#settings-backup");
  return {
    lang: el.getAttribute("lang"),
    heading: section.querySelector("h3").textContent,
    daily: section.querySelector(".workspace-backup-daily > .settings-row .settings-row-help").textContent,
    cleanup: section.querySelector("[data-cleanup]").textContent,
    auto: section.querySelector("[data-auto-removal]").textContent,
    typed: section.querySelector(".settings-input").value,
    preview: section.querySelector(".backup-retention-result [role=status]")?.textContent ?? null,
    confirm: section.querySelector(".backup-retention-confirm")?.getAttribute("aria-label") ?? null,
    confirmText: section.querySelector(".backup-retention-confirm p")?.textContent ?? null,
    buttons: [...section.querySelectorAll(".backup-retention-confirm button")].map((b) => b.textContent),
  };
});

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- In English.
  let box = await openEditor("backup", "Workspace backup & restore", "backup");
  await box.locator("[data-cleanup]").waitFor({ timeout: 10_000 });
  await box.locator('input[aria-label="Backup folder"]').fill("/backups/by-hand");
  await box.locator('input[aria-label="Backups to keep"]').fill("1");
  await box.locator(".backup-retention").getByRole("button", { name: "Preview", exact: true }).click();
  await box.locator(".backup-retention-result").waitFor({ timeout: 10_000 });
  await box.locator(".backup-retention").getByRole("button", { name: "Remove…" }).click();
  await box.locator(".backup-retention-confirm").waitFor({ timeout: 10_000 });
  const en = await state(box);
  assert.deepEqual([en.lang, en.heading], ["en", "Workspace backup"]);
  assert.match(en.cleanup, /^After this run: Removed 1 old backup: yuzuno-backup-20261020T0300Z, about 3\.0 GiB as their manifests declared \(disk use can differ\)\. First, yuzuno-backup-20261028T0300Z was read back whole\. Not removed: yuzuno-backup-20261019T0300Z \(.+\)\. 1 more wait for the next run that succeeds\.$/);
  assert.match(en.auto, /at most 20 at a time\./);
  assert.equal(en.confirm, "Remove yuzuno-backup-20261021T0300Z");
  assert.equal(report.posts.length, 1, "the preview only");
  check("Workspace backup in English: the daily run and its partial cleanup, a folder typed, a removal being confirmed", { cleanup: en.cleanup });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", box, "Workspace 备份");
  const zh = await state(box);
  assert.deepEqual([zh.lang, zh.heading], ["zh-Hans", "Workspace 备份"]);
  assert.match(zh.daily, /^每天 UTC 03:00（此设备上为 .+），在 \/backups\/daily 中新建一个文件夹。那里的旧备份会按下方“自动删除”的说明删除。$/);
  assert.equal(zh.cleanup,
    `本次运行后：已删除 1 个旧备份：yuzuno-backup-20261020T0300Z，按其清单声明约 3.0 GiB（实际磁盘占用可能不同）。删除前已完整回读 yuzuno-backup-20261028T0300Z。未删除：yuzuno-backup-20261019T0300Z（${SKIPPED}）。另有 1 个等待下一次成功的运行。`,
    "the cleanup said apart from the run, Core's reason as it came");
  assert.match(zh.auto, /^自 2026-10-27 10:00 UTC 起开启：每次成功的每日备份之后，Core 会在 \/backups\/daily 中保留最新的 2 个，并删除那里此 Workspace 更旧的备份，每次最多 20 个。/);
  assert.equal(zh.typed, "/backups/by-hand", "the typed folder stays");
  assert.match(zh.preview, /^保留最新的 1 个：保留 1 个，可以删除 1 个（按其清单声明约 2\.0 GiB），0 个受保护或无法判断。$/);
  assert.equal(zh.confirm, "删除 yuzuno-backup-20261021T0300Z", "the confirmation stays open");
  assert.match(zh.confirmText, /^删除 \/backups\/daily\/yuzuno-backup-20261021T0300Z，备份于 2026-10-21 03:00 UTC，约 2\.0 GiB？只会删除这一个备份。/);
  assert.deepEqual(zh.buttons, ["删除这个备份", "取消"]);
  assert.deepEqual(pageOwn(meanwhile), []);
  await page.screenshot({ path: join(output, "backup-zh.png") });
  check("changed to Chinese in another window: the run and its cleanup said apart, names, paths and Core's words as they came, the typed folder, the preview and the confirmation kept; nothing read or sent", { zh, meanwhile });

  // ---- Back to English in another window.
  meanwhile = await elsewhere("en", box, "Workspace backup");
  assert.deepEqual(await state(box), en, "as it was in English");
  assert.deepEqual(pageOwn(meanwhile), []);
  check("back to English in another window: the page is as it was, nothing read or sent", { meanwhile });

  assert.deepEqual(report.posts.map((p) => p.path), ["/api/workspace/backup/retention/preview"], "the one preview asked for, nothing started or changed");
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
