// T-19 slice 3a, Settings that say they are reading (F1: ST:AD1, ST:R1, ST:B1), in Chromium on a
// production build of the app, through the real Settings, with every API answered here (no Core).
// Each section's read is held until this check answers it:
// - while Core has not answered, New Agent defaults, Phone access and Workspace backup each say they
//   are reading (a status line), and show none of their settings yet;
// - once Core answers, the line is gone and the settings show;
// - in another window, the read failing: the line shows while it is on its way, then gives way to
//   the error alone (an editor once opened stays mounted, so each read checked is a window's first).
// On the desktop (1280×860) and a phone (390×844), each with normal and reduced motion; the lines in
// Chinese once, on the desktop. Writes: none but the app's own saves of where an Agent was read;
// anything else is refused and counted. Served from http://127.0.0.1. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/settings-reading-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/settings-reading");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], console: [], reads: [], unknownGets: [], writes: [], readingSaves: [], states: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const defaults = {
  saved: { harness: "codex" },
  builtIn: { harness: "codex", codexPermissionPreset: null, claudePermissionMode: "default", codexModel: null, codexReasoningEffort: null, claudeModel: null },
  effective: {
    harness: { value: "codex", source: "workspace" },
    codexPermissionPreset: { value: null, source: "builtin" },
    claudePermissionMode: { value: "default", source: "builtin" },
  },
};
const remote = JSON.parse(await readFile(new URL("./fixtures/remote-access-views.json", import.meta.url), "utf8")).appliedVerified;
const backup = { canChange: true, workspaceId: "fixture", canBackUp: true, refusals: [], unfinishedJobs: [], estimateBytes: 3 * 1024 * 1024,
  current: null, recent: [], notCovered: ["Native CLI accounts, keys and configuration"], replaceRunningWorkspace: "Replacing the Workspace this Core uses needs Core stopped" };
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs,
  "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [], messageReceipts: [] },
  "/api/agents/a/reading": { handoff: null },
  "/api/home": { generatedAt: new Date().toISOString(), order: ["p"], needsYou: [], projects: [] },
  "/api/machines": { machines: [] },
};
// The three reads this check holds, and what each answers once let go.
const sections = [
  { name: "New Agent defaults", path: "/api/agent-defaults", view: defaults, query: "new agent", card: "New Agent defaults", zhQuery: "默认", zhCard: "新 Agent 默认值", editor: "agent-defaults",
    section: "#settings-agent-defaults", settings: ".settings-group", en: "Reading the defaults…", zh: "正在读取默认值…" },
  { name: "Phone access", path: "/api/remote-access", view: remote, query: "phone", card: "Phone & remote access", zhQuery: "手机", zhCard: "手机与远程访问", editor: "remote",
    section: "#settings-remote", settings: ".remote-access-hosts", en: "Reading phone access…", zh: "正在读取手机访问…" },
  { name: "Workspace backup", path: "/api/workspace/backup", view: backup, query: "backup", card: "Workspace backup & restore", zhQuery: "备份", zhCard: "Workspace 备份与恢复", editor: "backup",
    section: "#settings-backup", settings: ".workspace-backup-coverage", en: "Reading the Workspace backup…", zh: "正在读取 Workspace 备份…" },
];
const held = new Map(sections.map((s) => [s.path, []]));
// The reads held now: only while the check waits for one (anything else reading them is answered).
const holding = new Set();
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    report.reads.push(`${request.method()} ${path}`);
    if (request.method() !== "GET") {
      if (request.method() === "PUT" && /^\/api\/agents\/[^/]+\/reading$/.test(path)) {
        report.readingSaves.push(path);
        return route.fulfill({ json: { accepted: true } });
      }
      // Reads that are POSTs, and change nothing.
      if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [] } });
      if (path === "/api/collaboration/task_list") return route.fulfill({ json: { tasks: [], hasMore: false, counts: {} } });
      report.writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
    }
    // Held until the check answers it.
    if (holding.has(path)) return void held.get(path).push(route);
    const view = sections.find((s) => s.path === path)?.view;
    if (view) return route.fulfill({ json: view });
    const known = gets[path];
    if (known !== undefined) return route.fulfill({ json: known });
    if (!report.unknownGets.includes(path)) report.unknownGets.push(path);
    return route.fulfill({ json: {} });
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
/** Holds the reads of `path` from now on, until they are answered. */
const hold = (path) => holding.add(path);
/** The reads of `path` on their way, once at least `count` are. */
async function waiting(path, count = 1) {
  const until = Date.now() + 10_000;
  while (held.get(path).length < count) {
    if (Date.now() > until) throw new Error(`no read of ${path} came`);
    await new Promise((done) => setTimeout(done, 25));
  }
  return held.get(path);
}
/** Answers every read of `path` on its way: with the view, or as a failure. */
async function answer(path, json, status = 200) {
  holding.delete(path);
  for (const route of held.get(path).splice(0)) await route.fulfill({ status, json });
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
  { name: "desktop-zh", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference", language: "zh-Hans" },
];
for (const run of runs) {
  const tag = run.name;
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  /** A window of the app, opened afresh: an editor once opened stays mounted, so each read checked is its first. */
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
    page.on("console", (m) => { if (m.type() === "error") report.console.push(`${tag}: ${m.text().slice(0, 600)}`); });
    await page.route("**/*", serve);
    await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
    if (run.language)
      await page.addInitScript((language) => localStorage.setItem("yuzuno.language", JSON.stringify({ language })), run.language);
    await page.goto("http://127.0.0.1:4320/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
    return page;
  };
  const openEditor = async (page, s) => {
    if (!(await page.locator(".settings-search input").isVisible())) {
      await page.getByRole("button", { name: run.language ? "设置与更新" : "Settings and updates" }).click({ timeout: 10_000 });
      await page.locator(".settings-search input").waitFor({ timeout: 10_000 });
    }
    await page.locator(".settings-search input").fill(run.language ? s.zhQuery ?? s.query : s.query);
    const card = page.locator(".settings-catalog-card").filter({ has: page.locator("h4", { hasText: run.language ? s.zhCard : s.card }) }).first();
    await card.locator("button").click({ timeout: 10_000 });
    await page.locator(`#settings-editor-${s.editor}`).waitFor({ timeout: 10_000 });
  };
  /** The section as it is now: its status lines, alerts and whether its settings show. */
  const state = (page, s) => page.evaluate(([section, settings]) => {
    const el = document.querySelector(section);
    if (!el) return null;
    return {
      status: [...el.querySelectorAll("[role=status]")].map((n) => n.textContent.trim()),
      alerts: [...el.querySelectorAll("[role=alert]")].map((n) => n.textContent.trim()),
      settings: !!el.querySelector(settings),
    };
  }, [s.section, s.settings]);
  /** Opens the section with its read held, and how it is once that read is on its way. */
  const opened = async (page, s) => {
    hold(s.path);
    await openEditor(page, s);
    await waiting(s.path);
    // A frame for what the open drew, with Core's answer still to come.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    return state(page, s);
  };
  try {
    // Each section opened, its read answered.
    let page = await open();
    for (const s of sections) {
      const words = run.language ? s.zh : s.en;
      const before = report.states[`${tag}: ${s.name}: before the answer`] = await opened(page, s);
      ok(`${tag}: ${s.name} while Core has not answered: the section says "${words}" in a status line, and shows none of its settings yet (${JSON.stringify(before)})`,
        !!before && before.status.includes(words) && !before.settings && before.alerts.length === 0, before);
      await answer(s.path, s.view);
      await page.locator(`${s.section} ${s.settings}`).waitFor({ timeout: 10_000 }).catch(() => {});
      const after = report.states[`${tag}: ${s.name}: answered`] = await state(page, s);
      ok(`${tag}: ${s.name} once Core answers: the line is gone and its settings show (${JSON.stringify(after)})`,
        !!after && !after.status.includes(words) && after.settings && after.alerts.length === 0, after);
    }
    await page.screenshot({ path: join(output, `${tag}.png`) });
    await page.close();
    if (!run.language) {
      // In another window, each section's read failing.
      page = await open();
      for (const s of sections) {
        const words = s.en;
        const again = report.states[`${tag}: ${s.name}: read again`] = await opened(page, s);
        ok(`${tag}: ${s.name} in another window, its read failing: while it is on its way, the line shows (${JSON.stringify(again)})`,
          !!again && again.status.includes(words) && !again.settings && again.alerts.length === 0, again);
        await answer(s.path, { error: "fixture: Core could not read this" }, 500);
        await page.locator(`${s.section} [role=alert]`).first().waitFor({ timeout: 10_000 }).catch(() => {});
        const failed = report.states[`${tag}: ${s.name}: failed`] = await state(page, s);
        ok(`${tag}: ${s.name} failing: the line gives way to the error alone (${JSON.stringify(failed)})`,
          !!failed && !failed.status.includes(words) && failed.alerts.some((a) => a.includes("fixture: Core could not read this")) && !failed.settings, failed);
      }
      await page.screenshot({ path: join(output, `${tag}-failed.png`) });
      await page.close();
    }
  } catch (error) {
    report.failures.push({ name: `${tag}: sequence ran to its end`, detail: String(error?.stack || error).slice(0, 1200) });
    console.log(`FAIL ${tag}: sequence ran to its end: ${String(error).slice(0, 300)}`);
    for (const s of sections) await answer(s.path, s.view).catch(() => {});
  } finally {
    await context.close();
  }
}
await browser.close();
ok("writes: none but the app's own saves of where an Agent was read", report.writes.length === 0, report.writes);
ok("no page errors", report.errors.length === 0, report.errors);
await writeFile(join(output, "settings-reading-check.json"), JSON.stringify(report, null, 1));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; report in ${output}`);
if (report.failures.length) process.exitCode = 1;
