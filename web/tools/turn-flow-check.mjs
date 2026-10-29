// Independent production bundle + in-memory event fixtures. Never contacts Core.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "An isolated build is required");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_CHECK_OUTPUT || "../acceptance/turn-flow");
await mkdir(output, { recursive: true });
const report = {
  mode: "isolated-event-fixtures",
  checks: [],
  errors: [],
  mutations: [],
};
const agent = {
  id: "a",
  name: "Mori",
  status: "working",
  harness: "codex",
  cwd: "/fixture",
  model: "test-model",
  color: "sage",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  createdAt: "",
  updatedAt: "",
};
const otherAgent = { ...agent, id: "b", name: "Hana", status: "idle" };
const tool = (id) => ({
  id,
  type: "commandExecution",
  command: "检查消息顺序 · rg conversation web/src",
  status: "inProgress",
});
const turn = {
  id: "live",
  status: "inProgress",
  startedAt: Date.parse("2026-10-12T11:57:55Z") / 1000,
  items: [
    {
      id: "initial",
      type: "userMessage",
      content: [{ type: "text", text: "检查当前界面。" }],
    },
    {
      id: "progress",
      type: "agentMessage",
      phase: "commentary",
      text: "我会检查消息顺序，并保留你正在阅读的位置。",
    },
    tool("tool-a"),
    { id: "empty-reasoning", type: "reasoning", summary: [], content: [] },
  ],
};
const history = Array.from({ length: 6 }, (_, i) => ({
  id: `history-${i}`,
  status: "completed",
  items: [
    {
      id: `old-${i}`,
      type: "agentMessage",
      phase: "final_answer",
      text: `HistoryMarker${i}: ${"这是之前的回复，供阅读位置验证。 ".repeat(35)}`,
    },
  ],
}));
const detail = {
  agent,
  turns: [...history, turn],
  pending: [],
  artifacts: [],
  messageReceipts: [],
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Fix Date.now without pausing intervals or disclosure animation.
await page.clock.setFixedTime(new Date("2026-10-12T12:00:00Z"));
await page.addInitScript(() => {
  window.EventSource = class {
    constructor() {
      window.turnFlowEvents = this;
    }
    close() {}
  };
});
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  assert.equal(url.hostname, "yuzuno-turn-flow.test");
  if (request.method() !== "GET") {
    report.mutations.push({ path: url.pathname, method: request.method() });
    assert.equal(url.pathname, "/api/agents/a/messages");
    const input = request.postDataJSON();
    turn.items.push({
      id: "steering",
      clientId: input.clientMessageId,
      type: "userMessage",
      content: [{ type: "text", text: input.text }],
    });
    const receipt = { status: "accepted", input, turnId: "live", agentId: "a" };
    detail.messageReceipts.push(receipt);
    return route.fulfill({ json: receipt });
  }
  if (url.pathname === "/api/workspace")
    return route.fulfill({
      json: {
        agents: [agent, otherAgent],
        runtime: { connected: true },
        defaultCwd: "/fixture",
      },
    });
  if (url.pathname === "/api/agents/a") return route.fulfill({ json: detail });
  if (url.pathname === "/api/agents/b")
    return route.fulfill({ json: { agent: otherAgent, turns: [], pending: [], artifacts: [] } });
  if (url.pathname === "/api/updates")
    return route.fulfill({ json: unmanagedUpdates });
  assert.ok(
    !url.pathname.startsWith("/api/"),
    `Unexpected request: ${url.pathname}`,
  );
  const file = resolve(
    dist,
    `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
  );
  assert.ok(file.startsWith(dist + "/"));
  return route.fulfill({
    body: await readFile(file),
    contentType: {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".woff2": "font/woff2",
    }[extname(file)],
  });
});
page.on("pageerror", (error) => report.errors.push(error.message));
const refresh = async () => {
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/agents/a"),
  );
  await page.evaluate(() =>
    window.turnFlowEvents.onmessage?.({ data: "fixture" }),
  );
  await response;
};
const group = page.locator('[data-turn-id="live"] .tool-activity').first();
const isOpen = (locator) => locator.evaluate((el) => el.open);
const waitOpen = async (locator, open) => {
  await page.waitForFunction(
    ({ selector, open }) => document.querySelector(selector)?.open === open,
    { selector: '[data-turn-id="live"] .tool-activity', open },
  );
  assert.equal(await isOpen(locator), open);
};
const record = (name, data) => report.checks.push({ name, ...data });
try {
  await page.goto("https://yuzuno-turn-flow.test/");
  await group.waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await isOpen(group), true);
  const timer = page.locator('[data-turn-id="live"] .activity-elapsed');
  assert.equal(await timer.textContent(), "· 2m 05s");
  assert.equal(await page.locator("#item-empty-reasoning").count(), 0);
  await page.clock.setFixedTime(new Date("2026-10-12T12:00:02Z"));
  await page.waitForFunction(() => document.querySelector(".activity-elapsed")?.textContent === "· 2m 07s");
  await page.reload();
  await group.waitFor();
  assert.equal(await timer.textContent(), "· 2m 07s");
  record("Working clock advances without events and survives page reload; empty reasoning has no card");
  await page.locator('[data-agent-id="b"] .agent-select').click();
  await page.getByRole("textbox", { name: "Message Hana" }).waitFor();
  assert.equal(await page.locator(".activity-elapsed").count(), 0);
  await page.locator('[data-agent-id="a"] .agent-select').click();
  await group.waitFor();
  assert.equal(await timer.textContent(), "· 2m 07s");
  record("Switching Agents neither leaks nor resets the working clock");
  await page
    .getByRole("textbox", { name: "Message Mori" })
    .fill("SteeringMarker：先保留现有样式，再调整动画。");
  await page.getByRole("button", { name: "Send while working" }).click();
  await page.locator('[data-item-id="steering"]').waitFor();
  const order = await page
    .locator('[data-turn-id="live"]')
    .evaluate((el) =>
      [...el.querySelectorAll(".user-message, .commentary, .tool-item")].map(
        (node) => node.dataset.itemId || node.id,
      ),
    );
  assert.deepEqual(order, ["initial", "progress", "item-tool-a", "steering"]);
  assert.equal(await isOpen(group), true);
  record(
    "Sending during work inserts user input after the existing output, without folding tools",
    { order },
  );
  await page
    .getByRole("textbox", { name: "Message Mori" })
    .fill("下一条草稿保留");

  turn.items[2].status = "completed";
  const reply = {
    id: "next-progress",
    type: "agentMessage",
    phase: "commentary",
    text: "",
  };
  turn.items.push(reply);
  await refresh();
  await page
    .locator("#item-tool-a .tool-result")
    .filter({ hasText: "returned" })
    .waitFor();
  assert.equal(await isOpen(group), true);
  assert.equal(await page.locator('[data-item-id="next-progress"]').count(), 0);
  reply.text = "收到，我会保留现有样式。现在调整展开和折叠动画。";
  await refresh();
  await waitOpen(group, false);
  await page.waitForTimeout(250);
  record(
    "Tool completion and empty streaming placeholders keep the block open; visible commentary folds it",
  );

  assert.equal(
    await page.evaluate(
      () =>
        CSS.supports("interpolate-size", "allow-keywords") &&
        CSS.supports("selector(details::details-content)"),
    ),
    true,
  );
  for (const opening of [true, false]) {
    const animation = await group.evaluate(async (el) => {
      const before = el.getBoundingClientRect().height;
      el.querySelector(":scope > summary").click();
      // Native details content transitions are not exposed by getAnimations().
      // Sample actual layout between frames to verify both opening and closing.
      await new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      );
      await new Promise((done) => setTimeout(done, 50));
      const middle = el.getBoundingClientRect().height;
      const duration =
        parseFloat(
          getComputedStyle(el, "::details-content").transitionDuration,
        ) * 1000;
      await new Promise((done) => setTimeout(done, duration + 50));
      const after = el.getBoundingClientRect().height;
      return {
        before,
        middle,
        after,
        duration,
        open: el.open,
      };
    });
    // Opening unfolds a little slower than closing folds (tool-activity.css).
    assert.equal(animation.duration, opening ? 300 : 220, JSON.stringify(animation));
    assert.equal(animation.open, opening);
    assert.ok(
      animation.middle > Math.min(animation.before, animation.after) &&
        animation.middle < Math.max(animation.before, animation.after),
      JSON.stringify(animation),
    );
    record(
      opening
        ? "Expansion interpolates height smoothly"
        : "Collapse interpolates height smoothly",
      animation,
    );
  }

  turn.items.push(tool("tool-b"));
  await refresh();
  const second = page.locator('[data-turn-id="live"] .tool-activity').nth(1);
  await second.waitFor();
  assert.equal(await isOpen(second), true);
  await second.locator(":scope > summary").click();
  await page.waitForTimeout(250);
  turn.items.at(-1).status = "completed";
  await refresh();
  await page
    .locator("#item-tool-b .tool-result")
    .filter({ hasText: "returned" })
    .waitFor({ state: "attached" });
  assert.equal(await isOpen(second), false);
  await group.locator(":scope > summary").click();
  await page.waitForTimeout(250);
  turn.items.push({
    id: "final",
    type: "agentMessage",
    phase: "final_answer",
    text: "顺序和动画已完成。",
  });
  await refresh();
  await page.locator('[data-item-id="final"]').waitFor();
  assert.equal(await isOpen(group), true);
  assert.equal(await isOpen(second), false);
  record(
    "Manual history expansion and explicit live collapse survive later execution events",
  );

  await page.getByRole("button", { name: "Search conversation" }).click();
  await page
    .getByRole("searchbox", { name: "Search loaded messages" })
    .fill("SteeringMarker");
  await page.locator(".conversation-search-result").click();
  await page
    .locator('[data-item-id="steering"][data-search-highlight="true"]')
    .waitFor();
  assert.equal(
    await composerDraft(page.getByRole("textbox", { name: "Message Mori" })),
    "下一条草稿保留",
  );
  await page.getByRole("button", { name: "Search conversation" }).click();
  await page
    .getByRole("searchbox", { name: "Search loaded messages" })
    .fill("HistoryMarker1");
  await page.locator(".conversation-search-result").click();
  await page
    .locator('[data-item-id="old-1"][data-search-highlight="true"]')
    .waitFor();
  const top = await page
    .locator(".conversation-scroll")
    .evaluate((el) => el.scrollTop);
  turn.items.push(tool("tool-c"));
  await refresh();
  await page.locator("#item-tool-c").waitFor({ state: "attached" });
  await page.waitForTimeout(250);
  const after = await page
    .locator(".conversation-scroll")
    .evaluate((el) => el.scrollTop);
  assert.ok(Math.abs(after - top) < 2, `${top} -> ${after}`);
  record(
    "Search jumps to the interleaved input; new tool activity preserves history reading and the draft",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await group.evaluate((el) => el.querySelector(":scope > summary").click());
  assert.equal(
    await group.evaluate((el) => el.getAnimations({ subtree: true }).length),
    0,
  );
  record("Reduced-motion preference disables disclosure animation");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  turn.items.push(
    tool("tool-c2"),
    {
      id: "edit",
      type: "fileChange",
      status: "completed",
      changes: [{ path: "a.ts" }, { path: "b.ts" }],
    },
    {
      id: "mcp1",
      type: "mcpToolCall",
      server: "documentation",
      tool: "search_reference_for_current_project",
    },
    {
      id: "mcp2",
      type: "mcpToolCall",
      server: "documentation",
      tool: "search_reference_for_current_project",
    },
    { id: "mcp3", type: "mcpToolCall", server: "documentation", tool: "fetch" },
    { id: "compact", type: "contextCompaction" },
  );
  turn._yuzunoCompactionId = "compact";
  turn._yuzunoCompactionStartedAt = Date.parse("2026-10-12T11:59:50Z");
  await refresh();
  const compacting = page.locator(
    '[data-turn-id="live"] .turn-activity[data-state="compacting"]',
  );
  await compacting.waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector(".activity-elapsed")?.textContent === "· 12s");
  record("Compacting shows its own elapsed time, separate from the Turn duration");
  const pet = compacting.locator(".activity-yuzu");
  const motion = await pet.evaluate(async (el) => {
    const animation = el.getAnimations()[0];
    animation.pause();
    animation.currentTime = 0;
    const start = getComputedStyle(el).transform;
    animation.currentTime = 770;
    const middle = getComputedStyle(el).transform;
    animation.play();
    return { name: getComputedStyle(el).animationName, start, middle };
  });
  assert.equal(motion.name, "activity-compact");
  assert.notEqual(motion.start, motion.middle);
  assert.equal(
    await page.locator(".conversation-header .status-label").innerText(),
    "Compacting",
  );
  // How many steps; each call says the rest in its own capsule (T-9).
  assert.equal(
    await page
      .locator('[data-turn-id="live"] .tool-activity')
      .last()
      .locator(":scope > summary .tool-overview")
      .innerText(),
    "7 tool steps",
  );
  assert.ok(
    Math.abs(
      (await page
        .locator(".conversation-scroll")
        .evaluate((el) => el.scrollTop)) - top,
    ) < 2,
  );
  record(
    "The heading counts the tool steps; real compaction uses a distinct character animation without changing reading position",
    motion,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await pet.evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  record("Compacting respects reduced motion");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const theme of ["light", "dark"])
    for (const width of [1440, 940, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        localStorage.setItem(
          "yuzuno.appearance",
          JSON.stringify({ theme, fontSize: 20 }),
        );
        window.dispatchEvent(
          new StorageEvent("storage", { key: "yuzuno.appearance" }),
        );
      }, theme);
      await page
        .locator('[data-turn-id="live"]')
        .evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(250);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({ path: `${output}/${theme}-${width}-20px.png` });
      await compacting.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${output}/${theme}-${width}-compacting.png`,
      });
      record("Layout fits", { theme, width, fontSize: 20 });
    }
  delete turn._yuzunoCompactionId;
  delete turn._yuzunoCompactionStartedAt;
  await refresh();
  await page
    .locator('[data-turn-id="live"] .turn-activity[data-state="working"]')
    .waitFor();
  record("Compaction completion restores Working");
  await page.waitForFunction(() => document.querySelector(".activity-elapsed")?.textContent === "· 2m 07s");
  record("Working resumes the total Turn duration after compaction");

  const summary = { id: "public-summary", type: "reasoning", summary: ["检查布局"], content: [] };
  turn.items.push(summary);
  await refresh();
  const summaryRow = page.locator("#item-public-summary");
  await summaryRow.waitFor();
  await summaryRow.locator(":scope > summary").click();
  await summaryRow.locator("pre").waitFor();
  assert.equal(await summaryRow.locator("pre").textContent(), "检查布局");
  summary.summary = ["检查布局并保留阅读位置。", "Verify the result."];
  await refresh();
  await page.waitForFunction(() => document.querySelector("#item-public-summary pre")?.textContent.includes("Verify the result."));
  assert.equal(await isOpen(summaryRow), true);
  assert.equal(await summaryRow.locator("pre").textContent(), "检查布局并保留阅读位置。\nVerify the result.");
  assert.equal(await page.locator("#item-empty-reasoning").count(), 0);
  record("Public summary sections render and update in an expanded card without remounting");

  agent.status = "idle";
  turn.status = "completed";
  await refresh();
  await timer.waitFor({ state: "detached" });
  record("Completed Turns stop showing a running timer");
  assert.deepEqual(report.mutations, [
    { path: "/api/agents/a/messages", method: "POST" },
  ]);
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(`Passed ${report.checks.length} checks; ${output}/report.json`);
