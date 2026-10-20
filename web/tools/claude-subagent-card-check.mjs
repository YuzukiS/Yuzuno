// T-26: a Claude Agent's sub-agents on the dock (T-79's SubAgentDock), in a
// real browser. The card takes keyboard focus and keeps Tab inside it up to
// "Go to its Turn"; a card made tall by a long result and its calls stays
// inside the window and is placed again in a smaller one; its calls carry no
// Turn anchors; "Go to its Turn" goes to the Turn the sub-agent started in.
// Production bundle in an isolated browser with an explicit API fixture; no
// Core, daily window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/claude-subagent-card");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a", name: "Kiri", status: "idle", harness: "claude", connectionState: "connected", cwd: "/fixture", model: "claude-sonnet-5",
  settings: {}, color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
};
// As Core records CLI 2.1.280's frames (T-26 probe).
const agentCall = (id, description, subAgent) => ({
  id, type: "claudeToolUse", name: "Agent", status: "completed",
  input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose" }, output: [{ type: "text", text: "done" }], subAgent,
});
const call = (id, parent) => ({
  id, type: "claudeToolUse", name: "Read", status: "completed", input: { file_path: `docs/${id}.md` }, output: `${id} output`, parentToolUseId: parent,
});
const reply = (id, text) => ({ id, type: "agentMessage", text, phase: "final_answer" });
const longResult = Array.from({ length: 40 }, (_, i) => `结论第 ${i + 1} 行：这一段足够长，会把卡片撑高。`).join("\n");
const turns = [
  { id: "t1", status: "completed", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "派两个子 agent 去看文档" }] },
    agentCall("agent-1", "Survey the docs", { taskId: "task-1", type: "Explore", status: "completed", result: longResult,
      usage: { tokens: 31000, toolUses: 3, durationMs: 21000 } }),
    agentCall("agent-2", "Read b.txt", { taskId: "task-2", type: "general-purpose", status: "completed", result: "bravo" }),
    call("intro", "agent-1"), call("setup", "agent-1"), call("faq", "agent-1"),
    reply("r1", "两个子 agent 都完成了。"),
  ] },
  { id: "t2", status: "completed", items: [
    { id: "u2", type: "userMessage", content: [{ type: "text", text: "后台盯一下构建" }] },
    agentCall("agent-3", "Watch the build", { taskId: "task-3", type: "general-purpose", status: "running", background: true, activity: "Waiting for make" }),
    reply("r2", Array.from({ length: 14 }, (_, i) => `第二轮的第 ${i + 1} 段说明。`).join("\n\n")),
  ] },
];
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 760 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 18, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-claude-subagent-card.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const json = {
      "/api/workspace": { agents: [agent], runtime: { connected: true }, defaultCwd: "/fixture" },
      "/api/agents/a": detail,
      "/api/updates": unmanagedUpdates,
      "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs,
      "/api/jobs/live": noLiveJobs,
      "/api/ci": noCiRuns,
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
  await page.goto("http://yuzuno-claude-subagent-card.test/");
  const nodes = page.locator(".conversation-subagent");
  await nodes.first().waitFor();

  // Still running first, then the latest; a running one is no failure.
  const shown = await nodes.evaluateAll((els) => els.map((el) => [el.getAttribute("aria-label"), el.className.match(/state-(\w+)/)[1]]));
  assert.deepEqual(shown.map(([label, state]) => [label.split(" · ")[0], state]),
    [["Watch the build", "running"], ["Read b.txt", "succeeded"], ["Survey the docs", "succeeded"]], JSON.stringify(shown));
  check("a Claude Agent's sub-agents are on the dock, still running first", { shown });

  // From the keyboard: the card takes focus and keeps Tab inside it up to
  // "Go to its Turn"; Escape returns focus to the node.
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return { inside: !!el?.closest(".subagent-card"), label: (el?.getAttribute("aria-label") || el?.textContent || el?.tagName || "").trim().slice(0, 60) };
    });
  const focusIn = async (selector) => {
    await page.waitForFunction((s) => document.activeElement?.closest(s), selector, { timeout: 2000 }).catch(() => {});
    return focused();
  };
  await nodes.nth(1).focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("dialog", { name: "Sub-agent Read b.txt" });
  await card.waitFor();
  let focus = await focusIn(".subagent-card");
  assert.ok(focus.inside, `opening the card moves focus into it: ${JSON.stringify(focus)}`);
  const reached = [];
  for (let step = 0; step < 16 && !focus.label.startsWith("Go to its Turn"); step++) {
    await page.keyboard.press("Tab");
    focus = await focused();
    reached.push(focus.label);
    assert.ok(focus.inside, `Tab stays in the card: ${JSON.stringify(reached)}`);
  }
  assert.ok(focus.label.startsWith("Go to its Turn"), `Tab reaches "Go to its Turn": ${JSON.stringify(reached)}`);
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  focus = await focusIn(".work-dock");
  assert.ok(focus.label.startsWith("Read b.txt"), `closing returns focus to its node: ${JSON.stringify(focus)}`);
  check("from the keyboard, the card takes focus and Tab stays in it up to Go to its Turn", { reached });

  // The lowest node's card, tall with its long result and then its calls,
  // stays inside the window with its actions reachable.
  await nodes.last().click();
  const tall = page.getByRole("dialog", { name: "Sub-agent Survey the docs" });
  await tall.waitFor();
  const fits = () =>
    tall.evaluate(
      (el) =>
        new Promise((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const box = el.getBoundingClientRect();
              done({ top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), innerHeight });
            }),
          ),
        ),
    );
  let box = await fits();
  assert.ok(box.top >= 8 && box.bottom <= box.innerHeight - 8, `the card stays inside the window: ${JSON.stringify(box)}`);
  await tall.getByRole("button", { name: /Its tool calls · 3/ }).click();
  await tall.locator(".claude-subagent-calls .claude-tool").nth(2).waitFor();
  box = await fits();
  assert.ok(box.top >= 8 && box.bottom <= box.innerHeight - 8, `with its calls shown, still inside: ${JSON.stringify(box)}`);
  const anchors = await tall.locator("[id^='item-'], [data-item-id]").count();
  assert.equal(anchors, 0, "its calls carry no Turn anchors in the card");
  const go = tall.getByRole("button", { name: "Go to its Turn" });
  await go.scrollIntoViewIfNeeded();
  const goBox = await go.boundingBox();
  assert.ok(goBox && goBox.y + goBox.height <= box.innerHeight, `its actions are reachable: ${JSON.stringify(goBox)}`);
  await page.screenshot({ path: resolve(output, "claude-card-tall.png") });
  check("a card tall with a long result and its calls stays inside the window, without Turn anchors", box);

  await page.setViewportSize({ width: 1440, height: 560 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".subagent-card");
    const rect = el?.getBoundingClientRect();
    return rect && rect.top >= 8 && rect.bottom <= innerHeight - 8;
  });
  box = await fits();
  check("a smaller window places the card again", box);

  // "Go to its Turn" goes to the Turn where it started.
  await page.setViewportSize({ width: 1440, height: 760 });
  await go.click();
  await tall.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const t = document.getElementById("turn-t1")?.getBoundingClientRect();
    const pane = document.querySelector(".conversation-scroll").getBoundingClientRect();
    return t && t.top < pane.bottom && t.bottom > pane.top;
  });
  check("its card goes to the Turn where the sub-agent started");

  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, "report.json")}`);
  if (report.error) console.error(report.error);
}
