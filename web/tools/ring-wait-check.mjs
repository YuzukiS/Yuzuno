// YN-51 (the user's choices on Home, design/yn51-ring-wait): a turning ring
// holds one icon for what its Agent waits on. The Agent rows in Chromium,
// every API answered here (no Core, no CLI, no daily configuration),
// synthetic Agents. At 1440 (the rail at 240 px) and 390 (a phone, touch),
// light and dark, Chinese and English:
// - each row shows the wait expected of it, by the user's order (review >
//   CI > Job > sub-agent > shell), and only a working ring holds one: a
//   needs-you row whose CI runs, a thinking row and an idle row hold none;
// - a running Turn's call shows only after it has held the Turn a second;
// - the icon is 11 px, centred in the 22 px ring, inside its arc's inner
//   edge, in the ring's colour, and adds nothing to the row's height;
// - its card says which one and names the rest; the row's screen-reader
//   text and the ring's label say it; nothing cut;
// - under reduced motion nothing moves (the icon's fade included); with
//   motion the arc turns and the icon fades in once, then stays still.
// Screenshots for the user, each with its card open on the busiest row.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/ring-wait-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-51 S1b", checks: [], screenshots: [], unexpected: [], writes: [], errors: [], rows: {} };
const check = (name) => {
  report.checks.push({ name });
  console.log(`PASS ${name}`);
};
const HOST = "yuzuno-ring-wait.test";
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
// A Turn that ended and this device has shown: not "done".
const seen = { seq: 1, outcome: "finished", at: ago(30) };
const base = { goal: "", cwd: "/fixture/app", model: "gpt-6", color: "sage", harness: "claude", createdAt: "", updatedAt: ago(1),
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p1", connectionState: "connected", status: "idle", lastTurnEnd: seen };
const standing = (id, name, extra = {}) => ({ ...base, id, name, ...extra });
const executor = (id, shortName, title, extra = {}) => ({
  ...base, id, name: `${id.toUpperCase().replace("YN", "YN-")} · Design first`, kind: "executor", ...extra,
  executor: { state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead" },
    task: { id: id.toUpperCase().replace("YN", "YN-"), title, shortName }, template: { id: "design-first", label: "Design first" },
    dispatchedAt: ago(72.5), since: ago(6.5) },
});
// Synthetic Agents, tasks, PRs and commands (made up for this check).
const agents = [
  standing("lead", "Dev Lead", { kind: "lead", workSummary: { kind: "progress", source: "agent", text: "Releasing PR #214 after its CI" } }),
  standing("research", "Research A", { status: "working", turnWait: { kind: "shell", itemId: "c1", label: "pytest -q tests/test_loader.py" },
    workSummary: { kind: "progress", source: "agent", text: "Running the loader tests" } }),
  standing("bg", "Dev 7", { workSummary: { kind: "result", source: "agent", text: "Dev server left running" } }),
  standing("dev5", "Dev 5", { workSummary: { kind: "result", source: "agent", text: "Merged; waiting for the next task" } }),
  executor("yn12", "导出设置", "The export settings save bar"),
  executor("yn51", "环内显示在等什么", "The rail's ring shows what it waits on", { status: "working",
    turnWait: { kind: "subAgent", itemId: "a1", label: "Find the rail's data sources" } }),
  executor("yn30", "夜间回归测试", "The nightly regression's time budget"),
  executor("yn44", "首页两列布局", "Home in two columns on wide screens", { status: "working" }),
  executor("yn26", "合并队列", "The merge queue's pause notice", { status: "waiting", pendingCount: 1,
    workSummary: { kind: "pending", source: "runtime", text: "Approve the design note", requestId: "q1" } }),
];
const pr = (number, running) => ({ number, url: `https://github.com/owner/repo/pull/${number}`, state: "open", headSha: "a".repeat(40), ci: "pending",
  reviews: { approved: 0, changesRequested: false, running } });
const reads = {
  "/api/jobs/live": { agents: { yn12: { active: 1, unknown: 0, name: "web-tests" }, yn30: { active: 1, unknown: 0, name: "core-lib-tests" },
    yn26: { active: 1, unknown: 0, name: "lint" } } },
  "/api/ci/live": { agents: { lead: { running: 1, discovering: 0, check: 0 }, yn12: { running: 1, discovering: 0, check: 0 },
    yn26: { running: 1, discovering: 0, check: 0 } } },
  "/api/waits/live": { agents: { lead: { reviews: { running: 1, pr: 214, round: 1 } }, yn12: { reviews: { running: 1, pr: 231, round: 2 } },
    bg: { shells: 2 } } },
  "/api/executors/live": { executors: { yn12: { pr: pr(231, true) } } },
};
// Each row: the wait its ring shows (null: none), its card's line, and the "also" line.
const EXPECTED = {
  lead: ["review", ["在等审查：PR #214 第 1 轮", "Waiting on a review: PR #214, round 1"], ["另有：CI", "Also: CI"]],
  research: ["shell", ["在等 shell：pytest -q tests/test_loader.py", "Waiting on a shell command: pytest -q tests/test_loader.py"], null],
  bg: ["shell", ["在等 2 个后台 shell", "Waiting on 2 background shells"], null],
  dev5: [null, null, null],
  yn12: ["review", ["在等审查：PR #231 第 2 轮", "Waiting on a review: PR #231, round 2"], ["另有：CI、1 个 Job", "Also: CI, 1 Job"]],
  yn51: ["subAgent", ["在等子代理：Find the rail's data sources", "Waiting on a sub-agent: Find the rail's data sources"], null],
  yn30: ["job", ["在等 Job：core-lib-tests", "Waiting on a Job: core-lib-tests"], null],
  yn44: [null, null, null],
  yn26: [null, null, null],
};
const SHORT = { review: ["在等审查", "Waiting on a review"], shell: ["在等 shell", "Waiting on a shell command"], subAgent: ["在等子代理", "Waiting on a sub-agent"],
  job: ["在等 Job", "Waiting on a Job"], ci: ["在等 CI", "Waiting on CI"] };
const yuzuno = { id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture/app" }, createdAt: "", updatedAt: "" };
const home = () => ({ generatedAt: ago(0), order: ["p1"], needsYou: [], projects: [{ project: { id: "p1", name: "Yuzuno" },
  agents: { working: 6, idle: 2, waiting: 1, error: 0, offline: 0, total: 9 }, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 1, history: [], sections: [] } }] });
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
    "/api/workspace": { workspace: { id: "ws-ring-wait" }, agents, projects: [yuzuno], runtime: { connected: true }, defaultCwd: "/fixture" },
    "/api/home": home(), "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
    "/api/jobs": noJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews, ...reads,
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

// Each row as drawn: its ring, the wait it holds, the icon's box against the
// ring's, how far its drawing reaches from the ring's centre, its colour.
const rows = (page) => page.locator(".agent-list article[data-agent-id]").evaluateAll((list) => list.map((r) => {
  const box = r.querySelector(":scope > .agent-island .island-ringbox");
  const icon = box?.querySelector(".island-wait");
  const ring = box?.getBoundingClientRect();
  const b = icon?.getBoundingClientRect();
  let reach = null;
  if (icon) {
    const scale = b.width / 24;
    const stroke = parseFloat(icon.getAttribute("stroke-width")) * scale;
    let max = 0;
    for (const el of icon.querySelectorAll("path,rect,circle,line")) {
      const len = el.getTotalLength();
      for (let i = 0; i <= 300; i++) {
        const p = el.getPointAtLength((len * i) / 300);
        max = Math.max(max, Math.hypot(p.x - 12, p.y - 12));
      }
    }
    reach = +(max * scale + stroke / 2).toFixed(2);
  }
  const one = r.querySelector(":scope > .agent-row-top .agent-line-one");
  const two = r.querySelector(":scope > .agent-row-meta, :scope > .agent-row-state");
  const cut = (el) => !!el && (el.scrollWidth > el.clientWidth + 1);
  return {
    id: r.dataset.agentId, state: r.querySelector(":scope > .agent-island")?.dataset.state, wait: box?.dataset.wait ?? null,
    icons: box?.querySelectorAll(".island-wait").length ?? 0, ring: ring ? [ring.width, ring.height] : null,
    icon: b ? [+b.width.toFixed(2), +b.height.toFixed(2)] : null,
    centre: b ? [+(b.left + b.width / 2 - (ring.left + ring.width / 2)).toFixed(2), +(b.top + b.height / 2 - (ring.top + ring.height / 2)).toFixed(2)] : null,
    reach, colour: icon ? getComputedStyle(icon).color === getComputedStyle(box).color : null,
    animation: icon ? getComputedStyle(icon).animationName : null,
    said: r.querySelector(".agent-select")?.getAttribute("aria-description") ?? "",
    label: r.querySelector(":scope > button.agent-island")?.getAttribute("aria-label") ?? null,
    height: r.getBoundingClientRect().height,
    cut: cut(one) || cut(two),
  };
}));
// The arc's inner edge, from the ring's centre, in a 22 px ring (agent-island.css: r 9.5, arc 2.4, in 24).
const INNER = 9.5 * 22 / 24 - (2.4 * 22 / 24) / 2;

async function run({ width, height, theme, lang, motion = false }) {
  const phone = width < 600;
  const tag = `${phone ? "390-phone" : "1440-240"}-${theme}-${lang}${motion ? "-motion" : ""}`;
  const i = lang === "zh" ? 0 : 1;
  const context = await browser.newContext({ viewport: { width, height }, locale: lang === "zh" ? "zh-CN" : "en-US", timezoneId: "Asia/Shanghai",
    reducedMotion: motion ? "no-preference" : "reduce", colorScheme: theme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  await context.addInitScript(({ theme, lang }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, agentOrder: "list", agentList: "detailed", projectGroups: "headers" }));
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
    const loaded = Date.now();
    await page.goto(`https://${HOST}/`, { waitUntil: "load" });
    await rowOf("yn26").waitFor({ timeout: 15_000 });
    // What Agents left running, from the live reads.
    await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn12"] .island-ringbox[data-wait="review"]'), null, { timeout: 10_000 });
    // A Turn's call waits its second: not yet, then shown.
    const early = await rowOf("research").locator(".island-ringbox").getAttribute("data-wait");
    if (Date.now() - loaded < 900) assert.equal(early, null, `${tag}: a Turn's call shows only after a second`);
    await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="research"] .island-ringbox[data-wait="shell"]'), null, { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelector('.agent-list article[data-agent-id="yn51"] .island-ringbox[data-wait="subAgent"]'), null, { timeout: 5_000 });
    await page.mouse.move(0, 0);
    if (motion) await page.waitForTimeout(250);
    const all = await rows(page);
    const seenRows = Object.fromEntries(all.map((r) => [r.id, r]));
    report.rows[tag] = seenRows;
    for (const [id, [wait]] of Object.entries(EXPECTED)) {
      const r = seenRows[id];
      assert.ok(r, `${tag}: ${id} listed`);
      assert.equal(r.wait, wait, `${tag}: ${id} waits on ${wait}`);
      assert.equal(r.icons, wait ? 1 : 0, `${tag}: ${id} holds ${wait ? "one icon" : "none"}`);
      assert.ok(!r.cut, `${tag}: ${id}'s words are not cut`);
      if (!wait) {
        assert.doesNotMatch(r.said, /在等审查|在等 CI|在等 Job|在等子代理|在等 shell|Waiting on/, `${tag}: ${id} says no wait`);
        continue;
      }
      assert.equal(r.state, "working", `${tag}: ${id}'s icon is in a working ring`);
      assert.deepEqual(r.ring, [22, 22], `${tag}: ${id}'s ring is 22 px`);
      assert.deepEqual(r.icon, [11, 11], `${tag}: ${id}'s icon is 11 px`);
      assert.ok(Math.abs(r.centre[0]) < 0.05 && Math.abs(r.centre[1]) < 0.05, `${tag}: ${id}'s icon is centred: ${r.centre}`);
      assert.ok(r.reach <= INNER, `${tag}: ${id}'s icon reaches ${r.reach} px, the arc's inner edge is ${INNER.toFixed(2)}`);
      assert.equal(r.colour, true, `${tag}: ${id}'s icon is in the ring's colour`);
      assert.equal(r.animation, motion ? "island-wait-in" : "none", `${tag}: ${id}'s icon ${motion ? "fades in" : "does not move"}`);
      assert.ok(r.said.includes(SHORT[wait][i]), `${tag}: ${id}'s row says ${SHORT[wait][i]}: ${r.said}`);
      if (r.label != null) assert.ok(r.label.includes(SHORT[wait][i]), `${tag}: ${id}'s ring says it: ${r.label}`);
    }
    // The icon adds nothing to a row's height.
    const heights = await page.evaluate(() => [...document.querySelectorAll(".agent-list .island-wait")].map((icon) => {
      const row = icon.closest("article");
      const before = row.getBoundingClientRect().height;
      const parent = icon.parentNode, next = icon.nextSibling;
      icon.remove();
      const after = row.getBoundingClientRect().height;
      parent.insertBefore(icon, next);
      return [row.dataset.agentId, before, after];
    }));
    for (const [id, before, after] of heights) assert.equal(before, after, `${tag}: ${id}'s icon takes no height`);
    // The arc turns under motion; nothing turns under reduced motion.
    const spin = await page.evaluate(() => getComputedStyle(document.querySelector('.agent-list article[data-agent-id="yn12"] .r-spin')).animationName);
    assert.equal(spin, motion ? "island-turn" : "none", `${tag}: the arc ${motion ? "turns" : "rests"}`);
    // Each card says which one, and the rest.
    for (const [id, [wait, line, also]] of Object.entries(EXPECTED)) {
      await page.keyboard.press("Tab");
      await rowOf(id).locator(".agent-select").focus();
      const tip = page.locator('.tip.agent-card[role="tooltip"]:not([data-state="closed"])');
      await tip.waitFor({ timeout: 5_000 });
      const text = (await tip.innerText()).replace(/\s+/g, " ");
      if (wait) {
        assert.ok(text.includes(line[i]), `${tag}: ${id}'s card says "${line[i]}": ${text}`);
        if (also) assert.ok(text.includes(also[i]), `${tag}: ${id}'s card says "${also[i]}": ${text}`);
        else assert.ok(!/另有|Also:/.test(text), `${tag}: ${id}'s card names no other wait`);
        assert.equal(await tip.locator(`.agent-card-wait[data-wait="${wait}"] svg`).count(), 1, `${tag}: ${id}'s card line has its icon`);
      } else {
        assert.equal(await tip.locator(".agent-card-wait").count(), 0, `${tag}: ${id}'s card has no wait line`);
      }
      await page.locator("body").focus();
      await rowOf(id).locator(".agent-select").evaluate((el) => el.blur());
      await tip.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    }
    check(`${tag}: each row waits on what it should, one icon in a working ring, 11 px, centred, inside its arc, its colour, no height; its card and its words say it`);
    // Screenshots: the list, and the list with the busiest row's card open.
    const shot = async (name, el) => {
      await el.screenshot({ path: join(output, name), animations: "disabled" });
      report.screenshots.push(name);
    };
    await page.mouse.move(0, 0);
    await shot(`${tag}-list.png`, list);
    await page.keyboard.press("Tab");
    await rowOf("yn12").locator(".agent-select").focus();
    await page.locator('.tip.agent-card[role="tooltip"]:not([data-state="closed"])').waitFor({ timeout: 5_000 });
    const card = await page.locator('.tip.agent-card[role="tooltip"]:not([data-state="closed"])').boundingBox();
    const listBox = await list.boundingBox();
    const x = Math.max(0, Math.min(card.x, listBox.x) - 8), y = Math.max(0, Math.min(card.y, listBox.y) - 8);
    await page.screenshot({ path: join(output, `${tag}-card.png`), animations: "disabled",
      clip: { x, y, width: Math.max(card.x + card.width, listBox.x + listBox.width) - x + 8, height: Math.max(card.y + card.height, listBox.y + listBox.height) - y + 8 } });
    report.screenshots.push(`${tag}-card.png`);
  } finally {
    await context.close();
  }
}

try {
  for (const theme of ["light", "dark"]) for (const lang of ["zh", "en"]) await run({ width: 1440, height: 900, theme, lang });
  await run({ width: 390, height: 844, theme: "light", lang: "zh" });
  await run({ width: 390, height: 844, theme: "dark", lang: "en" });
  await run({ width: 1440, height: 900, theme: "light", lang: "zh", motion: true });
  assert.deepEqual(report.errors, [], "no page errors");
  assert.deepEqual(report.unexpected, [], "no request left the fixture");
  assert.deepEqual(report.writes, [], "nothing written");
  check("no page errors, no request left the fixture, nothing written");
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = String(error?.stack || error);
  console.log(`FAIL ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
}
