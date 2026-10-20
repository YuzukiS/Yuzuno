// Bounded browser regression for the user's Back to latest / stop-following flow.
// All HTTP and SSE data is synthetic; no running Core or workspace data is used.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { noJobs, noCiRuns, noReviews, idleJobsBudget, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "An isolated production build is required");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "T-35", source: process.env.T35_HEAD, cases: [], errors: [], mutations: [] };
const shapes = (process.env.T35_SHAPES || "long,giant,short,paged,paged-delay").split(",");
const motions = (process.env.T35_MOTIONS || "no-preference,reduce").split(",");
const browser = await chromium.launch({ executablePath: "/usr/sbin/chromium", headless: true });
const paragraph = i => `Paragraph ${i}: output grows while the reader chooses whether to follow the latest message. `;
const user = id => ({ id: `${id}-user`, type: "userMessage", content: [{ type: "text", text: `Request ${id}` }] });
const reply = (id, length) => ({ id: `${id}-reply`, type: "agentMessage", text: Array.from({ length }, (_, i) => paragraph(i)).join("\n\n") });
function fixture(shape) {
  const agent = { id: "a", name: "Follow A", harness: "codex", status: "working", cwd: "/fixture", model: "fixture",
    settings: { reasoningEffort: "medium", approvalPolicy: "on-request", sandbox: "workspace-write" },
    color: "sage", createdAt: "", updatedAt: "", rev: 1, lastSeq: 1, reviewedSeq: 1, unreadCount: 0, pendingCount: 0 };
  let turns = Array.from({ length: 48 }, (_, i) => ({ id: `t${i}`, status: i === 47 ? "inProgress" : "completed",
    items: [user(`t${i}`), reply(`t${i}`, i === 47 ? (shape === "short" ? 1 : 24) : 2 + i % 5)] }));
  if (shape === "giant") turns = [{ id: "t47", status: "inProgress", items: [user("t47"),
    ...Array.from({ length: 80 }, (_, i) => reply(`block${i}`, 2 + i % 4))] }];
  return {
    a: { agent, turns, pending: [], artifacts: [], messageReceipts: [] },
    b: { agent: { ...agent, id: "b", name: "Follow B" }, turns: [{ id: "b0", status: "inProgress", items: [user("b0"), reply("b0", 22)] }], pending: [], artifacts: [], messageReceipts: [] },
  };
}
const paneState = () => {
  const pane = document.querySelector(".conversation-scroll");
  return { top: pane.scrollTop, height: pane.scrollHeight, viewport: pane.clientHeight,
    gap: pane.scrollHeight - pane.clientHeight - pane.scrollTop,
    nodes: document.getElementsByTagName("*").length,
    turns: pane.querySelectorAll(".turn").length,
    blocks: pane.querySelectorAll('[data-window^="blocks:"] > .conversation-window-row').length,
    button: !!document.querySelector(".jump-latest") };
};
async function stable(page) {
  // Wait for measured layout to stop moving, with a hard deadline; don't
  // assume that two animation frames finish nested variable-height rows.
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    if (!el) return false;
    const value = `${el.scrollTop}/${el.scrollHeight}/${el.clientHeight}`;
    const previous = window.t35Stable;
    window.t35Stable = { value, n: previous?.value === value ? previous.n + 1 : 0 };
    return window.t35Stable.n >= 6;
  }, null, { timeout: 5000, polling: "raf" });
}
async function wheelUp(page, distance = 700) {
  await page.locator(".conversation-scroll").hover();
  await page.mouse.wheel(0, -distance);
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.clientHeight - el.scrollTop > 200;
  });
  await stable(page);
}
async function stream(page, id, count) {
  await page.evaluate(({ id, count }) => {
    window.t35Streams ||= {};
    const state = window.t35Streams[id] = { count: 0, done: false };
    void (async () => {
      for (let i = 0; i < count; i++) {
        const event = await window.t35Append(id);
        window.t35Events.onmessage?.({ data: JSON.stringify(event), lastEventId: `delta-${id}-${event.rev}` });
        state.count++;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      state.done = true;
    })();
  }, { id, count });
}
async function streamDone(page, id, detail) {
  await page.waitForFunction(id => window.t35Streams[id]?.done, id);
  const marker = `T35-${id}-${detail.agent.rev}`;
  await page.waitForFunction(marker => document.querySelector(".conversation-scroll")?.textContent.includes(marker), marker);
  await stable(page);
}
async function latest(page) {
  await page.locator(".jump-latest").click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return !!document.querySelector("#turn-t47") && el.scrollHeight - el.clientHeight - el.scrollTop < 2;
  }, null, { timeout: 5000 });
}
async function traceScroll(page) {
  await page.evaluate(() => {
    const pane = document.querySelector(".conversation-scroll");
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const trace = window.t35Trace = [];
    const sample = (kind, extra = {}) => {
      if (trace.length >= 160) return;
      const top = descriptor.get.call(pane), box = pane.getBoundingClientRect();
      trace.push({ at: performance.now(), kind, top, height: pane.scrollHeight, viewport: pane.clientHeight,
        gap: pane.scrollHeight - pane.clientHeight - top, button: !!document.querySelector(".jump-latest"), ...extra,
        rows: [...pane.querySelectorAll('[data-window="turns"] > .conversation-window-row')].map(row => ({
          key: row.dataset.windowKey, top: row.getBoundingClientRect().top - box.top, height: row.getBoundingClientRect().height,
        })) });
    };
    // Observe programmatic writes without changing the native getter/setter.
    Object.defineProperty(pane, "scrollTop", { configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { sample("write", { value, stack: new Error().stack }); descriptor.set.call(this, value); },
    });
    pane.addEventListener("scroll", () => sample("scroll"));
    pane.addEventListener("wheel", event => sample("wheel", { deltaY: event.deltaY }));
    new ResizeObserver(() => sample("resize")).observe(pane.querySelector(".conversation-inner"));
    sample("start");
  });
}
try {
  for (const motion of motions) for (const shape of shapes) {
    const result = { motion, shape, checks: [], requests: [] };
    report.cases.push(result);
    const details = fixture(shape);
    let delayTail = false;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: motion });
    await context.addInitScript(() => {
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }));
      window.EventSource = class {
        constructor() {
          this.readyState = 0; window.t35Events = this;
          setTimeout(() => { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: '{"type":"resumed"}', lastEventId: "fixture-0" }); }, 20);
        }
        addEventListener() {}
        close() { this.readyState = 2; }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.errors.push({ motion, shape, error: error.message }));
    await page.exposeFunction("t35Append", id => {
      const detail = details[id], turn = detail.turns.at(-1), item = turn.items.at(-1);
      const text = `\n\nT35-${id}-${++detail.agent.rev}: ${paragraph(detail.agent.rev)}`;
      item.text += text;
      return { type: "agent.delta", agentId: id, rev: detail.agent.rev, turnId: turn.id, itemId: item.id, op: "append", field: "text", text };
    });
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://t35-follow.test") { report.errors.push(`External request ${url.origin}`); return route.abort(); }
      if (request.method() !== "GET") {
        report.mutations.push({ path: url.pathname, method: request.method() });
        return route.fulfill({ status: 403, json: {} });
      }
      let data;
      if (url.pathname === "/api/workspace") data = { agents: Object.values(details).map(d => d.agent), runtime: { connected: true }, projects: [], defaultCwd: "/fixture" };
      else if (/^\/api\/agents\/[ab]$/.test(url.pathname)) {
        data = structuredClone(details[url.pathname.at(-1)]);
        if (shape.startsWith("paged") && data.agent.id === "a") {
          if (delayTail && !url.search) await new Promise(resolve => setTimeout(resolve, 350));
          // Snapshot at response time, including deltas produced during the
          // intentional API latency, just as revision reconciliation expects.
          data = structuredClone(details.a);
          const all = data.turns;
          const index = url.searchParams.has("turnId") ? Math.max(0, all.findIndex(t => t.id === url.searchParams.get("turnId"))) : all.length - 12;
          data.turns = all.slice(index, index + 12);
          data.conversation = { index: all.map((t, i) => ({ ...t, number: i + 1, itemCount: t.items.length, items: [t.items[0]] })),
            questions: [], nativeClientIds: [], start: JSON.stringify([data.turns[0].id, data.turns[0].items[0].id]),
            end: JSON.stringify([data.turns.at(-1).id, data.turns.at(-1).items.at(-1).id]),
            hasBefore: index > 0, hasAfter: index + 12 < all.length, totalItems: all.length * 2 };
        }
      }
      else if (url.pathname === "/api/updates") data = unmanagedUpdates;
      else if (url.pathname === "/api/jobs") data = noJobs;
      else if (url.pathname === "/api/jobs/live") data = { agents: {} };
      else if (url.pathname === "/api/jobs/budget") data = idleJobsBudget;
      else if (url.pathname === "/api/ci") data = noCiRuns;
      else if (url.pathname === "/api/reviews") data = noReviews;
      else if (url.pathname === "/api/backlog") data = { observedAt: "2026-10-16T00:00:00Z", agents: {} };
      else if (url.pathname === "/api/pr-reviews/settings") data = { harness: "codex", model: "gpt-6.1-sol" };
      if (data !== undefined) { result.requests.push(url.pathname + url.search); return route.fulfill({ json: data }); }
      if (url.pathname.startsWith("/api/")) { report.errors.push(`Unexpected fixture GET ${url.pathname}`); return route.fulfill({ status: 404, json: {} }); }
      const file = resolve(dist, url.pathname === "/" ? "index.html" : "." + url.pathname);
      assert.ok(file.startsWith(dist + "/"));
      return route.fulfill({ body: await readFile(file), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" }[extname(file)] });
    });
    try {
      await page.goto("http://t35-follow.test/");
      await page.getByRole("textbox", { name: "Message Follow A" }).waitFor();
      await page.locator("#turn-t47").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await stable(page);
      result.initial = await page.evaluate(paneState);
      assert.ok(result.initial.nodes < 6000, "Conversation DOM remains bounded");
      if (process.env.T35_TRACE) await traceScroll(page);
      if (shape === "paged-delay") {
        await page.locator('[data-turn-choice]').last().focus();
        await page.keyboard.press("Home");
        await page.locator('[data-turn-choice="t0"]').click();
        await page.locator('#turn-t0').waitFor();
        await page.getByRole("button", { name: "Continue to newer messages", exact: true }).waitFor();
        await stable(page);
        delayTail = true;
      } else await wheelUp(page, 1200);
      result.beforeClick = await page.evaluate(paneState);
      if (process.env.T35_TRACE) result.wheelTrace = await page.evaluate(() => window.t35Trace);
      assert.ok(result.beforeClick.button && (shape === "paged-delay" || result.beforeClick.gap > 200),
        `Upward reading position must survive layout before streaming: ${JSON.stringify(result.beforeClick)}`);
      await stream(page, "a", 64);
      await page.waitForFunction(() => window.t35Streams.a.count >= 4);
      await latest(page);
      result.afterClick = await page.evaluate(paneState);
      await streamDone(page, "a", details.a);
      result.afterGrowth = await page.evaluate(paneState);
      assert.ok(result.afterGrowth.gap < 2, `After streaming: ${JSON.stringify(result.afterGrowth)}`);
      assert.equal(result.afterGrowth.button, false);
      result.checks.push("Click during 40Hz SSE growth reaches the latest and keeps following");

      await stream(page, "a", 40);
      await page.waitForFunction(() => window.t35Streams.a.count >= 4);
      await wheelUp(page);
      const anchor = await page.evaluate(() => {
        const pane = document.querySelector(".conversation-scroll"), box = pane.getBoundingClientRect();
        const nodes = [...pane.querySelectorAll("[data-item-id]")].map(el => ({ el, box: el.getBoundingClientRect() }));
        const visible = nodes.filter(n => n.box.height > 0 && n.box.bottom > box.top && n.box.top < box.bottom);
        const chosen = visible.find(n => n.box.top >= box.top) || visible[0];
        return chosen && { id: chosen.el.dataset.itemId, top: chosen.box.top };
      });
      assert.ok(anchor, "There is a visible reading anchor");
      await streamDone(page, "a", details.a);
      const anchorTop = await page.locator(`[data-item-id="${anchor.id}"]`).first().evaluate(el => el.getBoundingClientRect().top);
      result.afterCancel = { ...await page.evaluate(paneState), anchor, anchorTop };
      assert.ok(result.afterCancel.gap > 200, "Upward wheel cancels follow while the stream continues");
      assert.ok(Math.abs(anchorTop - anchor.top) < 8, "Streaming leaves the reading anchor in place");
      result.checks.push("Upward wheel cancels follow and preserves the visible reading anchor");
      await latest(page);
      await stable(page);
      assert.ok((await page.evaluate(paneState)).gap < 2, "Follow can be explicitly resumed");

      await stream(page, "a", 32);
      await page.locator('.agent-row[data-agent-id="b"] .agent-select').click();
      await page.getByRole("textbox", { name: "Message Follow B" }).waitFor();
      await page.locator("#turn-b0").waitFor();
      await stable(page);
      await stream(page, "b", 24);
      await streamDone(page, "b", details.b);
      assert.ok((await page.evaluate(paneState)).gap < 2, "Selected Agent follows its own stream");
      await page.waitForFunction(() => window.t35Streams.a.done);
      await page.locator('.agent-row[data-agent-id="a"] .agent-select').click();
      await page.getByRole("textbox", { name: "Message Follow A" }).waitFor();
      await page.locator("#turn-t47").waitFor();
      await stable(page);
      result.afterSwitch = await page.evaluate(paneState);
      assert.ok(result.afterSwitch.gap < 2, "Switching back opens the current tail");
      result.checks.push("Switching Agents during growth follows the selected Agent and resets to its tail");
      await page.screenshot({ path: resolve(output, `${shape}-${motion}-final.png`) });
      result.passed = true;
    } catch (error) {
      result.error = String(error.stack || error);
      result.failureState = await page.evaluate(paneState).catch(() => null);
      if (process.env.T35_TRACE) result.trace = await page.evaluate(() => window.t35Trace);
      await page.screenshot({ path: resolve(output, `${shape}-${motion}-failure.png`) });
      result.passed = false;
    } finally { await context.close(); }
  }
  report.passed = report.cases.every(c => c.passed) && !report.errors.length && !report.mutations.length;
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(({ shape, motion, passed, error }) => ({ shape, motion, passed, error })) }));
if (!report.passed) process.exitCode = 1;
