// Production component, fixture transport, independent Chromium and port.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("../", import.meta.url)),
  output =
    process.env.T83_BROWSER_OUT || path.join(root, "../target/t83/browser");
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(
  path.join(root, "node_modules/.cache/usage-browser-"),
);
const report = {
  provenance:
    "Production CodexPlanUsage, fixture account responses, isolated browser/port; no daily window.",
  checks: [],
  screenshots: [],
  errors: [],
};
let server, browser;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';import {CodexPlanUsage} from ${JSON.stringify(path.join(root, "src/CodexPlanUsage.tsx"))};const root=createRoot(document.getElementById('root'));window.showAgent=(id='a')=>root.render(<section className="inspector-section purpose-section"><h2>Agent information</h2><dl><CodexPlanUsage key={id} agent={{id,connectionState:'connected'}} streamConnected={true}/></dl></section>);window.showAgent();`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"production"' },
    build: {
      write: false,
      lib: { entry, name: "UsageBrowser", formats: ["iife"] },
    },
  });
  const bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (x) => x.type === "chunk",
  ).code;
  const css = (
    await Promise.all(
      [
        "styles.css",
        "appearance.css",
        "palettes.css",
        "codex-plan-usage.css",
      ].map((f) => readFile(path.join(root, "src", f), "utf8")),
    )
  ).join("\n");
  const at = new Date().toISOString(),
    later = Math.floor(Date.now() / 1000) + 7200;
  const value = {
    revision: 1,
    status: "ready",
    account: {
      type: "chatgpt",
      label: "fixture@example.invalid",
      planType: "pro",
    },
    accountId: "fixture-account",
    source: {
      generation: "9",
      label: "Remote fixture",
      machineId: "remote",
      runtimeId: "isolated",
    },
    checkedAt: new Date(Date.now() - 10000).toISOString(),
    observedAt: at,
    ordinaryUsageAllowed: null,
    error: null,
    buckets: [
      {
        limitId: "codex",
        limitName: "Codex",
        planType: "pro",
        observedAt: at,
        credits: null,
        primary: {
          usedPercent: 32,
          windowDurationMins: 300,
          resetsAt: later,
          observedAt: at,
        },
        secondary: {
          usedPercent: 68,
          windowDurationMins: 10080,
          resetsAt: later + 86400,
          observedAt: at,
        },
      },
      {
        limitId: "other",
        limitName: "Other models",
        planType: null,
        observedAt: at,
        credits: null,
        primary: {
          usedPercent: 12,
          windowDurationMins: 15,
          resetsAt: later,
          observedAt: at,
        },
        secondary: null,
      },
    ],
  };
  const boot = `window.fixture=${JSON.stringify(value)};window.calls=[];window.fail=false;window.fetch=async(url,init={})=>{window.calls.push({url,method:init.method||'GET'});if(init.method==='POST')await new Promise(r=>setTimeout(r,200));const v=structuredClone(window.fixture);if(window.fail){v.revision++;v.status='error';v.error='Could not refresh; previous observations may be outdated.';}return{ok:true,status:200,json:async()=>v};};`;
  const html = `<!doctype html><html data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}\n:root{--font-adjust:7px}body{background:var(--paper);color:var(--ink);padding:16px}.purpose-section{width:340px;max-width:100%;margin:auto;padding:16px}h2{font-size:16px}</style><div id="root"></div><script>${boot}${bundle.replaceAll("</script", "<\\/script")}</script></html>`;
  server = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({
    executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 440, height: 800 } });
  page.on("pageerror", (e) => report.errors.push(e.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.getByText("32% used", { exact: true }).waitFor();
  assert.equal(await page.getByText("Codex · 5h", { exact: true }).count(), 1);
  assert.equal(
    await page.getByText("Other models · 15m", { exact: true }).count(),
    1,
  );
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (t) => (document.documentElement.dataset.theme = t),
      theme,
    );
    await page.setViewportSize({ width: 390, height: 900 });
    assert.ok(
      await page
        .locator(".purpose-section")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    );
    const name = `${theme}-390-20px.png`;
    await page.screenshot({ path: path.join(output, name) });
    report.screenshots.push(name);
    report.checks.push(
      `${theme}/390/20px compact rows without horizontal overflow`,
    );
  }
  await page.locator("summary").focus();
  await page.keyboard.press("Enter");
  await page.getByText(/Shared account quota/).waitFor();
  assert.match(
    await page.locator("details").innerText(),
    /Remote fixture.*account fixture-account/s,
  );
  assert.match(
    await page.locator("details").innerText(),
    /Resets:.*Observed:/s,
  );
  report.checks.push("Keyboard opens source, reset and observation details");
  await page.evaluate(() => (window.fail = true));
  await page.getByRole("button", { name: "Refresh Codex plan usage" }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh Codex plan usage" })
      .isDisabled(),
    true,
  );
  await page.getByText(/Could not refresh/).waitFor();
  assert.match(
    await page.locator(".codex-plan-values").innerText(),
    /Last report · 32%/,
  );
  await page.evaluate(() => {
    window.fail = false;
    window.fixture.revision = 3;
  });
  await page.getByRole("button", { name: "Refresh Codex plan usage" }).click();
  await page.getByText("32% used", { exact: true }).waitFor();
  report.checks.push(
    "Refresh busy, retained report on failure, successful retry",
  );
  await page.evaluate(() => {
    window.fixture.buckets[0].primary.resetsAt =
      Math.floor(Date.now() / 1000) - 1;
    window.fixture.revision = 4;
    window.dispatchEvent(
      new CustomEvent("yuzuno:codex-usage", {
        detail: { agentId: "a", usage: window.fixture },
      }),
    );
  });
  await page.getByText("Waiting for update", { exact: true }).waitFor();
  report.checks.push("Elapsed reset remains waiting, not zero");
  await page.evaluate(() => {
    window.fixture = {
      ...window.fixture,
      status: "unavailable",
      account: { type: "apiKey" },
      accountId: null,
      buckets: [],
      revision: 1,
    };
    window.showAgent("b");
  });
  await page
    .getByText("Not available for API-key authentication", { exact: true })
    .waitFor();
  assert.equal(await page.getByText("32% used", { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(output, "api-key-unknown.png") });
  report.screenshots.push("api-key-unknown.png");
  report.checks.push(
    "Agent switch clears prior account and explains authentication limitation",
  );
  const calls = await page.evaluate(() => window.calls);
  assert.ok(
    calls.every((c) => /^\/api\/agents\/[ab]\/codex\/usage$/.test(c.url)),
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(path.join(output, "report.json"));
