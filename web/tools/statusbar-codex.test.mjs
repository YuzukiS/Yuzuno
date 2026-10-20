import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// The status bar's Codex plan usage (T-82) beside the details panel's
// (T-83): the bar is not remounted per Agent, so a report must never show
// for an Agent other than the one it was read for, not even for one render;
// and the panel and the bar share one read.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/statusbar-codex-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';
import {useCodex} from ${JSON.stringify(path.join(root, "src/StatusBar.tsx"))};
import {CodexPlanUsage} from ${JSON.stringify(path.join(root, "src/CodexPlanUsage.tsx"))};
window.renders=[];
function Bar({agent}){const codex=useCodex(agent,true);window.renders.push({id:agent.id,text:codex?codex.text:null,title:codex?codex.title:null});return <span id="bar">{codex?codex.text:""}</span>}
function Harness({id,panel}){const agent={id,harness:'codex',connectionState:'connected',closedAt:null};return <>{panel&&<dl><CodexPlanUsage key={id} agent={agent} streamConnected={true}/></dl>}<Bar agent={agent}/></>}
const root=createRoot(document.getElementById('root'));
window.show=(id,panel=false)=>root.render(<React.StrictMode><Harness id={id} panel={panel}/></React.StrictMode>);`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "StatusBarCodexTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f) {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail("Expected UI state did not appear");
}
// One account's report: a 5 h and a 7 d window.
function report(label, five, revision = 1) {
  const at = new Date().toISOString();
  const window = (mins, usedPercent) => ({ usedPercent, windowDurationMins: mins, resetsAt: Math.floor(Date.now() / 1000) + 3600, observedAt: at });
  return {
    revision,
    status: "ready",
    account: { type: "chatgpt", label, planType: "pro" },
    accountId: label,
    source: { generation: "1", label: "Core host", machineId: null, runtimeId: null },
    checkedAt: at,
    observedAt: at,
    ordinaryUsageAllowed: true,
    error: null,
    buckets: [{ limitId: "codex", limitName: null, planType: "pro", observedAt: at, credits: null, primary: window(300, five), secondary: window(10080, 40) }],
  };
}
function lab(handler) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const v = await handler(url, init);
    return { ok: true, status: 200, json: async () => v };
  };
  w.eval(bundle);
  // Null until React's first render.
  return { dom, w, calls, bar: () => w.document.getElementById("bar")?.textContent ?? null };
}

test("switching between two connected Codex Agents never shows the first one's report for the second", async () => {
  let release;
  const l = lab(async (url) =>
    url.includes("/agents/a/") ? report("a@example.invalid", 23) : new Promise((r) => (release = () => r(report("b@example.invalid", 12)))),
  );
  try {
    l.w.show("a");
    await until(() => l.bar() === "5h 23% · 7d 40%");
    l.w.show("b");
    await until(() => release);
    await sleep(30);
    const early = l.w.renders.filter((r) => r.id === "b");
    assert.ok(early.length > 0);
    assert.ok(early.every((r) => r.text === null), JSON.stringify(early));
    assert.equal(l.bar(), "");
    release();
    await until(() => l.bar() === "5h 12% · 7d 40%");
    const shown = l.w.renders.filter((r) => r.id === "b" && r.text);
    assert.ok(shown.every((r) => r.text === "5h 12% · 7d 40%" && /for b@example\.invalid/.test(r.title)), JSON.stringify(shown));
    assert.deepEqual(
      l.calls.map((c) => `${c.method} ${c.url}`),
      ["GET /api/agents/a/codex/usage", "GET /api/agents/b/codex/usage"],
    );
  } finally {
    l.dom.window.close();
  }
});

test("the details panel and the bar share one read, and one again after a stream reset", async () => {
  let n = 0;
  const l = lab(async () => report("a@example.invalid", ++n === 1 ? 23 : 31, n));
  try {
    l.w.show("a", true);
    await until(() => l.bar() === "5h 23% · 7d 40%" && l.w.document.body.textContent.includes("23% used"));
    assert.equal(l.calls.length, 1, JSON.stringify(l.calls));
    l.w.dispatchEvent(new l.w.CustomEvent("yuzuno:codex-usage", { detail: null }));
    await until(() => l.bar() === "5h 31% · 7d 40%" && l.w.document.body.textContent.includes("31% used"));
    assert.equal(l.calls.length, 2, JSON.stringify(l.calls));
    assert.ok(l.calls.every((c) => c.method === "GET" && c.url === "/api/agents/a/codex/usage"));
  } finally {
    l.dom.window.close();
  }
});
