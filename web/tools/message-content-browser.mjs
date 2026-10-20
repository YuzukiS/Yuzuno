// Isolated built-UI checks. All API/SSE calls use a fixture; no Core or model.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { installConnectionFixture } from "./connection-fixture.mjs";

const output = new URL("../../target/t48/browser/", import.meta.url);
await mkdir(output, { recursive: true });
const base = "http://127.0.0.1:4496";
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4496",
    "--strictPort",
  ],
  { cwd: new URL("../", import.meta.url), stdio: "ignore" },
);
const report = { checks: [], errors: [] };
let browser, page;
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error("Isolated static server exited");
    if (
      await fetch(base).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  context.setDefaultTimeout(10000);
  await context.route("**/api/**", (route) => route.abort());
  await context.addInitScript(installConnectionFixture);
  await context.addInitScript(() => {
    const original = window.fetch;
    const saved = JSON.parse(sessionStorage.getItem("t48-records") || "{}");
    const f = (window.contentFixture = {
      saved,
      posts: [],
      hold: false,
      release: null,
    });
    const summarize = (input) => {
      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      const parts = [];
      let offset = 0;
      for (const block of input.textBlocks || []) {
        if (block.start > offset)
          parts.push({
            kind: "text",
            text: input.text.slice(offset, block.start).slice(0, 80),
          });
        const text = input.text.slice(block.start, block.end),
          label = [...segmenter.segment(text)]
            .slice(0, 10)
            .map((s) => s.segment)
            .join("");
        parts.push({
          kind: "paste",
          ...block,
          label,
          truncated: label.length < text.length,
          preview: text.slice(0, 160),
        });
        offset = block.end;
      }
      if (offset < input.text.length)
        parts.push({
          kind: "text",
          text: input.text.slice(offset).slice(0, 80),
        });
      return parts;
    };
    window.fetch = async (url, init = {}) => {
      const path = new URL(url, location.href).pathname;
      const id = path.match(/^\/api\/agents\/([ab])/)?.[1];
      const json = (body) => ({
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      });
      if (init.method === "POST") {
        if (!path.endsWith("/messages"))
          throw new Error("Unexpected mutation " + path);
        const input = JSON.parse(init.body);
        f.posts.push(input);
        if (f.hold) await new Promise((resolve) => (f.release = resolve));
        const item = {
          id: "user-" + input.clientMessageId,
          type: "userMessage",
          clientId: input.clientMessageId,
          content: [{ type: "text", text: input.text }],
          _yuzunoTextBlocks: input.textBlocks,
        };
        const receipt = {
          input,
          status: "accepted",
          turnId: "pasted-turn",
          binding: { itemId: item.id, turnId: "pasted-turn", userIndex: 0 },
        };
        f.saved[id] = {
          item,
          receipt,
          summary: {
            kind: "task",
            source: "user",
            text: "User request",
            turnId: "pasted-turn",
            itemId: item.id,
            requestParts: summarize(input),
          },
        };
        sessionStorage.setItem("t48-records", JSON.stringify(f.saved));
        return json(receipt);
      }
      if (path.includes("/items/") && path.endsWith("/payload")) {
        const item = f.saved[id].item;
        return json({
          itemId: item.id,
          fields: {
            content: item.content,
            _yuzunoTextBlocks: item._yuzunoTextBlocks,
          },
        });
      }
      const response = await original(url, init),
        body = await response.json();
      if (path === "/api/workspace")
        body.agents = body.agents.map((a) => ({
          ...a,
          status: f.saved[a.id] ? "working" : "idle",
          pendingCount: 0,
          workSummary: f.saved[a.id]?.summary,
        }));
      if (/^\/api\/agents\/[ab]$/.test(path)) {
        body.pending = [];
        body.agent = {
          ...body.agent,
          status: f.saved[id] ? "working" : "idle",
          pendingCount: 0,
          workSummary: f.saved[id]?.summary,
        };
        if (f.saved[id]) {
          body.messageReceipts = [f.saved[id].receipt];
          body.turns = [
            {
              id: "pasted-turn",
              status: "inProgress",
              items: [f.saved[id].item],
            },
          ];
        }
      }
      return json(body);
    };
  });
  page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(e.message));
  const source = "👨‍👩‍👧‍👦e\u0301中文123456" + "\n  full source".repeat(20);
  const raw = "before " + source + " between " + source + " after";
  const label = "👨‍👩‍👧‍👦e\u0301中文123456…";
  await page.goto(base);
  await page.locator("[data-composer-input]").waitFor();
  async function paste(text) {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await page.keyboard.press("Control+V");
  }
  for (const id of ["a", "b"]) {
    if (id === "b")
      await page
        .getByRole("button", { name: "Open Claude fixture", exact: true })
        .click();
    const editor = page.locator("[data-composer-input]");
    await editor.click();
    await page.keyboard.insertText("before ");
    await paste(source);
    await page.keyboard.insertText(" between ");
    await paste(source);
    await page.keyboard.insertText(" after");
    const chips = page.locator(".pasted-text-composer .pasted-text-chip");
    await chips.nth(1).waitFor();
    assert.ok(
      (await chips.allTextContents()).every((t) => t.startsWith(label)),
    );
    const ids = await chips.evaluateAll((nodes) =>
      nodes.map((n) => n.dataset.pasteId),
    );
    await page.evaluate(() => (window.contentFixture.hold = true));
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page.locator(".outgoing-message .pasted-text-chip").nth(1).waitFor();
    assert.ok(
      !(await page.locator(".outgoing-message").textContent()).includes(
        "full source",
      ),
    );
    const sent = await page.evaluate(() => window.contentFixture.posts.at(-1));
    assert.equal(sent.text, raw);
    assert.deepEqual(
      sent.textBlocks.map((b) => b.id),
      ids,
    );
    await page.evaluate(() => window.contentFixture.release());
    await page.locator(".turn .user-text .pasted-text-chip").nth(1).waitFor();
    await page.reload();
    await page.locator(".turn .user-text .pasted-text-chip").nth(1).waitFor();
    assert.equal(
      await page.locator(".pasted-text-composer .pasted-text-chip").count(),
      0,
    );
    assert.deepEqual(
      await page
        .locator(".turn .user-text .pasted-text-chip")
        .evaluateAll((nodes) => nodes.map((n) => n.dataset.pasteId)),
      ids,
    );
    assert.equal(
      await page.locator(".current-turn-excerpt .pasted-text-chip").count(),
      2,
    );
    assert.equal(
      await page
        .locator(
          `[data-agent-id="${id}"] .agent-work-summary .pasted-text-chip`,
        )
        .count(),
      2,
    );
    const history = page.locator(".turn .user-text .pasted-text-chip").first();
    await history.hover();
    const preview = page.locator(".message-text-preview");
    await preview.waitFor();
    assert.ok((await preview.textContent()).length < 850);
    const bounds = await preview.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1440);
    await history.focus();
    await page.keyboard.press("Enter");
    await page.locator(".message-text-source").waitFor();
    assert.equal(
      await page.locator(".message-text-source").textContent(),
      source,
    );
    await page
      .getByRole("button", { name: "Copy full text", exact: true })
      .click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      source,
    );
    await page.keyboard.press("Escape");
    await page.locator(".message-text-source").waitFor({ state: "detached" });
    await page.waitForFunction(
      (id) => document.activeElement?.dataset.pasteId === id,
      ids[0],
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset.pasteId),
      ids[0],
    );
    await page
      .locator(`[data-agent-id="${id}"] .agent-work-summary .pasted-text-chip`)
      .nth(1)
      .click();
    await page.locator(".message-text-source").waitFor();
    assert.equal(
      await page.locator(".message-text-source").textContent(),
      source,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Copy turn", exact: true }).click();
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes(raw));
    await page.screenshot({
      path: new URL(`${id}-blocks.png`, output).pathname,
      animations: "disabled",
    });
    report.checks.push(
      `${id === "a" ? "Codex" : "Claude"} composer → sending → history/Your request/rail, native clipboard, full viewer, focus, reload`,
    );
  }
  await page
    .getByRole("button", { name: "Open Codex fixture", exact: true })
    .click();
  await page.locator(".turn .user-text .pasted-text-chip").nth(1).waitFor();
  assert.ok(
    !(await page.locator(".turn .user-text").textContent()).includes(
      "full source",
    ),
  );
  report.checks.push(
    "Switching Agents retains ordered blocks without full closed-source DOM",
  );
  await page.evaluate(() =>
    localStorage.setItem(
      "yuzuno.appearance",
      JSON.stringify({ theme: "dark", palette: "garden", fontSize: 20 }),
    ),
  );
  await page.reload();
  await page.locator(".turn .user-text .pasted-text-chip").nth(1).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".turn .user-text .pasted-text-chip").first().click();
  const modal = page.getByRole("dialog");
  await modal.waitFor();
  assert.equal(
    await page
      .locator(".message-text-source")
      .evaluate((el) => getComputedStyle(el).fontSize),
    "20px",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  const box = await modal.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({
    path: new URL("narrow-viewer.png", output).pathname,
    animations: "disabled",
  });
  report.checks.push("Narrow viewport full viewer is bounded");
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack;
  if (page)
    await page
      .screenshot({ path: new URL("failure.png", output).pathname })
      .catch(() => {});
  throw error;
} finally {
  await writeFile(
    new URL("report.json", output),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  server.kill();
}
