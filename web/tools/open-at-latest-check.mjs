// T-170: a phone opens a conversation at its latest message, and says so
// truthfully. In Chromium (or Playwright's Linux WebKit, see
// browser-engine.mjs), on a production build with every API answered here
// (no Core), synthetic content only: Mori with 1408 Turns sent a window at a
// time, as Core sends them, and Hana with a few.
// The page loads with Mori selected and the phone showing its Agent list,
// Mori's conversation drawn behind it; Mori is opened from the list as soon
// as its row can be pressed. The order the two first answers arrive in is
// set: Mori's conversation before the Workspace that draws it (the order
// that left it at the top of its window, with no Back to latest), and after.
// Each order three times, upright (320×640) and sideways (844×390):
// - opened, it is at its latest, and Back to latest is not shown;
// then once per order:
// - read further up: Back to latest shows; turned, or with the on-screen
//   keyboard up (set as keyboard-viewport.ts sets it), it is not pulled to
//   the end;
// - back to the list and Mori again (the same conversation): it keeps its
//   place, its draft and Back to latest;
// - Hana, then Mori again: its place (T-166) and its draft;
// - Back to latest takes it to the end; there, turned and with the keyboard
//   up, it stays at the end.
// An emulated phone is not a real one: no on-screen keyboard, iOS Safari or
// real Core.
//   YUZUNO_UI_DIST=<isolated build> node tools/open-at-latest-check.mjs [--baseline]
// --baseline only measures and takes the screenshots (a build from before).
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/open-at-latest");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", runs: [], orders: [], checks: [], errors: [], unexpected: [], mutations: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const seconds = (minutesAgo) => Math.floor((now - minutesAgo * 60_000) / 1000);
const base = { color: "sage", createdAt: at(9000), updatedAt: at(1), unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, goal: "", cwd: "/fixture", model: "gpt-6", projectId: "p1", status: "idle", harness: "codex", connectionState: "connected" };
const agents = [{ ...base, id: "a", name: "Mori", threadId: "thread-a" }, { ...base, id: "b", name: "Hana", threadId: "thread-b" }];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/fixture" }, createdAt: at(9000), updatedAt: at(9000) }];
const longReply = "手机上打开这个对话时，它应该停在最新的消息，而不是窗口的开头。".repeat(8);
const turns = (who, count) => Array.from({ length: count }, (_, n) => ({
  id: `${who}-t${n}`, status: "completed", startedAt: seconds(count - n + 2), completedAt: seconds(count - n + 1),
  items: [
    { id: `${who}-u${n}`, type: "userMessage", content: [{ type: "text", text: `${who} step ${n + 1}: check the next part.` }] },
    { id: `${who}-r${n}`, type: "agentMessage", text: n === count - 1 ? longReply : `${who} reply ${n + 1}. ${"Some more text so a Turn has a little height. ".repeat(n % 3 + 1)}` },
  ],
}));
const allTurns = { a: turns("Mori", 1408), b: turns("Hana", 6) };
// As Core sends a long conversation: a window of Turns, the latest unless a
// Turn or a page before or after a cursor is asked for, and an index of all.
const WINDOW = 12;
const detail = (agent, query) => {
  const all = allTurns[agent.id];
  const cursor = (name) => all.findIndex((t) => t.id === JSON.parse(query.get(name))[0]);
  const start = query.has("turnId") ? Math.max(0, all.findIndex((t) => t.id === query.get("turnId")))
    : query.has("before") ? Math.max(0, cursor("before") - WINDOW)
    : query.has("after") ? Math.min(all.length - 1, cursor("after") + 1)
    : Math.max(0, all.length - WINDOW);
  const shown = all.slice(start, start + WINDOW);
  return {
    agent, pending: [], messageReceipts: [], artifacts: [], turns: shown,
    conversation: {
      index: all.map((t, i) => ({ ...t, number: i + 1, itemCount: t.items.length, items: [t.items[0]] })),
      questions: [], nativeClientIds: [],
      start: JSON.stringify([shown[0].id, shown[0].items[0].id]), end: JSON.stringify([shown.at(-1).id, shown.at(-1).items.at(-1).id]),
      hasBefore: start > 0, hasAfter: start + WINDOW < all.length, totalItems: all.reduce((sum, t) => sum + t.items.length, 0),
    },
  };
};

const browser = await launchBrowser();
/** A phone page; `order` holds back one of the two first answers until the
 * other has gone, 200 ms more (3 s at most), and records the order they went
 * in. */
async function open(viewport, order, name) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
  let releaseFirst;
  const first = new Promise((done) => { releaseFirst = done; });
  const held = order === "detail-first" ? "/api/workspace" : "/api/agents/a";
  const leader = order === "detail-first" ? "/api/agents/a" : "/api/workspace";
  let heldOnce = false;
  const answered = [];
  report.orders.push({ run: name, order, answered });
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
    assert.equal(url.hostname, "yuzuno-latest.test");
    const path = url.pathname;
    if (method === "POST" && path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method === "POST" && /^\/api\/agents\/[ab]\/review$/.test(path)) return route.fulfill({ json: {} });
    if (/^\/api\/agents\/[ab]\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (method !== "GET") {
      report.mutations.push({ run: name, method, path });
      return route.fulfill({ status: 400, json: { error: `Unexpected ${method} ${path} in this check` } });
    }
    if (path === held && !heldOnce) {
      heldOnce = true;
      await Promise.race([first, new Promise((done) => setTimeout(done, 3000))]);
      await new Promise((done) => setTimeout(done, 200));
    }
    const agent = agents.find((a) => path === `/api/agents/${a.id}`);
    const json = agent ? detail(agent, url.searchParams) : {
      "/api/workspace": { workspace: { id: "ws-latest" }, agents, projects, runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/home": { generatedAt: at(0), order: ["p1"], needsYou: [], projects: [] },
      "/api/machines": { machines: [{ id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture", lastCheck: null }] },
      "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) {
      await route.fulfill({ json });
      if (path === leader || path === held) answered.push(path);
      if (path === leader) releaseFirst();
      return;
    }
    if (path.startsWith("/api/")) {
      report.unexpected.push(path);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    await route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" }[extname(file)] });
  });
  await page.goto("http://yuzuno-latest.test/");
  await page.locator(".app").waitFor();
  return { context, page };
}
const composer = (page, who) => page.locator(`[data-composer-input][aria-label="Message ${who}"]`);
/** From the Agent list, as soon as the row can be pressed. */
async function openFromList(page, who) {
  if (!(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
  await page.locator(`.agent-row .agent-select[aria-label="Open ${who}"]`).click();
  await composer(page, who).waitFor();
  await page.locator(".main-panel .conversation-scroll .turn").last().waitFor();
  await page.waitForTimeout(800);
}
/** Where the conversation is: how far from its end, whether Back to latest
 * shows, the Turn at the top of the view and how far its top is from the
 * view's, and the composer's draft. */
const place = (page) => page.evaluate(() => {
  const el = document.querySelector(".main-panel .conversation-scroll");
  const view = el.getBoundingClientRect();
  const top = [...el.querySelectorAll("[data-turn-id]")].find((turn) => turn.getBoundingClientRect().bottom > view.top + 1);
  const latest = document.querySelector(".jump-latest");
  return {
    away: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    backToLatest: !!latest && getComputedStyle(latest).visibility !== "hidden",
    turn: top?.dataset.turnId ?? null,
    offset: top ? Math.round(top.getBoundingClientRect().top - view.top) : null,
    draft: document.querySelector(".main-panel [data-composer-input]")?.innerText.trim() ?? null,
  };
});
const keyboard = (page, height) => page.evaluate((visible) => {
  if (visible === null) {
    document.documentElement.style.removeProperty("--visual-height");
    document.documentElement.removeAttribute("data-keyboard");
  } else {
    document.documentElement.style.setProperty("--visual-height", `${visible}px`);
    document.documentElement.setAttribute("data-keyboard", "");
  }
}, height);
const shot = (page, name) => page.screenshot({ path: resolve(output, `${report.mode}-${name}.png`) });
const draftText = "合成草稿：回到这个对话时它还在。";

const viewports = [{ name: "upright", width: 320, height: 640, turned: { width: 640, height: 320 } }, { name: "sideways", width: 844, height: 390, turned: { width: 390, height: 844 } }];
try {
  for (const viewport of viewports) for (const order of ["detail-first", "workspace-first"]) for (let time = 0; time < 3; time++) {
    const name = `${viewport.name}-${order}-${time}`;
    const { context, page } = await open(viewport, order, name);
    await openFromList(page, "Mori");
    const opened = await place(page);
    await shot(page, `${name}-opened`);
    const run = { name, opened };
    report.runs.push(run);
    console.log(`${name}: opened ${JSON.stringify(opened)}`);
    // The order this load had: the one asked for.
    assert.equal(report.orders.at(-1).answered[0], order === "detail-first" ? "/api/agents/a" : "/api/workspace", `${name}: answered in the order set: ${JSON.stringify(report.orders.at(-1))}`);
    if (!baseline) {
      assert.ok(opened.away <= 2, `${name}: opened at its latest: ${JSON.stringify(opened)}`);
      assert.ok(!opened.backToLatest, `${name}: at its latest, Back to latest is not shown`);
    }
    if (time > 0) {
      await context.close();
      continue;
    }

    // Read further up, with a draft.
    await page.locator(".main-panel .conversation-scroll").evaluate((el) => el.scrollBy(0, -1500));
    await page.waitForTimeout(600);
    await composer(page, "Mori").click();
    await page.keyboard.insertText(draftText);
    await page.waitForTimeout(400);
    run.reading = await place(page);
    // Turned, and with the keyboard up: not pulled to the end.
    await page.setViewportSize(viewport.turned);
    await page.waitForTimeout(600);
    run.turned = await place(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(600);
    await keyboard(page, Math.round(viewport.height * 0.45));
    await page.waitForTimeout(500);
    run.keyboard = await place(page);
    await keyboard(page, null);
    await page.waitForTimeout(500);
    run.afterKeyboard = await place(page);
    // The same conversation again from the list, then Hana and back.
    await openFromList(page, "Mori");
    run.again = await place(page);
    await openFromList(page, "Hana");
    await openFromList(page, "Mori");
    run.returned = await place(page);
    await shot(page, `${name}-returned`);
    // Back to latest, then turned and with the keyboard up there.
    if (run.returned.backToLatest) {
      await page.locator(".jump-latest").click();
      await page.waitForTimeout(800);
    }
    run.latest = await place(page);
    await page.setViewportSize(viewport.turned);
    await page.waitForTimeout(600);
    run.latestTurned = await place(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(600);
    await keyboard(page, Math.round(viewport.height * 0.45));
    await page.waitForTimeout(500);
    run.latestKeyboard = await place(page);
    console.log(`${name}: ${JSON.stringify(run)}`);
    if (!baseline) {
      assert.ok(run.reading.away > 72 && run.reading.backToLatest, `${name}: read further up, Back to latest shows: ${JSON.stringify(run.reading)}`);
      for (const step of ["turned", "keyboard", "afterKeyboard"])
        assert.ok(run[step].away > 72 && run[step].backToLatest, `${name}: ${step}, it is not pulled to the end: ${JSON.stringify(run[step])}`);
      for (const step of ["again", "returned"]) {
        assert.equal(run[step].turn, run.afterKeyboard.turn, `${name}: ${step}, at the same Turn: ${JSON.stringify(run)}`);
        assert.ok(Math.abs(run[step].offset - run.afterKeyboard.offset) <= 8, `${name}: ${step}, where it was: ${JSON.stringify(run)}`);
        assert.ok(run[step].backToLatest, `${name}: ${step}, Back to latest shows`);
        assert.equal(run[step].draft, draftText, `${name}: ${step}, the draft is kept`);
      }
      for (const step of ["latest", "latestTurned", "latestKeyboard"])
        assert.ok(run[step].away <= 2 && !run[step].backToLatest, `${name}: ${step}, at the end: ${JSON.stringify(run[step])}`);
      check(`${name}: read up it keeps its place, turned or with the keyboard; opened again it keeps place and draft; Back to latest goes to the end, which turns and keyboards keep`);
    }
    await context.close();
  }
  if (!baseline) {
    check("every load opened at the latest, Mori's conversation answering before the Workspace and after, upright and sideways", { runs: report.runs.length });
    assert.deepEqual(report.errors, [], "no page errors");
    assert.deepEqual(report.mutations, [], "no write request beyond those allowed above");
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, `${report.mode}-report.json`), JSON.stringify(report, null, 2));
}
console.log(`${report.checks.length} checks, ${report.errors.length} page errors; report in ${output}`);
