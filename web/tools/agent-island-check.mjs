// T-43 rail v11 (the user's answers to design/ask-rail-readability, 2026-11-07):
// the Agent rows in Chromium, with every API answered here (no Core, no CLI,
// no daily configuration) and synthetic Agents. At 1440 (the rail at 240 px)
// and 390 (a phone, touch), light and dark, Chinese and English:
// - the ring is one of five states (working, needs you, done, failed, idle),
//   22 px at the row's top right, strokes only, a mark for done and failed;
// - every other state is a pill left of the ring that stays while it holds
//   (等负责人, 审查中, 等合并, 排队 · 第 2 位, 离线), in its outline, line one's
//   words clear of it; needs you and failed are row islands;
// - an executor's line one is its task's short name, else its title; line
//   two what it is doing and its clock; no task key or PR number on a row;
// - only a lead shows updates unread, as a dot; no count anywhere;
// - no row has a "…"; the context-menu key on a row's link opens its menu;
// - the selected row looks as a hovered row does: its background only;
// - nothing cut, three lines at most; on a phone every row is 44 px or more.
// Screenshots for the design Ask.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/agent-island-check.mjs
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
const report = { task: "T-43 rail v11", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], rows: {} };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-agent-island.test";
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "codex", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle" };
const standing = (id, name, extra = {}) => ({ ...base, id, name, ...extra });
const executor = (id, task, state, extra = {}, lifecycle = {}) => ({
  ...base, id, name: `${id.toUpperCase().replace("YN", "YN-")} · Design first`, kind: "executor", ...extra,
  executor: { state, agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead 2" }, task: { id: id.toUpperCase().replace("YN", "YN-"), ...task },
    template: { id: "design-first", label: "Design first" }, dispatchedAt: ago(72.5), since: ago(6.5), ...lifecycle },
});
// Synthetic Agents and tasks (made up for this check).
const fixture = () => [
  standing("lead", "Dev Lead 2", { kind: "lead", status: "working", unreadCount: 2, workSummary: { kind: "progress", source: "agent", text: "Merging #702" } }),
  // A Turn it ended that this device hasn't shown: done ✓.
  standing("dev9", "Dev 9", { unreadCount: 3, lastSeq: 4, lastTurnEnd: { seq: 4, outcome: "finished", at: ago(14) } }),
  standing("dev5", "Dev 5", { unreadCount: 3, lastTurnEnd: { seq: 1, outcome: "finished", at: ago(80) } }),
  standing("dev6", "Dev 6", { status: "offline", disconnectedAt: ago(40) }),
  executor("yn24", { title: "Export and import device preferences", shortName: "设备偏好导出" }, "delivering", { status: "working",
    workSummary: { kind: "progress", source: "agent", text: "第 3 片：证据 Job 在跑" } }),
  executor("yn26", { title: "Keep the selection after a refresh", shortName: "保持选中" }, "delivering"),
  executor("yn27", { title: "Status bar wording", shortName: "状态栏文案" }, "delivering"),
  executor("yn21", { title: "Design note for device preferences", shortName: "设备偏好设计" }, "running", { status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "批准设计说明", requestId: "q1" } }),
  executor("yn33", { title: "Release the Mac app", shortName: "Mac 发布" }, "failed", { closedAt: ago(1.5) }, { reason: "Both starts failed" }),
  executor("yn30", { title: "Import old settings", shortName: "导入旧设置" }, "queued", {}, { position: 2 }),
  // No short name: its title, two lines at most.
  executor("yn29", { title: "Fix the selection that jumps to the first row after a refresh" }, "running", { status: "working" }),
];
let agents = fixture();
const pr = (number, approved, running, ci = "success") => ({ number, url: `https://github.com/owner/repo/pull/${number}`, state: "open", headSha: "a".repeat(40), ci,
  reviews: { approved, changesRequested: false, running } });
const live = { executors: { yn24: { pr: pr(681, 0, true) }, yn26: { pr: pr(688, 1, false) }, yn27: { pr: pr(705, 2, false) } } };
// Each row at rest: [ring, form, pill (zh, en) or null, dot].
const EXPECTED = {
  lead: ["working", "ring", null, true], dev9: ["done", "ring", null, false], dev5: ["idle", "ring", null, false],
  dev6: ["idle", "pill", ["离线", "Offline"], false],
  yn24: ["working", "pill", ["审查中", "In review"], false], yn26: ["idle", "pill", ["等负责人", "Lead's turn"], false],
  yn27: ["idle", "pill", ["等合并", "Ready to merge"], false], yn21: ["waiting", "row", null, false], yn33: ["failed", "row", null, false],
  yn30: ["idle", "pill", ["排队 · 第 2 位", "Queued · 2 in line"], false], yn29: ["working", "ring", null, false],
};
const ONE = {
  lead: "Dev Lead 2负责人", dev9: "Dev 9", dev5: "Dev 5", dev6: "Dev 6", yn24: "设备偏好导出", yn26: "保持选中", yn27: "状态栏文案",
  yn21: "设备偏好设计", yn33: "Mac 发布", yn30: "导入旧设置", yn29: "Fix the selection that jumps to the first row after a refresh",
};
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const home = () => ({ generatedAt: ago(0), order: ["p1"],
  needsYou: [{ kind: "approval", projectId: "p1", agentId: "yn21", agentName: "YN-21 · Design first", requestId: "q1", title: "批准设计说明", since: ago(12.5) }],
  projects: [{ project: { id: "p1", name: "Yuzuno" }, agents: { working: 3, idle: 5, waiting: 1, error: 1, offline: 1, total: 11 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }] });
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
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  if (/^\/api\/agents\/[^/]+\/executor$/.test(path)) return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  const json = {
    "/api/workspace": { workspace: { id: "ws-agent-island" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home(), "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    "/api/executors/live": live,
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

// Every row as drawn.
const rows = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((list) => list.map((r) => {
  const island = r.querySelector(":scope > .agent-island");
  const ring = island?.querySelector(".island-ringbox")?.getBoundingClientRect();
  const row = r.getBoundingClientRect();
  const lines = (el) => {
    if (!el || getComputedStyle(el).display === "none") return 0;
    const range = document.createRange();
    range.selectNodeContents(el);
    // Lines as shown: a clamped line past the box's end is laid out, not shown.
    const end = el.getBoundingClientRect().bottom + 1;
    let n = 0, last = -Infinity;
    for (const b of [...range.getClientRects()].filter((x) => x.width > 0 && x.bottom <= end).map((x) => x.bottom).sort((x, y) => x - y)) if (b - last > 6) { n++; last = b; }
    return n;
  };
  const one = r.querySelector(":scope > .agent-row-top .agent-line-one");
  const two = r.querySelector(":scope > .agent-row-meta, :scope > .agent-row-state");
  const cut = (el) => !!el && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  const pill = island?.querySelector(".island-pill");
  const shell = r.querySelector(":scope > .island-shell")?.getBoundingClientRect();
  // Line one's words end before the pill's outline begins.
  const words = (() => {
    if (!one) return 0;
    const range = document.createRange();
    range.selectNodeContents(one);
    return Math.max(0, ...[...range.getClientRects()].map((x) => x.right));
  })();
  return {
    id: r.dataset.agentId, state: island?.dataset.state, form: r.dataset.form, pill: pill?.textContent ?? null, dot: !!island?.querySelector(".island-dot"),
    notch: !!r.querySelector(".island-notch"), menu: !!r.querySelector(".agent-row-menu, .agent-actions-button"),
    ring: ring ? [Math.round(ring.width), Math.round(ring.height)] : null,
    topRight: !!ring && row.right - ring.right <= 14 && ring.top - row.top <= 12,
    marks: island?.querySelectorAll("svg path.r-mark").length ?? -1,
    rings: island ? [...island.querySelectorAll("svg circle")].map((c) => c.getAttribute("class")) : [],
    one: one?.textContent ?? null, lines: lines(one) + lines(two), cut: [one, two].some(cut) && !pill,
    clear: !pill || !shell || words <= shell.left + 0.5, pillLeft: !pill || !ring || pill.getBoundingClientRect().right <= ring.left + 0.5,
    height: Math.round(row.height), text: r.textContent,
  };
}));

async function run({ width, height, theme, lang = "zh" }) {
  const phone = width < 600;
  const tag = `${width}-${theme}-${lang}`;
  agents = fixture();
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: theme, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail: 240 }));
    window.addEventListener("yuzuno:open-task-review", (event) => event.stopImmediatePropagation());
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const list = page.locator(".agent-list");
  const rowOf = (id) => list.locator(`article[data-agent-id="${id}"]`);
  try {
    await page.goto(`https://${HOST}/`);
    await list.locator('article[data-agent-id="yn29"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn27"] .island-pill'), null, { timeout: 10_000 });
    await page.mouse.move(0, 0);
    const seen = Object.fromEntries((await rows(page)).map((r) => [r.id, r]));
    report.rows[tag] = seen;
    const i = lang === "zh" ? 0 : 1;
    for (const [id, [state, form, pill, dot]] of Object.entries(EXPECTED)) {
      const r = seen[id];
      assert.ok(r, `${tag}: ${id} listed`);
      assert.deepEqual([r.state, r.form, r.pill, r.dot], [state, form, pill ? pill[i] : null, dot], `${tag}: ${id} at rest`);
      assert.ok(["idle", "working", "waiting", "done", "failed"].includes(r.state), `${tag}: ${id}'s ring is one of five`);
      assert.equal(r.marks, state === "done" || state === "failed" ? 1 : 0, `${tag}: ${id}'s mark`);
      assert.ok(r.rings.every((c) => /^r-(idle|track|arc|breathe|full)$/.test(c)), `${tag}: ${id}'s ring has no rounds, dots, dashes or box: ${r.rings}`);
      assert.deepEqual(r.ring, [22, 22], `${tag}: ${id}'s ring is 22 px`);
      assert.ok(r.topRight, `${tag}: ${id}'s ring at the row's top right`);
      assert.equal(r.one, id === "lead" && lang === "en" ? "Dev Lead 2Lead" : ONE[id], `${tag}: ${id}'s line one`);
      assert.ok(r.lines >= 1 && r.lines <= 3, `${tag}: ${id} is ${r.lines} lines`);
      assert.ok(r.clear && r.pillLeft, `${tag}: ${id}'s pill left of its ring, line one's words clear of it`);
      assert.equal(r.notch || r.menu, false, `${tag}: ${id} has no count and no "…"`);
      if (id.startsWith("yn")) assert.doesNotMatch(r.text, /#\d|YN-\d/, `${tag}: ${id} shows no key or PR number`);
      if (phone) assert.ok(r.height >= 44, `${tag}: ${id} is ${r.height} px tall on a phone`);
    }
    await list.screenshot({ path: join(output, `${tag}-1-list.png`) });
    report.screenshots.push(`${tag}-1-list`);
    check(`${tag}: five ring states, pills that stay for the rest, the task's short name on line one, a lead's dot only, no "…", nothing cut, three lines at most${phone ? ", 44 px rows" : ""}`);

    if (!phone) {
      // The selected row looks as a hovered row does: its background only.
      await rowOf("dev5").locator(".agent-select").click();
      await page.mouse.move(0, 0);
      const look = (id) => rowOf(id).evaluate((r) => ({ bg: getComputedStyle(r).backgroundColor, border: getComputedStyle(r).borderTopColor, shadow: getComputedStyle(r).boxShadow }));
      const selected = await look("dev5");
      await rowOf("dev9").hover();
      const hovered = await look("dev9");
      await page.mouse.move(0, 0);
      assert.equal(selected.bg, hovered.bg, `${tag}: the selected row's background is hover's (${selected.bg} / ${hovered.bg})`);
      assert.deepEqual([selected.border, selected.shadow], ["rgba(0, 0, 0, 0)", "none"], `${tag}: no border or shadow of its own`);
      assert.equal(await rowOf("dev5").locator(".agent-row-menu, .agent-actions-button").count(), 0, `${tag}: the selected row has no "…"`);
      // The context-menu key on its link opens its menu; Escape closes it.
      await rowOf("dev5").locator(".agent-select").focus();
      await page.keyboard.press("Shift+F10");
      await page.locator(".agent-actions-menu:not(.is-leaving)").waitFor({ timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.locator(".agent-actions-menu:not(.is-leaving)").waitFor({ state: "detached", timeout: 5_000 });
      await page.evaluate(() => document.activeElement?.blur());
      await list.screenshot({ path: join(output, `${tag}-2-selected.png`) });
      report.screenshots.push(`${tag}-2-selected`);
      check(`${tag}: the selected row looks as hover does, with no "…"; Shift+F10 on its link opens its menu`);
    }
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  for (const theme of ["light", "dark"]) {
    await run({ width: 1440, height: 900, theme });
    await run({ width: 390, height: 844, theme });
  }
  await run({ width: 1440, height: 900, theme: "light", lang: "en" });
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
