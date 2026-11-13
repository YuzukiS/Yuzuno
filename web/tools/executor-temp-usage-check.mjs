// YN-78 S2c: an executor's temporary files line in its Overview, in
// Chromium, with every API answered here (no Core, no CLI, no daily
// configuration) and synthetic executors: one past the 2 GiB soft line, one
// whose last measurement is unknown with an earlier count, one an older Core
// answered for without a measurement. At 1440 (desktop) and 390 (a phone,
// touch), English and Chinese:
// - the line is drawn under the header, inside the pane, nothing wider than
//   it, its words as the user reads them;
// - past the line, the notice is on its own row beside it and says nothing
//   is cleaned up or stopped;
// - unknown says why and keeps the last count apart; not measured is never 0.
// Screenshots of each.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/executor-temp-usage-check.mjs
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
const report = { task: "YN-78 S2c", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], measures: {} };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-executor-temp-usage.test";
const GiB = 2 ** 30;
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { goal: "", cwd: "/fixture/app", model: "deepseek-synthetic", color: "sage", harness: "opencode", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle" };
const temp = {
  over: { path: "/fixture/data/t/a1b2c3d4", usage: { revision: 6, state: "measured", bytes: Math.round(2.4 * GiB), at: ago(3), limitBytes: 2 * GiB,
    over: true, lastMeasured: { bytes: Math.round(2.4 * GiB), at: ago(3) } } },
  unknown: { path: "/fixture/data/t/e5f6a7b8", usage: { revision: 2, state: "unknown", bytes: null, reason: "entries", at: ago(1), limitBytes: 2 * GiB,
    lastMeasured: { bytes: 37 * 1024 * 1024, at: ago(48) } } },
  older: { path: "/fixture/data/t/c9d0e1f2" },
};
const lifecycle = (id, key, title, tempDir) => ({ state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead 2" },
  task: { id: key, title }, template: { id: "build-from-design", label: "Build from design" }, dispatchedAt: ago(40), since: ago(6), tempDir });
const agents = [
  { ...base, id: "lead", name: "Dev Lead 2", kind: "lead", harness: "claude" },
  { ...base, id: "x1", name: "YN-41 · Build from design", kind: "executor", status: "working",
    workSummary: { kind: "progress", source: "agent", text: "Running the focused tests" },
    executor: lifecycle("x1", "YN-41", "Export device preferences", temp.over) },
  { ...base, id: "x2", name: "YN-42 · Build from design", kind: "executor",
    executor: lifecycle("x2", "YN-42", "导入设备偏好（合成示例）", temp.unknown) },
  { ...base, id: "x3", name: "YN-43 · Build from design", kind: "executor",
    executor: lifecycle("x3", "YN-43", "Status bar wording", temp.older) },
];
const overview = Object.fromEntries(agents.filter((a) => a.executor).map((a) => [a.id, {
  agentId: a.id, lifecycle: a.executor, task: { id: a.executor.task.id, title: a.executor.task.title, status: "doing" },
  template: { id: "build-from-design", label: "Build from design", deliveryMode: "pr" }, materials: null,
  steps: [{ kind: "materials", state: "done" }, { kind: "work", state: "doing" }, { kind: "pr", state: "todo" }],
  jobs: [], pullRequest: null, merge: null, result: null,
}]));
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

async function route(route) {
  const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
  if (url.hostname !== HOST) {
    report.unexpected.push(request.url());
    return route.abort();
  }
  if (/^\/api\/agents\/[^/]+\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
  if (method !== "GET" && path.startsWith("/api/collaboration/")) {
    const op = path.split("/").at(-1);
    if (op === "task_list") return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false, nextAfterSeq: null } });
    if (op === "github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (method !== "GET") return route.fulfill({ json: {} });
  const read = path.match(/^\/api\/agents\/([^/]+)\/executor$/);
  if (read) return overview[read[1]] ? route.fulfill({ json: overview[read[1]] }) : route.fulfill({ status: 404, json: { error: "This Agent is no executor", code: "not_executor" } });
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  const json = {
    "/api/workspace": { workspace: { id: "ws-executor-temp-usage" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": { generatedAt: ago(0), order: ["p1"], needsYou: [], projects: [] }, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates,
    "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns,
    "/api/reviews": noReviews, "/api/executors/live": { executors: {} },
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
}

// The line as drawn: where it is against the pane and the header, what is wider than the pane, and its parts.
const measure = (page) => page.evaluate(() => {
  const panel = document.querySelector("#executor-overview");
  const line = panel.querySelector(".executor-overview-temp");
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const box = panel.getBoundingClientRect();
  const wide = [...panel.querySelectorAll("*")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
  }).map((el) => el.className || el.tagName);
  if (!line) return { line: null, wide, overflowX: panel.scrollWidth > panel.clientWidth + 1 };
  const parts = [...line.children].map((el) => ({ cls: el.className || el.tagName.toLowerCase(), text: el.textContent, ...rect(el),
    lines: (() => { const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size; })() }));
  return { state: line.dataset.state, text: line.textContent, line: rect(line), panel: rect(panel), head: rect(panel.querySelector(".executor-overview-head")),
    parts, wide, overflowX: panel.scrollWidth > panel.clientWidth + 1, ink: getComputedStyle(line.querySelector(".v")).color };
});

const words = {
  en: { label: "Temporary files", over: "2.4 GiB of the 2 GiB soft line", notice: "At the soft line: a notice only. Nothing is cleaned up, paused or refused.",
    unknown: "unknown: more than 20,000 entries", last: /^last count 37 MiB, /, none: "not measured yet", at: /^last measured / },
  zh: { label: "临时文件占用", over: "2.4 GiB / 2 GiB 软提示线", notice: "已到软提示线：只是提示，不会清理、暂停或拒绝任何工作。",
    unknown: "未知：超过 20,000 项", last: /^上次成功 37 MiB（/, none: "未测", at: /^上次测量 / },
};

async function run({ width, height, lang }) {
  const phone = width < 600;
  const tag = `${width}-${lang}`;
  const w = words[lang];
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: "light", ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail: 240 }));
  }, { lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const press = (locator) => (phone ? locator.tap() : locator.click());
  const open = async (id) => {
    if (phone && await page.locator(".phone-back").isVisible()) await press(page.locator(".phone-back"));
    await press(page.locator(`.agent-list article[data-agent-id="${id}"] .agent-select`));
    await page.locator(`#executor-overview .executor-overview-head h2:has-text("${overview[id].task.id}")`).waitFor({ timeout: 10_000 });
    await page.mouse.move(0, 0);
  };
  const shot = async (name) => {
    await page.screenshot({ path: join(output, `${tag}-${name}.png`) });
    report.screenshots.push(`${tag}-${name}`);
  };
  const placed = (m, id) => {
    assert.ok(m.line, `${tag} ${id}: the line is drawn`);
    assert.deepEqual(m.wide, [], `${tag} ${id}: nothing wider than the Overview`);
    assert.equal(m.overflowX, false, `${tag} ${id}: no sideways scroll`);
    assert.ok(m.line.top >= m.head.bottom, `${tag} ${id}: under the header`);
    assert.ok(m.line.left >= m.panel.left && m.line.right <= m.panel.right, `${tag} ${id}: inside the pane`);
    assert.ok(m.line.height > 0 && m.line.width > 0);
  };
  try {
    await page.goto(`https://${HOST}/`);
    await page.locator('.agent-list article[data-agent-id="x3"]').waitFor({ timeout: 15_000 });

    await open("x1");
    let m = await measure(page);
    report.measures[`${tag}-x1`] = m;
    placed(m, "x1");
    assert.equal(m.state, "over");
    assert.deepEqual(m.parts.map((p) => p.cls), ["strong", "v", "note", "over"]);
    assert.equal(m.parts[0].text, w.label);
    assert.equal(m.parts[1].text, w.over);
    assert.match(m.parts[2].text, w.at);
    assert.equal(m.parts[3].text, w.notice);
    assert.ok(m.parts[3].top >= m.parts[1].bottom - 1, `${tag}: the notice on a row of its own`);
    assert.equal(m.parts[1].lines, 1, `${tag}: the count on one line`);
    await shot("over");
    check(`${tag}: past the soft line, a notice only`);

    await open("x2");
    m = await measure(page);
    report.measures[`${tag}-x2`] = m;
    placed(m, "x2");
    assert.equal(m.state, "unknown");
    assert.deepEqual(m.parts.map((p) => p.cls), ["strong", "v", "note", "note"]);
    assert.equal(m.parts[1].text, w.unknown);
    assert.match(m.parts[3].text, w.last);
    await shot("unknown");
    check(`${tag}: unknown says why and keeps the last count apart`);

    await open("x3");
    m = await measure(page);
    report.measures[`${tag}-x3`] = m;
    placed(m, "x3");
    assert.equal(m.state, "none");
    assert.deepEqual(m.parts.map((p) => p.cls), ["strong", "v"]);
    assert.equal(m.parts[1].text, w.none);
    assert.doesNotMatch(m.text, /\b0\b/);
    await shot("not-measured");
    check(`${tag}: an older Core's answer is not measured, never 0`);
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const lang of ["en", "zh"])
    for (const [width, height] of [[1440, 900], [390, 844]]) await run({ width, height, lang });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.unexpected, []);
  assert.deepEqual(report.writes, [], "no collaboration write: a check only reads");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${report.failure}`);
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
process.exitCode = report.status === "passed" ? 0 : 1;
