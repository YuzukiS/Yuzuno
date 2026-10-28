// Defaults to a wholly isolated component fixture. SESSION_IMPORT_BASE inspects
// an explicitly supplied Core read-only (preview only, never imports there).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(
  process.env.SESSION_IMPORT_OUTPUT || "../acceptance/session-import/browser",
);
await mkdir(output, { recursive: true });
const realBase = process.env.SESSION_IMPORT_BASE;
const threadId =
  process.env.SESSION_IMPORT_THREAD || "019a1234-5678-4321-aaaa-123456789abc";
if (realBase && !process.env.SESSION_IMPORT_THREAD)
  throw new Error(
    "SESSION_IMPORT_THREAD is required with SESSION_IMPORT_BASE.",
  );
const errors = [],
  checks = [],
  requests = [];
const fixtureAgent = {
  id: "history-agent",
  name: "History agent",
  goal: "",
  cwd: "/workspace",
  harness: "codex",
  model: "codex-model",
  color: "yellow",
  status: "offline",
  connectionState: "disconnected",
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
  lastSeq: 0,
  reviewedSeq: 0,
  unreadCount: 0,
  pendingCount: 0,
};
const turn = (id) => ({
  id,
  status: "completed",
  items: [
    {
      id: id + "-user",
      type: "userMessage",
      content: [{ type: "inputText", text: "Continue this work " + id }],
    },
    {
      id: id + "-agent",
      type: "agentMessage",
      text: ("Saved work for " + id + ". ").repeat(100),
    },
  ],
});
let server, browser, fixture;
try {
  let base = realBase;
  if (!base) {
    const cache = path.join(root, "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    fixture = await mkdtemp(path.join(cache, "session-import-browser-"));
    const entry = path.join(fixture, "entry.tsx");
    await writeFile(
      entry,
      `import React from 'react';import {createRoot} from 'react-dom/client';
import {RemoteCreateAgent} from ${JSON.stringify(path.join(root, "src/RemoteCreateAgent.tsx"))};
import {App} from ${JSON.stringify(path.join(root, "src/App.tsx"))};
import ${JSON.stringify(path.join(root, "src/styles.css"))};import ${JSON.stringify(path.join(root, "src/appearance.css"))};
function Fixture(){const [open,setOpen]=React.useState(true);return <><button onClick={()=>setOpen(true)}>New agent</button><RemoteCreateAgent open={open} close={()=>setOpen(false)} defaultCwd="/workspace" disabled={false} onCreated={(a)=>{window.created=a;setOpen(false)}}/></>};createRoot(document.getElementById('root')).render(location.search.includes('history=1')?<App/>:<Fixture/>);`,
    );
    const result = await build({
      root,
      configFile: false,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      logLevel: "silent",
      plugins: [react()],
      build: {
        write: false,
        lib: { entry, name: "SessionFixture", formats: ["iife"] },
      },
    });
    const built = (Array.isArray(result) ? result[0] : result).output;
    const js = built.find((v) => v.type === "chunk").code;
    const css = built
      .filter((v) => v.type === "asset" && v.fileName.endsWith(".css"))
      .map((v) => v.source)
      .join("\n");
    server = createServer(async (req, res) => {
      if (req.url === "/bundle.js") {
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(js);
        return;
      }
      if (req.url === "/bundle.css") {
        res.setHeader("Content-Type", "text/css");
        res.end(css);
        return;
      }
      if (req.url.startsWith("/api/")) {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push({
          url: req.url,
          method: req.method,
          body: body ? JSON.parse(body) : null,
        });
        let data = {};
        if (req.url === "/api/events") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end();
          return;
        }
        if (req.url === "/api/workspace")
          data = {
            agents: [fixtureAgent],
            defaultCwd: "/workspace",
            runtime: { connected: true },
          };
        if (req.url === "/api/agents/history-agent")
          data = {
            agent: fixtureAgent,
            turns: [turn("c"), turn("d"), turn("e")],
            history: { hasMore: true, nextCursor: "older", loadedCount: 3 },
            pending: [],
            artifacts: [],
          };
        if (req.url.startsWith("/api/agents/history-agent/history?")) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          data = {
            turns: [turn("a"), turn("b")],
            hasMore: false,
            nextCursor: null,
          };
        }
        if (req.url.endsWith("/machines")) data = { machines: [] };
        if (req.url.endsWith("/models")) data = { models: [] };
        if (req.url.endsWith("/preview"))
          data = {
            threadId,
            name: "Yuzuno development",
            cwd: "/home/developer/yuzuno-next-session-import",
            preview:
              "Let’s bring this conversation home.\n接续已有的开发上下文，让下一步工作从这里继续。",
            model: "gpt-6.1",
            reasoningEffort: "high",
            turnCount: 142,
            updatedAt: Date.now() / 1000,
            existingAgentId: null,
            warnings: [
              "Only saved conversation history is imported. Running tools and sub-agents stay in the original client.",
            ],
            permissions: {
              presets: ["ask", "auto", "full", "config"].map((id) => ({
                id,
                available: true,
              })),
            },
          };
        if (req.url.endsWith("/import"))
          data = {
            id: "imported-a",
            name: "Yuzuno development",
            cwd: "/workspace",
            threadId,
            status: "offline",
          };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>',
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    args: ["--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  if (realBase)
    await page
      .getByRole("button", { name: /New agent/ })
      .first()
      .click();
  await page
    .getByRole("button", { name: "Existing Codex session", exact: true })
    .click();
  await page.getByLabel("Codex session ID").fill(threadId);
  await page
    .getByRole("button", { name: "Preview session", exact: true })
    .click();
  await page.locator(".session-preview").waitFor({ timeout: 120000 });
  checks.push("preview-visible");
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty("--reading-size", "20px");
        document.documentElement.style.setProperty("--font-adjust", "7px");
      }, theme);
      await page.locator(".modal").evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-top.png`),
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "page does not overflow",
      );
      assert.ok(
        await page
          .locator(".modal")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        "modal does not overflow",
      );
      await page
        .getByRole("button", {
          name: /Add to workspace|Open agent/,
          exact: true,
        })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-bottom.png`),
      });
      assert.ok(
        await page
          .getByRole("button", {
            name: /Add to workspace|Open agent/,
            exact: true,
          })
          .isVisible(),
      );
      checks.push(`${theme}-${width}-20px-layout`);
    }
  }
  if (!realBase) {
    await page
      .getByRole("radiogroup", { name: "Permissions", exact: true })
      .locator('input[value="auto"]')
      .check();
    await page
      .getByRole("button", { name: "Add to workspace", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const imports = requests.filter((r) => r.url.endsWith("/import"));
    assert.equal(imports.length, 1);
    assert.equal(imports[0].body.permissionPreset, "auto");
    assert.ok(requests.every((r) => !/(turn|resume|reconnect)/.test(r.url)));
    checks.push("fixture-import-once-without-turn");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base + "/?history=1");
    await page.locator("#turn-c").waitFor();
    await page
      .locator(".conversation-scroll")
      .evaluate((el) => (el.scrollTop = 0));
    const before = await page
      .locator("#turn-c")
      .evaluate((el) => el.getBoundingClientRect().top);
    await page
      .getByRole("button", { name: "Load earlier messages", exact: true })
      .click();
    await page.locator("#turn-a").waitFor();
    const after = await page
      .locator("#turn-c")
      .evaluate((el) => el.getBoundingClientRect().top);
    assert.ok(
      Math.abs(after - before) < 3,
      `history scroll anchor stayed put: ${before} -> ${after}`,
    );
    assert.equal(await page.locator(".turn").count(), 5);
    await page
      .getByRole("textbox")
      .first()
      .fill("Typing should preserve expanded history");
    assert.equal(await page.locator(".turn").count(), 5);
    checks.push("history-prepend-preserves-reading-position");
    await page.screenshot({
      path: path.join(output, "history-scroll-anchor.png"),
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        mode: realBase ? "real-core-preview-read-only" : "isolated-ui-fixture",
        base,
        checks,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ checks, output }));
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  if (fixture) await rm(fixture, { recursive: true, force: true });
}
