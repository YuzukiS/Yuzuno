// Bounded component acceptance. Peer snapshots come from actual Core delivery
// tests (scripted native harness); Job/CI cases are explicit contract fixtures.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "../target/t50/browser");
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(
  path.join(root, "node_modules/.cache/mailbox-browser-"),
);
const report = {
  checks: [],
  errors: [],
  apiCalls: [],
  provenance:
    "Peer: actual Core reservation/delivery via scripted native harness. Job/CI: contract fixtures, no live CI monitor.",
};
let server, browser;
try {
  const peer = JSON.parse(
    await readFile(
      path.join(root, "../target/t50/peer-deliveries.json"),
      "utf8",
    ),
  );
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';
import {MailboxNotice} from ${JSON.stringify(path.join(root, "src/MailboxNotice.tsx"))};
const root=createRoot(document.getElementById('root'));window.renderNotices=(rows)=>root.render(<>{rows.map((row,i)=><section key={i} data-case={row.name}><small>{row.name}</small><div className="user-message"><MailboxNotice snapshot={row.snapshot} text="Read the original body through peer_read; this fixture never fetches mail." time={<time>10:24</time>}/></div></section>)}</>);`,
  );
  const built = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      lib: { entry, name: "MailboxAcceptance", formats: ["iife"] },
    },
  });
  const bundle = (Array.isArray(built) ? built[0] : built).output.find(
    (item) => item.type === "chunk",
  ).code;
  const css = (
    await Promise.all(
      ["styles.css", "appearance.css", "palettes.css", "collaboration.css"].map(
        (file) => readFile(path.join(root, "src", file), "utf8"),
      ),
    )
  ).join("\n");
  const html = `<!doctype html><html data-theme="light" data-palette="yuzu"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}\nbody{padding:24px;background:var(--paper);color:var(--ink)}main{max-width:900px;margin:auto}section{padding:12px 0;border-bottom:1px solid var(--line)}section>small{display:block;color:var(--text-quiet);margin-bottom:8px}section .user-message{margin:0;max-width:100%}@media(max-width:600px){body{padding:16px}}</style><main id="root"></main><script>${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  await writeFile(path.join(output, "notice.html"), html);
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    headless: true,
  });
  const page = await browser.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("/api/")) report.apiCalls.push(request.url());
  });
  const single = (kind, status, name, priority = "normal") => ({
    version: 1,
    priority,
    afterSeq: 10,
    throughSeq: 11,
    messageCount: 1,
    count: 1,
    remainingCount: 0,
    groups: [{ kind, status, name, count: 1 }],
  });
  const longName = "单测 · a very long immutable build name ".repeat(12);
  const rows = [
    ...peer.map((row) => ({
      name: `Core peer ${row.priority}`,
      snapshot: row.snapshot,
    })),
    ...["succeeded", "failed", "cancelled", "timed_out", "oom", "unknown"].map(
      (status) => ({
        name: `Job ${status}`,
        snapshot: single("job", status, longName),
      }),
    ),
    ...["passed", "failed", "cancelled", "skipped", "pending"].map(
      (status) => ({
        name: `CI ${status} fixture`,
        snapshot: single("ci", status, "PR #27"),
      }),
    ),
    {
      name: "Mixed results",
      snapshot: {
        version: 1,
        priority: "normal",
        afterSeq: 12,
        throughSeq: 24,
        messageCount: 12,
        count: 9,
        remainingCount: 4,
        groups: [
          { kind: "job", status: "failed", count: 3, name: longName },
          { kind: "ci", status: "passed", count: 2 },
        ],
      },
    },
    {
      name: "Historical fallback",
      snapshot: { version: 0, priority: "urgent" },
    },
    {
      name: "Other system result",
      snapshot: single("system", "", "Yuzuno Core"),
    },
  ];
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(
        ({ rows, theme }) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.fontSize = "20px";
          window.renderNotices(rows);
        },
        { rows, theme },
      );
      await page.locator(".mailbox-notice").last().waitFor();
      const layout = await page
        .locator(".mailbox-notice > summary")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect(),
              style = getComputedStyle(element);
            return {
              width: rect.width,
              height: rect.height,
              right: rect.right,
              scroll: element.scrollWidth,
              client: element.clientWidth,
              maxHeight: Number.parseFloat(style.fontSize) * 2.8 + 6,
              closed: !element.parentElement.open,
            };
          }),
        );
      for (const box of layout) {
        assert.ok(
          box.right <= width - 14 && box.scroll <= box.client + 1,
          JSON.stringify({ width, theme, box }),
        );
        assert.ok(
          box.height <= box.maxHeight,
          `At most two lines: ${JSON.stringify({ width, box })}`,
        );
        assert.ok(box.closed);
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const mixed = page.locator('[data-case="Mixed results"] .mailbox-notice');
      assert.equal(await mixed.locator(".mailbox-group").count(), 2);
      await mixed.locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await mixed.evaluate((element) => element.open), true);
      assert.ok(
        (await mixed.locator(".mailbox-full-summary").textContent()).includes(
          longName,
        ),
      );
      await page.keyboard.press("Enter");
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-20px.png`),
        fullPage: true,
      });
      report.checks.push({
        width,
        theme,
        fontSize: 20,
        notices: layout.length,
        overflow: false,
        maxLines: 2,
        keyboardExpansion: true,
      });
    }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.apiCalls, []);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
