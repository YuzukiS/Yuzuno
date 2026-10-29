import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// T-9: a Codex MCP call's capsule names its server and tool instead of only
// its kind ("mcp Tool Call"). Its raw details are unchanged.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "tool-label-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderTurns=(list)=>root.render(<>{list.map((props)=><Turn key={props.turn.id} {...props}/>)}</>);`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ToolLabel", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = { id: "agent-1", name: "Dev", status: "idle", color: "sage", harness: "codex" };
const long = { server: "a-very-long-mcp-server-name-for-checking", tool: "an_extremely_long_tool_name_that_does_not_fit_in_one_row" };
const items = [
  { id: "m1", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed", arguments: { taskId: "T-1" },
    result: { content: [{ type: "text", text: "ok" }] } },
  { id: "m2", type: "mcpToolCall", server: "yuzuno", tool: "task_get", status: "completed", arguments: { taskId: "T-2" } },
  { id: "m3", type: "mcpToolCall", server: "yuzuno", status: "failed" },
  { id: "m4", type: "mcpToolCall", ...long, status: "completed" },
  { id: "ls", type: "commandExecution", command: "ls", aggregatedOutput: "Cargo.toml\n", status: "completed", exitCode: 0 },
];
const turn = {
  id: "turn-1", status: "completed",
  items: [{ id: "ask", type: "userMessage", content: [{ type: "text", text: "Look it up" }] }, ...items,
    { id: "reply", type: "agentMessage", text: "Found it.", phase: "final_answer" }],
};

async function mount() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  const calls = [];
  window.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  window.eval(bundle);
  window.renderTurns([{ turn, index: 0, agent, onFile() {} }]);
  await tick();
  for (const group of window.document.querySelectorAll(".tool-activity"))
    if (!group.open) group.querySelector("summary").click();
  await tick();
  return { window, document: window.document, calls, close: () => window.close() };
}
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (page, id) => page.document.querySelector(`[id="item-${id}"]`);
const label = (node) => node.querySelector(":scope > summary > span:first-of-type");
const result = (node) => node.querySelector(":scope > summary > .tool-result").textContent;

test("a Codex MCP call's capsule names its server and tool", async () => {
  const page = await mount();
  try {
    const m1 = row(page, "m1");
    assert.equal(label(m1).textContent, "yuzuno/task_get");
    // The server quieter, the tool in bold; the tip has the name whole.
    assert.equal(label(m1).querySelector(".tool-call-server")?.textContent, "yuzuno/");
    assert.equal(label(m1).querySelector("strong")?.textContent, "task_get");
    // A call that returned says so, and no more (T-9: never success).
    assert.equal(result(m1), "returned");

    // The heading keeps only an overview; each call is its own capsule.
    assert.equal(page.document.querySelectorAll(".tool-activity .tool-count").length, 0);
    assert.equal(page.document.querySelector(".tool-activity .tool-overview").textContent, "5 tool steps1 failed");

    // A long name is whole in the text; only the capsule cuts it short.
    const m4 = row(page, "m4");
    assert.equal(label(m4).textContent, `${long.server}/${long.tool}`);

    // A call that names no tool is named by its kind, as before but readable.
    const m3 = row(page, "m3");
    assert.equal(label(m3).textContent, "MCP tool");
    assert.equal(label(m3).querySelector("strong"), null);
    assert.equal(result(m3), "failed");

    // Other rows keep their own labels.
    assert.equal(label(row(page, "ls")).textContent, "ls");

    // The raw details are unchanged.
    m1.querySelector("summary").click();
    await tick();
    assert.equal(m1.querySelector(".tool-content pre").textContent, JSON.stringify(items[0], null, 2));
    assert.deepEqual(page.calls, [], "nothing is fetched to name a row");
  } finally {
    page.close();
  }
});
