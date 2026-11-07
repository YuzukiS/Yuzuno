// T-43, 灵动环 v4-2 (the user's choice): the Agent row's island in Chromium,
// with every API answered here (no Core, no CLI, no daily configuration) and
// synthetic Agents in the six states: working, handed in, needs you, queued,
// done with three unread, failed (and idle). At 1440 (the rail) and 390 (a
// phone), light and dark: no avatar on any row; each row's island is its
// own, at the row's right end and centred on its lines, and holds the
// executor's template and PR (the user's review of 2026-11-07); line two is
// only the summary, and a row without one is one line; the ring stays within
// 24 px, needs you and failed open to two lines by themselves; the time is
// the island's; pressing the island opens its card in the row's place,
// leading with what the state asks for, and Escape closes it. With motion,
// the ring slides to the card's cover; under reduced motion nothing animates.
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
const report = { task: "T-43 v4-2", checks: [], screenshots: [], unexpected: [], writes: [], errors: [] };
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
    template: { id: "design-first", label: "Design first" }, dispatchedAt: ago(72), since: ago(6), ...lifecycle },
});
// Synthetic Agents (names and texts made up for this check).
const agents = [
  standing("lead", "Dev Lead 2", { kind: "lead", status: "working", workSummary: { kind: "progress", source: "agent", text: "Merging #659" } }),
  standing("dev9", "Dev 9", { unreadCount: 3, lastTurnEnd: { seq: 4, outcome: "finished", at: ago(14) } }),
  executor("yn24", "YN-24 · Design first", "delivering", { status: "working" }),
  executor("yn26", "YN-26 · Small fix", "delivering"),
  executor("yn21", "YN-21 · Design first", "running", { status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Approve the design note", requestId: "q1" } }),
  executor("yn33", "YN-33 · Design first", "failed", { closedAt: ago(1) }, { reason: "Both starts failed" }),
  executor("yn30", "YN-30 · Small fix", "queued", {}, { position: 2 }),
  // Its last Turn end is one this device has shown (reviewedSeq 1): idle, not done.
  standing("dev5", "Dev 5", { lastTurnEnd: { seq: 1, outcome: "finished", at: ago(80) } }),
];
// What each row's island says, and its form while nothing is pressed.
const EXPECTED = {
  lead: ["working", "ring"], dev9: ["done", "ring"], yn24: ["working", "ring"], yn26: ["handed", "ring"],
  yn21: ["waiting", "two"], yn33: ["failed", "two"], yn30: ["queued", "ring"], dev5: ["idle", "ring"],
};
const SIX = ["working", "handed", "waiting", "queued", "done", "failed"];
// The rows with a summary on line two: the lead's update. The rest are one
// line; needs you and failed say theirs in the island's two lines.
const LINE_TWO = ["lead"];
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
  if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
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
  await locator.screenshot({ path: join(output, `${name}.png`) });
  report.screenshots.push(name);
}

// Every row: its island's state, form and size, what is on line two, and
// whether a time is written anywhere on line two outside the island.
const rows = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((list) => list.map((r) => {
  const island = r.querySelector(":scope > .agent-island");
  const box = island?.getBoundingClientRect();
  const line = r.querySelector(".agent-row-state");
  const name = r.querySelector(".agent-name").getBoundingClientRect();
  const lines = line ? line.getBoundingClientRect() : name;
  const outside = line?.textContent ?? "";
  const shown = (el) => !!el && getComputedStyle(el).display !== "none";
  const row = r.getBoundingClientRect();
  return {
    id: r.dataset.agentId,
    avatar: !!r.querySelector(".agent-rail-avatar, .agent-avatar"),
    // Centred on the name and line two together, at the row's right end.
    centred: !!box && Math.abs((box.top + box.bottom) / 2 - (name.top + lines.bottom) / 2) <= 2.5,
    rightEnd: !!box && row.right - box.right <= 48 && box.left > name.left,
    lineTwo: !!line,
    chipsOutside: !!r.querySelector(".executor-row-facts:not(.agent-island .executor-row-facts)"),
    pr: island?.querySelector(".executor-pr-chip")?.textContent ?? null,
    // Which chips show: one with no room wraps onto the line the island hides.
    chipsShown: [...(island?.querySelectorAll(".executor-row-facts > span") ?? [])].filter((c) => {
      const f = c.parentElement.getBoundingClientRect(), b = c.getBoundingClientRect();
      return b.top < f.bottom - 1 && b.right <= f.right + 0.5;
    }).map((c) => c.textContent),
    state: island?.dataset.state, form: island?.dataset.form,
    width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0),
    lines: [shown(island?.querySelector(".island-head")), shown(island?.querySelector(".island-line"))],
    label: island?.getAttribute("aria-label") ?? "",
    unread: island?.querySelector(".island-unread")?.textContent ?? null,
    timeOutside: /(\d+|<1)\s*(m|h|d|分|时|天)\b/.test(outside),
  };
}));

async function run({ width, height, theme, motion }) {
  const phone = width < 600;
  const tag = `${width}-${theme}${motion ? "-motion" : ""}`;
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: motion ? "no-preference" : "reduce", colorScheme: theme });
  await context.addInitScript((theme) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list" }));
    localStorage.setItem("yuzuno.language", JSON.stringify({ language: "en" }));
  }, theme);
  await context.route("**/*", route);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${tag}: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && report.errors.push(`${tag} console: ${message.text()}`));
  try {
    await page.goto(`https://${HOST}/`);
    const list = page.locator(".agent-list");
    await list.locator('article[data-agent-id="dev5"]').waitFor({ timeout: 15_000 });
    await list.locator('article[data-agent-id="yn26"] .executor-pr-chip').waitFor({ state: "attached", timeout: 10_000 });
    const seen = await rows(page);
    assert.deepEqual(seen.map((r) => r.id).sort(), Object.keys(EXPECTED).sort(), `${tag}: every Agent listed`);
    for (const r of seen) {
      assert.equal(r.avatar, false, `${tag}: ${r.id} has no avatar`);
      assert.ok(r.centred && r.rightEnd, `${tag}: ${r.id}'s island is at the row's right end, centred on its lines`);
      assert.equal(r.chipsOutside, false, `${tag}: ${r.id}'s template and PR are in its island`);
      // Line two is only the summary: a row without one (Dev 5, Dev 9, the queued one) is one line.
      assert.equal(r.lineTwo, LINE_TWO.includes(r.id), `${tag}: ${r.id} ${LINE_TWO.includes(r.id) ? "has" : "has no"} line two`);
      assert.deepEqual([r.state, r.form], EXPECTED[r.id], `${tag}: ${r.id}'s state and form`);
      assert.equal(r.timeOutside, false, `${tag}: ${r.id} writes no time outside its island`);
      if (r.form === "ring") {
        assert.ok(r.height <= 24, `${tag}: ${r.id}'s ring is ${r.height}px tall`);
        if (["idle", "done", "offline", "archived"].includes(r.state)) assert.ok(r.width <= 24, `${tag}: ${r.id}'s calm ring is ${r.width}px wide`);
      } else {
        assert.deepEqual(r.lines, [true, true], `${tag}: ${r.id} shows two lines`);
        assert.ok(r.height >= 36, `${tag}: ${r.id}'s two lines are ${r.height}px tall`);
      }
    }
    assert.deepEqual(SIX.filter((s) => !seen.some((r) => r.state === s)), [], `${tag}: the six states are all on screen`);
    assert.equal(seen.find((r) => r.id === "dev9").unread, "3", `${tag}: Dev 9's three unread on its ring`);
    assert.match(seen.find((r) => r.id === "yn21").label, /Needs you · waiting 12m · Approve the design note/, `${tag}: the wait is the island's`);
    assert.match(seen.find((r) => r.id === "yn24").label, /Working · for 1h12m · handed in #681; on the next slice/, `${tag}: handed in, on its next slice`);
    assert.deepEqual(["yn24", "yn26"].map((id) => seen.find((r) => r.id === id).pr), ["#681", "#688"], `${tag}: each PR is in its island`);
    // Chips show whole or not at all; a phone's full-width list has room for them.
    report.chips = { ...(report.chips ?? {}), [tag]: Object.fromEntries(seen.filter((r) => r.pr !== null || r.chipsShown.length).map((r) => [r.id, r.chipsShown])) };
    if (phone) assert.deepEqual(["yn24", "yn26"].map((id) => seen.find((r) => r.id === id).chipsShown), [["#681"], ["#688", "Design first"]], `${tag}: the chips show on a phone`);
    await shot(list, `${tag}-1-list`);
    check(`${tag}: no avatar; each island at line two's end; six states; ring ≤ 24 px; needs you and failed in two lines`);

    // The card, in the row's place: handed in leads with its result.
    const row = list.locator('article[data-agent-id="yn26"]');
    await row.locator(".agent-island").click();
    const card = row.locator(".agent-island-card");
    await card.waitFor({ timeout: 5_000 });
    if (motion) {
      const moving = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".agent-list")).map((a) => a.effect.target.className));
      assert.ok(moving.some((c) => String(c).includes("island-cover")), `${tag}: the ring slides to the card's cover (${moving.join(", ")})`);
    } else {
      assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.(".agent-list")).length), 0, `${tag}: under reduced motion nothing in the list animates`);
      const dot = await list.locator('article[data-agent-id="lead"] .island-dot').evaluate((el) => getComputedStyle(el, "::before").animationName);
      assert.equal(dot, "none", `${tag}: Working's dot stands still`);
    }
    const inRow = await row.evaluate((r) => {
      const a = r.getBoundingClientRect(), c = r.querySelector(".agent-island-card").getBoundingClientRect();
      return c.top >= a.top - 1 && c.bottom <= a.bottom + 1 && c.left >= a.left - 1 && c.right <= a.right + 1;
    });
    assert.ok(inRow, `${tag}: the card opens inside its row`);
    assert.deepEqual(await card.locator(".island-actions button").allTextContents(), ["See result", "Open"]);
    await page.waitForTimeout(400);
    await shot(phone ? page : list, `${tag}-2-card-handed`);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "See result", `${tag}: opening it moves focus to its first action`);
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached", timeout: 5_000 });
    assert.equal(await row.locator(".agent-island").getAttribute("data-form"), "ring", `${tag}: Escape folds it back`);
    // Needs you leads with Home.
    const waiting = list.locator('article[data-agent-id="yn21"]');
    await waiting.locator(".agent-island").click();
    await waiting.locator(".agent-island-card").waitFor({ timeout: 5_000 });
    assert.deepEqual(await waiting.locator(".island-actions button").allTextContents(), ["Answer on Home", "Open", "Task"]);
    // Opened near the list's end, its actions are scrolled into view.
    const inView = await waiting.locator(".island-actions").evaluate((el) => {
      let box = el.parentElement;
      while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
      const a = el.getBoundingClientRect(), b = (box ?? document.documentElement).getBoundingClientRect();
      return a.top >= Math.max(0, b.top) - 1 && a.bottom <= Math.min(innerHeight, b.bottom) + 1;
    });
    assert.ok(inView, `${tag}: the card's actions are in view`);
    await page.waitForTimeout(400);
    await shot(phone ? page : list, `${tag}-3-card-needs-you`);
    check(`${tag}: the island's card opens in its row and leads with what the state asks for; Escape closes it`);
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
