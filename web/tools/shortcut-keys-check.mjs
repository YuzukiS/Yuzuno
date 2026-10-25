// T-189 P2: three shortcuts take another letter on this device, in Chromium
// (en-US, not an Apple device: Ctrl), with every API answered here (no Core,
// no daily configuration). Through the production build's real Settings:
//  - Keyboard shortcuts, Find an Agent → J: Ctrl+J opens and closes Find,
//    Ctrl+K no longer does, and the rail's search button says Ctrl J;
//  - New Agent → J is refused, naming Find an Agent; Ctrl+N still opens New
//    Agent;
//  - Search this conversation → G: its button announces Control+G Meta+G;
//  - after a reload Ctrl+J still opens Find;
//  - Restore defaults: Ctrl+K opens Find again; the send key's preference is
//    never written;
//  - nothing is sent to Core.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/shortcut-keys-check.mjs
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
const report = { task: "T-189", checks: [], posts: [], unexpected: [], errors: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-shortcut-keys.test";
const agent = { id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "gpt-6", projectId: null, color: "sage",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", connectionState: "connected", threadId: "native-a" };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
await context.addInitScript(() => {
  window.EventSource = class { close() {} };
  Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
});
await context.route("**/*", async (route) => {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/a\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET") {
    report.posts.push({ method, path });
    return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-shortcut-keys" }, agents: [agent], projects: [], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
    "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
    "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
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

const find = () => page.locator(".agent-search input");
const findShown = async () => (await find().count()) > 0 && (await find().isVisible());
const settled = () => page.waitForTimeout(250);
async function press(keys) {
  // Focus off any field: the keys are the window's.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(keys);
  await settled();
}
async function openShortcuts() {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await page.locator(".settings-search input").fill("shortcuts");
  await page.getByRole("button", { name: "Open Keyboard shortcuts" }).click();
  await page.locator("#settings-editor-shortcuts").waitFor({ timeout: 10_000 });
}
const closeDialog = async () => {
  await page.keyboard.press("Escape");
  await page.locator(".settings-modal").waitFor({ state: "detached", timeout: 10_000 });
};
const choose = (name, letter) => page.getByRole("combobox", { name: `Key for ${name}` }).selectOption(letter);
const stored = (key) => page.evaluate((key) => localStorage.getItem(key), key);

try {
  await page.goto(`https://${HOST}/`);
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });

  // ---- The usual letters, unset.
  await press("Control+k");
  assert.equal(await findShown(), true, "Ctrl+K opens Find");
  await press("Control+k");
  assert.equal(await findShown(), false, "again to close");

  // ---- Find an Agent → J.
  await openShortcuts();
  await choose("Find an Agent", "J");
  assert.equal(await stored("yuzuno.shortcuts"), '{"find":"J","newAgent":"N","search":"F"}');
  // New Agent → J: refused, named; nothing changed.
  await choose("New Agent", "J");
  const refused = await page.locator(".shortcut-refused").textContent();
  assert.equal(refused, "Ctrl+J is already Find an Agent. Nothing was changed: choose another letter, or give Find an Agent another one first.");
  assert.equal(await page.getByRole("combobox", { name: "Key for New Agent" }).inputValue(), "N");
  assert.equal(await stored("yuzuno.shortcuts"), '{"find":"J","newAgent":"N","search":"F"}');
  await choose("Search this conversation", "G");
  assert.equal(await stored("yuzuno.shortcuts"), '{"find":"J","newAgent":"N","search":"G"}');
  await page.screenshot({ path: join(output, "shortcut-keys.png") });
  await closeDialog();
  // The conversation's search button announces its letter in effect.
  assert.equal(await page.locator("[aria-keyshortcuts]").first().getAttribute("aria-keyshortcuts"), "Control+G Meta+G");
  await press("Control+j");
  assert.equal(await findShown(), true, "Ctrl+J opens Find");
  await press("Control+j");
  assert.equal(await findShown(), false);
  await press("Control+k");
  assert.equal(await findShown(), false, "Ctrl+K no longer does");
  assert.equal(await page.getByRole("button", { name: "Search agents" }).getAttribute("title"), "Search agents · Ctrl J");
  check("Find an Agent → J: Ctrl+J opens and closes Find, Ctrl+K doesn't; New Agent → J is refused, named, nothing changed", { refused });

  // ---- Ctrl+N still opens New Agent.
  await press("Control+n");
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10_000 });
  check("Ctrl+N still opens New Agent");

  // ---- After a reload.
  await page.reload();
  await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });
  await press("Control+j");
  assert.equal(await findShown(), true, "kept after a reload");
  await press("Control+j");
  check("after a reload Ctrl+J still opens Find");

  // ---- Restore defaults.
  await openShortcuts();
  await page.locator("#settings-editor-shortcuts").getByRole("button", { name: "Restore defaults" }).click();
  await settled();
  assert.equal(await stored("yuzuno.shortcuts"), null);
  await closeDialog();
  await press("Control+k");
  assert.equal(await findShown(), true, "Ctrl+K again");
  assert.equal(await stored("yuzuno.preferences"), null, "the send key's preference was never written");
  check("Restore defaults: Ctrl+K opens Find again; the send key's preference never written");

  assert.deepEqual(report.posts, [], "nothing sent to Core");
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.errors, []);
  check("nothing sent, nothing outside the fixture, no page errors");
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
