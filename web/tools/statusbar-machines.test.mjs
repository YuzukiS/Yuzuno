import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// The status bar's remote machines (YN-61): only a machine whose last check
// failed is unreachable, in the failure colour and counted as needing a look.
// Open Agents that are disconnected on a machine that answered are their own
// count, in the bar's quiet colour, and the tip names them under their
// machine. Closed or connected Agents are not counted.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/statusbar-machines-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';import {createRoot} from 'react-dom/client';
import {StatusBar, useMachines} from ${JSON.stringify(path.join(root, "src/StatusBar.tsx"))};
import {useLanguage} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
window.opened=0;
function Probe({agents}){const m=useMachines('1',true,agents,useLanguage());window.machines=m&&{text:m.text,title:m.title};return null}
const root=createRoot(document.getElementById('root'));
window.show=(agents)=>root.render(<><Probe agents={agents}/><StatusBar previewMode={false} eventConnection="open" live={true} agents={agents} revision="1" machinesRevision="1" claudeRuntime={null} codexAgent={null} coreLabel="Connected" coreHealthy={true} onMachines={()=>{window.opened++}}/></>);`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "StatusBarMachinesTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what) {
  for (let i = 0; i < 300; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail(`Expected: ${what}`);
}
const at = new Date(Date.now() - 3_600_000).toISOString();
const machine = (id, reachable) => ({
  id,
  name: id,
  target: id,
  kind: "ssh",
  defaultCwd: "/home/me",
  lastCheck: { machineId: id, startedAt: at, checkedAt: at, durationMs: 900, reachable, harnesses: [] },
});
const agent = (id, name, machineId, connectionState, closedAt = null) => ({
  id,
  name,
  status: connectionState === "connected" ? "idle" : "offline",
  harness: "codex",
  cwd: "/home/me",
  model: "test-model",
  settings: {},
  createdAt: at,
  updatedAt: at,
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 1,
  reviewedSeq: 1,
  closedAt,
  connectionState,
  remote: { machine: { id: machineId, name: machineId } },
});
// Synthetic machines: owl failed its last check, mini answered.
const cases = {
  "the last check failed": {
    machines: [machine("owl", false)],
    agents: [agent("a1", "Mori", "owl", "connected")],
  },
  "only Agents are disconnected": {
    machines: [machine("mini", true)],
    agents: [
      agent("a1", "Kumo · iOS", "mini", "disconnected"),
      agent("a2", "Tora", "mini", "disconnected"),
      agent("a3", "Sora", "mini", "connected"),
      agent("a4", "Hoshi", "mini", "disconnected", at),
    ],
  },
  "both": {
    machines: [machine("owl", false), machine("mini", true)],
    agents: [agent("a1", "Mori", "owl", "disconnected"), agent("a2", "Tora", "mini", "disconnected")],
  },
};
// A page with only /api/machines answered: every other read the bar makes
// fails as Core would for a missing route, and is not what this checks.
function lab(f, language) {
  const dom = new JSDOM('<div id="core-status-slot"></div><div id="root"></div>', {
    url: "http://isolated.test",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  w.fetch = async (url) => {
    const u = new URL(url, "http://isolated.test");
    if (u.pathname === "/api/machines") return { ok: true, status: 200, json: async () => structuredClone({ machines: f.machines }) };
    return { ok: false, status: 404, json: async () => ({ error: "not in fixture" }), text: async () => "" };
  };
  w.eval(bundle);
  w.show(f.agents);
  return w;
}
async function bar(name, language) {
  const w = lab(cases[name], language);
  await until(() => w.machines && w.document.querySelector(".statusbar-end button.statusbar-item"), `${name}: the machines item`);
  const button = w.document.querySelector(".statusbar-end button.statusbar-item");
  const entry = w.document.querySelector(".core-status-entry");
  return {
    w,
    button,
    text: button.textContent.trim(),
    failed: button.classList.contains("is-failed"),
    needsLook: entry.classList.contains("needs-look"),
    tip: w.machines.title.split("\n"),
  };
}
const WHEN = "[^;；]+";

test("a machine whose last check failed is unreachable, in the failure colour", async () => {
  const en = await bar("the last check failed", "en");
  try {
    assert.equal(en.text, "1 machine · 1 unreachable");
    assert.equal(en.w.machines.text, en.text);
    assert.ok(en.failed, "failure colour");
    assert.ok(en.needsLook, "the folded entry asks for a look");
    assert.match(en.tip[0], new RegExp(`^owl: unreachable at its last check, ${WHEN}$`));
    assert.equal(en.tip.at(-1), "Open Machines");
    en.button.click();
    assert.equal(en.w.opened, 1, "opens Machines");
  } finally {
    en.w.close();
  }
  const zh = await bar("the last check failed", "zh-Hans");
  try {
    assert.equal(zh.text, "1 台机器 · 1 台无法连接");
    assert.ok(zh.failed);
    assert.match(zh.tip[0], new RegExp(`^owl：上次检查时无法连接，${WHEN}$`));
  } finally {
    zh.w.close();
  }
});

test("a machine that answered with only its Agents disconnected is not unreachable, and is quiet", async () => {
  const en = await bar("only Agents are disconnected", "en");
  try {
    assert.equal(en.text, "1 machine · 2 Agents disconnected");
    assert.ok(!en.failed, "no failure colour");
    assert.ok(!en.needsLook, "the folded entry stays quiet");
    // Open Agents only, by name: the connected and the closed one are not there.
    assert.match(en.tip[0], new RegExp(`^mini: reachable at its last check, ${WHEN}; Agents disconnected: Kumo · iOS, Tora$`));
  } finally {
    en.w.close();
  }
  const zh = await bar("only Agents are disconnected", "zh-Hans");
  try {
    assert.equal(zh.text, "1 台机器 · 2 个 Agent 未连接");
    assert.ok(!zh.failed);
    assert.match(zh.tip[0], new RegExp(`^mini：上次检查时可以连接，${WHEN}；未连接的 Agent：Kumo · iOS、Tora$`));
  } finally {
    zh.w.close();
  }
});

test("an unreachable machine and disconnected Agents are said apart, each Agent under its machine", async () => {
  const en = await bar("both", "en");
  try {
    assert.equal(en.text, "2 machines · 1 unreachable · 2 Agents disconnected");
    assert.ok(en.failed, "failure colour for the unreachable one");
    assert.ok(en.needsLook);
    assert.match(en.tip[0], new RegExp(`^owl: unreachable at its last check, ${WHEN}; Agent disconnected: Mori$`));
    assert.match(en.tip[1], new RegExp(`^mini: reachable at its last check, ${WHEN}; Agent disconnected: Tora$`));
    assert.equal(en.tip[2], "Open Machines");
  } finally {
    en.w.close();
  }
  const zh = await bar("both", "zh-Hans");
  try {
    assert.equal(zh.text, "2 台机器 · 1 台无法连接 · 2 个 Agent 未连接");
    assert.ok(zh.failed);
    assert.match(zh.tip[0], new RegExp(`^owl：上次检查时无法连接，${WHEN}；未连接的 Agent：Mori$`));
    assert.match(zh.tip[1], new RegExp(`^mini：上次检查时可以连接，${WHEN}；未连接的 Agent：Tora$`));
    assert.equal(zh.tip[2], "打开“机器”");
  } finally {
    zh.w.close();
  }
});
