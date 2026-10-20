// Controlled native-shaped question/SSE events through the built GUI. Every
// request is intercepted; no Core, native session, or user window is used.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST && process.env.YUZUNO_BROWSER_OUTPUT);
const dist = resolve(process.env.YUZUNO_UI_DIST),
  output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
assert.ok(!dist.endsWith("/web/dist"));
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:4491";
const report = {
  checks: [],
  errors: [],
  screenshots: [],
  performance: {},
  fixture:
    "Real Chromium production GUI; native-shaped question events, all HTTP/SSE controlled; no native model/Core execution.",
};
const check = (text) => {
  report.checks.push(text);
  console.log("PASS", text);
};
const question = (id, title) => ({
  id,
  type: "agentMessage",
  phase: "commentary",
  delivery: "async",
  questions: [{ title, options: ["Yuzu", "Sage"] }],
});
const a = {
  id: "a",
  name: "Mori",
  harness: "codex",
  threadId: "fixture-thread",
  cwd: "/fixture",
  goal: "",
  model: "fixture",
  color: "sage",
  status: "working",
  connectionState: "connected",
  createdAt: "",
  updatedAt: "",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  rev: 1,
};
const b = { ...a, id: "b", name: "Hana", threadId: "fixture-b" };
const old = question(
  "q1",
  "Which garden should we use? 中文问题 stays available while the agent keeps working.",
);
const detail = {
  a: {
    agent: a,
    turns: [
      { id: "old", status: "completed", items: [old] },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `t-${i}`,
        status: "completed",
        items: [
          {
            id: `r-${i}`,
            type: "agentMessage",
            text:
              `Earlier output ${i}.\n` +
              "A long running log remains in history. ".repeat(50),
          },
        ],
      })),
      {
        id: "live",
        status: "inProgress",
        items: [
          {
            id: "stream",
            type: "agentMessage",
            phase: "commentary",
            text: "Working through the logs. ",
          },
        ],
      },
    ],
    pending: [],
    artifacts: [],
    messageReceipts: [],
    history: { hasMore: true, nextCursor: "older", loadedCount: 42 },
  },
  b: { agent: b, turns: [], pending: [], artifacts: [], messageReceipts: [] },
};
const historic = {
  id: "imported-old",
  status: "completed",
  items: [
    question(
      "historical",
      "Old imported question whose answer status is unconfirmed",
    ),
  ],
};
const calls = [];
let mode = "accept";
let browser;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
try {
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    assert.equal(url.origin, origin);
    if (!url.pathname.startsWith("/api/")) {
      const file = resolve(
        dist,
        url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      );
      assert.ok(file.startsWith(dist + "/"));
      return route.fulfill({
        status: 200,
        contentType: mime[extname(file)] || "application/octet-stream",
        body: await readFile(file),
      });
    }
    const data = request.postDataJSON();
    calls.push({ path: url.pathname, method: request.method(), data });
    const reply = (body) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/workspace")
      return reply({
        agents: [a, b],
        workspace: { id: "t41-browser" },
        runtime: { connected: true },
        defaultCwd: "/fixture",
        projects: [],
      });
    if (/^\/api\/agents\/[ab]$/.test(url.pathname))
      return reply(detail[url.pathname.at(-1)]);
    if (url.pathname.endsWith("/history"))
      return reply({ turns: [historic], hasMore: false, nextCursor: null });
    if (url.pathname.endsWith("/messages")) {
      const receipt = {
        input: data,
        status:
          mode === "reject"
            ? "rejected"
            : mode === "lost"
              ? "uncertain"
              : "accepted",
        turnId: "live",
        error:
          mode === "reject" ? "Fixture rejected the answer; draft kept" : null,
      };
      detail.a.messageReceipts.push(receipt);
      a.rev++;
      if (mode === "lost") return route.abort("connectionreset");
      return reply(receipt);
    }
    if (url.pathname.endsWith("/reconnect") || url.pathname.endsWith("/review"))
      return reply({});
    if (url.pathname === "/api/models") return reply({ models: [] });
    if (url.pathname === "/api/machines") return reply({ machines: [] });
    if (url.pathname === "/api/catchup")
      return reply({ items: [], agents: [] });
    if (url.pathname.includes("/collaboration/"))
      return reply({ tasks: [], messages: [], agents: [] });
    if (url.pathname === "/api/updates") return reply({ managed: false });
    assert.equal(
      request.method(),
      "GET",
      `Unexpected mutation ${url.pathname}`,
    );
    return reply({});
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("t41-seeded")) {
      localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
      localStorage.setItem(
        "yuzuno.appearance",
        JSON.stringify({ theme: "light", fontSize: 20, palette: "garden" }),
      );
      localStorage.setItem("t41-seeded", "yes");
    }
    window.questionStreams = [];
    window.EventSource = class {
      constructor() {
        this.readyState = 0;
        this.closed = false;
        window.questionStreams.push(this);
        setTimeout(() => {
          if (!this.closed) {
            this.readyState = 1;
            this.onopen?.({});
            // Core completes the SSE handshake; without this the real hook
            // correctly resets/refetches after START_WAIT_MS (800 ms).
            this.onmessage?.({ data: JSON.stringify({ type: "resumed" }) });
          }
        }, 0);
      }
      close() {
        this.closed = true;
        this.readyState = 2;
      }
    };
    window.emitQuestionEvent = (event) =>
      window.questionStreams
        .filter((s) => !s.closed)
        .at(-1)
        ?.onmessage?.({ data: JSON.stringify(event) });
    window.questionStorage = { writes: [], reads: [] };
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      window.questionStorage.reads.push(key);
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      window.questionStorage.writes.push({ key, length: value.length });
      return set.call(this, key, value);
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => report.errors.push(error.message));
  await page.goto(origin);
  const dock = page.locator(".question-dock-open"),
    field = () => page.locator('.async-question input[type="text"]');
  await dock.waitFor();
  assert.match(await dock.innerText(), /· 1/);
  assert.equal(
    await page.locator(".conversation-scroll .pending-questions").count(),
    0,
  );
  const composer = page.locator("[data-composer-input]");
  report.alignment = [];
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1600, 1440, 1101, 1100, 721, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const box = await page.locator(".pending-questions").boundingBox();
      const input = await page.locator(".composer").boundingBox();
      assert.ok(Math.abs(box.x - input.x) <= 1, `Left alignment at ${width}`);
      assert.ok(Math.abs(box.x + box.width - input.x - input.width) <= 1, `Right alignment at ${width}`);
      assert.equal(await page.locator(".pending-questions").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
      report.alignment.push({ theme, width, dockLeft: box.x, composerLeft: input.x, dockWidth: box.width, composerWidth: input.width });
      if ([1600, 390].includes(width)) {
        const file = `${theme}-20px-${width}-aligned.png`;
        await page.screenshot({ path: resolve(output, file) });
        report.screenshots.push(file);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  check("dock and composer share exact edges in both themes at 1600/1440/1101/1100/721/720/390px and 20px text");

  await composer.fill("Keep the ordinary composer draft.");
  await page.locator(".conversation-scroll").evaluate((el) => {
    el.scrollTop = 200;
    el.dispatchEvent(new Event("wheel", { bubbles: true }));
  });
  const scrollBefore = await page
    .locator(".conversation-scroll")
    .evaluate((el) => el.scrollTop);
  const added = question(
    "q2",
    "A second native question arrives during continuing output",
  );
  detail.a.turns.at(-1).items.push(added);
  await page.evaluate((event) => window.emitQuestionEvent(event), {
    type: "agent.item",
    agentId: "a",
    turnId: "live",
    rev: ++a.rev,
    item: added,
  });
  await page.waitForFunction(() =>
    document.querySelector(".question-dock-open")?.textContent.includes("· 2"),
  );
  assert.equal(
    await composer.evaluate((el) => document.activeElement === el),
    true,
  );
  assert.ok(
    Math.abs(
      (await page
        .locator(".conversation-scroll")
        .evaluate((el) => el.scrollTop)) - scrollBefore,
    ) < 5,
  );
  check(
    "a native-shaped question event adds the fixed entry without scrolling history or stealing composer focus",
  );

  await dock.click();
  await field().fill("A durable answer 中文");
  await page
    .getByRole("button", { name: "Original question", exact: true })
    .click();
  await page.waitForFunction(
    () => document.activeElement?.dataset.itemId === "q1",
  );
  await page
    .locator('[data-item-id="q1"]')
    .getByRole("button", { name: "View question and answer" })
    .click();
  assert.equal(await field().inputValue(), "A durable answer 中文");
  assert.equal(await page.locator(".async-question").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page.getByRole("heading", { name: "Hana", exact: true }).waitFor();
  assert.equal(await dock.count(), 0);
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await dock.waitFor();
  await dock.click();
  assert.equal(await field().inputValue(), "A durable answer 中文");
  await page.keyboard.press("Escape");
  await page.reload();
  await dock.waitFor();
  await dock.click();
  assert.equal(await field().inputValue(), "A durable answer 中文");
  check(
    "one form and persisted question draft survive source navigation, Agent switching and reload",
  );

  await page.waitForLoadState("networkidle");
  const beforeCalls = calls.length;
  await page.evaluate(() => {
    window.questionStorage.reads = [];
    window.questionStorage.writes = [];
  });
  const start = Date.now();
  for (let i = 0; i < 60; i++) {
    const event = {
      type: "agent.delta",
      agentId: "a",
      rev: ++a.rev,
      turnId: "live",
      itemId: "stream",
      op: "append",
      field: "text",
      text: ` stream-${i}`,
    };
    detail.a.turns.at(-1).items[0].text += event.text;
    await page.evaluate((event) => window.emitQuestionEvent(event), event);
    await field().pressSequentially("x");
  }
  const storage = await page.evaluate(() => window.questionStorage);
  report.performance.calls = calls.slice(beforeCalls);
  assert.equal(
    storage.reads.filter(
      (k) => k === "yuzuno.outbox" || k.startsWith("yuzuno.paste."),
    ).length,
    0,
  );
  assert.ok(storage.writes.length >= 60);
  assert.ok(
    storage.writes.every((w) => w.key.startsWith("yuzuno.question-draft.v1:")),
  );
  assert.equal(
    calls
      .slice(beforeCalls)
      .filter(
        (c) => /^\/api\/agents\/a$/.test(c.path) || c.path.endsWith("/history"),
      ).length,
    0,
  );
  report.performance = {
    durationMs: Date.now() - start,
    streamedDeltas: 60,
    answerEdits: 60,
    draftWrites: storage.writes.length,
    maxWriteLength: Math.max(...storage.writes.map((w) => w.length)),
    outboxOrPasteReads: 0,
    detailOrHistoryFetches: 0,
  };
  check(
    "answer typing during streamed logs writes only its own small draft without body reads or history/detail refetches",
  );

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const [width, height] of [
      [1440, 1000],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const dialog = page.getByRole("dialog");
      const box = await dialog.boundingBox();
      assert.ok(
        box.x >= -1 &&
          box.x + box.width <= width + 1 &&
          box.y >= -1 &&
          box.y + box.height <= height + 1,
      );
      assert.equal(
        await field().evaluate((el) => getComputedStyle(el).fontSize),
        "20px",
      );
      const name = `${theme}-20px-${width}-answer.png`;
      await page.screenshot({ path: resolve(output, name) });
      report.screenshots.push(name);
    }
    await page.keyboard.press("Escape");
    const name = `${theme}-20px-390-dock.png`;
    const rect = await page.locator(".pending-questions").boundingBox();
    const composerRect = await composer.boundingBox();
    assert.ok(rect.y >= 0 && rect.y + rect.height <= composerRect.y);
    await page.screenshot({ path: resolve(output, name) });
    report.screenshots.push(name);
    await dock.click();
  }
  check(
    "light/dark 20px layouts fit desktop and 390px screens without covering the composer",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  mode = "reject";
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Fixture rejected" })
    .waitFor();
  assert.match(await dock.innerText(), /Answer needs attention/);
  mode = "accept";
  await page
    .getByRole("button", { name: "Send answer", exact: true })
    .dblclick();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 2);
  await page.keyboard.press("Escape");
  assert.match(await dock.innerText(), /· 1/);
  assert.equal(await composer.innerText(), "Keep the ordinary composer draft.");
  check(
    "rejection keeps the answer visible; explicit retry sends once and only acceptance removes it",
  );
  await dock.click();
  await field().fill("Keep the uncertain answer");
  mode = "lost";
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Delivery unconfirmed", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Delivery unconfirmed", exact: true })
      .isDisabled(),
    true,
  );
  await page.reload();
  await dock.waitFor();
  assert.match(await dock.innerText(), /Delivery unconfirmed/);
  await dock.click();
  assert.equal(await field().inputValue(), "Keep the uncertain answer");
  detail.a.messageReceipts.at(-1).status = "accepted";
  a.rev++;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Check delivery" })
    .click();
  await page
    .getByRole("button", { name: "Answer sent", exact: true })
    .waitFor();
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 3);
  check(
    "transport uncertainty survives reload and receipt reconciliation clears it without resending",
  );
  await page.keyboard.press("Escape");
  assert.equal(await dock.count(), 0);
  assert.equal(await page.locator(".pending-questions").count(), 0);
  assert.match(await page.locator(".session-history-loader").innerText(), /Earlier history has not been checked/);
  check("all accepted plus hasMore leaves no fixed card; history notice stays at the conversation top");
  for (const id of ["dismiss-one", "dismiss-two"]) {
    const item = question(id, `New unanswered question ${id}`);
    detail.a.turns.at(-1).items.push(item);
    await page.evaluate(event => window.emitQuestionEvent(event), { type: "agent.item", agentId: "a", turnId: "live", rev: ++a.rev, item });
  }
  await page.waitForFunction(() => document.querySelector(".question-dock-open")?.textContent.includes("· 2"));
  await dock.click();
  await field().fill("Dismissed answer 中文 remains saved");
  await page.getByRole("dialog").getByRole("button", { name: "Dismiss question", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Dismiss question", exact: true }).click();
  assert.equal(await dock.count(), 0);
  await page.getByRole("button", { name: "Open Hana", exact: true }).click();
  await page.getByRole("heading", { name: "Hana", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open Mori", exact: true }).click();
  await page.getByRole("heading", { name: "Mori", exact: true }).waitFor();
  assert.equal(await dock.count(), 0);
  await page.reload();
  await page.getByRole("heading", { name: "Mori", exact: true }).waitFor();
  assert.equal(await dock.count(), 0);
  await page.locator('[data-item-id="dismiss-one"]').getByRole("button", { name: "View question and answer" }).click();
  assert.equal(await field().inputValue(), "Dismissed answer 中文 remains saved");
  await page.getByRole("button", { name: "Restore to questions", exact: true }).click();
  assert.match(await dock.innerText(), /· 1/);
  await page.getByRole("dialog").getByRole("button", { name: "Dismiss question", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await dock.count(), 0);
  assert.equal(calls.filter(c => c.path.endsWith("/messages")).length, 3);
  check("multiple explicit dismissals survive switching and reload; source restore keeps the exact draft and sends nothing");
  const reads = calls.filter((c) => c.path.endsWith("/history")).length;
  assert.equal(await page.locator(".pending-questions").count(), 0);
  await page.locator(".session-history-loader").scrollIntoViewIfNeeded();
  assert.equal(calls.filter((c) => c.path.endsWith("/history")).length, reads);
  await page.getByRole("button", { name: "Load earlier turns" }).click();
  const anchor = page.locator('[data-item-id="historical"]');
  await anchor.waitFor();
  assert.match(
    await anchor.innerText(),
    /Historical question · answer status unconfirmed/,
  );
  assert.equal(await dock.count(), 0);
  await anchor
    .getByRole("button", { name: "View historical question" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .count(),
    0,
  );
  await field().fill("Reference only");
  await page.getByRole("button", { name: "Add answer to draft" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.querySelector("[data-composer-input]")?.textContent.includes("Reference only"),
  );
  assert.match(await composer.innerText(), /Reference only/);
  assert.equal(calls.filter((c) => c.path.endsWith("/messages")).length, 3);
  check(
    "manual history paging shows unconfirmed historical questions without a false pending count or unsupported direct send",
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error);
  throw error;
} finally {
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser?.close();
}
