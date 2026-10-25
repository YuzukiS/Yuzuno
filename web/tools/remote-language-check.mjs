// T-189: Phone access in the interface language, in Chromium (en-US), with
// every API answered here from the backend's example views (no Core, no
// Tailscale, no Serve, no daily configuration). Through the real Settings:
//  - set up in English: checked, a Serve port typed and not saved, a port
//    Core can't take refused by the page, the verification steps open;
//  - the language changed in another window: the page is Chinese with the
//    same typed values, the same refusal (now in Chinese), the same check,
//    and what Core reports as it came: addresses, ports, the login, the QR
//    code, a failed step's detail, the change's error, its notes and the
//    startup error. Nothing is read, checked, saved or applied again;
//  - back to English in another window: the page is as it was;
//  - nothing but the one Check pressed is sent to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/remote-language-check.mjs
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
const HOST = "yuzuno-remote-language.test";

const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: new Date().toISOString(), order: ["p1"], needsYou: [], projects: [] };
// The backend's examples (synthetic names): applied, but verification failed
// at the Windows hop; with a note and a startup error Core would add.
const examples = JSON.parse(await readFile(new URL("./fixtures/remote-access-views.json", import.meta.url), "utf8"));
const { _note, ...notVerified } = examples.appliedNotVerified;
const NOTE = "The earlier entry on port 8444 was removed.";
const STARTUP = "Port 4318 is used by another program.";
const view = {
  ...structuredClone(examples.appliedVerified),
  ...structuredClone(notVerified),
  startupError: STARTUP,
};
view.operation.notes = [NOTE];
const HOP = view.verification.steps.find((step) => step.id === "hop").detail;
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
  // The other window is a plain page of the same site, not the app.
  if (path === "/other.html") return route.fulfill({ body: "<!doctype html><title>other</title>", contentType: "text/html" });
  if (path.startsWith("/api/")) report.reads.push(`${method} ${path}`);
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  // Check only reads Tailscale and Serve; here it answers the same view.
  if (path === "/api/remote-access/check" && method === "POST") return route.fulfill({ json: view });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-remote-language" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/remote-access": view,
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
 * what this page asked Core meanwhile, once `heading` shows. */
async function elsewhere(language, box, heading) {
  const before = report.reads.length;
  await other.evaluate((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), language);
  await box.locator("h3", { hasText: heading }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  return report.reads.slice(before);
}
const remote = (reads) => reads.filter((read) => read.includes("/api/remote-access") || !read.startsWith("GET "));
const count = (read) => report.reads.filter((r) => r === read).length;
const state = (box) => box.evaluate((el) => ({
  lang: el.getAttribute("lang"),
  heading: el.querySelector("h3").textContent,
  badge: el.querySelector(".settings-current").textContent,
  hosts: [...el.querySelectorAll(".remote-access-hosts div")].map((d) => [d.querySelector("dt").textContent, d.querySelector("dd").textContent]),
  notes: [...el.querySelectorAll(".remote-access-note")].map((p) => p.textContent),
  lines: [...el.querySelectorAll(".remote-access-states li")].map((li) => [li.dataset.tone, ...[...li.children].map((s) => s.textContent)]),
  stepsOpen: el.querySelector(".remote-access-verification").open,
  steps: [...el.querySelectorAll(".remote-access-verification li")].map((li) => li.textContent),
  href: el.querySelector(".remote-access-result a").getAttribute("href"),
  qr: [el.querySelector(".remote-access-qr").getAttribute("aria-label"), el.querySelector(".remote-access-qr path").getAttribute("d")],
  alerts: [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent),
  coreNotes: [...el.querySelectorAll(".remote-access-notes li")].map((li) => li.textContent),
  advancedOpen: el.querySelector(".remote-access-advanced").open,
  inputs: [...el.querySelectorAll(".remote-access-advanced input")].map((i) => i.value),
  preview: el.querySelector(".remote-access-preview")?.textContent ?? null,
  buttons: [...el.querySelectorAll(".remote-access-actions button")].map((b) => [b.textContent, b.disabled]),
  pending: localStorage.getItem("yuzuno.remoteAccess.pending"),
}));

try {
  await page.goto(`https://${HOST}/`);
  await page.getByRole("button", { name: "Settings and updates" }).waitFor({ timeout: 10_000 });
  await other.goto(`https://${HOST}/other.html`);

  // ---- In English: checked, a port typed, a refusal, the steps open.
  let box = await openEditor("phone", "Phone & remote access", "remote");
  await box.locator(".remote-access-states").waitFor({ timeout: 10_000 });
  await box.getByRole("button", { name: "Check", exact: true }).click();
  await box.locator(".remote-access-actions .primary-button:not([disabled])").waitFor({ timeout: 10_000 });
  await box.locator(".remote-access-advanced summary").click();
  await box.locator(".remote-access-advanced input").nth(0).fill("9443");
  const preview = await box.locator(".remote-access-preview").textContent();
  assert.equal(preview, "Your phone will open https://pc.tail0.ts.net:9443");
  await box.locator(".remote-access-advanced input").nth(1).fill("70000");
  await box.getByRole("button", { name: "Save and apply" }).click();
  await box.locator('[role="alert"]', { hasText: "must be a port" }).waitFor({ timeout: 10_000 });
  await box.locator(".remote-access-verification summary").click();
  const en = await state(box);
  assert.deepEqual([en.lang, en.heading, en.badge], ["en", "Phone access", "Not verified"]);
  assert.deepEqual(en.lines[3], ["warn", "Verification", `Failed at “From Windows to Core”: ${HOP}`]);
  assert.deepEqual(en.inputs, ["9443", "70000", "owner@github"]);
  assert.ok(en.alerts.includes("Core's phone port must be a port from 1 to 65535."), en.alerts.join("|"));
  assert.equal(en.pending, null, "a refused change is not kept to send");
  assert.equal(count("POST /api/remote-access/check"), 1);
  check("Phone access in English: checked, a Serve port typed, a port refused by the page, the steps open", { preview, alerts: en.alerts });

  // ---- Changed to Chinese in another window.
  let meanwhile = await elsewhere("zh-Hans", box, "手机访问");
  const zh = await state(box);
  assert.deepEqual([zh.lang, zh.heading, zh.badge], ["zh-Hans", "手机访问", "未验证"]);
  assert.deepEqual(zh.hosts, [
    ["Core 运行于", "WSL · Ubuntu · mirrored 网络模式"],
    ["Tailscale 运行于", "Windows · pc.tail0.ts.net · 运行中"],
    ["允许的登录", "owner@github"],
  ]);
  assert.deepEqual(zh.lines, [
    ["on", "已保存的设置", "开启 · https://pc.tail0.ts.net:8444 · owner@github"],
    ["on", "Core 监听", "开启，端口 4318，用于 https://pc.tail0.ts.net:8444"],
    ["on", "Tailscale Serve", "Yuzuno 的入口，端口 8444 → http://127.0.0.1:4318 · 另有 2 个入口保持原样"],
    ["warn", "验证", `在“从 Windows 到 Core”失败：${HOP}`],
  ]);
  assert.ok(zh.steps.includes(`从 Windows 到 Core：失败 · ${HOP}`), zh.steps.join("|"));
  assert.ok(zh.steps.includes("完整链路：已跳过 · Needs the Serve entry and the Windows hop"), "a step's detail as Core wrote it");
  assert.equal(zh.href, en.href, "the address as Core gave it");
  assert.deepEqual(zh.qr, ["https://pc.tail0.ts.net:8444 的二维码", en.qr[1]], "the QR code unchanged");
  assert.ok(zh.alerts.includes(`Core 启动时无法提供手机入口：${STARTUP}`), zh.alerts.join("|"));
  assert.ok(zh.alerts.includes(`${view.operation.error}。`), "the change's error as Core wrote it");
  assert.ok(zh.alerts.includes("Core 的手机端口必须是 1 到 65535 之间的端口。"), "the refusal, worded again");
  assert.deepEqual(zh.coreNotes, [NOTE]);
  assert.deepEqual([zh.stepsOpen, zh.advancedOpen, zh.inputs, zh.pending], [true, true, en.inputs, null], "what was open and typed stays");
  assert.deepEqual(zh.buttons, [["检查", false], ["保存并应用", false], ["关闭", false]], "still checked");
  assert.deepEqual(remote(meanwhile), []);
  await page.screenshot({ path: join(output, "remote-zh.png") });
  check("changed to Chinese in another window: Phone access is Chinese, what Core reports as it came, typed values, the check and the refusal kept; nothing read or sent", { lines: zh.lines, alerts: zh.alerts, meanwhile });

  // ---- Back to English in another window.
  meanwhile = await elsewhere("en", box, "Phone access");
  assert.deepEqual(await state(box), en, "as it was in English");
  assert.deepEqual(remote(meanwhile), []);
  check("back to English in another window: the page is as it was, nothing read or sent", { meanwhile });

  assert.equal(count("GET /api/remote-access"), 1, "read once, when opened");
  assert.equal(count("POST /api/remote-access/check"), 1, "only the Check pressed");
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "nothing saved or applied");
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
