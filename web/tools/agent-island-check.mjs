// T-43, 灵动环 v10.1 (the user's design of 2026-11-07): the Agent row's
// island in Chromium, with every API answered here (no Core, no CLI, no
// daily configuration) and synthetic Agents in the states a rail shows:
// working, handed in, needs you, queued, done with three unread, failed and
// idle. At 1440 (the rail) and 390 (a phone, touch), light and dark, English
// and Chinese:
// - the ring is the state: 22 px at the row's top right, strokes only, a
//   mark inside for done and failed, nothing for the rest;
// - at rest needs you and failed are row islands, everything else a ring;
// - an executor's line one is what it is doing, line two its task key and
//   clock; a standing Agent's line one its name; nothing cut; every row, card
//   included, four lines at most;
// - a click on the row opens the conversation (a row island's text
//   included) and changes no island; only the ring steps it, ring → row
//   island → card → ring, and never opens the conversation; no card offers
//   to open it; each card's buttons lead elsewhere;
// - the ring's hit area is 28 px with a mouse and 40 px on touch, nothing
//   drawn; hover darkens the row only, with no border; on the ring the row
//   stays and the ring shows its halo;
// - Tab reaches the row's link, then the ring's button (aria-expanded);
//   Enter steps, Escape closes;
// - a new message grows the pill left out of the ring and it shrinks back;
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
const report = { task: "T-43 v10.1", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], rows: {}, cards: {}, hits: {} };
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
const EXPECTED = {
  lead: ["working", "ring", 0], dev9: ["done", "ring", 1], yn24: ["working", "ring", 0], yn26: ["handed", "ring", 0],
  yn21: ["waiting", "row", 0], yn33: ["failed", "row", 1], yn30: ["queued", "ring", 0], dev5: ["idle", "ring", 0],
};
const TEXT = {
  en: {
    one: { yn24: "Slice 2: evidence Job running", yn26: "Handed in #688 · waiting for the lead", yn21: "Needs you: Approve the design note",
      yn33: "Failed: Both starts failed", yn30: "Queued: 2 in line", lead: "Dev Lead 2Lead", dev9: "Dev 9", dev5: "Dev 5" },
    two: { yn24: /^YN-24 · 1h12m$/, yn26: /^YN-26 · 6m$/, yn21: /^YN-21 · 12m$/, yn33: /^YN-33 · 1m ago$/, yn30: /^YN-30 · 1h12m$/ },
    acts: { yn24: ["Task"], yn26: ["See result"], yn21: ["Answer on Home", "Task"], yn33: ["See why"], yn30: ["Task"], lead: [], dev9: [], dev5: [] },
    short: { Task: "Task", "See result": "Result", "Answer on Home": "Answer", "See why": "Why" },
  },
  zh: {
    one: { yn24: "Slice 2: evidence Job running", yn26: "已交 #688 · 等负责人", yn21: "等你：Approve the design note",
      yn33: "出错：Both starts failed", yn30: "排队：第 2 位", lead: "Dev Lead 2负责人", dev9: "Dev 9", dev5: "Dev 5" },
    two: { yn24: /^YN-24 · 1时12分$/, yn26: /^YN-26 · 6分$/, yn21: /^YN-21 · 12分$/, yn33: /^YN-33 · 1分前$/, yn30: /^YN-30 · 1时12分$/ },
    acts: { yn24: ["看任务"], yn26: ["看结果"], yn21: ["去 Home 回答", "看任务"], yn33: ["看出错原因"], yn30: ["看任务"], lead: [], dev9: [], dev5: [] },
    short: { 看任务: "任务", 看结果: "结果", "去 Home 回答": "回答", 看出错原因: "原因" },
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
  const lines = (el) => {
    if (!el || getComputedStyle(el).display === "none") return 0;
    const h = el.getBoundingClientRect().height, lh = parseFloat(getComputedStyle(el).lineHeight);
    return h > 0 && lh > 0 ? Math.round(h / lh) : 0;
  };
  const one = r.querySelector(":scope > .agent-row-top .agent-line-one");
  const two = r.querySelector(":scope > .agent-row-meta, :scope > .agent-row-state");
  const more = r.querySelector(":scope > .agent-row-more");
  const buttons = [...r.querySelectorAll(":scope > .island-actions > button")];
  const cut = (el) => !!el && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  return {
    id: r.dataset.agentId,
    avatar: !!r.querySelector(".agent-rail-avatar, .agent-avatar"),
    state: island?.dataset.state, form: island?.dataset.form, rowForm: r.dataset.form,
    expanded: island?.getAttribute("aria-expanded"),
    ring: ring ? [Math.round(ring.width), Math.round(ring.height)] : null,
    // At the top right: its right edge near the row's (the "…" folded), its top on line one.
    // The "…" beside it takes its width only on the selected row.
    topRight: !!ring && row.right - ring.right - (r.querySelector(":scope > .agent-row-menu")?.getBoundingClientRect().width || -3) - 3 <= 14 && ring.top - row.top <= 12,
    marks: island?.querySelectorAll("svg path.r-mark").length ?? -1,
    strokesOnly: !!island && [...island.querySelectorAll("svg *")].every((n) => ["circle", "path", "g"].includes(n.localName)) && !island.querySelector(".island-dot"),
    one: one?.textContent ?? null, two: r.querySelector(":scope > .agent-row-meta")?.textContent ?? null,
    lines: lines(one) + lines(two) + lines(more) + new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
    cut: [one, r.querySelector(":scope > .agent-row-meta"), r.querySelector(".agent-name"), more].some(cut),
    shell: (() => { const s = r.querySelector(":scope > .island-shell"); return s ? getComputedStyle(s).opacity : null; })(),
    buttons: buttons.map((b) => b.textContent),
    selected: r.querySelector(":scope > .agent-select")?.getAttribute("aria-current") === "true",
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
  }, { theme, lang });
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  const list = page.locator(".agent-list");
  const rowOf = (id) => list.locator(`article[data-agent-id="${id}"]`);
  const formOf = (id) => rowOf(id).getAttribute("data-form");
  const waitForm = (id, form) => page.waitForFunction(([id, form]) => document.querySelector(`.agent-list article[data-agent-id="${id}"]`)?.dataset.form === form, [id, form], { timeout: 5_000 });
  const listAnimations = () => page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".agent-list")).length);
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
      assert.equal(r.expanded, form === "row" ? "true" : "false", `${tag}: ${id}'s ring says whether the island is open`);
      assert.equal(r.shell, form === "row" ? "1" : "0", `${tag}: ${id}'s outline ${form === "row" ? "is the row's" : "is hidden in its ring"}`);
      assert.equal(r.one, words.one[id], `${tag}: ${id}'s line one`);
      if (words.two[id]) assert.match(r.two, words.two[id], `${tag}: ${id}'s task key and clock`);
      assert.equal(r.cut, false, `${tag}: nothing of ${id}'s cut`);
      assert.ok(r.lines >= 1 && r.lines <= 4, `${tag}: ${id} is ${r.lines} lines`);
    }
    assert.equal(await rowOf("dev9").locator(".island-notch").textContent(), "3", `${tag}: Dev 9's three unread beside its ring`);
    await shot(list, `${tag}-1-list`);
    check(`${tag}: rings 22 px at the top right, strokes only, marks for done and failed; needs you and failed are row islands; line one the activity, line two the key and clock; nothing cut; four lines at most`);

    // The ring steps the island and never opens the conversation; no card offers to.
    const ringClick = (id) => (phone ? rowOf(id).locator(".agent-island").tap() : rowOf(id).locator(".agent-island").click());
    for (const id of Object.keys(EXPECTED)) {
      const before = reads[id] ?? 0;
      const rest = EXPECTED[id][1];
      if (rest === "ring") {
        await ringClick(id);
        await waitForm(id, "row");
      }
      await ringClick(id);
      await waitForm(id, "card");
      const r = (await byId(page))[id];
      report.cards[`${tag}-${id}`] = r;
      assert.equal(r.expanded, "true", `${tag}: ${id}'s ring says the card is open`);
      // Their long words, or all their short ones when the long ones would make a fifth line.
      const short = words.acts[id].map((w) => words.short[w]);
      assert.ok([words.acts[id], short].some((want) => JSON.stringify(want) === JSON.stringify(r.buttons)), `${tag}: ${id}'s card buttons: ${r.buttons}`);
      assert.ok(!r.buttons.some((b) => /Open|打开会话|会话/.test(b)), `${tag}: ${id}'s card offers no conversation`);
      assert.ok(r.lines <= 4, `${tag}: ${id}'s card is ${r.lines} lines`);
      assert.equal(r.cut, false, `${tag}: nothing of ${id}'s card cut`);
      if (id === "yn21" || id === "yn26") await shot(phone ? page : list, `${tag}-2-card-${id}`);
      await ringClick(id);
      await waitForm(id, rest);
      assert.equal(reads[id] ?? 0, before, `${tag}: ${id}'s ring never opened its conversation`);
    }
    check(`${tag}: the ring steps the island ring → row island → card → back and never opens the conversation; no card offers it; cards four lines at most`);

    // Hit areas, measured from the ring's centre: 28 px with a mouse, 40 px on touch.
    const reach = phone ? 19.5 : 13.5;
    const hits = await rowOf("yn30").locator(".agent-island .island-ringbox").evaluate((g, d) => {
      const b = g.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2, island = g.closest(".agent-island");
      return { coarse: matchMedia("(pointer: coarse)").matches, at: [[-d, 0], [d, 0], [0, -d], [0, d]].map(([x, y]) => island.contains(document.elementFromPoint(cx + x, cy + y))),
        out: island.contains(document.elementFromPoint(cx - d - 6, cy)) };
    }, reach);
    report.hits[tag] = hits;
    assert.equal(hits.coarse, phone, `${tag}: pointer ${phone ? "coarse" : "fine"}`);
    assert.deepEqual(hits.at, [true, true, true, true], `${tag}: the ring takes presses ${reach} px from its centre`);
    assert.equal(hits.out, false, `${tag}: and not past its hit area`);

    if (!phone) {
      // Hover: the row darkens, no border, no halo; on the ring, the halo and the row as at rest.
      const look = () => rowOf("dev5").evaluate((r) => ({ bg: getComputedStyle(r).backgroundColor, border: getComputedStyle(r).borderTopColor,
        halo: getComputedStyle(r.querySelector(".island-ringbox"), "::after").content }));
      const restLook = await look();
      await rowOf("dev5").locator(".agent-line-one").hover({ force: true });
      const rowHover = await look();
      await rowOf("dev5").locator(".agent-island").hover();
      const ringHover = await look();
      report.hover = { ...(report.hover ?? {}), [tag]: { rest: restLook, row: rowHover, ring: ringHover } };
      assert.notEqual(rowHover.bg, restLook.bg, `${tag}: hover darkens the row`);
      assert.equal(rowHover.border, restLook.border, `${tag}: and draws no border`);
      assert.equal(rowHover.halo, "none", `${tag}: and no halo on the ring`);
      assert.notEqual(ringHover.halo, "none", `${tag}: on the ring, its halo`);
      assert.equal(ringHover.bg, restLook.bg, `${tag}: and the row as at rest`);
      if (theme === "light") {
        await rowOf("dev5").locator(".agent-island").hover();
        await list.screenshot({ path: join(output, `${tag}-3-ring-hover.png`) });
        await rowOf("dev5").locator(".agent-line-one").hover({ force: true });
        await list.screenshot({ path: join(output, `${tag}-3-row-hover.png`) });
        report.screenshots.push(`${tag}-3-ring-hover`, `${tag}-3-row-hover`);
      }
      await page.mouse.move(0, 0);

      // The keyboard: the row's link, then the ring's button; Enter steps, Escape closes.
      await rowOf("yn30").locator(".agent-select").focus();
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => [document.activeElement?.className, document.activeElement?.getAttribute("aria-expanded"), document.activeElement?.closest("article")?.dataset.agentId]);
      assert.deepEqual(focused, ["agent-island", "false", "yn30"], `${tag}: Tab goes from the row's link to its ring`);
      await page.keyboard.press("Enter");
      await waitForm("yn30", "row");
      await page.keyboard.press("Escape");
      await waitForm("yn30", "ring");
      check(`${tag}: hover darkens the row only, the ring shows its halo; the ring's hit area is 28 px; Tab reaches the row and then the ring, Enter steps, Escape closes`);
    } else {
      check(`${tag}: on touch the ring's hit area is 40 px and a tap steps the island`);
    }

    if (motion) {
      // Out of the ring and back into it: the outline's first and last frames are the ring's circle.
      const frames = async () => page.evaluate(() => document.getAnimations()
        .filter((a) => a.effect?.target?.classList?.contains("island-shell") && a.effect.target.closest('[data-agent-id="yn30"]'))
        .map((a) => { const k = a.effect.getKeyframes(); return [k[0].width, k.at(-1).width]; }));
      await rowOf("yn30").locator(".agent-island").click();
      const opening = await frames();
      await waitForm("yn30", "row");
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(60);
      const closing = await frames();
      await waitForm("yn30", "ring");
      report.motion = { opening, closing };
      assert.ok(opening.some(([from]) => from === "22px"), `${tag}: the outline grows out of the ring (${JSON.stringify(opening)})`);
      assert.ok(closing.some(([, to]) => to === "22px"), `${tag}: and shrinks back into it (${JSON.stringify(closing)})`);
      check(`${tag}: with motion the outline starts as the ring's circle and ends in it`);
    } else {
      assert.equal(await listAnimations(), 0, `${tag}: under reduced motion nothing in the list animates`);
    }

    // A new message: the pill grows left out of the ring, then shrinks back (the list is read again within 5 s).
    {
      agents = agents.map((a) => (a.id === "dev5" ? { ...a, unreadCount: 1 } : a));
      await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="dev5"]')?.dataset.form === "pill", null, { timeout: 10_000 });
      const pill = await rowOf("dev5").evaluate((r) => {
        const p = r.querySelector(".island-pill").getBoundingClientRect(), g = r.querySelector(".island-ringbox").getBoundingClientRect(), s = r.querySelector(".island-shell").getBoundingClientRect();
        return { text: r.querySelector(".island-pill").textContent, leftOfRing: p.right <= g.left + 0.5, shell: s.left < p.left && s.right >= g.right && s.height <= 30 };
      });
      assert.deepEqual(pill, { text: lang === "zh" ? "新消息" : "New message", leftOfRing: true, shell: true }, `${tag}: the pill left of the ring, in its outline`);
      if (theme === "light" && !phone) await shot(list, `${tag}-4-pill`);
      await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="dev5"]')?.dataset.form === "ring", null, { timeout: 6_000 });
      check(`${tag}: a new message grows the pill left out of the ring, and it goes back after about 3 s`);
    }
    // A click on the row opens the conversation and changes no island: a
    // standing Agent's name, and the text of a row island. Last, as a
    // phone then shows the conversation in the list's place.
    for (const [id, part] of [["dev5", ".agent-line-one"], ["yn21", ".agent-row-meta"]]) {
      const before = reads[id] ?? 0;
      if (phone) await rowOf(id).locator(part).tap({ force: true });
      else await rowOf(id).locator(part).click({ force: true });
      for (let n = 0; n < 60 && (reads[id] ?? 0) <= before; n++) await page.waitForTimeout(50);
      assert.ok((reads[id] ?? 0) > before, `${tag}: a click on ${id}'s row (${part}) opens its conversation`);
      if (phone) break;
      assert.equal(await formOf(id), EXPECTED[id][1], `${tag}: ${id}'s island is as it was`);
    }
    check(`${tag}: a click on the row opens the conversation, a row island's text included, and leaves the island as it was`);
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
  await run({ width: 1440, height: 900, theme: "light", motion: false, lang: "zh" });
  await run({ width: 390, height: 844, theme: "light", motion: false, lang: "zh" });
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
