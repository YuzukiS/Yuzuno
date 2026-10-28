// T-161: "Load earlier messages" in a real browser layout. The reader is at
// the top of a long saved conversation (T-77 windows); the earlier window is
// put in front of what is being read, and the message at the top of the view
// must stay where it was on screen. The third load is past SAVED_WINDOWS and
// replaces the windows; the same holds, and what was in view stays shown.
// Then Back to latest shows the newest message at the end (T-6). jsdom has no layout, so ui.test.mjs
// cannot show this. Production bundle in an isolated browser with an
// explicit API fixture; no Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/history-load");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], loads: [], earlier: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a", name: "Mori", status: "idle", harness: "codex", cwd: "/fixture", model: "test-model",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
};
// T161_FIXTURE=small: forty short Turns of uneven length, so measured
// heights differ from estimates. big: fourteen long agentic Turns (commands
// with output between commentary), so a window starts inside a Turn and that
// Turn's own rows are windowed too. timed: big, with each Item's time as
// Core records it (15 s apart) and windows cut where the message read first
// loses its minute mark when the messages before it load.
const FIXTURE = process.env.T161_FIXTURE || "small";
const paragraph = (n, p) => `第 ${n} 轮的第 ${p + 1} 段：把检查结果逐条整理，写到足以换行好几次，让每条回复的高度都不一样。`;
const bigTurns = () => Array.from({ length: 14 }, (_, i) => {
  const n = i + 1;
  const work = Array.from({ length: 24 }, (_, k) => k % 3 === 2
    ? { id: `t${n}-x${k}`, type: "commandExecution", command: `rg -n check src/part${k}`, status: "completed",
      aggregatedOutput: Array.from({ length: 2 + ((n + k) % 7) }, (_, l) => `src/part${k}/file${l}.rs:${l + 1}: check ${n}.${k}`).join("\n") }
    : { id: `t${n}-x${k}`, type: "agentMessage", phase: "commentary", text: Array.from({ length: 1 + ((n + k) % 3) }, (_, p) => paragraph(n, p)).join("\n\n") });
  return {
    id: `t${n}`,
    status: "completed",
    items: [
      { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `问题 ${n}：请检查这一部分。` }] },
      ...work,
      { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: 2 + (n % 4) }, (_, p) => paragraph(n, p)).join("\n\n") },
    ],
  };
});
const turns = FIXTURE === "big" || FIXTURE === "timed" ? bigTurns() : Array.from({ length: 40 }, (_, i) => {
  const n = i + 1;
  const paragraphs = 1 + ((n * 7) % 6);
  const code = n % 4 === 0 ? `\n\n\`\`\`\n${Array.from({ length: 4 + (n % 5) }, (_, l) => `line ${l} of turn ${n}`).join("\n")}\n\`\`\`` : "";
  return {
    id: `t${n}`,
    status: "completed",
    items: [
      { id: `t${n}-u`, type: "userMessage", content: [{ type: "text", text: `问题 ${n}：请看一下这一段。` }] },
      { id: `t${n}-r`, type: "agentMessage", phase: "final_answer", text: Array.from({ length: paragraphs }, (_, p) => paragraph(n, p)).join("\n\n") + code },
    ],
  };
});
const all = turns.flatMap((turn) => turn.items.map((item) => JSON.stringify([turn.id, item.id])));
// The nearest message before the Item at `index`: a command has no row of
// its own, it is in its group's.
const messages = new Set(turns.flatMap((turn) => turn.items).filter((item) => ["userMessage", "agentMessage"].includes(item.type)).map((item) => item.id));
const messageBefore = (index) => all.slice(0, Math.max(0, index)).map((key) => JSON.parse(key)[1]).findLast((id) => messages.has(id)) ?? null;
if (FIXTURE === "timed") turns.forEach((turn, t) => turn.items.forEach((item, k) => {
  item._yuzunoTime = { at: Date.UTC(2026, 9, 20, 1 + t) + k * 15_000, source: "core" };
}));
// T161_SIZE: another window size, to cut the conversation at another Item.
const SIZE = Number(process.env.T161_SIZE) || ({ big: 40, timed: 41 }[FIXTURE] ?? 16);
// A window before an Item ends at it; a window from an Item starts at it.
const windowAt = (first) => {
  const from = Math.max(0, Math.min(first, all.length - SIZE));
  const shown = all.slice(from, from + SIZE);
  return {
    agent, pending: [], messageReceipts: [], artifacts: [],
    turns: turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => shown.includes(JSON.stringify([turn.id, item.id]))) }))
      .filter((turn) => turn.items.length),
    conversation: {
      index: turns.map((turn, i) => ({ id: turn.id, status: turn.status, number: i + 1, itemCount: turn.items.length })),
      questions: [], nativeClientIds: [],
      start: shown[0], end: shown.at(-1), hasBefore: from > 0, hasAfter: from + SIZE < all.length, totalItems: all.length,
    },
  };
};
const detailFor = (query) => {
  if (query.has("before")) return windowAt(all.indexOf(query.get("before")) - SIZE + 1);
  if (query.has("after")) return windowAt(all.indexOf(query.get("after")));
  if (query.has("turnId")) return windowAt(all.indexOf(JSON.stringify([query.get("turnId"), query.get("itemId")])));
  return windowAt(all.length - SIZE);
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 18, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-history-load.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/agents/a") {
      // Earlier windows answer a little later, as a read from Core does.
      if (url.searchParams.has("before")) {
        report.earlier.push(url.searchParams.get("before"));
        await new Promise((done) => setTimeout(done, 150));
      }
      return route.fulfill({ json: detailFor(url.searchParams) });
    }
    const json = {
      "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
      "/api/reviews": noReviews,
      "/api/catchup": { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith("/api/")) {
      report.unexpected.push(url.pathname);
      return route.fulfill({ json: {} });
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(dist + "/"));
    return route.fulfill({
      body: await readFile(file),
      contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[extname(file)],
    });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto("http://yuzuno-history-load.test/");
  const pane = page.locator(".conversation-scroll");
  await page.locator(`[data-item-id="${JSON.parse(all.at(-1))[1]}"]`).waitFor({ state: "attached" });
  report.fixture = FIXTURE;

  // Scroll to the very top of what is shown, as a reader reaching the button.
  const button = page.getByRole("button", { name: "Load earlier messages" });
  for (let step = 0; step < 40; step++) {
    await pane.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(50);
    if (await pane.evaluate((el) => el.scrollTop === 0) && await button.isVisible()) break;
  }
  assert.ok(await button.isVisible(), "the button is reached at the top");

  // Where a message's text is: below its minute mark, which can go when the
  // messages before it load. And a frame as it was drawn: a task posted from
  // the frame's callback runs once the frame is drawn, after the page's own
  // callbacks and layout in it.
  await page.addScriptTag({ content: `window.textTop = (item) => ([...item.children].find((child) => !child.classList.contains("message-time")) || item).getBoundingClientRect().top;
window.drawn = (look) => requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = look; channel.port2.postMessage(null); });` });
  // The message at the top of the view, as ReadingAnchor picks it, and where
  // its text is relative to the pane.
  const reading = () => pane.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const visible = [...el.querySelectorAll("[data-item-id]")]
      .map((item) => ({ id: item.dataset.itemId, item, rect: item.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom);
    const first = visible.find(({ rect }) => rect.top >= box.top) || visible[0];
    return first ? { id: first.id, top: Math.round(window.textTop(first.item) - box.top) } : null;
  });
  // Every frame for `ms`: where the anchor is, and what is in front of it.
  const follow = (id, ms) => pane.evaluate((el, [id, ms]) => new Promise((done) => {
    const trace = [];
    const began = performance.now();
    const look = () => {
      const box = el.getBoundingClientRect();
      const item = el.querySelector(`[data-item-id="${id}"]`);
      trace.push({
        t: Math.round(performance.now() - began),
        top: item ? Math.round(window.textTop(item) - box.top) : null,
        scrollTop: Math.round(el.scrollTop),
        loading: [...el.querySelectorAll("button")].some((b) => b.textContent === "Loading history…"),
      });
      if (performance.now() - began < ms) window.drawn(look);
      else done(trace);
    };
    window.drawn(look);
  }), [id, ms]);

  // What lies above the anchor: each element on the path from the pane to it
  // and its earlier siblings, with their boxes (a jump's cause is one that
  // changes height).
  const above = (id) => pane.evaluate((el, id) => {
    const box = el.getBoundingClientRect();
    const target = el.querySelector(`[data-item-id="${id}"]`);
    const out = [];
    for (let node = target; node && node !== el; node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        const r = sibling.getBoundingClientRect();
        if (r.height > 0) out.push({ tag: sibling.tagName.toLowerCase(), cls: String(sibling.className).slice(0, 60), key: sibling.dataset.windowKey || sibling.dataset.itemId || sibling.id || "", top: Math.round(r.top - box.top), h: Math.round(r.height) });
      }
    }
    return out;
  }, id);
  const probe = (id, frames) => pane.evaluate((el, [id, frames]) => new Promise((done) => {
    const shots = [];
    const look = () => {
      const box = el.getBoundingClientRect();
      const target = el.querySelector(`[data-item-id="${id}"]`);
      const parts = [];
      for (let node = target; node && node !== el; node = node.parentElement)
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          const r = sibling.getBoundingClientRect();
          if (r.height > 0) parts.push(`${sibling.tagName.toLowerCase()}.${String(sibling.className).split(" ")[0]}[${sibling.dataset.windowKey || sibling.dataset.itemId || ""}]=${Math.round(r.height)}`);
        }
      const loading = [...el.querySelectorAll("button")].some((b) => b.textContent === "Loading history…");
      shots.push({ top: target ? Math.round(window.textTop(target) - box.top) : null, loading, parts });
      // The last frame before the click, then `frames` frames from it.
      const since = shots.findIndex((shot) => shot.loading);
      if (since >= 0 && shots.length - since >= frames) done(shots.slice(Math.max(0, since - 1)));
      else if (shots.length > 600) done(shots.slice(-frames - 1));
      else window.drawn(look);
    };
    look();
  }), [id, frames]);

  // Every message in view, as the reader sees them.
  const inView = () => pane.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll("[data-item-id]")]
      .filter((item) => { const rect = item.getBoundingClientRect(); return rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom; })
      .map((item) => item.dataset.itemId);
  });
  for (const round of [1, 2, 3]) {
    const before = await reading();
    report.loads.push({ round, aboveBefore: await above(before.id) });
    // The closed groups in view, by their row: holding the place must not
    // open one (a group opened above the reader is what moved it).
    const closedGroups = () => pane.evaluate((el) => [...el.querySelectorAll("details.execution:not([open])")]
      .map((group) => group.closest("[data-window-key]")?.dataset.windowKey).filter(Boolean));
    const closedBefore = await closedGroups();
    const probing = probe(before.id, 4);
    assert.ok(before, `a message is in view before load ${round}`);
    const earlierThan = all.indexOf(JSON.stringify([before.id.split("-")[0], before.id]));
    const shown = await inView();
    const reads = report.earlier.length;
    await button.click();
    report.loads.at(-1).firstFrames = await probing;
    const trace = await follow(before.id, 2500);
    const after = trace.at(-1);
    // Every frame from the click: a frame drawn out of place is a jump too.
    const moved = [...report.loads.at(-1).firstFrames, ...trace].filter((p) => p.top !== null).map((p) => p.top - before.top);
    const load = Object.assign(report.loads.at(-1), { anchor: before.id, before: before.top, after: after.top, maxMove: Math.max(...moved.map(Math.abs)), trace, aboveAfter: await above(before.id) });
    await page.screenshot({ path: resolve(output, `load-${round}.png`) });
    const front = messageBefore(earlierThan);
    assert.ok(!front || await page.locator(`[data-item-id="${front}"]`).count() > 0, `load ${round}: earlier messages are in front: ${front}`);
    assert.ok(after.top !== null && Math.abs(after.top - before.top) <= 2 && load.maxMove <= 2,
      `load ${round}: the message being read stays in place: ${JSON.stringify({ anchor: before.id, before: before.top, after: after.top, maxMove: load.maxMove })}`);
    const opened = await pane.evaluate((el, keys) => keys.filter((key) =>
      el.querySelector(`[data-window-key="${key}"] details.execution[open]`)), closedBefore);
    load.closedGroups = { before: closedBefore.length, opened };
    assert.deepEqual(opened, [], `load ${round}: no group that was closed opens`);
    const gone = await pane.evaluate((el, ids) => ids.filter((id) => !el.querySelector(`[data-item-id="${id}"]`)), shown);
    load.inView = { before: shown, gone };
    assert.deepEqual(gone, [], `load ${round}: what was in view stays shown`);
    // The third replaces the windows: the new one ends at the last message
    // in view, not at the first Item shown.
    if (round === 3) assert.equal(JSON.parse(report.earlier.at(-1))[1], shown.at(-1), "load 3: the windows are replaced by the one ending at the last message in view");
    assert.ok(report.earlier.length > reads, `load ${round}: an earlier window is read`);
    check(`load ${round}: earlier messages go in front and ${before.id} stays where it was`, { before: before.top, after: after.top, maxMove: load.maxMove });
    // Back to the top for the next load.
    for (let step = 0; step < 40; step++) {
      await pane.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(50);
      if (await pane.evaluate((el) => el.scrollTop === 0) && await button.isVisible()) break;
    }
  }
  // Back to latest from the replaced windows (they have newer messages after
  // them): the newest window, shown to its end, and followed again (T-6).
  await page.locator("button.jump-latest").click();
  const newest = JSON.parse(all.at(-1))[1];
  await page.waitForFunction((id) => {
    const el = document.querySelector(".conversation-scroll");
    const item = el?.querySelector(`[data-item-id="${id}"]`);
    if (!item) return false;
    const box = el.getBoundingClientRect(), r = item.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  }, newest, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const latest = await pane.evaluate((el, id) => {
    const box = el.getBoundingClientRect(), item = el.querySelector(`[data-item-id="${id}"]`)?.getBoundingClientRect();
    return { shown: !!item && item.bottom > box.top && item.top < box.bottom, fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      pill: !!document.querySelector("button.jump-latest") };
  }, newest);
  report.latest = latest;
  await page.screenshot({ path: resolve(output, "latest.png") });
  assert.ok(latest.shown && latest.fromEnd < 72 && !latest.pill, `Back to latest shows the newest message at the end: ${JSON.stringify(latest)}`);
  check("Back to latest from the replaced windows shows the newest message at the end", latest);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error?.stack || error);
  if (page) await page.screenshot({ path: resolve(output, "failed.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
