import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-26: a Claude Agent's sub-agents on the conversation's sub-agent dock
// (T-79's SubAgentDock), from the Agent calls of the loaded Turns. The real
// dock and card in JSDOM; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "claude-subagent-dock-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ConversationSubAgentDock} from ${JSON.stringify(path.join(root, "src/ClaudeSubAgentDock.tsx"))};
const root=createRoot(document.getElementById('root'));
window.navigated=[];
window.renderDock=(turns,agent,running)=>flushSync(()=>root.render(<nav className="work-dock">
  <ConversationSubAgentDock agent={agent} turns={turns} running={running} onNavigate={(id)=>window.navigated.push(id)}/></nav>));`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ClaudeSubAgentDock", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = (harness = "claude", connectionState = "connected") => ({
  id: "a", name: "Kiri", harness, color: "sage", status: "idle", connectionState, cwd: "/w", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
});
// As Core records CLI 2.1.280's frames: two finished, one in the background,
// and a sub-agent one of them started.
const agentCall = (id, description, subAgent, extra = {}) => ({
  id, type: "claudeToolUse", name: "Agent", status: "completed",
  input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose" }, output: [{ type: "text", text: "done" }], subAgent, ...extra,
});
const call = (id, parent, name = "Read") => ({
  id, type: "claudeToolUse", name, status: "completed", input: { file_path: `${id}.txt` }, output: `${id} output`, parentToolUseId: parent,
});
const turns = () => [
  { id: "t1", status: "completed", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "Read the files" }] },
    agentCall("agent-a", "Read a.txt", { taskId: "task-a", type: "general-purpose", status: "completed", result: "alpha" }),
    agentCall("agent-b", "Plan the release", { taskId: "task-b", type: "Plan", status: "completed", result: "planned",
      usage: { tokens: 1200, toolUses: 2, durationMs: 3000 } }),
    call("a-read", "agent-a"),
    agentCall("agent-b2", "Check the notes", { taskId: "task-b2", status: "completed", result: "notes ok" }, { parentToolUseId: "agent-b" }),
    call("b2-read", "agent-b2"),
  ] },
  { id: "t2", status: "completed", items: [
    { id: "u2", type: "userMessage", content: [{ type: "text", text: "And c.txt in the background" }] },
    agentCall("agent-c", "Read c.txt", { taskId: "task-c", type: "general-purpose", status: "running", background: true, activity: "Reading c.txt" }),
    call("c-read", "agent-c"),
  ] },
];
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
// The calls a sub-agent's calls list shows, by their row's name and hint.
const calls = (scope) => {
  const list = scope.querySelector(".claude-subagent-calls");
  return [...list.querySelectorAll(".claude-tool")].filter((row) => row.parentElement.closest(".claude-subagent-calls") === list)
    .map((row) => row.querySelector(":scope > summary span").textContent);
};

function mount(respond = () => null, appearance = null) {
  const errors = [], requests = [], vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (appearance) window.localStorage.setItem("yuzuno.appearance", JSON.stringify(appearance));
  window.fetch = async (url) => {
    requests.push(String(url));
    const body = respond(String(url));
    return body ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
      : { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
  };
  window.eval(bundle);
  const document = window.document;
  const nodes = () => [...document.querySelectorAll(".conversation-subagent")];
  const node = (label) => nodes().find((n) => n.querySelector(".work-dock-label strong").textContent === label);
  const card = () => document.querySelector(".subagent-card");
  const button = (scope, text) => [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).includes(text));
  return { window, document, errors, requests, nodes, node, card, button, close: () => window.close() };
}

test("a Claude Agent's sub-agents are on the dock: its own calls' goal, status and result in a card, and its Turn one press away", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock(turns(), agent());
  assert.ok(page.document.querySelector(".work-dock-group[aria-label='Sub-agents']"), "a group of the dock");
  // The latest first; a sub-agent another one started opens within its card.
  assert.deepEqual(page.nodes().map((n) => [n.querySelector(".work-dock-label strong").textContent,
    n.querySelector(".work-dock-label small").textContent, n.className.match(/state-(\w+)/)[1]]), [
    ["Read c.txt", "Background", "running"],
    ["Plan the release", "Completed", "succeeded"],
    ["Read a.txt", "Completed", "succeeded"],
  ]);
  assert.equal(page.node("Plan the release").getAttribute("aria-label"), "Plan the release · Completed · Plan · 2 tool calls");
  assert.ok(page.card() === null, "no card before opening");

  page.node("Read c.txt").click();
  await tick();
  assert.equal(page.card().getAttribute("aria-label"), "Sub-agent Read c.txt");
  assert.match(page.card().textContent, /Status\s*Running in the background/);
  assert.match(page.card().textContent, /GOAL\s*Read c\.txt\s*Do: Read c\.txt/);
  assert.match(page.card().textContent, /Reading c\.txt/);
  assert.match(page.card().textContent, /RESULT\s*No result yet\./);
  page.button(page.card(), "Its tool calls · 1").click();
  await tick();
  assert.deepEqual(calls(page.card()), ["Read · c-read.txt"]);
  // Shown away from its Turn: no anchor a source link could find instead.
  assert.ok(page.card().querySelector("[id^='item-'], [data-item-id]") === null, "no Turn anchors in the card");
  page.button(page.card(), "Go to its Turn").click();
  await tick();
  assert.deepEqual([...page.window.navigated], ["t2"]);
  assert.ok(page.card() === null, "the card closes for its Turn");

  // A nested sub-agent opens within its parent's card, with its own calls.
  page.node("Plan the release").click();
  await tick();
  assert.match(page.card().textContent, /Usage\s*1,200 tokens · 2 tool calls · 3s/);
  page.button(page.card(), "Its tool calls · 1").click();
  await tick();
  const inner = [...page.card().querySelectorAll(".claude-tool")].find((n) => n.querySelector(":scope > summary").textContent.startsWith("Agent · Check the notes"));
  assert.equal(inner.querySelector(":scope > summary .tool-result").textContent, "Completed");
  inner.querySelector(":scope > summary").click();
  await tick();
  assert.match(inner.textContent, /RESULT\s*notes ok/);
  page.button(inner, "Its tool calls · 1").click();
  await tick();
  assert.deepEqual(calls(inner), ["Read · b2-read.txt"]);
  assert.ok(page.card().querySelector("[id^='item-'], [data-item-id]") === null, "no Turn anchors in the card");
  assert.deepEqual(page.requests, [], "all of it came with the Turns");
  assert.deepEqual(page.errors, []);
});

test("Settings sets how many sub-agents the dock shows, and 0 leaves the group off it", async (t) => {
  const one = mount(() => null, { dock: { jobs: 5, actions: 2, subAgents: 1 } });
  t.after(one.close);
  one.window.renderDock(turns(), agent());
  assert.deepEqual(one.nodes().map((n) => n.querySelector(".work-dock-label strong").textContent), ["Read c.txt"]);
  assert.equal(one.document.querySelector(".work-dock-more").getAttribute("aria-label"), "Sub-agents: 2 more, open the list");
  const none = mount(() => null, { dock: { jobs: 5, actions: 2, subAgents: 0 } });
  t.after(none.close);
  none.window.renderDock(turns(), agent());
  assert.ok(none.document.querySelector(".work-dock-group[aria-label='Sub-agents']") === null, "no Sub-agents group");
  assert.deepEqual([...one.errors, ...none.errors], []);
});

test("an Agent call too large for the conversation window is on the dock, and its card reads the saved original", async (t) => {
  // As core/src/conversation_window.rs bounded_item sends it: a preview that
  // keeps the sub-agent's facts, but not its goal or result.
  const facts = { taskId: "task-big", type: "general-purpose", status: "completed", description: "Summarize the log" };
  const original = { ...agentCall("agent-big", "Summarize the log", { ...facts, prompt: "Do: Summarize the log", result: "The log is fine." }) };
  const page = mount((url) => (url.includes("/items/agent-big/original") ? original : null));
  t.after(page.close);
  page.window.renderDock([{ id: "t3", status: "completed", items: [
    { id: "u3", type: "userMessage", content: [{ type: "text", text: "Summarize the log" }] },
    { id: "agent-big", type: "historyPreview", status: "completed", text: "Agent", name: "Agent",
      _yuzunoWindowPreview: { type: "claudeToolUse", bytes: 40000 }, subAgent: facts },
    call("big-read", "agent-big"),
  ] }], agent());
  const node = page.node("Summarize the log");
  assert.equal(node.className.match(/state-(\w+)/)[1], "succeeded");
  node.click();
  await tick();
  assert.match(page.card().textContent, /GOAL\s*Summarize the log\s*In the saved original of this call\./);
  assert.match(page.card().textContent, /RESULT\s*In the saved original of this call\./);
  assert.deepEqual(page.requests, [], "nothing is read until asked");
  page.button(page.card(), "Read the full call").click();
  await tick();
  assert.deepEqual(page.requests, ["/api/agents/a/items/agent-big/original?turnId=t3"]);
  assert.match(page.card().textContent, /GOAL\s*Summarize the log\s*Do: Summarize the log/);
  assert.match(page.card().textContent, /RESULT\s*The log is fine\./);
  page.button(page.card(), "Its tool calls · 1").click();
  await tick();
  assert.deepEqual(calls(page.card()), ["Read · big-read.txt"]);
  assert.deepEqual(page.errors, []);
});

test("a read original stays current: the preview's facts are laid over it, and a new status reads it again", async (t) => {
  const facts = (status, toolUses) => ({ taskId: "task-big", type: "general-purpose", status, description: "Summarize the log", usage: { toolUses } });
  const preview = (status, sub) => ({ id: "t3", status: "inProgress", items: [
    { id: "agent-big", type: "historyPreview", status, text: "Agent", name: "Agent",
      _yuzunoWindowPreview: { type: "claudeToolUse", bytes: 40000 }, subAgent: sub },
    call("big-read", "agent-big"),
  ] });
  // What Core has saved at each read.
  let saved = agentCall("agent-big", "Summarize the log", { ...facts("running", 1), prompt: "Do: Summarize the log", progress: "Reading the log" }, { status: "inProgress", output: null });
  const page = mount((url) => (url.includes("/items/agent-big/original") ? saved : null));
  t.after(page.close);
  page.window.renderDock([preview("inProgress", facts("running", 1))], agent());
  page.node("Summarize the log").click();
  await tick();
  page.button(page.card(), "Read the full call").click();
  await tick();
  assert.match(page.card().textContent, /GOAL\s*Summarize the log\s*Do: Summarize the log/);
  assert.match(page.card().textContent, /Reading the log/);
  assert.match(page.card().textContent, /RESULT\s*No result yet\./);
  // Core refetches the window for each update of so large a call: newer facts
  // show at once, over the original read a moment ago, without reading it again.
  page.window.renderDock([preview("inProgress", facts("running", 2))], agent());
  await tick();
  assert.match(page.card().textContent, /Usage\s*2 tool calls/);
  assert.equal(page.requests.length, 1);
  // It completed: its result is in the original, read again at once.
  saved = agentCall("agent-big", "Summarize the log", { ...facts("completed", 3), prompt: "Do: Summarize the log", result: "The log is fine." });
  page.window.renderDock([preview("completed", facts("completed", 3))], agent());
  await tick();
  assert.equal(page.requests.length, 2);
  assert.match(page.card().textContent, /Status\s*Completed/);
  assert.match(page.card().textContent, /Usage\s*3 tool calls/);
  assert.match(page.card().textContent, /RESULT\s*The log is fine\./);
  assert.ok(page.button(page.card(), "Read the full call") === undefined, "nothing left to read");
  assert.deepEqual(page.errors, []);
});

test("a nested sub-agent whose parent's call is outside the loaded window is on the dock itself", async (t) => {
  const page = mount();
  t.after(page.close);
  // The latest Items of t1 only: agent-b, which started agent-b2, is older.
  const [full] = turns();
  page.window.renderDock([{ ...full, items: full.items.filter((item) => ["agent-b2", "b2-read"].includes(item.id)) }], agent());
  assert.deepEqual(page.nodes().map((n) => n.querySelector(".work-dock-label strong").textContent), ["Check the notes"]);
  page.node("Check the notes").click();
  await tick();
  assert.match(page.card().textContent, /RESULT\s*notes ok/);
  page.button(page.card(), "Its tool calls · 1").click();
  await tick();
  assert.deepEqual(calls(page.card()), ["Read · b2-read.txt"]);
  // With its parent loaded it opens within the parent's card, as before.
  page.window.renderDock(turns(), agent());
  assert.deepEqual(page.nodes().map((n) => n.querySelector(".work-dock-label strong").textContent), ["Read c.txt", "Plan the release", "Read a.txt"]);
  assert.deepEqual(page.errors, []);
});

test("without Claude connected a running sub-agent is unconfirmed; a Codex Agent's dock is unchanged", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock(turns(), agent("claude", "disconnected"));
  const c = page.node("Read c.txt");
  // The dock's neutral node, as a Codex child's, not a run that went missing.
  assert.deepEqual([c.className.match(/state-(\w+)/)[1], c.querySelector(".work-dock-label small").textContent], ["unconfirmed", "Unconfirmed"]);
  assert.match(c.getAttribute("aria-label"), /Not confirmed · was running when Claude was last connected/);
  // The same Items under a Codex Agent are no Claude sub-agents.
  page.window.renderDock(turns(), agent("codex"));
  assert.deepEqual(page.nodes(), []);
  assert.ok(page.document.querySelector(".work-dock-group") === null);
  assert.deepEqual(page.errors, []);
});

test("a sub-agent still running whose call is outside the loaded window stays on the dock, in its place", async (t) => {
  // T-26: a background sub-agent outlives the Items after its call, and the
  // window holds the newest only. Core lists those still running
  // (conversation.runningSubAgents) as core/src/conversation_window.rs
  // previews their calls: the sub-agent's facts, not its goal or result.
  const facts = (description, id) => ({ taskId: `task-${id}`, type: "general-purpose", status: "running", background: true, description });
  const listed = (turnId, position, id, description) => ({ turnId, position, item: { id, type: "historyPreview", status: "completed",
    name: "Agent", _yuzunoWindowPreview: { type: "claudeToolUse" }, subAgent: facts(description, id) } });
  const original = agentCall("agent-bg", "Survey the notes", { ...facts("Survey the notes", "agent-bg"), prompt: "Do: Survey the notes" });
  const page = mount((url) => (url.includes("/items/agent-bg/original") ? original : null));
  t.after(page.close);
  // The newest Items of t5: a foreground sub-agent that ended, after agent-bg.
  const loaded = [{ id: "t5", status: "inProgress", _yuzunoSlice: { start: 50, total: 60, index: 4 }, items: [
    agentCall("agent-new", "Check the build", { taskId: "task-new", type: "general-purpose", status: "completed", result: "green" }),
    call("new-read", "agent-new"),
  ] }];
  page.window.renderDock(loaded, agent());
  assert.deepEqual(page.nodes().map((n) => n.querySelector(".work-dock-label strong").textContent), ["Check the build"],
    "without Core's list, only the loaded Items' sub-agents");
  const running = [listed("t5", [4, 3], "agent-bg", "Survey the notes"), listed("t7", [6, 2], "agent-deploy", "Watch the deploy"),
    // Loaded as well (an earlier page joined): once.
    listed("t5", [4, 50], "agent-new", "Check the build")];
  page.window.renderDock(loaded, agent(), running);
  assert.deepEqual(page.nodes().map((n) => [n.querySelector(".work-dock-label strong").textContent,
    n.querySelector(".work-dock-label small").textContent, n.className.match(/state-(\w+)/)[1]]), [
    ["Watch the deploy", "Background", "running"],
    ["Survey the notes", "Background", "running"],
    ["Check the build", "Completed", "succeeded"],
  ]);
  page.node("Survey the notes").click();
  await tick();
  assert.match(page.card().textContent, /Status\s*Running in the background/);
  assert.match(page.card().textContent, /GOAL\s*Survey the notes\s*In the saved original of this call\./);
  assert.deepEqual(page.requests, [], "nothing is read until asked");
  page.button(page.card(), "Read the full call").click();
  await tick();
  assert.deepEqual(page.requests, ["/api/agents/a/items/agent-bg/original?turnId=t5"]);
  assert.match(page.card().textContent, /GOAL\s*Survey the notes\s*Do: Survey the notes/);
  page.button(page.card(), "Go to its Turn").click();
  await tick();
  assert.deepEqual([...page.window.navigated], ["t5"]);
  assert.deepEqual(page.errors, []);
});
