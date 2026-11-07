// T-42: who needs you, in Chromium, with every API answered here (no Core, no
// daily configuration). Through the production build, on a desktop window and
// a phone, each with motion as usual and reduced:
//  - the rail in attention order (Appearance's Agent order): waiting on you,
//    failed and then finished Turn ends unseen here, working; their labels;
//  - the tab title "(N) …" and the app badge N, the count Home's tab shows,
//    an open async question among them;
//  - Home's Needs you lists the question and what else waits for the user's
//    decision, never a Turn end not seen here (YN-3);
//  - Ctrl+J reaches the page, which takes it (defaultPrevented), and next
//    needs you goes through Needs you in Core's order across Projects, and
//    round again, never to a Turn end unseen; on a phone, by the rail's button;
//  - a Turn end shown from the Agent list is seen on this device only (localStorage);
//  - nothing is sent to Core but reads, read receipts and reading positions.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/attention-check.mjs
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
const report = { task: "T-42", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "yuzuno-attention.test";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { harness: "codex", model: "gpt-6", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle" };
const ended = (seq, outcome) => ({ lastTurnEnd: { seq, outcome, at: at(4) } });
// In the list's own order: Mori, Hana, Sora, Kiri. Mori's and Hana's Turns
// ended after their conversations were last read (reviewedSeq).
const agents = [
  { ...base, id: "a", name: "Mori", cwd: "/w/app", projectId: "p-app", status: "error", ...ended(30, "failed"), reviewedSeq: 25 },
  { ...base, id: "b", name: "Hana", cwd: "/w/app", projectId: "p-app", ...ended(20, "finished"), reviewedSeq: 12 },
  // A request and a question sent to be answered later.
  { ...base, id: "c", name: "Sora", cwd: "/w/res", projectId: "p-res", status: "waiting", pendingCount: 2, openQuestions: 1 },
  { ...base, id: "d", name: "Kiri", cwd: "/w/res", projectId: "p-res", status: "working" },
];
const projects = [
  { id: "p-app", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" },
  { id: "p-res", name: "Research", defaultDirs: {}, createdAt: "", updatedAt: "" },
];
const body = (text) => ({ root: "body", elements: { body: { type: "BriefBody", props: {}, children: ["text"] }, text: { type: "Markdown", props: { text } } } });
const counts = (working, idle) => ({ working, idle, waiting: 0, error: 0, offline: 0, total: working + idle });
const panel = (id, name, sections) => ({ project: { id, name }, agents: counts(0, 2), errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 3, history: [], sections } });
const home = () => ({
  generatedAt: at(0),
  // Research first in Project Priority: Core orders Needs you so.
  order: ["p-res", "p-app"],
  needsYou: [
    { kind: "approval", projectId: "p-res", agentId: "c", agentName: "Sora", requestId: "r-1", title: "Run the test suite", since: at(10) },
    { kind: "question", projectId: "p-res", agentId: "c", agentName: "Sora", turnId: "t3", itemId: "q1", title: "Which seed?", since: at(8) },
    { kind: "ask", projectId: "p-app", agentId: "a", agentName: "Mori", sectionKey: "release", title: "Ship today?", since: at(30) },
  ],
  projects: [
    panel("p-res", "Research", []),
    panel("p-app", "App", [{
      key: "release", kind: "ask", title: "Ship today?", version: 3, owner: { agentId: "a", name: "Mori", state: "active" }, updatedAt: at(5),
      updatedTurnId: "t1", body: body("Ship today?"), attachments: [], refs: {}, seen: null, history: false,
      ask: { question: "Ship the release today?", state: "open", reply: { options: [{ id: "ship", label: "Ship today" }], freeText: true } },
    }]),
  ],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [
  { name: "desktop", reducedMotion: "no-preference", viewport: { width: 1280, height: 900 } },
  { name: "desktop-reduced", reducedMotion: "reduce", viewport: { width: 1280, height: 900 } },
  { name: "phone", reducedMotion: "no-preference", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: "phone-reduced", reducedMotion: "reduce", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "attention-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
console.log(`attention-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const { name: _name, ...options } = run;
  const context = await browser.newContext({ ...options, locale: "en-US", timezoneId: "UTC" });
  await context.addInitScript(() => {
    window.EventSource = class { close() {} };
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    // The app badge, where a browser has one; this one records it.
    window.__badges = [];
    navigator.setAppBadge = async (count) => window.__badges.push(count);
    navigator.clearAppBadge = async () => window.__badges.push(0);
    // Whether the page took Ctrl+J (read after the event's dispatch).
    window.__taken = [];
    window.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "j" && event.ctrlKey) setTimeout(() => window.__taken.push(event.defaultPrevented));
    });
    if (!localStorage.getItem("yuzuno.appearance")) {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ agentOrder: "attention", projectGroups: "none" }));
      // The window opens on Kiri, whose Turn hasn't ended: nothing is seen first.
      localStorage.setItem("yuzuno.selected.ws-attention", JSON.stringify("d"));
    }
  });
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method !== "GET") {
      report.posts.push({ run: run.name, method, path });
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) {
      const agent = agents.find((a) => a.id === detail[1]);
      return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    }
    const json = {
      "/api/workspace": { workspace: { id: "ws-attention" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": home(),
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
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const phone = !!run.isMobile;
  const rail = () => page.locator(".agent-list .agent-row");
  const ids = () => rail().evaluateAll((rows) => rows.map((row) => row.dataset.agentId));
  // The row's status words, kept on its island (T-43 v4-2).
  const label = (id) => page.locator(`.agent-row[data-agent-id="${id}"] .agent-island`).getAttribute("data-status");
  const title = () => page.locator(".conversation-title h1").textContent();
  const settled = () => page.waitForTimeout(300);
  // Home by its toolbar button; on a phone, from the list's way back first.
  const openHome = async () => {
    await page.getByRole("button", { name: /^Home/ }).first().click();
    await page.locator(".home-view").waitFor({ timeout: 10_000 });
  };
  const toList = async () => {
    if (!phone) return;
    if (await page.locator(".agent-list").isVisible()) return;
    await page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first().click();
    await page.locator(".agent-list").waitFor({ timeout: 10_000 });
  };
  const next = async () => {
    if (phone) {
      await toList();
      await page.locator(".next-needs-you").click();
    } else {
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press("Control+j");
    }
    await settled();
  };
  try {
    await page.goto(`https://${HOST}/`);
    await page.locator('.agent-row[data-agent-id="a"]').waitFor({ timeout: 10_000 });
    await toList();

    // ---- The rail in attention order, and its labels.
    assert.deepEqual(await ids(), ["c", "a", "b", "d"]);
    assert.equal(await label("a"), "Failed · unseen");
    assert.equal(await label("b"), "Finished · unseen");
    assert.match(await page.locator('.agent-row[data-agent-id="c"]').textContent(), /2 needs you/);
    // An unseen label takes its own line, so the name beside the avatar is whole.
    for (const id of ["a", "b"]) {
      const name = await page.locator(`.agent-row[data-agent-id="${id}"] .agent-name`).evaluate((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 }));
      assert.equal(name.clipped, false, `${id}'s name is whole: ${JSON.stringify(name)}`);
    }
    pass("the rail in attention order: Sora waiting on you, Mori's failed and Hana's finished Turn unseen, Kiri working");

    // ---- Title and badge: Sora's request and question, and Mori's Ask.
    await page.waitForFunction(() => document.title.startsWith("(3) "), null, { timeout: 10_000 });
    const pageTitle = await page.title();
    const badges = await page.evaluate(() => window.__badges);
    assert.equal(badges.at(-1), 3);
    pass("the tab title and app badge count 3, an open question among them", { title: pageTitle, badge: badges.at(-1) });

    // ---- Home's Needs you: what waits for the user's decision, no Turn end unseen (YN-3).
    await openHome();
    await page.locator('[data-needs-you="question:c:t3:q1"]').waitFor({ timeout: 10_000 });
    const listed = await page.locator(".home-needs-you [data-needs-you]").evaluateAll((items) => items.map((i) => i.dataset.needsYou));
    assert.deepEqual(listed, ["approval:r-1", "question:c:t3:q1", "ask:p-app:release"]);
    const unseen = (outcome) => page.locator(`.home-needs-you [data-unseen="${outcome}"]`).evaluateAll((items) => items.map((i) => i.dataset.unseenAgent));
    // One row however many: Needs you's card holds every item, none drawn over the cards around it.
    const card = await page.locator(".home-needs-you").boundingBox();
    const boxes = await page.locator(".home-needs-you .home-needs-item").evaluateAll((items) => items.map((i) => i.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    for (const box of boxes) assert.ok(box.top >= card.y - 1 && box.bottom <= card.y + card.height + 1, `an item inside Needs you's card: ${JSON.stringify({ card, box })}`);
    assert.deepEqual(await unseen("failed"), []);
    assert.deepEqual(await unseen("finished"), []);
    await page.screenshot({ path: join(output, `${run.name}-home.png`) });
    pass("Home's Needs you lists the question and what else waits for the user's decision, no Turn end not seen here");

    // ---- Next needs you, from Home: Needs you in Core's order, and round again.
    await next();
    assert.equal(await title(), "Sora");
    if (!phone) {
      const taken = await page.evaluate(() => window.__taken);
      assert.deepEqual(taken, [true], "the page received Ctrl+J and took it");
    }
    await next();
    await page.locator(".home-view").waitFor({ timeout: 10_000 });
    await page.locator("#home-section-p-app-release").waitFor({ timeout: 10_000 });
    await next();
    assert.equal(await title(), "Sora", "and round again");
    await page.screenshot({ path: join(output, `${run.name}-conversation.png`) });
    pass(`next needs you: Sora (Research's request and question), Mori's Ask on Home, then Sora again${phone ? ", by the rail's button" : ", by Ctrl+J, which the page took"}`);

    // ---- Shown from the Agent list as long as reading marks it read (1.2 s), a Turn end is seen on this device.
    for (const [id, seen] of [["a", '{"a":30}'], ["b", '{"a":30,"b":20}']]) {
      await toList();
      await page.locator(`.agent-row[data-agent-id="${id}"] .agent-select`).click();
      await page.waitForFunction((value) => localStorage.getItem("yuzuno.turnSeen.ws-attention") === value, seen, { timeout: 10_000 });
    }

    // ---- Seen on this device: the labels say so; another device's storage is its own.
    await toList();
    assert.equal(await label("a"), "Needs a look");
    assert.equal(await label("b"), "Ready");
    assert.deepEqual(await ids(), ["c", "d", "a", "b"], "seen, they are no longer first");
    assert.equal(await page.evaluate(() => localStorage.getItem("yuzuno.turnSeen.ws-attention")), '{"a":30,"b":20}');
    await page.screenshot({ path: join(output, `${run.name}-rail.png`) });
    pass("shown here, the Turn ends are seen on this device and the rail reorders");
  } finally {
    await context.close();
  }
}
