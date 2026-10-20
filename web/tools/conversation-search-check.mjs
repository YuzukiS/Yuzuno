// Isolated production-bundle checks with explicit fixtures. No Core connection.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { composerDraft, unmanagedUpdates } from "./browser-fixtures.mjs";

const dist = await realpath(
  process.env.YUZUNO_UI_DIST || "/tmp/yuzuno-conversation-search-dist",
);
assert.notEqual(
  dist,
  await realpath("dist"),
  "Use an isolated build, never web/dist.",
);
const output = resolve(
  process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/conversation-search",
);
const baseAgent = {
  cwd: "/fixture",
  model: "test",
  color: "green",
  status: "working",
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  unreadCount: 3,
  pendingCount: 1,
  lastSeq: 30,
  reviewedSeq: 2,
};
const agents = [
  { ...baseAgent, id: "a", name: "Mori", goal: "Conversation search fixture" },
  { ...baseAgent, id: "b", name: "Hana", goal: "Separate conversation" },
];
const filler =
  "This is an unrelated loaded message for reading and scrolling. ".repeat(15);
const turns = Array.from({ length: 12 }, (_, i) => ({
  id: `t${i}`,
  status: i === 11 ? "inProgress" : "completed",
  items: [
    {
      id: `u${i}`,
      type: "userMessage",
      content: [{ type: "text", text: `User ${i}: ${filler}` }],
    },
    {
      id: `p${i}`,
      type: "agentMessage",
      phase: "commentary",
      text: `Progress ${i}: ${filler}`,
    },
    {
      id: `r${i}`,
      type: "agentMessage",
      phase: "final_answer",
      text: `Reply ${i}: ${filler}`,
    },
  ],
}));
turns[2].items = [
  {
    id: "user-target",
    type: "userMessage",
    content: [
      { type: "text", text: "请检查这条中文请求。SearchToken 用户消息。" },
    ],
  },
  {
    id: "progress-target",
    type: "agentMessage",
    phase: "commentary",
    text: "Checking SearchToken, still working outside collapsed tools.",
  },
  {
    id: "tool",
    type: "commandExecution",
    command: "test",
    status: "completed",
    aggregatedOutput: "SearchToken tool-only-secret",
  },
  {
    id: "shared-reply",
    type: "agentMessage",
    phase: "final_answer",
    text: "The SEARCHTOKEN result is ready. SearchToken appears twice in this message.",
  },
];
turns[7].items.push({
  id: "shared-reply",
  type: "agentMessage",
  phase: "final_answer",
  text: "Later SearchToken reply, same item ID but a different turn.",
});
const pending = [
  {
    id: "pending-a",
    agentId: "a",
    method: "item/tool/requestUserInput",
    createdAt: "2026-10-12",
    params: {
      questions: [{ id: "q", question: "A preserved pending question" }],
    },
  },
];
const detail = {
  a: { agent: agents[0], turns, pending, artifacts: [] },
  b: {
    agent: agents[1],
    turns: [
      {
        id: "other-turn",
        status: "completed",
        items: [
          {
            id: "other-reply",
            type: "agentMessage",
            text: "Hana-only conversation text",
          },
        ],
      },
    ],
    pending: [],
    artifacts: [],
  },
};
const requests = [],
  errors = [],
  events = new Set();
const report = {
  mode: "isolated-browser-fixtures",
  dist,
  checks: [],
  browserErrors: errors,
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push({ method: request.method, path: url.pathname });
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": isolated fixture\n\n");
        events.add(response);
        response.on("close", () => events.delete(response));
        return;
      }
      const body =
        url.pathname === "/api/workspace"
          ? { agents, runtime: { connected: true }, defaultCwd: "/fixture" }
          : detail[url.pathname.split("/").at(-1)] || {};
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const file = resolve(
      dist,
      `.${url.pathname === "/" ? "/index.html" : url.pathname}`,
    );
    assert.ok(file.startsWith(dist + sep));
    const content = await readFile(file);
    response.writeHead(200, {
      "Content-Type":
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
        }[extname(file)] || "application/octet-stream",
    });
    response.end(content);
  } catch (error) {
    response.writeHead(404);
    response.end(String(error));
  }
});
let browser, page;
const emit = () => {
  for (const client of events) client.write('data: {"fixture":true}\n\n');
};
const check = (name, details = {}) => report.checks.push({ name, ...details });
try {
  await mkdir(output, { recursive: true });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const trigger = page.getByRole("button", {
    name: "Search conversation",
    exact: true,
  });
  const input = page.getByRole("searchbox", { name: "Search loaded messages" });
  const dialog = page.getByRole("dialog", { name: "Search conversation" });
  const matches = page.locator(".conversation-search-result");
  const conversation = page.locator(".conversation-scroll");
  const composer = page.getByRole("textbox", { name: "Message Mori" });
  await composer.fill("Keep this unsent draft 保留草稿");

  // Both shortcuts focus the search field. Escape cannot reach Interrupt.
  for (const shortcut of ["Control+f", "Meta+f"]) {
    await page.keyboard.press(shortcut);
    await input.waitFor();
    assert.equal(
      await input.evaluate((el) => document.activeElement === el),
      true,
    );
    await input.fill("No such text");
    assert.equal(await matches.count(), 0);
    assert.match(
      await dialog.getByRole("status").innerText(),
      /No messages match/,
    );
    await input.press("Escape");
    await dialog.waitFor({ state: "detached" });
  }
  check("Ctrl/Cmd+F, empty results, Escape closes without interrupt");

  await trigger.click();
  await input.fill("sEaRcHtOkEn");
  assert.equal(await matches.count(), 4);
  assert.match(await matches.nth(0).innerText(), /You[\s\S]*Turn 3/);
  assert.match(
    await matches.nth(1).innerText(),
    /Mori · Progress[\s\S]*Turn 3/,
  );
  assert.match(await matches.nth(2).innerText(), /Mori · Reply[\s\S]*Turn 3/);
  assert.match(await matches.nth(3).innerText(), /Turn 8/);
  await input.fill("tool-only-secret");
  assert.equal(await matches.count(), 0);
  await input.fill("中文请求");
  assert.equal(await matches.count(), 1);
  check(
    "message scope, roles, turn numbers, Chinese, case-insensitivity, no tool output",
  );

  const targets = [
    ["中文请求", 0, "t2", "user-target"],
    ["searchtoken", 1, "t2", "progress-target"],
    ["searchtoken", 2, "t2", "shared-reply"],
    ["searchtoken", 3, "t7", "shared-reply"],
  ];
  for (const [query, index, turnId, itemId] of targets) {
    if (!(await input.isVisible())) await trigger.click();
    await input.fill(query);
    await matches.nth(index).click();
    await dialog.waitFor({ state: "detached" });
    const target = page.locator(
      `[data-turn-id="${turnId}"] [data-item-id="${itemId}"]`,
    );
    await page.waitForFunction(
      ({ turnId, itemId }) =>
        document.activeElement?.dataset.itemId === itemId &&
        document.activeElement.closest("[data-turn-id]")?.dataset.turnId ===
          turnId,
      { turnId, itemId },
    );
    assert.equal(await target.getAttribute("data-search-highlight"), "true");
    const position = await target.evaluate((el) => {
      const row = el.getBoundingClientRect();
      const view = el.closest(".conversation-scroll").getBoundingClientRect();
      return { top: row.top, viewTop: view.top, viewBottom: view.bottom };
    });
    assert.ok(
      position.top >= position.viewTop && position.top < position.viewBottom,
    );
    const before = await conversation.evaluate((el) => el.scrollTop);
    const liveId = `live-${itemId}-${turnId}`;
    turns[11].items.push({
      id: liveId,
      type: "agentMessage",
      phase: "commentary",
      text: `New execution progress ${liveId}. ${filler}`,
    });
    emit();
    await page
      .locator(`[data-item-id="${liveId}"]`)
      .waitFor({ state: "attached" });
    assert.ok(
      Math.abs((await conversation.evaluate((el) => el.scrollTop)) - before) <=
        1,
    );
    assert.equal(
      await composerDraft(composer),
      "Keep this unsent draft 保留草稿",
    );
    assert.equal(await page.locator(".pending-card").count(), 1);
    assert.equal(
      await page.getByRole("button", { name: "Back to latest" }).isVisible(),
      true,
    );
    check("exact jump and reading position survive execution events", {
      turnId,
      itemId,
      position,
    });
  }
  await page.waitForFunction(
    () => !document.querySelector("[data-search-highlight]"),
  );
  check("temporary highlight expires");

  // A jump near the bottom must also stay detached from future output.
  await trigger.click();
  await input.fill("New execution progress live-shared-reply-t7");
  await matches.first().click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(
    () => document.activeElement?.dataset.itemId === "live-shared-reply-t7",
  );
  const nearBottom = await conversation.evaluate((el) => el.scrollTop);
  turns[11].items.push({
    id: "after-near-bottom",
    type: "agentMessage",
    phase: "commentary",
    text: filler.repeat(2),
  });
  emit();
  await page
    .locator('[data-item-id="after-near-bottom"]')
    .waitFor({ state: "attached" });
  assert.ok(
    Math.abs(
      (await conversation.evaluate((el) => el.scrollTop)) - nearBottom,
    ) <= 1,
    `Near-bottom jump moved from ${nearBottom} to ${await conversation.evaluate((el) => el.scrollTop)}`,
  );
  await page.getByRole("button", { name: "Back to latest" }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  turns[11].items.push({
    id: "after-resume",
    type: "agentMessage",
    phase: "commentary",
    text: filler,
  });
  emit();
  await page
    .locator('[data-item-id="after-resume"]')
    .waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const el = document.querySelector(".conversation-scroll");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  check("near-bottom search jump stays put; Back to latest resumes following");

  await trigger.click();
  await input.fill("SearchToken");
  await input.press("Escape");
  await page.locator(".agent-row").filter({ hasText: "Hana" }).click();
  await trigger.click();
  assert.equal(await input.inputValue(), "");
  assert.equal(await matches.count(), 0);
  await input.fill("SearchToken");
  assert.equal(await matches.count(), 0);
  await input.fill("Hana-only");
  assert.equal(await matches.count(), 1);
  await input.press("Escape");
  await page.locator(".agent-row").filter({ hasText: "Mori" }).click();
  await trigger.click();
  assert.equal(await input.inputValue(), "");
  check("agent switch clears query/results and never searches another agent");

  // Exercise both themes at the largest supported reading size and narrow layouts.
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [
      [1440, 960],
      [940, 650],
      [390, 844],
    ]) {
      await input.press("Escape");
      await page.setViewportSize({ width, height });
      await page.evaluate((theme) => {
        localStorage.setItem(
          "yuzuno.appearance",
          JSON.stringify({ theme, fontSize: 20 }),
        );
        window.dispatchEvent(
          new StorageEvent("storage", { key: "yuzuno.appearance" }),
        );
      }, theme);
      await trigger.click();
      await input.fill("message");
      await matches.first().waitFor();
      const layout = await dialog.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const list = el.querySelector(".conversation-search-results");
        return {
          theme: document.documentElement.dataset.theme,
          size: getComputedStyle(
            el.querySelector(".conversation-search-snippet"),
          ).fontSize,
          background: getComputedStyle(el).backgroundColor,
          inViewport:
            rect.x >= 0 &&
            rect.right <= innerWidth &&
            rect.y >= 0 &&
            rect.bottom <= innerHeight,
          noOverflow:
            el.scrollWidth <= el.clientWidth &&
            list.scrollWidth <= list.clientWidth,
          listScrolls: list.scrollHeight > list.clientHeight,
        };
      });
      assert.equal(layout.theme, theme);
      assert.equal(layout.size, "20px");
      assert.equal(layout.inViewport, true);
      assert.equal(layout.noOverflow, true);
      assert.equal(layout.listScrolls, true);
      await page.screenshot({
        path: resolve(output, `search-${theme}-${width}-20px.png`),
        animations: "disabled",
      });
      check("theme and 20px layout", { width, height, ...layout });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET"),
    [],
  );
  assert.equal(agents[0].reviewedSeq, 2);
  assert.equal(detail.a.pending.length, 1);
  report.mutationRequests = 0;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
  await page
    ?.screenshot({ path: resolve(output, "failure.png") })
    .catch(() => {});
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `${report.status}: ${report.checks.length} checks; ${resolve(output, "report.json")}`,
  );
  if (report.error) console.error(report.error);
}
