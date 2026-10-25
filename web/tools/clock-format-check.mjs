// T-189: this device's clock format in Chromium (en-US, Asia/Shanghai), with
// every API answered here (no Core, no daily configuration or data). In the
// production build's real Settings (search → Clock format → a choice):
//  - unset, conversation and Home times are written as before this setting;
//  - a choice rewrites the open conversation's message times and Turn ending
//    at once, and an open Home's "Data as of", their datetime unchanged;
//  - a saved choice is kept after a reload; one the browser refuses applies
//    in this window, is said not saved, and is gone after a reload;
//  - Restore defaults removes this device's choice and the times are as
//    before again.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/clock-format-check.mjs
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
const HOST = "yuzuno-clock.test";

// 21:05, 21:06 and 21:07:30 in Shanghai on 24 October 2026.
const ASKED = "2026-10-24T13:05:00.000Z", ANSWERED = "2026-10-24T13:06:10.000Z", DONE = Date.parse("2026-10-24T13:07:30Z") / 1000;
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: "p1", color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected" };
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: "", updatedAt: "" }];
const turns = [{ id: "t0", status: "completed", completedAt: DONE, items: [
  { id: "u0", type: "userMessage", content: [{ type: "text", text: "Is the build green?" }], _yuzunoTime: { at: Date.parse(ASKED), source: "core" } },
  { id: "r0", type: "agentMessage", text: "Yes, every job passed.", _yuzunoTime: { at: Date.parse(ANSWERED), source: "core" } },
] }];
const markdown = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const section = { id: 1, key: "build", kind: "status", title: "Build", version: 1, owner: { agentId: "a", name: "Mori", state: "active" },
  updatedAt: ASKED, updatedTurnId: "t0", body: markdown("Every job passed."), attachments: [], refs: {}, seen: null, history: false,
  status: { asOf: ASKED, validFor: 10 * 365 * 86400, stale: false } };
const home = { generatedAt: ASKED, order: ["p1"], needsYou: [], projects: [{
  project: { id: "p1", name: "Yuzuno" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], unseen: 1, missing: [], brief: { version: 1, history: [], sections: [section], teamSections: [] } }] };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript(() => {
  window.EventSource = class { close() {} };
});
page.on("pageerror", (error) => report.errors.push(error.message));
await page.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
  if (path === "/api/agents/a/reading") return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.writes.push({ method, path });
    return route.fulfill({ json: {} });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-clock" }, agents: [agent], projects, runtime: { connected: true }, defaultCwd: "/fixture" },
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

const nav = () => page.locator(".toolbar-nav .catchup-nav").first();
async function toHome() {
  await nav().waitFor({ timeout: 10_000 });
  if (!(await page.locator(".home-view").isVisible())) await nav().click();
  await page.locator('.home-view [data-section-key="build"]').waitFor({ timeout: 10_000 });
}
async function toConversation() {
  await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click({ timeout: 10_000 });
  await page.locator('.turn-footer').waitFor({ timeout: 10_000 });
}
/** What the conversation and Home write now, and what this browser wrote
 * before this setting: the formats the old code used. */
const conversation = () => page.evaluate(() => ({
  marks: [...document.querySelectorAll("time.message-time")].map((t) => ({ label: t.textContent, dateTime: t.dateTime })),
  footer: document.querySelector(".turn-footer")?.textContent.replace(/\s+/g, " ").trim() ?? null,
  footerTime: document.querySelector(".turn-footer time")?.dateTime ?? null,
}));
const asOf = () => page.locator('.home-view [data-section-key="build"]').evaluate((card) =>
  [...card.querySelectorAll("span")].map((s) => s.textContent.replace(/\s+/g, " ").trim()).find((t) => t.startsWith("Data as of")) ?? null);
const before = await (async () => {
  await page.goto(`https://${HOST}/`);
  return page.evaluate(({ ASKED, ANSWERED, DONE }) => {
    const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    return {
      marks: [ASKED, ANSWERED].map((iso) => clock.format(new Date(iso))),
      footer: `done ${clock.format(new Date(DONE * 1000))}`,
      asOf: `Data as of ${new Date(ASKED).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    };
  }, { ASKED, ANSWERED, DONE });
})();
const ENTRY = { search: "clock", title: "Clock format", editor: "time" };
async function openEditor() {
  if (!(await page.getByRole("searchbox", { name: "Search settings" }).isVisible())) {
    await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
    await page.getByRole("searchbox", { name: "Search settings" }).waitFor({ timeout: 10_000 });
  }
  await page.getByRole("searchbox", { name: "Search settings" }).fill(ENTRY.search);
  await page.getByRole("button", { name: `Open ${ENTRY.title}`, exact: true }).click({ timeout: 10_000 });
  const editor = page.locator(`#settings-editor-${ENTRY.editor}`);
  await editor.waitFor({ timeout: 10_000 });
  return editor;
}
async function closeSettings() {
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
}
const editorState = (editor) => editor.evaluate((el) => ({
  status: el.querySelector(".save-status [role=status]")?.textContent.trim() ?? null,
  alert: el.querySelector(".save-status [role=alert]")?.textContent.trim() ?? null,
  checked: el.querySelector('input[name="time-clock-format"]:checked')?.value ?? null,
}));
async function choose(clock) {
  const editor = await openEditor();
  await editor.locator(`input[name="time-clock-format"][value="${clock}"]`).check();
  const state = await editorState(editor);
  await closeSettings();
  return state;
}
const stored = () => page.evaluate(() => localStorage.getItem("yuzuno.time"));
const refuseWrites = (refuse) => page.evaluate((refuse) => {
  const storage = Storage.prototype;
  window.clockStorage ||= { setItem: storage.setItem };
  if (!refuse) return Object.assign(storage, window.clockStorage);
  storage.setItem = function (key, ...rest) {
    if (key === "yuzuno.time") throw new DOMException("Refused here.", "QuotaExceededError");
    return window.clockStorage.setItem.call(this, key, ...rest);
  };
}, refuse);
const H24 = /^\d{1,2}:\d{2}$/, H12 = /^\d{1,2}:\d{2}\s(AM|PM)$/;
const record = (name, state) => report.states.push({ name, ...state });

try {
  // Unset: as before.
  await toConversation();
  const unset = await conversation();
  record("unset conversation", unset);
  assert.deepEqual(unset.marks.map((m) => m.label), before.marks);
  assert.equal(unset.footer, before.footer);
  await toHome();
  assert.equal(await asOf(), before.asOf);
  assert.equal(await stored(), null);
  check("unset: message times, the Turn ending and Home's Data as of are written as before", { before });

  // 24-hour, chosen with the conversation open.
  await toConversation();
  const saved24 = await choose("h24");
  assert.equal(saved24.checked, "h24");
  assert.equal(saved24.status, "Saved on this device");
  assert.equal(await stored(), '{"clock":"h24"}');
  const h24 = await conversation();
  record("24-hour conversation", h24);
  assert.deepEqual(h24.marks.map((m) => m.label), ["21:05", "21:06"]);
  assert.equal(h24.footer, "done 21:07");
  assert.deepEqual(h24.marks.map((m) => m.dateTime), unset.marks.map((m) => m.dateTime), "the times themselves are unchanged");
  assert.equal(h24.footerTime, unset.footerTime);
  await page.screenshot({ path: join(output, "conversation-24h.png") });
  check("24-hour: the open conversation's times and Turn ending are written again at once, their datetime unchanged", { marks: h24.marks, footer: h24.footer });

  // 12-hour, chosen with Home open.
  await toHome();
  assert.equal(await asOf(), "Data as of Oct 24, 21:05");
  await choose("h12");
  const home12 = await asOf();
  assert.match(home12, /^Data as of Oct 24, 09:05\sPM$/);
  await page.screenshot({ path: join(output, "home-12h.png") });
  check("12-hour: an open Home's Data as of is written again at once", { before: "Data as of Oct 24, 21:05", after: home12 });

  // Kept after a reload.
  await page.reload();
  await toConversation();
  const reloaded = await conversation();
  assert.ok(reloaded.marks.every((m) => H12.test(m.label)), JSON.stringify(reloaded.marks));
  assert.match(reloaded.footer, /^done 9:07\sPM$/);
  check("a saved choice is kept after a reload", { marks: reloaded.marks });

  // Refused: in effect here, said not saved, gone after a reload.
  await refuseWrites(true);
  const refused = await choose("h24");
  assert.equal(refused.checked, "h24");
  assert.equal(refused.status, null, "never Saved");
  assert.ok(refused.alert && /full/.test(refused.alert), refused.alert);
  const unsaved = await conversation();
  assert.deepEqual(unsaved.marks.map((m) => m.label), ["21:05", "21:06"]);
  assert.equal(await stored(), '{"clock":"h12"}');
  await page.reload();
  await toConversation();
  assert.ok((await conversation()).marks.every((m) => H12.test(m.label)));
  check("a choice the browser refuses applies in this window, is said not saved, and is gone after a reload", { alert: refused.alert });

  // Restore defaults: removed, and as before again.
  await refuseWrites(false);
  await choose("h24");
  assert.ok((await conversation()).marks.every((m) => H24.test(m.label)));
  const editor = await openEditor();
  await editor.getByRole("button", { name: "Restore defaults" }).click();
  const restored = await editorState(editor);
  assert.equal(restored.checked, "system");
  assert.equal(restored.status, "Defaults restored on this device");
  await closeSettings();
  assert.equal(await stored(), null);
  const reset = await conversation();
  assert.deepEqual(reset.marks.map((m) => m.label), before.marks);
  assert.equal(reset.footer, before.footer);
  await toHome();
  assert.equal(await asOf(), before.asOf);
  check("Restore defaults removes this device's choice; times are written as before again");

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
