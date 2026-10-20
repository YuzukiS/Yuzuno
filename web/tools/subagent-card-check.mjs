// T-79 R1: the sub-agent card beside the dock stays inside the window when
// its details arrive and make it taller, and a child a later Turn works with
// again is one dock entry that goes to the Turn where it started. R2: moving
// between the card's list and a child keeps keyboard focus in it. Production
// bundle in an isolated browser with an explicit API fixture; no Core, daily
// window or writes.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/subagent-card");
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [] };
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
};

const agent = {
  id: "a",
  name: "Mori",
  status: "idle",
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  settings: {},
  color: "sage",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
};
const thread = (n) => `01a1418f-0000-7000-8000-00000000000${n}`;
const activity = (kind, n, extra = {}) => ({
  type: "subAgentActivity",
  id: `${kind}-${n}-${extra.turn || "t1"}`,
  kind,
  agentThreadId: thread(n),
  agentPath: `/root/child-${n}`,
  model: kind === "started" ? "gpt-6-astra" : null,
});
const reply = (id, text) => ({ id, type: "agentMessage", text });
const turns = [
  {
    id: "t1",
    status: "completed",
    items: [
      { id: "u1", type: "userMessage", content: [{ type: "text", text: "派几个子 agent 去查" }] },
      ...[1, 2, 3, 4, 5].map((n) => activity("started", n)),
      ...[1, 2, 3, 4, 5].map((n) => activity("completed", n)),
      reply("r1", "五个子 agent 都完成了。"),
    ],
  },
  {
    id: "t2",
    status: "completed",
    items: [
      { id: "u2", type: "userMessage", content: [{ type: "text", text: "让第一个再看一遍" }] },
      { ...activity("interacted", 1, { turn: "t2" }), id: "interacted-1-t2" },
      reply("r2", Array.from({ length: 12 }, (_, i) => `第二轮的第 ${i + 1} 段说明。`).join("\n\n")),
    ],
  },
];
const detail = { agent, pending: [], messageReceipts: [], artifacts: [], turns };
// A long answer, read only when a card opens, after a pause.
const childDetail = (id) => ({
  threadId: id,
  parentThreadId: "parent",
  nickname: null,
  role: null,
  path: `/root/child-${id.at(-1)}`,
  depth: 1,
  model: "gpt-6-astra",
  status: "idle",
  turn: { id: "child-turn", status: "completed", error: null },
  result: { text: Array.from({ length: 40 }, (_, i) => `结论第 ${i + 1} 行：这一段足够长，会把卡片撑高。`).join("\n"), truncated: false },
  readFrom: "history",
  readAt: new Date().toISOString(),
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 760 }, reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.EventSource = class {
      close() {}
    };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 18, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.hostname, "yuzuno-subagent-card.test");
    assert.equal(request.method(), "GET", `No writes: ${request.method()} ${url.pathname}`);
    const child = url.pathname.match(/^\/api\/agents\/a\/subagents\/([^/]+)$/);
    if (child) {
      await new Promise((done) => setTimeout(done, 400));
      return route.fulfill({ json: childDetail(decodeURIComponent(child[1])) });
    }
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
  await page.goto("http://yuzuno-subagent-card.test/");
  const nodes = page.locator(".conversation-subagent");
  await nodes.first().waitFor();

  // One entry per child, though child-1 appears in both Turns.
  const labels = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label").split(" · ")[0]));
  assert.equal(new Set(labels).size, labels.length, `one dock entry per child: ${JSON.stringify(labels)}`);
  assert.equal(labels.length, 5, JSON.stringify(labels));
  // The dock shows a few; the list of all of them shows every entry.
  await page.getByRole("button", { name: "Sub-agents: open the list" }).click();
  const list = page.getByRole("dialog", { name: "Sub-agents in this conversation" });
  await list.waitFor();
  const listed = await list.locator(".subagent-card-list li strong").allTextContents();
  assert.equal(new Set(listed).size, listed.length, `one listed entry per child: ${JSON.stringify(listed)}`);
  assert.equal(listed.length, 5, JSON.stringify(listed));
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  check("a child a later Turn works with again is one dock entry and one listed entry", { labels, listed });

  // From the keyboard: the card takes focus when it opens, and keeps it when
  // choosing a child from the list, or going back to the list, removes the
  // button that had it.
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return {
        inside: !!el?.closest(".subagent-card"),
        label: (el?.getAttribute("aria-label") || el?.textContent || el?.tagName || "").trim().slice(0, 60),
      };
    });
  // Focus moves in React's effects, just after the change it follows.
  const focusIn = async (selector) => {
    await page.waitForFunction((s) => document.activeElement?.closest(s), selector, { timeout: 2000 }).catch(() => {});
    return focused();
  };
  await page.getByRole("button", { name: "Sub-agents: open the list" }).focus();
  await page.keyboard.press("Enter");
  await list.waitFor();
  let focus = await focusIn(".subagent-card");
  assert.ok(focus.inside, `opening the card moves focus into it: ${JSON.stringify(focus)}`);
  for (let step = 0; step < 12 && !focus.label.startsWith("child-3"); step++) {
    await page.keyboard.press("Tab");
    focus = await focused();
  }
  assert.ok(focus.inside && focus.label.startsWith("child-3"), `Tab reaches a child in the list: ${JSON.stringify(focus)}`);
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Sub-agent child-3" }).locator(".subagent-answer").waitFor();
  focus = await focusIn(".subagent-card");
  assert.ok(focus.inside, `choosing a child keeps focus in the card: ${JSON.stringify(focus)}`);
  const reached = [];
  for (let step = 0; step < 16 && !focus.label.startsWith("Go to its Turn"); step++) {
    await page.keyboard.press("Tab");
    focus = await focused();
    reached.push(focus.label);
    assert.ok(focus.inside, `Tab stays in the card: ${JSON.stringify(reached)}`);
  }
  assert.ok(focus.label.startsWith("Go to its Turn"), `Tab reaches the card's actions: ${JSON.stringify(reached)}`);
  for (let step = 0; step < 16 && focus.label !== "All sub-agents"; step++) {
    await page.keyboard.press("Shift+Tab");
    focus = await focused();
  }
  assert.equal(focus.label, "All sub-agents");
  await page.keyboard.press("Enter");
  await list.waitFor();
  focus = await focusIn(".subagent-card-list");
  assert.ok(focus.inside && focus.label.startsWith("child-3"), `back on the list, at the child just read: ${JSON.stringify(focus)}`);
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  focus = await focusIn(".work-dock");
  assert.equal(focus.label, "Sub-agents: open the list", "closing returns focus to the dock");
  check("from the keyboard, the card takes focus, and choosing a child or going back keeps it there", { reached });

  // The lowest node's card, once its long answer has arrived, stays inside
  // the window with its actions reachable.
  const lowest = nodes.last();
  await lowest.click();
  const card = page.getByRole("dialog");
  await card.waitFor();
  await card.locator(".subagent-answer").waitFor();
  const fits = () =>
    card.evaluate(
      (el) =>
        new Promise((done) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const box = el.getBoundingClientRect();
              done({ top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height), innerHeight, scrolls: el.scrollHeight > el.clientHeight + 1 });
            }),
          ),
        ),
    );
  let box = await fits();
  assert.ok(box.top >= 8 && box.bottom <= box.innerHeight - 8, `the card stays inside the window: ${JSON.stringify(box)}`);
  const go = card.getByRole("button", { name: "Go to its Turn" });
  await go.scrollIntoViewIfNeeded();
  const goBox = await go.boundingBox();
  assert.ok(goBox && goBox.y + goBox.height <= box.innerHeight, `its actions are reachable: ${JSON.stringify(goBox)}`);
  await page.screenshot({ path: resolve(output, "card-lowest-node.png") });
  check("a card that grows when its details arrive is placed again inside the window", box);

  // A smaller window places it again.
  await page.setViewportSize({ width: 1440, height: 560 });
  await page.waitForFunction(() => {
    const el = document.querySelector(".subagent-card");
    const box = el?.getBoundingClientRect();
    return box && box.top >= 8 && box.bottom <= innerHeight - 8;
  });
  box = await fits();
  check("a smaller window places the card again", box);

  // Child-1's card goes to the Turn where it started, not the later one.
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 760 });
  const first = await nodes.evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-label").startsWith("child-1 ")));
  assert.ok(first >= 0);
  await nodes.nth(first).click();
  await card.waitFor();
  await card.getByRole("button", { name: "Go to its Turn" }).click();
  await page.waitForFunction(() => {
    const t = document.getElementById("turn-t1")?.getBoundingClientRect();
    const pane = document.querySelector(".conversation-scroll").getBoundingClientRect();
    return t && t.top < pane.bottom && t.bottom > pane.top;
  });
  check("its card goes to the Turn where the child started");

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
