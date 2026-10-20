// Chromium layout checks against explicit fixtures and the production bundle.
// This server is isolated: it never connects to or controls the running Core.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const dist = resolve("dist");
const output = resolve(
  process.env.YUZUNO_BROWSER_OUTPUT || "../acceptance/file-lines",
);
const source = Array.from(
  { length: 180 },
  (_, i) => `const line${i + 1} = "source ${i + 1}";`,
).join("\n");
const markdown =
  "# Rendered report\n\n**Source line three**\n\n| a | b |\n| - | - |\n| 1 | 2 |";
const agent = {
  id: "file-line-fixture",
  name: "File line fixture",
  goal: "Isolated file reference checks",
  cwd: "/workspace",
  model: "fixture",
  color: "green",
  status: "working",
  createdAt: "2026-10-12",
  updatedAt: "2026-10-12",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 0,
};
const links =
  "[Colon](web/src/App.tsx:120) · [Hash](web/src/App.tsx#L120) · [First](web/src/App.tsx:1) · [Last](web/src/App.tsx#L180) · [Outside](web/src/App.tsx:999) · [Plain](web/src/App.tsx) · [Markdown](report.md) · [Markdown source](report.md#L3)";
const detail = {
  agent,
  pending: [],
  artifacts: [],
  turns: Array.from({ length: 14 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    items: [
      {
        id: `reply-${index}`,
        type: "agentMessage",
        phase: "final_answer",
        text: `## Fixture reply ${index + 1}\n\n${"Conversation reading content. ".repeat(28)}\n\n${links}`,
      },
    ],
  })),
};
const requests = [],
  errors = [],
  results = [];
const report = {
  mode: "isolated-browser-fixtures",
  results,
  browserErrors: errors,
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push({
        method: request.method,
        path: url.pathname,
        query: [...url.searchParams],
      });
      if (url.pathname === "/api/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": fixture\n\n");
        return;
      }
      if (url.pathname === "/api/artifact") {
        const path = url.searchParams.get("path");
        assert.ok(
          ["web/src/App.tsx", "report.md"].includes(path),
          `Unexpected artifact path: ${path}`,
        );
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(path === "report.md" ? markdown : source);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          url.pathname === "/api/workspace"
            ? {
                agents: [agent],
                runtime: { connected: true },
                defaultCwd: agent.cwd,
              }
            : url.pathname === `/api/agents/${agent.id}`
              ? detail
              : {},
        ),
      );
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
let browser;
try {
  await mkdir(output, { recursive: true });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.YUZUNO_BROWSER_BIN
      ? { executablePath: process.env.YUZUNO_BROWSER_BIN }
      : { channel: "chrome" }),
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  for (const [width, height] of [
    [1440, 960],
    [940, 650],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(base);
    const composer = page.getByRole("textbox", {
      name: "Message File line fixture",
    });
    const draft = "Unsent draft preserved\n保留草稿";
    await composer.fill(draft);
    const reply = page.locator('[data-turn-id="turn-4"] .final-message');
    const conversation = page.locator(".conversation-scroll");
    for (const [label, line] of [
      ["Colon", 120],
      ["Hash", 120],
      ["First", 1],
      ["Last", 180],
      ["Outside", null],
      ["Plain", null],
      ["Markdown", null],
      ["Markdown source", 3],
    ]) {
      const link = reply.getByRole("link", { name: label, exact: true });
      await link.scrollIntoViewIfNeeded();
      await link.focus();
      const before = await conversation.evaluate(
        (element) => element.scrollTop,
      );
      await link.click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await dialog.locator(".loading-state").waitFor({ state: "detached" });
      if (line !== null) {
        const target = dialog.locator(".source-line-highlight");
        await target.waitFor();
        assert.equal(await target.getAttribute("data-line"), String(line));
        assert.equal(await target.count(), 1);
        const position = await target.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const container = element.closest(".artifact-content");
          const view = container.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            viewTop: view.top,
            viewBottom: view.bottom,
            scrollTop: container.scrollTop,
          };
        });
        assert.ok(
          position.top >= position.viewTop - 1 &&
            position.bottom <= position.viewBottom + 1,
          `${label}: target must be visible, ${JSON.stringify(position)}`,
        );
        if (line === 120) assert.ok(position.scrollTop > 0);
        if (label === "Colon")
          await page.screenshot({
            path: resolve(output, `line-${width}.png`),
            animations: "disabled",
          });
        results.push({ width, label, line, position });
      } else if (label === "Outside") {
        assert.match(
          await dialog.getByRole("alert").innerText(),
          /Line 999 is out of range.*180 lines/,
        );
        assert.equal(await dialog.locator(".source-line-highlight").count(), 0);
        await page.screenshot({
          path: resolve(output, `out-of-range-${width}.png`),
          animations: "disabled",
        });
      } else if (label === "Markdown") {
        assert.equal(
          await dialog.locator(".prose h1").innerText(),
          "Rendered report",
        );
        assert.equal(await dialog.locator(".prose table").count(), 1);
        assert.equal(await dialog.locator(".source-line").count(), 0);
      } else {
        assert.equal(await dialog.locator(".source-line").count(), 180);
        assert.equal(await dialog.locator(".source-line-highlight").count(), 0);
      }
      assert.ok(
        Math.abs(
          (await conversation.evaluate((element) => element.scrollTop)) -
            before,
        ) <= 1,
      );
      if (label === "Hash") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: "Close dialog" }).click();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(() =>
        document.activeElement?.closest(".final-message"),
      );
      assert.ok(
        Math.abs(
          (await conversation.evaluate((element) => element.scrollTop)) -
            before,
        ) <= 1,
        `${label}: reading position changed`,
      );
      assert.equal(await composer.inputValue(), draft);
      assert.equal(
        await page.evaluate(
          (id) => JSON.parse(localStorage.getItem("yuzuno.drafts"))[id],
          agent.id,
        ),
        draft,
      );
      assert.equal(
        await link.evaluate((element) => document.activeElement === element),
        true,
      );
      assert.equal(new URL(page.url()).hash, "");
      results.push({
        width,
        label,
        draftPreserved: true,
        readingPositionPreserved: true,
        focusRestored: true,
      });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET"),
    [],
  );
  assert.ok(requests.some((request) => request.path === "/api/artifact"));
  report.mutationRequests = 0;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
