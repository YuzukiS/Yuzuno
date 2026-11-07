// T-43, 灵动环 v10.2 (the user's design of 2026-11-07): the Agent row's
// island in Chromium, with every API answered here (no Core, no CLI, no
// daily configuration) and synthetic Agents in the states a rail shows:
// working, handed in, needs you, queued, done with three unread, failed and
// idle. At 1440 (the rail at 240 px) and 390 (a phone, touch), light and
// dark, English and Chinese:
// - the ring is the state: 22 px at the row's top right, strokes only, a
//   mark inside for done and failed, nothing for the rest;
// - at rest needs you and failed are row islands, everything else a ring;
// - an executor's line one is what it is doing, line two its task key and
//   clock; a standing Agent's line one its name; nothing cut; three lines;
// - a click on the row opens the conversation (a row island's text
//   included) and changes no island; a click on the ring goes straight to
//   its state's place: needs you to its item in Home's Needs you, an
//   executor's to its task, unread updates to the conversation, never
//   anything else; a ring with nowhere of its own is no button (no pointer,
//   not in the Tab order); there are no cards;
// - the ring's hit area is 28 px with a mouse and 40 px on touch, nothing
//   drawn; on hover it scales up a little in place (its strokes thicken
//   under reduced motion), with no halo; hover on the row only darkens it;
// - Tab reaches the row's link, then the ring, labelled with where it goes;
// - a new message and a hand-in each grow a pill left out of the ring that
//   takes its width from line one (its words wrap, never covered), and
//   shrink back;
// - with motion the outline starts as the ring's circle and ends in it;
//   under reduced motion nothing in the list animates.
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
const report = { task: "T-43 v10.2", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], rows: {}, went: {}, hits: {} };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-agent-island.test";

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "codex", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle" };
const standing = (id, name, extra = {}) => ({ ...base, id, name, ...extra });
const executor = (id, name, state, extra = {}, lifecycle = {}) => ({
  ...base, id, name, kind: "executor", ...extra,
  executor: { state, agentId: id, dispatcher: { kind: "user" }, task: { id: name.split(" · ")[0], title: name.split(" · ")[1] },
    template: { id: "design-first", label: "Design first" }, dispatchedAt: ago(72.5), since: ago(6.5), ...lifecycle },
});
// Synthetic Agents (names and texts made up for this check).
const fixture = () => [
  standing("lead", "Dev Lead 2", { kind: "lead", status: "working", workSummary: { kind: "progress", source: "agent", text: "Merging #659" } }),
  standing("dev9", "Dev 9", { unreadCount: 3, lastTurnEnd: { seq: 4, outcome: "finished", at: ago(14) } }),
  executor("yn24", "YN-24 · Design first", "delivering", { status: "working",
    workSummary: { kind: "progress", source: "agent", text: "Slice 2: evidence Job running" } }),
  executor("yn26", "YN-26 · Small fix", "delivering"),
  executor("yn21", "YN-21 · Design first", "running", { status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Approve the design note", requestId: "q1" } }),
  executor("yn33", "YN-33 · Design first", "failed", { closedAt: ago(1.5) }, { reason: "Both starts failed" }),
  executor("yn30", "YN-30 · Small fix", "queued", {}, { position: 2 }),
  // Its last Turn end is one this device has shown (reviewedSeq 1): idle, not done.
  standing("dev5", "Dev 5", { lastTurnEnd: { seq: 1, outcome: "finished", at: ago(80) } }),
];
let agents = fixture();
// Each row at rest: its state, its form, its mark inside the ring.
// Where each ring goes: home (its item in Needs you), task (its task),
// conversation, or null (no button: the row's click is its).
const GOES = { lead: null, dev9: "conversation", yn24: "task", yn26: "task", yn21: "home", yn33: "task", yn30: "task", dev5: null };
const EXPECTED = {
  lead: ["working", "ring", 0], dev9: ["done", "ring", 1], yn24: ["working", "ring", 0], yn26: ["handed", "ring", 0],
  yn21: ["waiting", "row", 0], yn33: ["failed", "row", 1], yn30: ["queued", "ring", 0], dev5: ["idle", "ring", 0],
};
const TEXT = {
  en: {
    one: { yn24: "Slice 2: evidence Job running", yn26: "Handed in #688 · waiting for the lead", yn21: "Needs you: Approve the design note",
      yn33: "Failed: Both starts failed", yn30: "Queued: 2 in line", lead: "Dev Lead 2Lead", dev9: "Dev 9", dev5: "Dev 5" },
    two: { yn24: /^YN-24 · 1h12m$/, yn26: /^YN-26 · 6m$/, yn21: /^YN-21 · 12m$/, yn33: /^YN-33 · 1m ago$/, yn30: /^YN-30 · 1h12m$/ },
    go: { dev9: "Dev 9 · Read 3 unread", yn24: "YN-24 · Design first · Open task YN-24", yn26: "YN-26 · Small fix · See the result of #688",
      yn21: "YN-21 · Design first · Answer its question on Home", yn33: "YN-33 · Design first · See why it failed", yn30: "YN-30 · Small fix · See its place in the queue" },
  },
  zh: {
    one: { yn24: "Slice 2: evidence Job running", yn26: "已交 #688 · 等负责人", yn21: "等你：Approve the design note",
      yn33: "出错：Both starts failed", yn30: "排队：第 2 位", lead: "Dev Lead 2负责人", dev9: "Dev 9", dev5: "Dev 5" },
    two: { yn24: /^YN-24 · 1时12分$/, yn26: /^YN-26 · 6分$/, yn21: /^YN-21 · 12分$/, yn33: /^YN-33 · 1分前$/, yn30: /^YN-30 · 1时12分$/ },
    go: { dev9: "Dev 9 · 看 3 条未读", yn24: "YN-24 · Design first · 看任务 YN-24", yn26: "YN-26 · Small fix · 看结果 #688",
      yn21: "YN-21 · Design first · 去 Home 回答提问", yn33: "YN-33 · Design first · 看出错原因", yn30: "YN-30 · Small fix · 看排队位置" },
  },
};
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" }];
const home = { generatedAt: ago(0), order: ["p1"],
  needsYou: [{ kind: "approval", projectId: "p1", agentId: "yn21", agentName: "YN-21 · Design first", requestId: "q1", title: "Approve the design note", since: ago(12.5) }],
  projects: [{ project: { id: "p1", name: "Yuzuno" }, agents: { working: 2, idle: 4, waiting: 1, error: 0, offline: 1, total: 8 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }] };
const live = { executors: {
  yn24: { pr: { number: 681, url: "https://github.com/owner/repo/pull/681", state: "open", headSha: "a".repeat(40), ci: "success", reviews: { approved: 0, changesRequested: false, running: false } } },
  yn26: { pr: { number: 688, url: "https://github.com/owner/repo/pull/688", state: "open", headSha: "b".repeat(40), ci: "success", reviews: { approved: 1, changesRequested: false, running: false } } },
} };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
// Each Agent's conversation read (GET /api/agents/<id>), per run: the row's click opens it, the ring's never.
let reads = {};

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
    report.writes.push({ method, path });
    return route.fulfill({ status: 404, json: { error: "not in the fixture" } });
  }
  if (method !== "GET") return route.fulfill({ json: {} });
  const detail = path.match(/^\/api\/agents\/([^/]+)$/);
  if (detail) {
    reads[detail[1]] = (reads[detail[1]] ?? 0) + 1;
    return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
  }
  const json = {
    "/api/workspace": { workspace: { id: "ws-agent-island" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home, "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
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

async function shot(locator, name) {
  await locator.page().mouse.move(0, 0);
  await locator.screenshot({ path: join(output, `${name}.png`) });
  report.screenshots.push(name);
}

// Every row as drawn: its island, its lines and their count, what is cut.
const rows = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((list) => list.map((r) => {
  const island = r.querySelector(":scope > .agent-island");
  const ring = island?.querySelector(".island-ringbox")?.getBoundingClientRect();
  const row = r.getBoundingClientRect();
  // Lines as drawn: the text's boxes, one line per bottom (a badge's box sits a few px off its line's).
  const lines = (el) => {
    if (!el || getComputedStyle(el).display === "none") return 0;
    const range = document.createRange();
    range.selectNodeContents(el);
    let n = 0, last = -Infinity;
    for (const b of [...range.getClientRects()].filter((x) => x.width > 0).map((x) => x.bottom).sort((x, y) => x - y)) if (b - last > 6) { n++; last = b; }
    return n;
  };
  const one = r.querySelector(":scope > .agent-row-top .agent-line-one");
  const two = r.querySelector(":scope > .agent-row-meta, :scope > .agent-row-state");
  const cut = (el) => !!el && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  return {
    id: r.dataset.agentId,
    avatar: !!r.querySelector(".agent-rail-avatar, .agent-avatar"),
    state: island?.dataset.state, form: island?.dataset.form, rowForm: r.dataset.form,
    tag: island?.tagName ?? null, label: island?.getAttribute("aria-label") ?? null, cursor: island ? getComputedStyle(island).cursor : null,
    ring: ring ? [Math.round(ring.width), Math.round(ring.height)] : null,
    // At the top right: its right edge near the row's (the "…" beside it takes its width only on the selected row), its top on line one.
    topRight: !!ring && row.right - ring.right - (r.querySelector(":scope > .agent-row-menu")?.getBoundingClientRect().width || -3) - 3 <= 14 && ring.top - row.top <= 12,
    marks: island?.querySelectorAll("svg path.r-mark").length ?? -1,
    strokesOnly: !!island && [...island.querySelectorAll("svg *")].every((n) => ["circle", "path", "g"].includes(n.localName)) && !island.querySelector(".island-dot"),
    one: one?.textContent ?? null, two: r.querySelector(":scope > .agent-row-meta")?.textContent ?? null,
    lines: lines(one) + lines(two),
    cut: [one, r.querySelector(":scope > .agent-row-meta"), r.querySelector(".agent-name")].some(cut),
    shell: (() => { const s = r.querySelector(":scope > .island-shell"); return s ? getComputedStyle(s).opacity : null; })(),
    // No cards: nothing in a row but its link, its ring and its "…" is a button.
    buttons: [...r.querySelectorAll("button")].map((b) => b.className.split(" ")[0]),
  };
}));
const byId = async (page) => Object.fromEntries((await rows(page)).map((r) => [r.id, r]));

async function run({ width, height, theme, motion, lang = "en" }) {
  const phone = width < 600;
  const tag = `${width}-${theme}-${lang}${motion ? "-motion" : ""}`;
  const words = TEXT[lang];
  agents = fixture();
  reads = {};
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: motion ? "no-preference" : "reduce", colorScheme: theme,
    ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang === "zh" ? "zh-Hans" : "en" }));
    // The desktop rail at 240 px.
    localStorage.setItem("yuzuno.panel-widths", JSON.stringify({ rail: 240 }));
    // Where a ring's task goes, as the app is told it.
    window.__tasks = [];
    window.addEventListener("yuzuno:open-task-review", (event) => window.__tasks.push(event.detail?.taskId ?? null));
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const list = page.locator(".agent-list");
  const rowOf = (id) => list.locator(`article[data-agent-id="${id}"]`);
  const ringOf = (id) => rowOf(id).locator(":scope > .agent-island");
  const formOf = (id) => rowOf(id).getAttribute("data-form");
  const listAnimations = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".agent-list")).length);
  const tasks = () => page.evaluate(() => window.__tasks.slice());
  const press = (locator) => (phone ? locator.tap() : locator.click());
  try {
    await page.goto(`https://${HOST}/`);
    await list.locator('article[data-agent-id="dev5"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => /#688/.test(document.querySelector('.agent-list article[data-agent-id="yn26"] .agent-line-one')?.textContent ?? ""), null, { timeout: 10_000 });
    await page.mouse.move(0, 0);

    // At rest.
    const seen = await byId(page);
    report.rows[tag] = seen;
    assert.deepEqual(Object.keys(seen).sort(), Object.keys(EXPECTED).sort(), `${tag}: every Agent listed`);
    for (const [id, [state, form, marks]] of Object.entries(EXPECTED)) {
      const r = seen[id];
      assert.equal(r.avatar, false, `${tag}: ${id} has no avatar`);
      assert.deepEqual([r.state, r.form, r.rowForm], [state, form, form], `${tag}: ${id} at rest`);
      assert.deepEqual(r.ring, [22, 22], `${tag}: ${id}'s ring is 22 px`);
      assert.ok(r.topRight, `${tag}: ${id}'s ring at the row's top right`);
      assert.ok(r.strokesOnly, `${tag}: ${id}'s ring is strokes only`);
      assert.equal(r.marks, marks, `${tag}: ${id}'s ring ${marks ? "has its mark" : "is empty inside"}`);
      assert.equal(r.shell, form === "row" ? "1" : "0", `${tag}: ${id}'s outline ${form === "row" ? "is the row's" : "is hidden in its ring"}`);
      assert.equal(r.one, words.one[id], `${tag}: ${id}'s line one`);
      if (words.two[id]) assert.match(r.two, words.two[id], `${tag}: ${id}'s task key and clock`);
      assert.equal(r.cut, false, `${tag}: nothing of ${id}'s cut`);
      assert.ok(r.lines >= 1 && r.lines <= 3, `${tag}: ${id} is ${r.lines} lines`);
      // Its ring: a button labelled with where it goes, or part of the row.
      assert.deepEqual([r.tag, r.label, r.cursor], GOES[id] ? ["BUTTON", words.go[id], "pointer"] : ["SPAN", null, "auto"], `${tag}: ${id}'s ring`);
      assert.deepEqual(r.buttons.filter((b) => !b.startsWith("agent-actions")), GOES[id] ? ["agent-select", "agent-island"] : ["agent-select"], `${tag}: ${id} has no card buttons`);
    }
    assert.equal(await rowOf("dev9").locator(".island-notch").textContent(), "3", `${tag}: Dev 9's three unread beside its ring`);
    await shot(list, `${tag}-1-list`);
    check(`${tag}: rings 22 px at the top right, strokes only, marks for done and failed; needs you and failed are row islands; line one the activity, line two the key and clock; nothing cut; three lines at most; a ring is a button only where it goes somewhere, labelled with where; no card buttons`);

    // Hit areas, measured from the ring's centre: 28 px with a mouse, 40 px on touch.
    const reach = phone ? 19.5 : 13.5;
    const hits = await ringOf("yn30").locator(".island-ringbox").evaluate((g, d) => {
      const b = g.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2, island = g.closest(".agent-island");
      return { coarse: matchMedia("(pointer: coarse)").matches, at: [[-d, 0], [d, 0], [0, -d], [0, d]].map(([x, y]) => island.contains(document.elementFromPoint(cx + x, cy + y))),
        out: island.contains(document.elementFromPoint(cx - d - 6, cy)) };
    }, reach);
    report.hits[tag] = hits;
    assert.equal(hits.coarse, phone, `${tag}: pointer ${phone ? "coarse" : "fine"}`);
    assert.deepEqual(hits.at, [true, true, true, true], `${tag}: the ring takes presses ${reach} px from its centre`);
    assert.equal(hits.out, false, `${tag}: and not past its hit area`);

    // A click on each ring goes to its state's place, never to the conversation unless that is its place; the island stays as it was.
    const went = {};
    for (const [id, goes] of Object.entries(GOES)) {
      if (!goes || goes === "home" || (phone && goes === "conversation")) continue;
      const before = { reads: reads[id] ?? 0, tasks: (await tasks()).length };
      await press(ringOf(id));
      if (goes === "task") {
        await page.waitForFunction((n) => window.__tasks.length > n, before.tasks, { timeout: 5_000 });
        const dialog = page.getByRole("dialog");
        await dialog.first().waitFor({ timeout: 5_000 });
        await page.keyboard.press("Escape");
        await dialog.first().waitFor({ state: "detached", timeout: 5_000 });
      } else for (let n = 0; n < 60 && (reads[id] ?? 0) <= before.reads; n++) await page.waitForTimeout(50);
      went[id] = { task: (await tasks()).slice(before.tasks), reads: (reads[id] ?? 0) - before.reads };
      if (goes === "task") assert.deepEqual(went[id], { task: [id.toUpperCase().replace("YN", "YN-")], reads: 0 }, `${tag}: ${id}'s ring opens its task, not its conversation`);
      else assert.deepEqual(went[id], { task: [], reads: 1 }, `${tag}: ${id}'s ring opens its conversation, at its unread`);
      assert.equal(await formOf(id), EXPECTED[id][1], `${tag}: ${id}'s island is as it was`);
    }
    report.went[tag] = went;

    if (!phone) {
      // Hover: on a ring that goes somewhere it grows a little in place (its strokes thicken under
      // reduced motion), no halo, the row as at rest; on the row, the row darkens and the ring stays.
      await rowOf("yn24").scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const look = (id) => rowOf(id).evaluate((r) => {
        const g = r.querySelector(".island-ringbox"), b = g.getBoundingClientRect(), c = r.querySelector(".island-ring circle:not(.r-track)");
        return { bg: getComputedStyle(r).backgroundColor, border: getComputedStyle(r).borderTopColor, transform: getComputedStyle(g).transform,
          centre: [Math.round((b.left + b.right) * 5) / 10, Math.round((b.top + b.bottom) * 5) / 10], stroke: parseFloat(getComputedStyle(c).strokeWidth),
          halo: getComputedStyle(g, "::after").content };
      });
      const scale = (t) => (t === "none" ? 1 : Number(/matrix\(([^,]+)/.exec(t)?.[1] ?? NaN));
      const rest = await look("yn24"), rest5 = await look("dev5");
      await ringOf("yn24").hover();
      await page.waitForTimeout(motion ? 250 : 50);
      const ring = await look("yn24");
      // Each look once its transitions (120 ms) have run.
      await rowOf("yn24").locator(".agent-line-one").hover({ force: true });
      await page.waitForTimeout(motion ? 400 : 50);
      const row = await look("yn24");
      await rowOf("dev5").locator(".island-ringbox").hover({ force: true });
      await page.waitForTimeout(motion ? 400 : 50);
      const plain = await look("dev5");
      report.hover = { ...(report.hover ?? {}), [tag]: { rest, ring, row, rest5, plain } };
      assert.equal(ring.halo, "none", `${tag}: no halo`);
      assert.equal(ring.bg, rest.bg, `${tag}: on the ring the row stays as it was`);
      assert.deepEqual(ring.centre, rest.centre, `${tag}: the ring stays in place`);
      if (motion) assert.ok(scale(ring.transform) >= 1.1 && scale(ring.transform) <= 1.15 && ring.stroke === rest.stroke, `${tag}: the ring grows a little: ${ring.transform}`);
      else assert.ok(scale(ring.transform) === 1 && ring.stroke > rest.stroke + 0.5, `${tag}: under reduced motion its strokes thicken instead: ${rest.stroke} → ${ring.stroke}`);
      assert.ok(row.bg !== rest.bg && row.border === rest.border && scale(row.transform) === 1 && row.stroke === rest.stroke, `${tag}: on the row, the row darkens, no border, the ring stays: ${JSON.stringify(row)}`);
      assert.ok(plain.bg !== rest5.bg && scale(plain.transform) === 1 && plain.stroke === rest5.stroke, `${tag}: a ring that is no button doesn't react; the row under it darkens: ${JSON.stringify([rest5, plain])}`);
      {
        await ringOf("yn24").hover();
        await page.waitForTimeout(motion ? 250 : 50);
        await list.screenshot({ path: join(output, `${tag}-3-ring-hover.png`) });
        await rowOf("yn24").locator(".agent-line-one").hover({ force: true });
        await page.waitForTimeout(motion ? 400 : 50);
        await list.screenshot({ path: join(output, `${tag}-3-row-hover.png`) });
        report.screenshots.push(`${tag}-3-ring-hover`, `${tag}-3-row-hover`);
      }
      await page.mouse.move(0, 0);

      // The keyboard: the row's link, then the ring, labelled with where it goes; Enter goes there. A plain ring isn't reached.
      await rowOf("yn30").locator(".agent-select").focus();
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => [document.activeElement?.className, document.activeElement?.getAttribute("aria-label"), document.activeElement?.closest("article")?.dataset.agentId]);
      assert.deepEqual(focused, ["agent-island", words.go.yn30, "yn30"], `${tag}: Tab goes from the row's link to its ring`);
      const n = (await tasks()).length;
      await page.keyboard.press("Enter");
      await page.waitForFunction((n) => window.__tasks.length > n, n, { timeout: 5_000 });
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").first().waitFor({ state: "detached", timeout: 5_000 });
      await rowOf("dev5").locator(".agent-select").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".agent-island")), false, `${tag}: a ring that is no button isn't in the Tab order`);
      check(`${tag}: each ring goes to its place (its task, its unread), never elsewhere; its hit area is 28 px; hover grows it a little in place${motion ? "" : " (thicker strokes under reduced motion)"}, no halo, and darkens only the row elsewhere; Tab reaches the row and then the ring, Enter goes`);
    } else {
      check(`${tag}: on touch the ring's hit area is 40 px and a tap goes to its place`);
    }

    // Two passing events at once (the list is read again within 5 s): Dev 5's new message, and
    // YN-24 handing in. Each pill grows left out of its ring and takes its width from line one,
    // whose words wrap rather than being covered (the user, v10.2); then each shrinks back.
    {
      const before = Object.fromEntries(await Promise.all(["dev5", "yn24"].map(async (id) => [id, await rowOf(id).evaluate((r) => ({
        width: Math.round(r.querySelector(".agent-line-one").getBoundingClientRect().width), height: Math.round(r.getBoundingClientRect().height) }))])));
      agents = agents.map((a) => (a.id === "dev5" ? { ...a, unreadCount: 1 }
        : a.id === "yn24" ? { ...a, status: "idle", workSummary: null, executor: { ...a.executor, since: ago(0.2) } } : a));
      await page.waitForFunction(() => ["dev5", "yn24"].every((id) => document.querySelector(`.agent-list article[data-agent-id="${id}"]`)?.dataset.form === "pill"), null, { timeout: 10_000, polling: "raf" });
      const opening = await rowOf("dev5").evaluate((r) => r.querySelector(".island-shell").getAnimations().map((a) => { const k = a.effect.getKeyframes(); return [k[0].width, k.at(-1).width]; }));
      const pills = Object.fromEntries(await Promise.all(["dev5", "yn24"].map(async (id) => [id, await rowOf(id).evaluate((r) => {
        const p = r.querySelector(".island-pill").getBoundingClientRect(), g = r.querySelector(".island-ringbox").getBoundingClientRect(), s = r.querySelector(".island-shell").getBoundingClientRect();
        const one = r.querySelector(".agent-line-one"), range = document.createRange();
        range.selectNodeContents(one);
        const words = Math.max(...[...range.getClientRects()].map((x) => x.right));
        return { text: r.querySelector(".island-pill").textContent, leftOfRing: p.right <= g.left + 0.5, shell: s.left < p.left && s.right >= g.right && s.height <= 30,
          // Pushed, not covered: line one's words end before the pill's outline begins.
          clear: words <= s.left + 0.5, width: Math.round(one.getBoundingClientRect().width), height: Math.round(r.getBoundingClientRect().height), cut: one.scrollHeight > one.clientHeight + 1 };
      })])));
      report.pills = { ...(report.pills ?? {}), [tag]: { before, pills } };
      const said = lang === "zh" ? { dev5: "1 条新消息", yn24: "已交 #681" } : { dev5: "1 new message", yn24: "Handed in #681" };
      for (const id of ["dev5", "yn24"]) {
        const p = pills[id];
        assert.ok(p.text === said[id] && p.leftOfRing && p.shell && p.clear && !p.cut, `${tag}: ${id}'s pill left of its ring, in its outline, line one's words clear of it: ${JSON.stringify(p)}`);
        assert.ok(p.width < before[id].width, `${tag}: ${id}'s pill takes its width from line one: ${before[id].width} → ${p.width}`);
      }
      if (!phone || theme === "light") await shot(list, `${tag}-4-pills`);
      await page.waitForFunction(() => ["dev5", "yn24"].every((id) => document.querySelector(`.agent-list article[data-agent-id="${id}"]`)?.dataset.form === "ring"), null, { timeout: 6_000, polling: "raf" });
      const closing = await rowOf("dev5").evaluate((r) => r.querySelector(".island-shell").getAnimations().map((a) => { const k = a.effect.getKeyframes(); return [k[0].width, k.at(-1).width]; }));
      const after = await rowOf("dev5").evaluate((r) => Math.round(r.querySelector(".agent-line-one").getBoundingClientRect().width));
      assert.equal(after, before.dev5.width, `${tag}: line one has its width back`);
      report.motion = { ...(report.motion ?? {}), [tag]: { opening, closing } };
      if (motion) {
        assert.ok(opening.some(([from]) => from === "22px"), `${tag}: the outline grows out of the ring (${JSON.stringify(opening)})`);
        assert.ok(closing.some(([, to]) => to === "22px"), `${tag}: and shrinks back into it (${JSON.stringify(closing)})`);
      } else assert.equal(await listAnimations(), 0, `${tag}: under reduced motion nothing in the list animates`);
      check(`${tag}: a new message and a hand-in each grow a pill left out of the ring that pushes line one's words aside, and go back after about 3 s${motion ? "; the outline starts as the ring's circle and ends in it" : ""}`);
    }

    if (!phone) {
      // A click on the row opens the conversation and changes no island: a
      // standing Agent's name, and the text of a row island.
      for (const [id, part] of [["dev5", ".agent-line-one"], ["yn21", ".agent-row-meta"]]) {
        const before = reads[id] ?? 0;
        await rowOf(id).locator(part).click({ force: true });
        for (let n = 0; n < 60 && (reads[id] ?? 0) <= before; n++) await page.waitForTimeout(50);
        assert.ok((reads[id] ?? 0) > before, `${tag}: a click on ${id}'s row (${part}) opens its conversation`);
        assert.equal(await formOf(id), EXPECTED[id][1], `${tag}: ${id}'s island is as it was`);
      }
      check(`${tag}: a click on the row opens the conversation, a row island's text included, and leaves the island as it was`);
    }

    // Needs you: its ring goes to its item in Home's Needs you, highlighted; never its conversation. Last, as a phone then shows Home.
    {
      const before = reads.yn21 ?? 0;
      await press(ringOf("yn21"));
      await page.waitForFunction(() => document.activeElement?.dataset?.needsYou === "approval:q1", null, { timeout: 8_000 });
      await page.locator('[data-needs-you="approval:q1"][data-home-highlight]').waitFor({ timeout: 5_000 });
      assert.equal(reads.yn21 ?? 0, before, `${tag}: the needs-you ring never opened the conversation`);
      await page.screenshot({ path: join(output, `${tag}-5-home-needs-you.png`) });
      report.screenshots.push(`${tag}-5-home-needs-you`);
      check(`${tag}: the needs-you ring goes to its item in Home's Needs you, highlighted`);
    }
  } catch (error) {
    await page.screenshot({ path: join(output, `${tag}-failure.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  await run({ width: 1440, height: 900, theme: "light", motion: true });
  for (const theme of ["light", "dark"]) {
    await run({ width: 1440, height: 900, theme, motion: false });
    await run({ width: 390, height: 844, theme, motion: false });
  }
  for (const theme of ["light", "dark"]) {
    await run({ width: 1440, height: 900, theme, motion: false, lang: "zh" });
    await run({ width: 390, height: 844, theme, motion: false, lang: "zh" });
  }
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
