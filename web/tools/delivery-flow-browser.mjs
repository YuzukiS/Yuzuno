// An isolated component fixture; never connects to a real Core or daily window.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.env.T61_REPORT_DIR || "target/t61/browser");
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const fixture = await mkdtemp(
  path.join(root, "node_modules/.cache/delivery-browser-"),
);
let browser, server;
const errors = [],
  checks = [];
const settings = { harness: "codex", model: "gpt-6.1-sol" };
const candidate = {
  flowId: "fixture",
  round: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const linked = {
  id: "7:pull:1",
  kind: "pull",
  number: 1,
  repository: "fixture/repository",
  url: "https://github.com/fixture/repository/pull/1",
  stale: false,
  error: null,
  snapshot: {
    ...candidate,
    title: "A long pull request title with 中文内容 for a narrow task panel",
  },
};
const step = {
  id: "a-retained-operation-identity",
  requestId: "delivery:fixture:1:operation",
  attempts: 1,
  error: null,
};
const flow = {
  id: "fixture",
  enabled: true,
  linkId: linked.id,
  url: linked.url,
  maxRounds: 2,
  state: "ready_to_merge",
  reason:
    "Review passed and the latest observed GitHub Actions attempts passed for this fixed revision. A person must check merge requirements and merge; nothing is deployed.",
  candidate,
  rounds: [
    {
      ...candidate,
      number: 1,
      settings,
      resultId: "retained-result-identity",
      review: step,
      ci: step,
    },
  ],
  reviewEvidence: {
    id: "original-review",
    status: "completed",
    conclusion: "no_findings",
    actualModel: settings.model,
  },
  ciEvidence: {
    watch: { observedAt: "2026-10-16T06:00:00Z", error: null },
    runs: [
      {
        id: "ci",
        name: "Frontend and Core checks · 回归验证",
        conclusion: "success",
        status: "completed",
        url: linked.url,
      },
    ],
  },
};
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';
import {DeliveryFlow} from ${JSON.stringify(path.join(root, "src/DeliveryFlow.tsx"))};
import ${JSON.stringify(path.join(root, "src/styles.css"))};
import ${JSON.stringify(path.join(root, "src/appearance.css"))};
import ${JSON.stringify(path.join(root, "src/palettes.css"))};
createRoot(document.getElementById('root')).render(<DeliveryFlow taskId="T-1" revision={1} onCandidate={()=>{}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    plugins: [react()],
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "DeliveryFixture", formats: ["iife"] },
    },
  });
  const built = (Array.isArray(result) ? result[0] : result).output;
  const js = built.find((x) => x.type === "chunk").code;
  const css = built
    .filter((x) => x.type === "asset" && x.fileName.endsWith(".css"))
    .map((x) => x.source)
    .join("\n");
  server = createServer((req, res) => {
    const type =
      req.url === "/bundle.js"
        ? "text/javascript"
        : req.url === "/bundle.css"
          ? "text/css"
          : "text/html";
    res.setHeader("Content-Type", type);
    res.end(
      req.url === "/bundle.js"
        ? js
        : req.url === "/bundle.css"
          ? css
          : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>body{padding:12px;background:var(--paper);color:var(--ink)}</style><div id="root"></div><script src="/bundle.js"></script>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
  });
  for (const theme of ["light", "dark"])
    for (const width of [360, 640])
      for (const state of ["setup", "ready"]) {
        const page = await browser.newPage({
          viewport: { width, height: 1100 },
        });
        page.on("pageerror", (e) => errors.push(e.message));
        await page.route("**/api/**", (route) => {
          const url = route.request().url();
          assert.match(url, /\/(delivery_get|github_links)$/);
          return route.fulfill({
            json: url.endsWith("delivery_get")
              ? { flow: state === "ready" ? flow : null, settings }
              : { links: [linked] },
          });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.setProperty("--font-adjust", "7px");
          document.documentElement.style.setProperty("--reading-size", "20px");
        }, theme);
        if (state === "setup")
          await page.getByRole("button", { name: "Set up delivery…" }).click();
        else {
          await page.getByRole("status").waitFor();
          await page
            .getByText("Authorization and operation identities", {
              exact: true,
            })
            .click();
        }
        const overflow = await page
          .locator(".delivery-flow")
          .evaluate((el) => ({
            client: el.clientWidth,
            scroll: el.scrollWidth,
            fontSize: getComputedStyle(document.documentElement).fontSize,
          }));
        assert.equal(overflow.fontSize, "20px");
        assert.ok(
          overflow.scroll <= overflow.client + 1,
          JSON.stringify({ theme, width, state, overflow }),
        );
        await page.screenshot({
          path: path.join(output, `${theme}-${width}-${state}.png`),
          fullPage: true,
        });
        checks.push({ theme, width, state, fontSize: 20, noOverflow: true });
        await page.close();
      }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "browser.json"),
    JSON.stringify({ success: true, isolated: true, checks, errors }, null, 2),
  );
  console.log(`Passed ${checks.length} isolated theme, 20px and width checks.`);
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
