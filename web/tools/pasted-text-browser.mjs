// Isolated production-build acceptance. Start `vite preview --port 4485
// --strictPort` in this worktree. Every API/SSE operation uses the fixture;
// nothing contacts a Core, CLI, account or user browser.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { installConnectionFixture } from "./connection-fixture.mjs";

const base = process.env.T33_UI_URL || "http://127.0.0.1:4485";
const output = new URL("../../target/t33/browser-r2-final/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], requests: [], performance: {} };
const browser = await chromium.launch({
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  hasTouch: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
context.setDefaultTimeout(10_000);
context.on("page", (p) =>
  p.on("pageerror", (e) => report.errors.push(e.message)),
);
context.on("request", (r) =>
  report.requests.push({ url: r.url(), method: r.method() }),
);
await context.route("**/api/**", (route) => route.abort());
await context.addInitScript(installConnectionFixture);
await context.addInitScript(() => {
  const original = window.fetch;
  const f = (window.pasteFixture = {
    sent: [],
    failNext: false,
    writes: [],
    outboxReads: 0,
    bodyReads: 0,
    pastes: 0,
  });
  document.addEventListener("paste", () => f.pastes++);
  const get = Storage.prototype.getItem,
    set = Storage.prototype.setItem;
  Storage.prototype.getItem = function (key) {
    if (key === "yuzuno.outbox") f.outboxReads++;
    if (key.startsWith("yuzuno.paste.v1:")) f.bodyReads++;
    return get.call(this, key);
  };
  Storage.prototype.setItem = function (key, value) {
    const start = performance.now();
    set.call(this, key, value);
    f.writes.push({ key, length: value.length, ms: performance.now() - start });
  };
  window.fetch = async (url, init = {}) => {
    const path = new URL(url, location.href).pathname;
    if (init.method === "POST") {
      if (!/\/agents\/[ab]\/(messages|turns)$/.test(path))
        throw new Error("Unexpected fixture mutation " + path);
      const input = JSON.parse(init.body);
      f.sent.push({ path, input });
      if (new TextEncoder().encode(input.text).length > 100_000) {
        return {
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({
              code: "message_not_submitted",
              error: "Fixture limit: 100,000 UTF-8 bytes",
            }),
        };
      }
      if (f.failNext) {
        f.failNext = false;
        throw new Error("Fixture response lost");
      }
      return {
        ok: true,
        json: async () => ({
          input,
          status: "accepted",
          turnId: "fixture-send",
        }),
      };
    }
    const response = await original(url, init);
    if (/^\/api\/agents\/[ab]$/.test(path)) {
      const body = await response.json();
      body.agent.rev = 1;
      body.pending = [];
      body.turns.unshift(
        ...Array.from({ length: 80 }, (_, i) => ({
          id: `history-${i}`,
          status: "completed",
          items: [
            {
              id: `request-${i}`,
              type: "userMessage",
              content: [{ type: "text", text: `Review ${i}` }],
            },
            {
              id: `answer-${i}`,
              type: "agentMessage",
              phase: "final_answer",
              text:
                `## Result ${i}\n\n` +
                "Some **rendered** output with a [link](https://example.invalid).\n\n".repeat(
                  8,
                ),
            },
          ],
        })),
      );
      return { ok: true, json: async () => body };
    }
    return response;
  };
});
const page = await context.newPage();
const input = () => page.locator("[data-composer-input]");
const chips = () => page.locator(".pasted-text-chip");
const ids = () =>
  chips().evaluateAll((els) => els.map((el) => el.dataset.pasteId));
const saved = (id = "a") =>
  page.evaluate((id) => {
    const draft = JSON.parse(
      localStorage.getItem("yuzuno.composer.v1:" + id) || '{"parts":[]}',
    );
    return draft.parts
      .map((p) =>
        p.kind === "text"
          ? p.text
          : localStorage.getItem("yuzuno.paste.v1:" + id + ":" + p.bodyId),
      )
      .join("");
  }, id);
async function settled(expected, id = "a") {
  await page.waitForFunction(
    ({ expected, id }) => {
      const draft = JSON.parse(
        localStorage.getItem("yuzuno.composer.v1:" + id) || '{"parts":[]}',
      );
      return (
        draft.parts
          .map((p) =>
            p.kind === "text"
              ? p.text
              : localStorage.getItem("yuzuno.paste.v1:" + id + ":" + p.bodyId),
          )
          .join("") === expected
      );
    },
    { expected, id },
  );
}
async function paste(text, native = false) {
  await input().focus();
  if (native) {
    await page.evaluate((text) => navigator.clipboard.writeText(text), text);
    await page.keyboard.press("Control+v");
  } else {
    await input().evaluate((el, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    }, text);
  }
}
const check = async (name, fn) => {
  await fn();
  report.checks.push(name);
  console.log("PASS " + name);
};
const raw = "  line\r\n\t中文\r\n\r\n".repeat(12),
  single = "x".repeat(2100);
let blockIds;
try {
  await page.goto(base);
  await input().waitFor();
  await check(
    "short/native and long/CRLF pastes, selection replacement, repeated blocks and surrounding text",
    async () => {
      await paste("short text", true);
      await settled("short text");
      assert.equal(await chips().count(), 0);
      await input().press("Shift+Enter");
      await page.keyboard.type("note");
      await settled("short text\nnote");
      await input().fill("before REPLACE");
      await input().press("Control+End");
      await input().press("Control+Shift+ArrowLeft");
      await paste(raw);
      await page.keyboard.type(" between ");
      await paste(single, true);
      await page.keyboard.type(" after");
      await settled("before " + raw + " between " + single + " after");
      assert.equal(await chips().count(), 2);
      blockIds = await ids();
      assert.equal(new Set(blockIds).size, 2);
      await input().press("Alt+Shift+ArrowDown");
      await settled("before " + raw + " between " + single + " after");
      assert.deepEqual(await ids(), blockIds);
      await paste(raw);
      assert.equal(await chips().count(), 3);
      const threeIds = await ids();
      await input().press("Backspace");
      await settled("before " + raw + " between " + single + " after");
      await input().press("Control+z");
      assert.deepEqual(await ids(), threeIds);
      await input().press("ArrowLeft");
      await input().press("Delete");
      await settled("before " + raw + " between " + single + " after");
      await input().press("Control+z");
      assert.deepEqual(await ids(), threeIds);
      await input().press("Control+z");
      await settled("before " + raw + " between " + single + " after");
      assert.deepEqual(await ids(), blockIds);
      await input().press("Control+y");
      assert.equal(await chips().count(), 3);
      await input().press("Control+z");
    },
  );
  await check(
    "bounded hover, keyboard/touch full view, selectable raw text, edit/remove/undo and portal focus",
    async () => {
      await chips().first().hover();
      await page.locator(".pasted-text-preview").waitFor();
      assert.ok(
        (await page.locator(".pasted-text-preview pre").textContent()).length <=
          800,
      );
      await input().press("Escape");
      await page.locator(".pasted-text-preview").waitFor({ state: "hidden" });
      await chips().first().focus();
      await page.keyboard.press("Enter");
      const full = page.getByLabel("Full pasted text");
      await full.waitFor();
      assert.equal(await full.inputValue(), raw.replaceAll("\r\n", "\n"));
      await full.press("Control+a");
      await full.press("Control+c");
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        raw.replaceAll("\r\n", "\n"),
      );
      await full.fill("  edited\n\n");
      await page.getByRole("button", { name: "Save changes" }).click();
      await settled("before   edited\r\n\r\n between " + single + " after");
      await chips().first().tap();
      await full.waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (id) => document.activeElement?.dataset.pasteId === id,
        blockIds[0],
      );
      assert.equal(
        await page.evaluate(() => document.activeElement?.dataset.pasteId),
        blockIds[0],
      );
      await chips().first().click();
      await page.getByRole("button", { name: "Remove block" }).click();
      assert.equal(await chips().count(), 1);
      await input().focus();
      await input().press("Control+z");
      assert.deepEqual(await ids(), blockIds);
      assert.equal(await page.evaluate(() => pasteFixture.sent.length), 0);
      await page.getByLabel("Ask for an interactive result").click();
      await page.locator('[role="dialog"]').waitFor();
      await page.locator(".modal-overlay").click({ position: { x: 5, y: 5 } });
      assert.equal(
        await input().evaluate((el) => document.activeElement === el),
        false,
      );
      await page.keyboard.press("Escape");
      await page.locator(".composer-bottom > span").click();
      await page.keyboard.type(" end");
      await settled("before   edited\r\n\r\n between " + single + " after end");
    },
  );
  await check(
    "Agent switching and reload preserve exact bodies, stable IDs and ordering",
    async () => {
      await page
        .locator(".agent-row")
        .filter({ hasText: "Claude fixture" })
        .click();
      await input().fill("Claude draft");
      await settled("Claude draft", "b");
      await page
        .locator(".agent-row")
        .filter({ hasText: "Codex fixture" })
        .click();
      assert.deepEqual(await ids(), blockIds);
      await input().focus();
      await input().press("Control+z");
      await settled("before   edited\r\n\r\n between " + single + " after");
      await input().press("Control+y");
      await settled("before   edited\r\n\r\n between " + single + " after end");
      await page.reload();
      await input().waitFor();
      assert.deepEqual(await ids(), blockIds);
      await settled("before   edited\r\n\r\n between " + single + " after end");
    },
  );
  await check(
    "native select-all copy/cut expands full blocks; undo and redo restore text and IDs",
    async () => {
      const before = await saved();
      await input().focus();
      await input().press("Control+a");
      await input().press("Control+c");
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        before,
      );
      await input().press("Control+x");
      await settled("");
      await input().press("Control+z");
      await settled(before);
      assert.deepEqual(await ids(), blockIds);
      await input().press("Control+y");
      await settled("");
      await input().press("Control+z");
      await settled(before);
    },
  );
  await check(
    "two real pages restore stale bodies after the other page sends or removes a block",
    async () => {
      for (const action of ["send", "remove"]) {
        await input().fill("");
        await paste(raw);
        const originalIds = await ids();
        const other = await context.newPage();
        try {
          await other.goto(base);
          const field = other.locator("[data-composer-input]");
          await other.locator(".pasted-text-chip").waitFor();
          if (action === "send") await input().press("Enter");
          else {
            await chips().first().click();
            await page.getByRole("button", { name: "Remove block" }).click();
          }
          await settled("");
          assert.equal(
            await page.evaluate(
              () =>
                Object.keys(localStorage).filter((k) =>
                  k.startsWith("yuzuno.paste.v1:a:"),
                ).length,
            ),
            0,
          );
          await field.focus();
          await field.press("Control+End");
          await other.keyboard.type("!");
          await settled(raw + "!");
          await page.reload();
          await chips().first().waitFor();
          assert.deepEqual(await ids(), originalIds);
          await settled(raw + "!");
          assert.equal(await input().getAttribute("contenteditable"), "true");
        } finally {
          await other.close();
        }
      }
    },
  );
  await check(
    "missing body recovery requires confirmation, survives reload and leaves other Agents intact",
    async () => {
      const kept = await saved("b");
      const manifest = await page.evaluate(() =>
        localStorage.getItem("yuzuno.composer.v1:a"),
      );
      await page.evaluate(() => {
        for (const key of Object.keys(localStorage))
          if (key.startsWith("yuzuno.paste.v1:a:"))
            localStorage.removeItem(key);
      });
      await page.reload();
      await page.getByRole("button", { name: "Reset saved draft…" }).waitFor();
      assert.equal(await input().getAttribute("contenteditable"), "false");
      await page.getByRole("button", { name: "Reset saved draft…" }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(
        await page.evaluate(() => localStorage.getItem("yuzuno.composer.v1:a")),
        manifest,
      );
      await page.getByRole("button", { name: "Reset saved draft…" }).click();
      await page.screenshot({
        path: new URL("recovery-confirmation.png", output).pathname,
      });
      await page.evaluate(() => {
        window.restoreStorageSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === "yuzuno.composer.v1:a")
            throw new Error("Fixture denied reset");
          return window.restoreStorageSet.call(this, key, value);
        };
      });
      await page
        .getByRole("button", { name: "Discard saved draft", exact: true })
        .click();
      await page.locator('[role="dialog"] [role="alert"]').waitFor();
      assert.equal(await input().getAttribute("contenteditable"), "false");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("yuzuno.composer.v1:a")),
        manifest,
      );
      await page.screenshot({
        path: new URL("recovery-failure.png", output).pathname,
      });
      await page.evaluate(() => {
        Storage.prototype.setItem = window.restoreStorageSet;
        delete window.restoreStorageSet;
      });
      await page
        .getByRole("button", { name: "Discard saved draft", exact: true })
        .click();
      await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
      await input().fill("recovered");
      await settled("recovered");
      await page.reload();
      await input().waitFor();
      assert.equal(await input().getAttribute("contenteditable"), "true");
      await settled("recovered");
      assert.equal(await saved("b"), kept);
      assert.equal(await page.evaluate(() => pasteFixture.sent.length), 0);
    },
  );
  await check(
    "internal long plain-text drag moves once; an external long-text drop still folds",
    async () => {
      const long = "drag".repeat(510);
      await input().fill("end\n" + long);
      await input().press("Control+End");
      await input().press("Control+Shift+Home");
      for (let i = 0; i < 4; i++) await input().press("Shift+ArrowRight");
      await input().evaluate((el) => {
        const dt = new DataTransfer();
        el.dispatchEvent(
          new DragEvent("dragstart", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
        const r = el.querySelector(".cm-line").getBoundingClientRect();
        el.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: r.left + 0.1,
            clientY: r.top + r.height / 2,
          }),
        );
        el.dispatchEvent(
          new DragEvent("dragend", { bubbles: true, dataTransfer: dt }),
        );
      });
      await settled(long + "end\n");
      assert.equal(await chips().count(), 0);
      await input().press("Control+z");
      await settled("end\n" + long);
      await input().fill("");
      await input().evaluate((el, long) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", long);
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: r.left + 10,
            clientY: r.top + 20,
          }),
        );
      }, long);
      await settled(long);
      assert.equal(await chips().count(), 1);
    },
  );
  await check(
    "both Harnesses keep large failed drafts across reload; Codex retry identity survives without reparsing on keystrokes",
    async () => {
      for (const [id, name] of [
        ["a", "Codex fixture"],
        ["b", "Claude fixture"],
      ]) {
        await page.locator(".agent-row").filter({ hasText: name }).click();
        await input().fill("  ");
        await input().press("Control+End");
        const large = raw.repeat(250);
        await paste(large);
        await page.keyboard.type("  ");
        const expected = "  " + large + "  ";
        await settled(expected, id);
        const beforeIds = await ids();
        await page.evaluate(() => {
          pasteFixture.failNext = true;
        });
        await input().press("Enter");
        await page
          .getByText("Fixture response lost", { exact: false })
          .first()
          .waitFor();
        await settled(expected, id);
        assert.deepEqual(await ids(), beforeIds);
        const first = await page.evaluate(() => pasteFixture.sent.at(-1));
        await page.reload();
        await input().waitFor();
        await settled(expected, id);
        assert.deepEqual(await ids(), beforeIds);
        const reads = await page.evaluate(() => pasteFixture.outboxReads);
        await input().press("Control+End");
        await page.keyboard.type("x".repeat(30));
        for (let i = 0; i < 30; i++) await page.keyboard.down("Backspace");
        await page.keyboard.up("Backspace");
        await settled(expected, id);
        assert.equal(
          await page.evaluate(() => pasteFixture.outboxReads),
          reads,
        );
        await input().press("Enter");
        await settled("", id);
        const retry = await page.evaluate(() => pasteFixture.sent.at(-1));
        assert.equal(first.input.text, expected);
        assert.equal(retry.input.text, expected);
        if (id === "a")
          assert.equal(
            first.input.clientMessageId,
            retry.input.clientMessageId,
          );
      }
    },
  );
  await check(
    "UTF-8 byte-limit rejection retains the complete Chinese draft for both Harnesses",
    async () => {
      const oversized = "中".repeat(34_000);
      for (const [id, name] of [
        ["a", "Codex fixture"],
        ["b", "Claude fixture"],
      ]) {
        await page.locator(".agent-row").filter({ hasText: name }).click();
        await paste(oversized);
        await settled(oversized, id);
        const beforeIds = await ids();
        await input().press("Enter");
        await page
          .getByText("Fixture limit: 100,000 UTF-8 bytes", { exact: false })
          .first()
          .waitFor();
        await settled(oversized, id);
        assert.deepEqual(await ids(), beforeIds);
        assert.equal(
          await page.evaluate(() => pasteFixture.sent.at(-1).input.text),
          oversized,
        );
        await input().fill("");
        await settled("", id);
      }
    },
  );
  await check(
    "Chinese IME commits next to an atomic block; composing Enter does not send",
    async () => {
      await paste(raw);
      await input().press("Control+End");
      const sent = await page.evaluate(() => pasteFixture.sent.length);
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.imeSetComposition", {
        text: "ni",
        selectionStart: 2,
        selectionEnd: 2,
      });
      await cdp.send("Input.imeSetComposition", {
        text: "你",
        selectionStart: 1,
        selectionEnd: 1,
      });
      await input().evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await cdp.send("Input.insertText", { text: "你好" });
      await settled(raw + "你好", "b");
      assert.equal(await page.evaluate(() => pasteFixture.sent.length), sent);
      await input().press("Control+a");
      await input().press("Backspace");
      await settled("", "b");
    },
  );
  await check(
    "large paste stays compact while typing and holding Backspace under streamed long history",
    async () => {
      const huge = "large plain text\n".repeat(30_000);
      await paste(huge);
      await settled(huge, "b");
      assert.ok(await input().evaluate((el) => el.textContent.length < 100));
      await page.evaluate(() => {
        pasteFixture.writes = [];
        pasteFixture.bodyReads = 0;
        pasteFixture.longTasks = [];
        pasteFixture.streamCount = 0;
        new PerformanceObserver((list) =>
          pasteFixture.longTasks.push(
            ...list.getEntries().map((e) => e.duration),
          ),
        ).observe({ type: "longtask", buffered: false });
        let rev = 1;
        pasteFixture.stream = setInterval(() => {
          const stream = connectionFixture.streams
            .filter((s) => !s.closed)
            .at(-1);
          stream?.onmessage?.({
            data: JSON.stringify({
              type: "agent.delta",
              agentId: "b",
              rev: ++rev,
              turnId: "turn-b",
              itemId: "reply-b",
              op: "append",
              field: "text",
              text: ` stream-${++pasteFixture.streamCount}`,
            }),
          });
        }, 50);
      });
      const start = Date.now();
      await page.keyboard.type("x".repeat(120), { delay: 20 });
      for (let i = 0; i < 120; i++) await page.keyboard.down("Backspace");
      await page.keyboard.up("Backspace");
      const metrics = await page.evaluate(() => {
        clearInterval(pasteFixture.stream);
        return {
          writes: pasteFixture.writes,
          bodyReads: pasteFixture.bodyReads,
          longTasks: pasteFixture.longTasks,
          streamCount: pasteFixture.streamCount,
          visibleStream: document
            .querySelector(".conversation-scroll")
            ?.textContent.includes("stream-"),
        };
      });
      await settled(huge, "b");
      assert.ok(metrics.streamCount > 40 && metrics.visibleStream);
      assert.ok(metrics.writes.length >= 240);
      assert.equal(metrics.bodyReads, 0);
      assert.ok(
        metrics.writes.every(
          (w) => w.key.startsWith("yuzuno.composer.v1:") && w.length < 600,
        ),
      );
      report.performance = {
        elapsedMs: Date.now() - start,
        streamCount: metrics.streamCount,
        draftWrites: metrics.writes.length,
        maxWriteLength: Math.max(...metrics.writes.map((w) => w.length)),
        longTasks: metrics.longTasks,
        bodyReads: metrics.bodyReads,
      };
      await chips().first().hover();
      await page.locator(".pasted-text-preview").waitFor();
      assert.ok(
        (await page.locator(".pasted-text-preview").textContent()).length <
          1000,
      );
    },
  );
  await check(
    "light/dark, 20px reading size and narrow touch layout stay usable",
    async () => {
      async function checkPreview() {
        await page.mouse.move(1, 1);
        await chips().first().hover();
        const preview = page.locator(".pasted-text-preview-container");
        await preview.waitFor();
        const styles = await preview.evaluate((el) => {
          const s = getComputedStyle(el),
            inner = el.querySelector(".pasted-text-preview"),
            hint = inner.querySelector("small");
          const r = el.getBoundingClientRect(),
            h = hint.getBoundingClientRect();
          const probe = document.createElement("div");
          probe.style.background = "var(--input)";
          document.body.append(probe);
          const expectedBackground = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            radius: s.borderRadius,
            background: s.backgroundColor,
            expectedBackground,
            padding: getComputedStyle(inner).paddingTop,
            width: r.width,
            left: r.left,
            right: r.right,
            hintFits: h.bottom <= r.bottom + 1 && h.right <= r.right + 1,
            viewport: innerWidth,
          };
        });
        assert.equal(styles.radius, "7px");
        assert.equal(styles.padding, "10px");
        assert.ok(
          styles.width <= 420 &&
            styles.left >= 0 &&
            styles.right <= styles.viewport,
        );
        assert.ok(styles.hintFits, JSON.stringify(styles));
        assert.equal(styles.background, styles.expectedBackground);
        report.previewStyles ||= [];
        report.previewStyles.push(styles);
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty("--reading-size", "20px");
        }, theme);
        assert.equal(
          await input().evaluate((el) => getComputedStyle(el).fontSize),
          "20px",
        );
        await checkPreview();
        await page.screenshot({
          path: new URL(`${theme}-desktop.png`, output).pathname,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
        await checkPreview();
        await page.screenshot({
          path: new URL(`${theme}-mobile-preview.png`, output).pathname,
        });
        await chips().first().tap();
        await page.getByLabel("Full pasted text").waitFor();
        assert.equal(
          await page
            .getByLabel("Full pasted text")
            .evaluate((el) => getComputedStyle(el).fontSize),
          "20px",
        );
        await page.screenshot({
          path: new URL(`${theme}-mobile-dialog.png`, output).pathname,
        });
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    },
  );
  assert.deepEqual(report.errors, []);
  assert.ok(
    report.requests.every(
      (r) =>
        new URL(r.url).origin === base &&
        !new URL(r.url).pathname.startsWith("/api/") &&
        r.method === "GET",
    ),
  );
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
  await page
    .screenshot({ path: new URL("failure.png", output).pathname })
    .catch(() => {});
  console.error(error);
} finally {
  await writeFile(
    new URL("report.json", output),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
