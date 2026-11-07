// T-19 slice 3a part 2, Settings that keep focus when what was pressed goes (F2: ST:A14, ST:SA5, ST:AD4,
// ST:B8, ST:A12), in Chromium on a production build of the app, through the real Settings, with every
// API answered here (no Core). Each is pressed three ways: as a pointer does in Chromium (it focuses
// the button), from the keyboard (Enter on the focused button), and with focus on the page and a press
// that does not move it (as a click on Safari, which does not focus buttons):
// - an Appearance file's Apply and Cancel close its preview: focus goes to Import, which opened it;
// - the shared preset's Apply closes its preview: focus goes to Preview…, which opened it; its Follow
//   does too, and focus goes to Stop following, which has taken Follow this preset…'s place; a press
//   whose confirming read is still on its way while the reader moves on keeps focus where they went;
// - New Agent defaults' Save, gone once nothing is left to save: focus goes to the line that says it
//   was saved;
// - the daily backup's change, saved by the Backup page's bar (YN-8 S6b): its Save says Saving…
//   while Core has not answered, then the bar's line says it was saved, and focus goes there (the
//   Save pressed is gone with the change);
// - Try again in a refused Appearance save, answered: focus goes to the line that says it was saved;
//   Restore defaults in the refusal, answered: focus goes to Restore defaults again.
// On the desktop (1280×860) and a phone (390×844), each with normal and reduced motion. Writes: the
// defaults' saves and the daily schedule's saves this check makes, and the app's own saves of where
// an Agent was read; anything else is refused and counted. Served from http://127.0.0.1. Chromium is
// not Safari: the press that does not focus is a script's click.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/settings-focus-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/settings-focus");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], unknownGets: [], writes: [], defaultsSaves: 0, scheduleSaves: 0,
  readingSaves: [], focus: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
// What Core keeps, as this check's saves change it.
let harness = "codex";
let schedule;
const defaults = () => ({
  saved: { harness },
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default", codexModel: null, codexReasoningEffort: null, claudeModel: null },
  effective: {
    harness: { value: harness, source: "workspace" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
  },
});
const backup = () => ({ canChange: true, workspaceId: "fixture", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 3 * 1024 * 1024,
  current: null, recent: [], notCovered: [], replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped", schedule });
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [], messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
  "/api/machines": { machines: [] },
  // A preset another device saved: a dark theme.
  "/api/appearance-preset": { workspaceId: "fixture", preset: { version: 1, revision: 3, savedAt: "2026-11-03T08:00:00.000Z", savedVia: "local", appearance: { theme: "dark" } } },
};
// Reads and saves held until the check answers them, only while it waits for one.
const holding = new Set();
const held = new Map();
const key = (method, path) => `${method} ${path}`;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    const method = request.method();
    const answer = (json) => route.fulfill({ json });
    let reply;
    if (method === "GET") {
      if (path === "/api/agent-defaults") reply = defaults;
      else if (path === "/api/workspace/backup") reply = backup;
      else if (gets[path] !== undefined) reply = () => gets[path];
      else {
        if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
        reply = () => ({});
      }
    } else if (method === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) {
      report.readingSaves.push(path);
      reply = () => ({ accepted: true });
    } else if (method === "POST" && path === "/api/collaboration/github_repositories") reply = () => ({ repositories: [] });
    else if (method === "POST" && path === "/api/collaboration/task_list") reply = () => ({ tasks: [], hasMore: false, counts: {} });
    else if (method === "POST" && path === "/api/agent-defaults") {
      report.defaultsSaves++;
      const change = request.postDataJSON();
      reply = () => {
        if ("harness" in change) harness = change.harness ?? "codex";
        return defaults();
      };
    } else if (method === "POST" && path === "/api/workspace/backup/schedule") {
      report.scheduleSaves++;
      const body = request.postDataJSON();
      reply = () => {
        schedule = { ...schedule, enabled: body.enabled, timeUtc: body.timeUtc, folder: body.folder };
        return { schedule };
      };
    } else {
      report.writes.push(key(method, path));
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    const k = key(method, path);
    if (holding.has(k)) {
      if (!held.has(k)) held.set(k, []);
      held.get(k).push(() => answer(reply()));
      return;
    }
    return answer(reply());
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = resolve(dist, file);
  assert.ok(full.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(full), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}
const hold = (method, path) => holding.add(key(method, path));
async function waiting(method, path) {
  const until = Date.now() + 10_000;
  while (!(held.get(key(method, path))?.length)) {
    if (Date.now() > until) throw new Error(`no ${method} ${path} came`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function release(method, path) {
  holding.delete(key(method, path));
  for (const answer of held.get(key(method, path))?.splice(0) ?? []) await answer();
}

// In the page, from the first script on: the event stream (none), and a browser that can be made to
// refuse saving Appearance (as when its storage is full).
function pageHelpers() {
  window.EventSource = class { addEventListener() {} close() {} };
  window.__refuse = false;
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name, value) {
    if (window.__refuse && name === "yuzuno.appearance") throw new DOMException("fixture: full", "QuotaExceededError");
    return setItem.call(this, name, value);
  };
  window.__focused = () => {
    const el = document.activeElement;
    return el && el !== document.body
      ? { tag: el.tagName, text: el.textContent.trim().slice(0, 80), label: el.getAttribute("aria-label"), role: el.getAttribute("role") }
      : "the page";
  };
}

const appearanceFile = (fontSize) => ({ name: `look-${fontSize}.json`, mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ format: "yuzuno-appearance", version: 1, exportedAt: "2026-11-03T09:00:00.000Z", appearance: { fontSize } })) });

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const HOWS = [
  ["pointer", "pressed as a pointer does"],
  ["keyboard", "pressed from the keyboard"],
  ["page", "pressed with focus on the page, by a press that does not move it"],
];
const EDITOR = "#settings-editor-appearance";
const FILE = `${EDITOR} [aria-label="Appearance file"]`;
const SHARED = `${EDITOR} [aria-label="Shared preset"]`;
for (const run of runs) {
  const tag = run.name;
  harness = "codex";
  schedule = { enabled: true, timeUtc: "03:00", folder: "/backups/daily", nextRunAt: "2026-11-04T03:00:00Z", retentionNote: null, lastRun: null };
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  const openEditor = async (query, title, editor) => {
    // On a phone an open page hides Settings' directory and its search (YN-8): Back to it.
    const back = page.locator(".settings-center .settings-back");
    if (await back.isVisible().catch(() => false)) {
      await back.click();
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    if (!(await page.locator(".settings-search input").isVisible())) {
      await page.getByRole("button", { name: "Settings and updates" }).click({ timeout: 10_000 });
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    await page.locator(".settings-search input").fill(query);
    const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: title }) }).first();
    await card.locator("button").click({ timeout: 10_000 });
    await page.locator(`#settings-editor-${editor}`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  const press = async (button, how) => {
    await button.waitFor({ timeout: 10_000 });
    if (how === "pointer") return button.click({ timeout: 5000 });
    if (how === "keyboard") {
      await button.focus();
      return page.keyboard.press("Enter");
    }
    await page.evaluate(() => document.activeElement?.blur?.());
    await button.evaluate((b) => b.click());
  };
  /** Where focus is, against `target`, a frame after what was pressed has settled. */
  const focusOn = async (label, target) => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const on = (await target.count()) === 1 && await target.evaluate((el) => el === document.activeElement);
    const at = report.focus[`${tag}: ${label}`] = await page.evaluate(() => window.__focused());
    return { on, at };
  };
  const theme = async (value) => {
    const radio = page.locator(`${EDITOR} input[name="appearance-theme"][value="${value}"]`);
    if (!(await radio.isChecked())) await page.locator(`${EDITOR} .theme-choice-${value}`).click({ timeout: 5000 });
  };
  try {
    await page.goto("http://127.0.0.1:4321/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
    await openEditor("shared preset", "Shared Appearance preset", "appearance");
    const importButton = page.locator(FILE).getByRole("button", { name: "Import from a file…", exact: true });

    // ---- ST:A14: an Appearance file's preview, closed by Apply or Cancel.
    let size = 17;
    for (const [how, said] of HOWS) {
      for (const which of ["Apply", "Cancel"]) {
        await page.locator(`${FILE} input[type=file]`).setInputFiles(appearanceFile(size++));
        const preview = page.locator(`${FILE} .appearance-file-preview`);
        await preview.waitFor({ timeout: 10_000 });
        const button = which === "Apply" ? preview.getByRole("button", { name: /^Apply \d+ selected$/ }) : preview.getByRole("button", { name: "Cancel", exact: true });
        await press(button, how);
        await preview.waitFor({ state: "detached", timeout: 10_000 });
        const { on, at } = await focusOn(`file ${which} (${how})`, importButton);
        ok(`${tag}: an Appearance file's ${which}, ${said}: its preview closes and focus goes to Import, which opened it (focus: ${JSON.stringify(at)})`, on, at);
      }
    }

    // ---- ST:SA5: the shared preset's previews, closed by Apply or Follow.
    const previewButton = page.locator(SHARED).getByRole("button", { name: "Preview…", exact: true });
    const followButton = page.locator(SHARED).getByRole("button", { name: "Follow this preset…", exact: true });
    const stopButton = page.locator(SHARED).getByRole("button", { name: "Stop following", exact: true });
    const applyPanel = page.locator(`${EDITOR} [aria-label="Shared preset preview"]`);
    const followPanel = page.locator(`${EDITOR} [aria-label="Follow preview"]`);
    for (const [how, said] of HOWS) {
      await theme("light");
      await previewButton.click({ timeout: 10_000 });
      await applyPanel.waitFor({ timeout: 10_000 });
      await press(applyPanel.getByRole("button", { name: /^Apply \d+ selected$/ }), how);
      await applyPanel.waitFor({ state: "detached", timeout: 10_000 });
      const { on, at } = await focusOn(`preset Apply (${how})`, previewButton);
      ok(`${tag}: the shared preset's Apply, ${said}: its preview closes and focus goes to Preview…, which opened it (focus: ${JSON.stringify(at)})`, on, at);
    }
    for (const [how, said] of HOWS) {
      if (await stopButton.count()) await stopButton.click({ timeout: 5000 });
      await theme("light");
      await followButton.click({ timeout: 10_000 });
      await followPanel.waitFor({ timeout: 10_000 });
      await press(followPanel.getByRole("button", { name: /^Follow( and apply| \(nothing)/ }), how);
      await followPanel.waitFor({ state: "detached", timeout: 10_000 });
      const { on, at } = await focusOn(`preset Follow (${how})`, stopButton);
      ok(`${tag}: the shared preset's Follow, ${said}: its preview closes and focus goes to Stop following, which has taken Follow this preset…'s place (focus: ${JSON.stringify(at)})`, on, at);
    }
    // The reader moves on while Apply's confirming read is on its way: focus stays where they went.
    if (await stopButton.count()) await stopButton.click({ timeout: 5000 });
    await theme("light");
    await previewButton.click({ timeout: 10_000 });
    await applyPanel.waitFor({ timeout: 10_000 });
    hold("GET", "/api/appearance-preset");
    await applyPanel.getByRole("button", { name: /^Apply \d+ selected$/ }).click({ timeout: 5000 });
    await waiting("GET", "/api/appearance-preset");
    const elsewhere = page.locator(`${EDITOR} input[name="appearance-theme"][value="light"]`);
    await elsewhere.focus();
    await release("GET", "/api/appearance-preset");
    await applyPanel.waitFor({ state: "detached", timeout: 10_000 });
    {
      const { on, at } = await focusOn("preset Apply, moved on", elsewhere);
      ok(`${tag}: the shared preset's Apply, the reader moving on while it confirms: focus stays on the theme they went to (focus: ${JSON.stringify(at)})`, on, at);
    }

    // ---- ST:A12: a refused Appearance save, answered by Try again or Restore defaults.
    const status = page.locator(`${EDITOR} .save-status`).first();
    for (const which of ["Try again", "Restore defaults"]) {
      for (const [how, said] of HOWS) {
        await page.evaluate(() => { window.__refuse = true; });
        const now = await page.locator(`${EDITOR} input[name="appearance-theme"][value="dark"]`).isChecked();
        await theme(now ? "light" : "dark");
        const failed = page.locator(`${EDITOR} .save-status-failed`);
        await failed.waitFor({ timeout: 10_000 });
        await page.evaluate(() => { window.__refuse = false; });
        await press(failed.getByRole("button", { name: which, exact: true }), how);
        await failed.waitFor({ state: "detached", timeout: 10_000 });
        const target = which === "Try again" ? status.locator("p[role=status]") : status.getByRole("button", { name: "Restore defaults", exact: true });
        const { on, at } = await focusOn(`${which} (${how})`, target);
        ok(which === "Try again"
          ? `${tag}: Try again in a refused Appearance save, ${said}: answered, focus goes to the line that says it was saved (focus: ${JSON.stringify(at)})`
          : `${tag}: Restore defaults in a refused Appearance save, ${said}: answered, focus goes to Restore defaults again (focus: ${JSON.stringify(at)})`, on, at);
      }
    }

    // ---- ST:AD4: the Agent defaults page's Save (YN-8 S5: its one save bar), gone once saved.
    await openEditor("new agent", "New Agent defaults", "agent-defaults");
    const section = page.locator("#settings-agent-defaults");
    const select = section.locator('select[aria-label="Harness for new Agents"]');
    const bar = page.locator(".settings-savebar:not([hidden])");
    for (const [how, said] of HOWS) {
      await select.waitFor({ timeout: 10_000 });
      await select.selectOption(harness === "codex" ? "claude" : "codex");
      await press(bar.getByRole("button", { name: "Save", exact: true }), how);
      const line = bar.locator("span[role=status]", { hasText: "All changes saved." });
      await line.waitFor({ timeout: 10_000 }).catch(() => {});
      const { on, at } = await focusOn(`defaults Save (${how})`, line);
      ok(`${tag}: the Agent defaults page's Save, ${said}: once saved it is gone, and focus goes to the bar's line that says it was saved (focus: ${JSON.stringify(at)})`, on, at);
    }

    // ---- ST:B8: the daily backup's change, saved by the Backup page's bar (YN-8 S6b).
    await openEditor("backup", "Workspace backup & restore", "backup");
    const daily = page.locator("#settings-backup .workspace-backup-daily");
    let hour = 4;
    for (const [how, said] of HOWS) {
      await daily.locator('input[aria-label="Time of day (UTC)"]').fill(`0${hour++}:00`);
      hold("POST", "/api/workspace/backup/schedule");
      await press(bar.getByRole("button", { name: "Save", exact: true }), how);
      await waiting("POST", "/api/workspace/backup/schedule");
      const label = (await bar.locator("button.primary-button").textContent()).trim();
      ok(`${tag}: the daily backup's change, the bar's Save, ${said}: while Core has not answered it says Saving… (it says "${label}")`, label === "Saving…", label);
      await release("POST", "/api/workspace/backup/schedule");
      const line = bar.locator("span[role=status]", { hasText: "All changes saved." });
      await line.waitFor({ timeout: 10_000 }).catch(() => {});
      ok(`${tag}: the daily backup's change, the bar's Save, ${said}: once Core answers, the bar's line says it was saved`, (await line.count()) === 1);
      const { on, at } = await focusOn(`schedule Save (${how})`, line);
      ok(`${tag}: the daily backup's change, the bar's Save, ${said}: the Save pressed is gone with the change, and focus goes to the bar's line that says it was saved (focus: ${JSON.stringify(at)})`, on, at);
    }
    await page.screenshot({ path: join(output, `${tag}.png`) });
  } catch (error) {
    report.failures.push({ name: `${tag}: sequence ran to its end`, detail: String(error?.stack || error).slice(0, 1200) });
    console.log(`FAIL ${tag}: sequence ran to its end: ${String(error).slice(0, 300)}`);
    for (const k of [...holding]) {
      const [method, path] = k.split(" ");
      await release(method, path).catch(() => {});
    }
  } finally {
    await context.close();
  }
}
await browser.close();
ok("writes: none but the defaults' and the daily schedule's saves this check makes, and where an Agent was read", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "settings-focus-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
