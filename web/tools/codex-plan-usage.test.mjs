import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/codex-usage-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';import {CodexPlanUsage,usageWindows} from ${JSON.stringify(path.join(root, "src/CodexPlanUsage.tsx"))};import {parseWorkspaceEvent} from ${JSON.stringify(path.join(root, "src/workspace-events.ts"))};import {useWorkspaceEvents} from ${JSON.stringify(path.join(root, "src/useWorkspaceEvents.ts"))};window.usageWindows=usageWindows;window.parseEvent=parseWorkspaceEvent;const root=createRoot(document.getElementById('root'));function Harness({id,connected=true}){useWorkspaceEvents(true,e=>window.forwarded.push(e));return <dl><CodexPlanUsage agent={{id,connectionState:connected?'connected':'disconnected'}} streamConnected={true}/></dl>};window.renderUsage=(id='a',connected=true)=>root.render(<React.StrictMode><Harness key={id} id={id} connected={connected}/></React.StrictMode>);window.renderUsage();`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: {
      write: false,
      minify: false,
      lib: { entry, name: "UsageTests", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (v) => v.type === "chunk",
  ).code;
} finally {
  await rm(temp, { recursive: true, force: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f) {
  for (let i = 0; i < 120; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail("Expected UI state did not appear");
}
function snapshot(overrides = {}) {
  const at = new Date().toISOString();
  return {
    revision: 1,
    status: "ready",
    account: {
      type: "chatgpt",
      label: "fixture@example.invalid",
      planType: "pro",
    },
    accountId: "fixture-account",
    source: {
      generation: "7",
      label: "Remote fixture",
      machineId: "remote",
      runtimeId: "fixture",
    },
    observedAt: at,
    checkedAt: new Date(Date.now() - 10000).toISOString(),
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
          resetsAt: Math.floor(Date.now() / 1000) + 3600,
          observedAt: at,
        },
        secondary: {
          usedPercent: 72,
          windowDurationMins: 10080,
          resetsAt: Math.floor(Date.now() / 1000) + 86400,
          observedAt: at,
        },
      },
    ],
    ...overrides,
  };
}
function lab(handler) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window,
    calls = [];
  w.forwarded = [];
  w.EventSource = class {
    constructor() {
      w.stream = this;
    }
    addEventListener() {}
    close() {}
  };
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const v = await handler(url, init);
    return { ok: true, status: 200, json: async () => v };
  };
  w.eval(bundle);
  return {
    dom,
    w,
    calls,
    text: () => w.document.body.textContent,
    button: () => w.document.querySelector("button"),
    event: (v) =>
      w.stream.onmessage({ data: JSON.stringify(v), lastEventId: "epoch-1" }),
  };
}
test("StrictMode first view reads once; refresh coalesces clicks and updates the compact account facts", async () => {
  let release;
  const l = lab(async (_url, init) =>
    init.method === "POST"
      ? new Promise(
          (r) => (release = () => r(snapshot({ revision: 2, buckets: [] }))),
        )
      : snapshot(),
  );
  try {
    await until(() => l.text().includes("32% used"));
    assert.equal(l.calls.length, 1);
    assert.match(l.text(), /5h.*7d/s);
    l.button().click();
    l.button().click();
    await until(() => release);
    assert.equal(l.button().disabled, true);
    release();
    await until(() => l.text().includes("No quota windows reported"));
    assert.equal(l.calls.filter((c) => c.method === "POST").length, 1);
    assert.ok(l.calls.every((c) => c.url === "/api/agents/a/codex/usage"));
  } finally {
    l.dom.window.close();
  }
});
test("usage SSE is handled separately and never requests conversation detail or read receipts", async () => {
  const l = lab(async () => snapshot());
  try {
    await until(() => l.text().includes("32% used"));
    const next = snapshot({ revision: 2 });
    next.buckets[0].primary.usedPercent = 44;
    l.event({ type: "agent.codexUsage", agentId: "a", usage: next });
    await until(() => l.text().includes("44% used"));
    assert.equal(l.calls.length, 1);
    assert.equal(l.w.forwarded.length, 0);
    assert.equal(
      l.w.parseEvent({ type: "agent.codexUsage", agentId: "a", usage: next })
        .type,
      "agent.codexUsage",
    );
  } finally {
    l.dom.window.close();
  }
});
test("failed refresh retains dated report and explicitly reports failure", async () => {
  const l = lab(async (_url, init) =>
    init.method === "POST"
      ? snapshot({
          revision: 2,
          status: "error",
          error: "Could not refresh from this native connection.",
        })
      : snapshot(),
  );
  try {
    await until(() => l.text().includes("32% used"));
    l.button().click();
    await until(() => l.text().includes("Could not refresh"));
    assert.match(l.text(), /Last report · 32%/);
  } finally {
    l.dom.window.close();
  }
});
test("reset and stale windows are unknown now; sparse window timestamps remain independent", async () => {
  const s = snapshot();
  s.buckets[0].primary.resetsAt = Math.floor(Date.now() / 1000) - 1;
  s.buckets[0].secondary.observedAt = new Date(
    Date.now() - 600000,
  ).toISOString();
  const l = lab(async () => s);
  try {
    await until(() => l.text().includes("Waiting for update"));
    assert.match(l.text(), /Last report · 72%/);
    assert.ok(!l.text().includes("0% used"));
  } finally {
    l.dom.window.close();
  }
});
test("switching Agents discards late response and never displays previous account", async () => {
  let release;
  const l = lab(async (url) =>
    url.includes("/a/")
      ? new Promise((r) => (release = () => r(snapshot())))
      : snapshot({
          account: null,
          accountId: null,
          status: "unavailable",
          buckets: [],
        }),
  );
  try {
    await until(() => release);
    l.w.renderUsage("b");
    await until(() => l.text().includes("Not signed in"));
    release();
    await sleep(30);
    assert.ok(!l.text().includes("fixture@example"));
    assert.ok(!l.text().includes("32%"));
  } finally {
    l.dom.window.close();
  }
});
test("auth invalidation during refresh retries the new generation after the old answer settles", async () => {
  let release,
    next,
    count = 0;
  const l = lab(async () =>
    ++count === 1
      ? new Promise((r) => (release = () => r(snapshot())))
      : new Promise(
          (r) =>
            (next = () =>
              r(
                snapshot({
                  revision: 3,
                  account: {
                    type: "chatgpt",
                    label: "new-account",
                    planType: null,
                  },
                }),
              )),
        ),
  );
  try {
    await until(() => release);
    l.event({
      type: "agent.codexUsage",
      agentId: "a",
      usage: snapshot({
        revision: 2,
        status: "unknown",
        account: null,
        buckets: [],
      }),
    });
    release();
    await until(() => next);
    assert.ok(!l.text().includes("fixture@example"));
    next();
    await until(() => l.text().includes("new-account"));
    assert.equal(count, 2);
  } finally {
    l.dom.window.close();
  }
});
test("stream reset discards old pending response and accepts restarted Core lower revisions", async () => {
  let release,
    next,
    count = 0;
  const l = lab(async () =>
    ++count === 1
      ? new Promise((r) => (release = () => r(snapshot({ revision: 900 }))))
      : new Promise(
          (r) =>
            (next = () =>
              r(
                snapshot({
                  revision: 1,
                  account: {
                    type: "chatgpt",
                    label: "restarted-account",
                    planType: null,
                  },
                }),
              )),
        ),
  );
  try {
    await until(() => release);
    l.event({ type: "reset", reason: "epoch" });
    release();
    await until(() => next);
    assert.ok(!l.text().includes("fixture@example"));
    next();
    await until(() => l.text().includes("restarted-account"));
    assert.equal(count, 2);
  } finally {
    l.dom.window.close();
  }
});
test("native reconnect does not reuse the old in-flight read", async () => {
  let release,
    count = 0;
  const l = lab(async () =>
    ++count === 1
      ? new Promise((r) => (release = () => r(snapshot({ revision: 900 }))))
      : snapshot({
          revision: 1,
          account: {
            type: "chatgpt",
            label: "reconnected-account",
            planType: null,
          },
        }),
  );
  try {
    await until(() => release);
    l.w.renderUsage("a", false);
    await until(() => l.text().includes("Native connection unavailable"));
    l.w.renderUsage("a", true);
    await until(() => l.text().includes("reconnected-account"));
    release();
    await sleep(30);
    assert.ok(!l.text().includes("fixture@example"));
    assert.equal(count, 2);
  } finally {
    l.dom.window.close();
  }
});
test("unsupported and disconnected states do not masquerade as unlimited or zero", async () => {
  const l = lab(async () =>
    snapshot({
      status: "unsupported",
      account: null,
      buckets: [],
      error: "This Codex version does not provide account usage.",
    }),
  );
  try {
    await until(() => l.text().includes("does not provide"));
    l.w.renderUsage("b", false);
    await until(() => l.text().includes("Native connection unavailable"));
    assert.equal(l.calls.length, 1);
    assert.equal(l.button().disabled, true);
    assert.ok(!/0%|unlimited/.test(l.text()));
  } finally {
    l.dom.window.close();
  }
});
