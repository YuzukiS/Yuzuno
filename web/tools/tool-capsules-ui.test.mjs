import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// The capsule row of a Turn's Tool activity (T-9), through the real Turn
// component: the name the harness gave each tool, how many calls it holds and
// what those calls' own fields say. No Core, no browser, no web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "tool-capsules-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurn=({turn,agent})=>{
  flushSync(()=>root.render(<Turn turn={turn} index={0} agent={agent} onFile={()=>{}} onRewindDraft={()=>{}}
    isLatestAgentTurn={true} />));
};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ToolCapsulesUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = {
  id: "a", name: "Mori", harness: "codex", color: "green", status: "working", cwd: "/work", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
};
/** One block of tool calls: a shell that returned, two MCP calls of the same
 *  tool with one failure, a Claude MCP call still running, and a reasoning
 *  summary, which reports no state of its own. */
const items = () => [
  { id: "u", type: "userMessage", content: [{ type: "text", text: "Check the docs" }] },
  { id: "sh", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0 },
  { id: "m1", type: "mcpToolCall", server: "docs", tool: "search", status: "completed" },
  { id: "m2", type: "mcpToolCall", server: "docs", tool: "search", status: "failed" },
  { id: "c1", type: "claudeToolUse", name: "mcp__yuzuno__task_get", status: "inProgress" },
  { id: "r", type: "reasoning", summary: ["Reading the two results"] },
];

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.eval(bundle);
  const document = window.document;
  const speak = (language) => {
    window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    window.dispatchEvent(new window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  const render = ({ status = "inProgress", agentStatus = "working", turnItems = items() } = {}) =>
    window.renderTurn({
      turn: JSON.parse(JSON.stringify({ id: "t1", status, items: turnItems })),
      agent: { ...agent, status: agentStatus },
    });
  /** Every capsule as the reader sees it. */
  const capsules = () =>
    [...document.querySelectorAll(".tool-activity > summary .tool-count")].map((capsule) => ({
      name: capsule.querySelector(".tool-count-name")?.textContent,
      number: capsule.querySelector(".tool-count-number")?.textContent,
      state: capsule.getAttribute("data-state"),
      said: capsule.querySelector(".tool-count-state")?.textContent.trim() ?? null,
    }));
  return { window, document, errors, render, speak, capsules, close: () => window.close() };
}

test("each tool is one capsule: its own name, its calls' number, and what those calls reported", (t) => {
  const page = mount();
  t.after(page.close);
  page.render();
  assert.deepEqual(page.capsules(), [
    // A call that returned says nothing more: the capsule never reads as success.
    { name: "Shell", number: "×1", state: "returned", said: null },
    { name: "docs/search", number: "×2", state: "failed", said: "1 failed" },
    { name: "mcp__yuzuno__task_get", number: "×1", state: "running", said: "running" },
    // Reasoning reports no state, so the capsule claims none.
    { name: "Reasoning", number: "×1", state: null, said: null },
  ]);
  assert.deepEqual(page.errors, []);
});

test("a call still reported as running is not confirmed once the turn is no longer followed", (t) => {
  const page = mount();
  t.after(page.close);
  // The turn ended with that call still reported as running.
  page.render({ status: "completed" });
  assert.deepEqual(
    page.capsules().map((capsule) => [capsule.name, capsule.state, capsule.said]),
    [
      ["Shell", "returned", null],
      ["docs/search", "failed", "1 failed"],
      ["mcp__yuzuno__task_get", "unconfirmed", "not confirmed"],
      ["Reasoning", null, null],
    ],
  );
  // The turn is running, but this Agent's execution state is uncertain.
  page.render({ agentStatus: "offline" });
  assert.deepEqual(
    page.capsules().map((capsule) => [capsule.name, capsule.state]),
    [["Shell", "returned"], ["docs/search", "failed"], ["mcp__yuzuno__task_get", "unconfirmed"], ["Reasoning", null]],
  );
});

test("a state covering every call in its group is said without a number", (t) => {
  const page = mount();
  t.after(page.close);
  page.render({ turnItems: [
    { id: "m1", type: "mcpToolCall", server: "docs", tool: "fetch", status: "failed" },
    { id: "m2", type: "mcpToolCall", server: "docs", tool: "fetch", status: "failed" },
  ] });
  assert.deepEqual(page.capsules().map((capsule) => [capsule.number, capsule.said]), [["×2", "failed"]]);
});

test("the capsules' own words follow the interface language; the tools' names do not (T-189)", (t) => {
  const page = mount();
  t.after(page.close);
  page.speak("zh-Hans");
  page.render();
  assert.deepEqual(page.capsules().map((capsule) => [capsule.name, capsule.said]), [
    ["Shell", null],
    ["docs/search", "1 个失败"],
    ["mcp__yuzuno__task_get", "运行中"],
    ["推理", null],
  ]);
  page.render({ status: "completed" });
  assert.deepEqual(page.capsules().map((capsule) => capsule.said), [null, "1 个失败", "未确认", null]);
  page.speak("en");
  page.render({ status: "completed" });
  assert.deepEqual(page.capsules().map((capsule) => capsule.said), [null, "1 failed", "not confirmed", null]);
});

test("the capsule row adds no control of its own: the disclosure keeps the keyboard", (t) => {
  const page = mount();
  t.after(page.close);
  page.render();
  const summary = page.document.querySelector(".tool-activity > summary");
  assert.equal(summary.querySelectorAll("button, a, input, select, textarea, [tabindex]").length, 0);
  // A long name is shown whole, not cut down to a shorter label.
  page.render({ turnItems: [
    { id: "long", type: "claudeToolUse", name: "mcp__claude_ai_Claude_Docs__batch", status: "completed" },
  ] });
  assert.deepEqual(page.capsules().map((capsule) => capsule.name), ["mcp__claude_ai_Claude_Docs__batch"]);
});
