import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-26: Claude sub-agents under their Agent call in the parent Turn. The real
// Turn in JSDOM (and in a conversation window, for source links), with Core's
// payload endpoint answered here; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "claude-subagents-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {ConversationWindow} from ${JSON.stringify(path.join(root, "src/ConversationWindow.tsx"))};
const root=createRoot(document.getElementById('root'));
const scroll={current:null}, follow={current:false};
window.renderTurn=(turn,agent,target)=>flushSync(()=>root.render(target
  ? <ConversationWindow scroll={scroll} follow={follow} target={target}><Turn turn={turn} index={0} agent={agent} onFile={()=>{}} onAnswer={()=>{}}/></ConversationWindow>
  : <Turn turn={turn} index={0} agent={agent} onFile={()=>{}} onAnswer={()=>{}}/>));`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ClaudeSubAgentsTurn", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = (connectionState = "connected", status = "idle") => ({
  id: "a", name: "Kiri", harness: "claude", color: "sage", status, connectionState, cwd: "/w", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
});
// As Core records CLI 2.1.280's frames (T-26 probe): two in parallel, one in the background.
const agentCall = (id, description, subAgent) => ({
  id, type: "claudeToolUse", name: "Agent", status: "completed",
  input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose" }, output: [{ type: "text", text: "done" }], subAgent,
});
const call = (id, parent, name = "Read", extra = {}) => ({
  id, type: "claudeToolUse", name, status: "completed", input: { file_path: `${id}.txt` }, output: `${id} output`, parentToolUseId: parent, ...extra,
});
const turn = (overrides = {}) => ({
  id: "t", status: "completed", items: [
    { id: "u", type: "userMessage", content: [{ type: "text", text: "Use three sub-agents" }] },
    { id: "m1", type: "agentMessage", phase: "commentary", text: "Starting them." },
    agentCall("agent-a", "List and read files in ./a", { taskId: "task-a", type: "general-purpose", status: "completed",
      background: false, result: "a.txt: alpha 1", usage: { tokens: 27800, toolUses: 2, durationMs: 8079 } }),
    agentCall("agent-b", "Read b.txt", { taskId: "task-b", type: "general-purpose", status: "completed", background: false, result: "b.txt is bravo" }),
    agentCall("agent-c", "Read c.txt", { taskId: "task-c", type: "general-purpose", status: "running", background: true,
      activity: "Reading c.txt", ...overrides.c }),
    call("a-ls", "agent-a", "Bash"),
    // The preview reports the full value's size ("bravo (whole)").
    call("b-read", "agent-b", "Read", { output: "bravo (start)", _yuzunoTruncated: { output: { bytes: 13, keep: "head" } } }),
    call("a-read", "agent-a"),
    call("c-read", "agent-c", "Read", { status: "inProgress", output: null }),
    { id: "m2", type: "agentMessage", phase: "final_answer", text: "a.txt: alpha 1. b.txt: bravo." },
  ],
});
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// Saved originals of calls the conversation window sent as previews.
const originals = {
  "big-read": { id: "big-read", type: "claudeToolUse", name: "Read", status: "completed", parentToolUseId: "inner",
    input: { file_path: "big.txt" }, output: "the whole saved output" },
};

function mount() {
  const errors = [], requests = [], vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.fetch = async (url) => {
    requests.push(String(url));
    const body = String(url).includes("/original") ? originals[decodeURIComponent(String(url).split("/items/")[1].split("/")[0])]
      : { fields: { output: "bravo (whole)" } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const row = (id) => document.getElementById(`item-${id}`);
  const summary = (id) => row(id).querySelector(":scope > summary");
  const open = async (id) => { summary(id).click(); await tick(); };
  const openTools = async () => {
    for (const group of document.querySelectorAll(".tool-activity")) if (!group.open) group.querySelector("summary").click();
    await tick();
  };
  return { window, document, errors, requests, row, summary, open, openTools, close: () => window.close() };
}

test("parallel and background sub-agents: each Agent call shows only its own goal, status, result and calls, read on request", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(turn(), agent());
  await page.openTools();
  const shown = [...page.document.querySelectorAll(".tool-activity .claude-tool")].map((node) => node.id);
  assert.deepEqual(shown, ["item-agent-a", "item-agent-b", "item-agent-c"], "sub-agents' calls are not the Turn's own tools");
  assert.match(page.document.querySelector(".tool-counts").textContent, /^Agent×3$/);
  assert.deepEqual(["agent-a", "agent-b", "agent-c"].map((id) => page.summary(id).querySelector(".tool-result").textContent),
    ["Completed", "Completed", "Running in the background"], "the background sub-agent runs on after its Turn ended");
  assert.equal(page.document.querySelectorAll(".claude-subagent").length, 0, "no detail DOM before a row opens");

  await page.open("agent-a");
  const a = page.row("agent-a");
  assert.match(a.textContent, /Status\s*Completed/);
  assert.match(a.textContent, /GOAL\s*List and read files in \.\/a\s*Do: List and read files in \.\/a/);
  assert.match(a.textContent, /RESULT\s*a\.txt: alpha 1/);
  assert.match(a.textContent, /Usage\s*27,800 tokens · 2 tool calls · 8s/);
  assert.equal(page.row("a-ls"), null, "its calls are mounted only when asked for");
  [...a.querySelectorAll("button")].find((b) => /Its tool calls · 2/.test(b.textContent)).click();
  await tick();
  assert.deepEqual([...a.querySelectorAll(".claude-subagent-calls .claude-tool")].map((node) => node.id), ["item-a-ls", "item-a-read"]);

  await page.open("agent-b");
  const b = page.row("agent-b");
  [...b.querySelectorAll("button")].find((node) => /Its tool calls · 1/.test(node.textContent)).click();
  await tick();
  assert.deepEqual([...b.querySelectorAll(".claude-subagent-calls .claude-tool")].map((node) => node.id), ["item-b-read"]);
  assert.equal(a.querySelector("#item-b-read"), null, "never under another sub-agent");
  assert.deepEqual(page.requests, [], "everything so far came with the Turn");
  // A call Core sent as a preview reads its full result on request.
  await page.open("b-read");
  [...page.row("b-read").querySelectorAll("button")].find((node) => /Show the full input and result/.test(node.textContent)).click();
  await tick();
  assert.deepEqual(page.requests, ["/api/agents/a/items/b-read/payload?turnId=t&field=output"]);
  assert.match(page.row("b-read").textContent, /bravo \(whole\)/);

  await page.open("agent-c");
  const c = page.row("agent-c");
  assert.match(c.textContent, /Status\s*Running in the background/);
  assert.match(c.textContent, /Reading c\.txt/);
  assert.match(c.textContent, /RESULT\s*No result yet\./);
  assert.doesNotMatch(page.document.querySelector(".commentary").textContent, /alpha|bravo/, "results stay with their sub-agent");
  assert.deepEqual(page.errors, []);
});

test("unconfirmed and unknown sub-agents say so; a link to a sub-agent's call opens its Agent call and the call", async (t) => {
  const page = mount();
  t.after(page.close);
  // Claude is not connected: what was running is not confirmed.
  page.window.renderTurn(turn(), agent("disconnected", "offline"));
  await page.openTools();
  assert.equal(page.summary("agent-c").querySelector(".tool-result").textContent, "Unconfirmed");
  await page.open("agent-c");
  assert.match(page.row("agent-c").textContent, /Not confirmed · was running when Claude was last connected/);
  // Its runtime ended while it ran: unknown, with why, never finished.
  page.window.renderTurn(turn({ c: { status: "unknown", reason: "runtime_ended" } }), agent());
  await tick();
  assert.equal(page.summary("agent-c").querySelector(".tool-result").textContent, "Unconfirmed");
  assert.match(page.row("agent-c").textContent, /Status unknown · Claude's connection ended first/);
  assert.match(page.row("agent-c").textContent, /No result was reported before its status became unknown\./);

  const linked = mount();
  t.after(linked.close);
  linked.window.renderTurn(turn(), agent(), { turnId: "t", itemId: "c-read" });
  await tick();
  assert.ok(linked.row("agent-c")?.open, "its Agent call opens");
  assert.ok(linked.row("c-read")?.open, "and the call itself");
  assert.ok(linked.row("agent-c").contains(linked.row("c-read")), "under its own sub-agent");
  assert.deepEqual([...page.errors, ...linked.errors], []);
});

test("a nested call's link opens every Agent call above it; a failure given only as text and a large call's original stay readable", async (t) => {
  const nested = {
    id: "t", status: "completed", items: [
      { id: "u", type: "userMessage", content: [{ type: "text", text: "Plan with a helper" }] },
      { ...agentCall("outer", "Plan", { taskId: "task-o", status: "completed" }) },
      { ...agentCall("inner", "Read big.txt", { taskId: "task-i", status: "completed" }), parentToolUseId: "outer" },
      call("inner-read", "inner"),
      // Too large for the conversation window: a preview with its identity.
      { id: "big-read", type: "historyPreview", status: "completed", text: "the whole sa", parentToolUseId: "inner",
        _yuzunoWindowPreview: { type: "claudeToolUse", bytes: 40000 } },
      // A failed Agent call whose only report is its text result.
      { id: "broken", type: "claudeToolUse", name: "Agent", status: "failed", input: { description: "Read z.txt", prompt: "Do: Read z.txt" },
        output: "Agent failed: the model refused", subAgent: { taskId: "task-z", status: "failed", background: false } },
    ],
  };
  const page = mount();
  t.after(page.close);
  page.window.renderTurn(nested, agent(), { turnId: "t", itemId: "inner-read" });
  await tick();
  for (const id of ["outer", "inner", "inner-read"]) assert.ok(page.row(id)?.open, `${id} opens`);
  assert.ok(page.row("outer").contains(page.row("inner")) && page.row("inner").contains(page.row("inner-read")), "each under its own sub-agent");

  // The large call: its saved original on request.
  const preview = page.row("big-read");
  assert.match(preview.textContent, /Large call · preview/);
  [...preview.querySelectorAll("button")].find((node) => /View the full call/.test(node.textContent)).click();
  await tick();
  assert.deepEqual(page.requests, ["/api/agents/a/items/big-read/original?turnId=t"]);
  assert.match(page.row("big-read").textContent, /the whole saved output/);
  assert.ok(page.row("inner").contains(page.row("big-read")), "still under its own sub-agent");

  await page.open("broken");
  assert.match(page.row("broken").textContent, /Status\s*Failed/);
  assert.match(page.row("broken").textContent, /RESULT\s*Agent failed: the model refused/, "the failure's own words");
  assert.deepEqual(page.errors, []);
});
