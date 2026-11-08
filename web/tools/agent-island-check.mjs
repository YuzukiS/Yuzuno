// T-43 rail v11 (the user's answers to design/ask-rail-readability, 2026-11-07):
// the Agent rows in Chromium, with every API answered here (no Core, no CLI,
// no daily configuration) and synthetic Agents. At 1440 (the rail at 240 px
// and at 320) and 390 (a phone, touch), light and dark, Chinese and English,
// detailed and compact, under Project headings and in Project cards:
// - the ring is one of five states (working, needs you, done, failed, idle),
//   22 px at the row's right, strokes only, a mark for done and failed;
// - the ring, or its pill and the ring, is centred on the whole row, within
//   1 px, for rows of one, two and three lines, with and without a pill,
//   archived rows included (YN-41); a pill's outline is centred on its ring;
//   the ring's hit area is 28 px with a mouse, 40 on touch;
// - a pill that comes and goes, the row growing from two lines to three and
//   back, leaves the ring centred and in its outline at every frame drawn;
//   so does a rail made narrower while pills show (YN-41);
// - every other state is a pill left of the ring that stays while it holds
//   (等负责人, 审查中, 等合并, 排队 · 第 2 位, 离线), in its outline, line one's
//   words clear of it; needs you and failed are row islands;
// - an executor's line one is its task's short name, else its title; line
//   two what it is doing and its clock; no task key or PR number on a row;
// - only a lead shows updates unread, as a dot; no count anywhere;
// - no row has a "…"; the context-menu key on a row's link opens its menu;
// - the selected row looks as a hovered row does: its background only;
// - nothing cut, three lines at most; on a phone every row is 44 px or more.
// Screenshots for the design Ask; with guides, each row's middle (YN-41).
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
const report = { task: "T-43 rail v11, YN-41", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], rows: {}, live: {} };
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
  // Three lines with a pill: a title of two lines beside "In review" (YN-41).
  executor("yn31", { title: "Show the review's findings beside the conversation without moving it" }, "delivering"),
  // One line beside its ring, two beside a pill: the row the live step queues (YN-41).
  executor("yn32", { title: "Export the device preferences file", shortName: "导出设备偏好文件" }, "running", { status: "working" }),
  // Archived, in the fold (YN-41).
  executor("yn20", { title: "Tidy the old notes", shortName: "整理旧说明" }, "archived"),
];
// The live step's yn32: queued, then running again (YN-41).
const queued32 = () => executor("yn32", { title: "Export the device preferences file", shortName: "导出设备偏好文件" }, "queued", {}, { position: 2 });
let agents = fixture();
const pr = (number, approved, running, ci = "success") => ({ number, url: `https://github.com/owner/repo/pull/${number}`, state: "open", headSha: "a".repeat(40), ci,
  reviews: { approved, changesRequested: false, running } });
const live = { executors: { yn24: { pr: pr(681, 0, true) }, yn26: { pr: pr(688, 1, false) }, yn27: { pr: pr(705, 2, false) }, yn31: { pr: pr(712, 0, true) } } };
// Each row at rest: [ring, form, pill (zh, en) or null, dot].
const EXPECTED = {
  lead: ["working", "ring", null, true], dev9: ["done", "ring", null, false], dev5: ["idle", "ring", null, false],
  dev6: ["idle", "pill", ["离线", "Offline"], false],
  yn24: ["working", "pill", ["审查中", "In review"], false], yn26: ["idle", "pill", ["等负责人", "Lead's turn"], false],
  yn27: ["idle", "pill", ["等合并", "Ready to merge"], false], yn21: ["waiting", "row", null, false], yn33: ["failed", "row", null, false],
  yn30: ["idle", "pill", ["排队 · 第 2 位", "Queued · 2 in line"], false], yn29: ["working", "ring", null, false],
  yn31: ["idle", "pill", ["审查中", "In review"], false], yn32: ["working", "ring", null, false],
};
const ONE = {
  lead: "Dev Lead 2负责人", dev9: "Dev 9", dev5: "Dev 5", dev6: "Dev 6", yn24: "设备偏好导出", yn26: "保持选中", yn27: "状态栏文案",
  yn21: "设备偏好设计", yn33: "Mac 发布", yn30: "导入旧设置", yn29: "Fix the selection that jumps to the first row after a refresh",
  yn31: "Show the review's findings beside the conversation without moving it", yn32: "导出设备偏好文件",
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
  const outline = r.querySelector(":scope > .island-shell");
  const shell = outline?.getBoundingClientRect();
  const mid = (b) => b.top + b.height / 2;
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
    right: !!ring && row.right - ring.right <= 14,
    // The ring's middle less the row's, and a pill's outline's less the ring's (YN-41).
    offset: ring ? +(mid(ring) - mid(row)).toFixed(2) : null,
    shellOffset: pill && ring && shell && outline.hasAttribute("style") ? +(mid(shell) - mid(ring)).toFixed(2) : null,
    footer: !!r.querySelector(":scope > .agent-row-bottom, :scope > .handoff-hint"),
    archived: !!r.closest(".rail-archived-rows"), linesOne: lines(one),
    marks: island?.querySelectorAll("svg path.r-mark").length ?? -1,
    rings: island ? [...island.querySelectorAll("svg circle")].map((c) => c.getAttribute("class")) : [],
    one: one?.textContent ?? null, lines: lines(one) + lines(two), cut: [one, two].some(cut) && !pill,
    clear: !pill || !shell || words <= shell.left + 0.5, pillLeft: !pill || !ring || pill.getBoundingClientRect().right <= ring.left + 0.5,
    height: Math.round(row.height), text: r.textContent,
  };
}));

// Every row's ring centred on the row, a pill's outline on its ring (YN-41).
function assertCentred(tag, list) {
  for (const r of list) {
    if (!r.ring) continue;
    assert.ok(r.right, `${tag}: ${r.id}'s ring at the row's right`);
    assert.equal(r.footer, false, `${tag}: ${r.id} has nothing under its lines`);
    assert.ok(Math.abs(r.offset) <= 1, `${tag}: ${r.id}'s ring centred on its ${r.lines}-line row (${r.offset} px off)`);
    if (r.form === "pill") {
      assert.notEqual(r.shellOffset, null, `${tag}: ${r.id}'s pill outline drawn`);
      assert.ok(Math.abs(r.shellOffset) <= 0.5, `${tag}: ${r.id}'s pill outline centred on its ring (${r.shellOffset} px off)`);
    }
  }
}

// The ring's hit area, where it is a button: 28 px with a mouse, 40 on touch,
// round the centred ring (YN-41 leaves it as it was).
const hitArea = (page, id) => page.locator(`.agent-list article[data-agent-id="${id}"]`).evaluate((r) => {
  const island = r.querySelector(":scope > button.agent-island");
  if (!island) return null;
  island.scrollIntoView({ block: "center" });
  const g = island.querySelector(".island-ringbox").getBoundingClientRect();
  const half = matchMedia("(pointer: coarse)").matches ? 20 : 14;
  const x = g.left + g.width / 2, y = g.top + g.height / 2;
  const at = (dy) => document.elementFromPoint(x, y + dy)?.closest(".agent-island") === island;
  return { half, inside: [at(-(half - 1)), at(half - 1)], outside: [at(-(half + 2)), at(half + 2)] };
});

async function run({ width, height, theme, lang = "zh", rail = 240, density = "detailed", groups = "headers", live = false }) {
  const phone = width < 600;
  const tag = `${width}-${phone ? "phone" : rail}-${density}-${groups}-${theme}-${lang}`;
  agents = fixture();
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce", colorScheme: theme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript(({ theme, lang, rail, density, groups }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list", agentList: density, projectGroups: groups }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail }));
    window.addEventListener("yuzuno:open-task-review", (event) => event.stopImmediatePropagation());
  }, { theme, lang, rail, density, groups });
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
    // The archived fold open, its row measured with the rest (YN-41).
    await list.locator(".rail-archived-toggle").click();
    await rowOf("yn20").waitFor({ timeout: 5_000 });
    await page.mouse.move(0, 0);
    if (!phone) assert.equal(await page.evaluate(() => document.querySelector('[style*="--rail-width"]')?.style.getPropertyValue("--rail-width")), `${rail}px`, `${tag}: the rail is ${rail} px`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.agentList), density, `${tag}: the list is ${density}`);
    if (groups === "cards") assert.ok(await list.locator(".project-group-cards article[data-agent-id]").count() > 0, `${tag}: rows in a Project card`);
    const all = await rows(page);
    const seen = Object.fromEntries(all.map((r) => [r.id, r]));
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
      assert.equal(r.one, id === "lead" && lang === "en" ? "Dev Lead 2Lead" : ONE[id], `${tag}: ${id}'s line one`);
      assert.ok(r.lines >= 1 && r.lines <= 3, `${tag}: ${id} is ${r.lines} lines`);
      assert.ok(r.clear && r.pillLeft, `${tag}: ${id}'s pill left of its ring, line one's words clear of it`);
      assert.equal(r.notch || r.menu, false, `${tag}: ${id} has no count and no "…"`);
      if (id.startsWith("yn")) assert.doesNotMatch(r.text, /#\d|YN-\d/, `${tag}: ${id} shows no key or PR number`);
      if (phone) assert.ok(r.height >= 44, `${tag}: ${id} is ${r.height} px tall on a phone`);
    }
    assert.ok(seen.yn20?.archived, `${tag}: the archived row measured`);
    assertCentred(tag, all);
    // Rows of one, two and three lines, each with and without a pill, in a detailed list.
    const kinds = new Set(all.filter((r) => r.form !== "row").map((r) => `${r.lines}${r.form === "pill" ? "+pill" : ""}`));
    if (density === "detailed") for (const k of ["1", "1+pill", "2", "2+pill", "3", "3+pill"]) assert.ok(kinds.has(k), `${tag}: a row of ${k} measured (${[...kinds]})`);
    // The hit area round a ring that is a button.
    for (const id of ["dev9", "yn29"]) {
      const hit = await hitArea(page, id);
      assert.ok(hit, `${tag}: ${id}'s ring is a button`);
      assert.deepEqual([...hit.inside, ...hit.outside], [true, true, false, false], `${tag}: ${id}'s ring takes a press ${hit.half} px each side of its middle, no further`);
    }
    await page.evaluate(() => document.querySelector(".agent-list")?.scrollTo(0, 0));
    await list.screenshot({ path: join(output, `${tag}-1-list.png`) });
    report.screenshots.push(`${tag}-1-list`);
    // The same, with each row's middle drawn across it.
    await page.evaluate(() => {
      for (const r of document.querySelectorAll(".agent-list article[data-agent-id]")) {
        const guide = document.createElement("i");
        guide.className = "yn41-guide";
        guide.style.cssText = "position:absolute;left:0;right:0;top:50%;height:0;border-top:1px dashed #d0308a;z-index:5;pointer-events:none";
        r.append(guide);
      }
    });
    await list.screenshot({ path: join(output, `${tag}-1-guides.png`) });
    report.screenshots.push(`${tag}-1-guides`);
    await page.evaluate(() => document.querySelectorAll(".yn41-guide").forEach((g) => g.remove()));
    check(`${tag}: five ring states, pills that stay for the rest, the task's short name on line one, a lead's dot only, no "…", nothing cut, three lines at most${phone ? ", 44 px rows" : ""}; every ring centred on its row (${[...kinds].sort().join(", ")}), archived included, its hit area ${phone ? "a finger's" : "a mouse's"}`);

    if (live) await liveStep(page, tag, rowOf);

    if (!phone && density === "detailed" && groups === "headers") {
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
      assertCentred(`${tag} selected`, (await rows(page)).filter((r) => r.id === "dev5"));
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

// A pill that comes and goes (YN-41): yn32 is queued, its line one wraps
// beside "排队 · 第 2 位" and the row grows from two lines to three; then it
// runs again, "已开始" shows for a few seconds and goes. Every mutation and
// every frame drawn on the way is measured: the ring stays on the row's
// middle and in its pill's outline. Then the rail is made narrower, a step
// at a time, while pills show: each pill's outline follows its ring.
async function liveStep(page, tag, rowOf) {
  await page.evaluate(() => {
    const frames = (window.__yn41 = []);
    const take = (why) => {
      const r = document.querySelector('.agent-list article[data-agent-id="yn32"]');
      const ring = r?.querySelector(":scope > .agent-island .island-ringbox")?.getBoundingClientRect();
      if (!ring) return;
      const row = r.getBoundingClientRect();
      const outline = r.querySelector(":scope > .island-shell");
      const pill = r.querySelector(":scope > .agent-island .island-pill");
      const shell = pill && outline?.hasAttribute("style") ? outline.getBoundingClientRect() : null;
      const mid = (b) => b.top + b.height / 2;
      frames.push({ why, form: r.dataset.form, pill: pill?.textContent ?? null, event: !!pill?.dataset.event, height: +row.height.toFixed(1),
        offset: +(mid(ring) - mid(row)).toFixed(2), shell: shell ? +(mid(shell) - mid(ring)).toFixed(2) : null });
    };
    take("start");
    new MutationObserver(() => take("mutation")).observe(document.querySelector(".agent-list"), { subtree: true, childList: true, attributes: true, characterData: true });
    const frame = () => {
      if (window.__yn41 !== frames) return;
      take("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const form = () => rowOf("yn32").getAttribute("data-form");
  assert.equal(await form(), "ring", `${tag}: yn32 starts at its ring`);
  agents = agents.map((a) => (a.id === "yn32" ? queued32() : a));
  await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn32"]')?.dataset.form === "pill", null, { timeout: 20_000 });
  await page.waitForTimeout(400);
  agents = agents.map((a) => (a.id === "yn32" ? fixture().find((f) => f.id === "yn32") : a));
  await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn32"] .island-pill[data-event]'), null, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn32"]')?.dataset.form === "ring", null, { timeout: 20_000 });
  await page.waitForTimeout(200);
  const frames = await page.evaluate(() => {
    const out = window.__yn41;
    window.__yn41 = null;
    return out;
  });
  const forms = frames.map((f) => (f.form === "pill" ? (f.event ? "event" : "pill") : f.form)).filter((f, n, a) => f !== a[n - 1]);
  const heights = [...new Set(frames.map((f) => f.height))];
  // Each form as each kind of sample saw it: a form only a mutation saw was never drawn.
  const seenBy = Object.fromEntries(["mutation", "frame"].map((why) => [why, frames.filter((f) => f.why === why).map((f) => (f.form === "pill" ? (f.event ? "event" : "pill") : f.form)).filter((f, n, a) => f !== a[n - 1])]));
  report.live[tag] = { frames: frames.length, forms, seenBy, heights, worst: Math.max(...frames.map((f) => Math.abs(f.offset))), worstShell: Math.max(0, ...frames.filter((f) => f.shell !== null).map((f) => Math.abs(f.shell))) };
  // No frame at the ring between the queued pill and the started one: the row would jump a line and back.
  assert.deepEqual(forms, ["ring", "pill", "event", "ring"], `${tag}: yn32's ring, its queued pill, its started pill, its ring (${JSON.stringify(seenBy)})`);
  assert.ok(heights.length >= 2, `${tag}: yn32's row grew and shrank (${heights})`);
  for (const f of frames) {
    assert.ok(Math.abs(f.offset) <= 1, `${tag}: yn32's ring centred at every ${f.why} (${f.form}, ${f.height} px tall, ${f.offset} px off)`);
    if (f.form === "pill") {
      assert.notEqual(f.shell, null, `${tag}: yn32's pill outline drawn at every ${f.why}`);
      assert.ok(Math.abs(f.shell) <= 0.5, `${tag}: yn32's pill outline on its ring at every ${f.why} (${f.shell} px off)`);
    }
  }
  check(`${tag}: a pill that comes and goes (${forms.join(" → ")}, ${heights.join("/")} px tall) leaves the ring centred and in its outline in ${frames.length} mutations and frames`);

  // The rail narrower, a step at a time, while pills show.
  const handle = page.locator(".rail-resize-handle");
  await handle.focus();
  const before = Object.fromEntries((await rows(page)).map((r) => [r.id, r.height]));
  const grew = new Set();
  for (let step = 0; step < 6; step++) {
    await handle.press("ArrowLeft");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const now = await rows(page);
    for (const r of now) if (r.form === "pill" && r.height !== before[r.id]) grew.add(r.id);
    assertCentred(`${tag} rail −${(step + 1) * 8} px`, now);
  }
  assert.ok(grew.size > 0, `${tag}: a pill row's lines wrapped anew as the rail narrowed`);
  await page.evaluate(() => document.querySelector(".agent-list")?.scrollTo(0, 0));
  await page.locator(".agent-list").screenshot({ path: join(output, `${tag}-3-narrower.png`) });
  report.screenshots.push(`${tag}-3-narrower`);
  for (let step = 0; step < 6; step++) await handle.press("ArrowRight");
  check(`${tag}: the rail 48 px narrower, a step at a time: pill rows ${[...grew].join(", ")} grew, every ring centred and in its outline`);
}

try {
  // The rail at 240 px and at a roomier 320, in both languages and themes (YN-41).
  for (const rail of [240, 320]) for (const lang of ["zh", "en"]) for (const theme of ["light", "dark"])
    await run({ width: 1440, height: 1100, theme, lang, rail, live: rail === 240 && theme === "light" });
  for (const theme of ["light", "dark"]) await run({ width: 390, height: 1100, theme });
  // The compact list, and rows in Project cards.
  await run({ width: 1440, height: 1100, theme: "light", density: "compact" });
  await run({ width: 1440, height: 1100, theme: "dark", lang: "en", density: "compact" });
  await run({ width: 1440, height: 1100, theme: "light", groups: "cards" });
  await run({ width: 1440, height: 1100, theme: "dark", lang: "en", groups: "cards", density: "compact" });
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
