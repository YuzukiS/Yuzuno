import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-25: a Claude Agent's background tasks (shells, monitors, workflows) as a
// group of the conversation's left dock, and stopping one of them. The real
// dock, card and stop button in JSDOM, with records as Core keeps them from
// CLI 2.1.280's frames; no Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "claude-background-tasks-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {ConversationBackgroundTaskDock} from ${JSON.stringify(path.join(root, "src/ClaudeBackgroundTasks.tsx"))};
import {ConversationSubAgentDock} from ${JSON.stringify(path.join(root, "src/ClaudeSubAgentDock.tsx"))};
const root=createRoot(document.getElementById('root'));
window.navigated=[];
window.renderDock=(turns,agent)=>flushSync(()=>root.render(<nav className="work-dock">
  <ConversationSubAgentDock agent={agent} turns={turns} onNavigate={(id)=>window.navigated.push(id)}/>
  <ConversationBackgroundTaskDock agent={agent} turns={turns} onNavigate={(id)=>window.navigated.push(id)}/></nav>));`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ClaudeBackgroundTasks", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = (harness = "claude", connectionState = "connected") => ({
  id: "a", name: "Kiri", harness, color: "sage", status: "idle", connectionState, cwd: "/w", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
});
const bash = (id, command, backgroundTask) => ({
  id, type: "claudeToolUse", name: "Bash", status: "completed", input: { command, run_in_background: !!backgroundTask },
  output: `Command running in background with ID: ${backgroundTask?.taskId}.`, ...(backgroundTask ? { backgroundTask } : {}),
});
const started = "2026-10-17T06:44:00Z";
const alpha = (extra = {}) => ({ taskId: "b4b36jo7p", type: "local_bash", status: "running", background: true,
  description: "sleep 25; echo alpha-done", startedAt: started, ...extra });
const turns = ({ alphaRecord = alpha(), betaRecord } = {}) => [
  { id: "t1", status: "completed", items: [
    { id: "u1", type: "userMessage", content: [{ type: "text", text: "Start two shells" }] },
    bash("toolu-a", "sleep 25; echo alpha-done", alphaRecord),
    bash("toolu-b", "sleep 50; echo beta-done", betaRecord ?? { taskId: "bownir676", type: "local_bash", status: "stopped", background: true,
      description: "sleep 50; echo beta-done", startedAt: started, endedAt: "2026-10-17T06:44:05Z",
      result: "sleep 50; echo beta-done", outputFile: "/tmp/claude-1000/tasks/bownir676.output" }),
    // A foreground shell keeps no record: not a background task.
    bash("toolu-f", "ls", null),
    { id: "toolu-m", type: "claudeToolUse", name: "Monitor", status: "completed", input: { description: "watch the build" },
      backgroundTask: { taskId: "m1", type: "monitor", status: "running", ambient: true, description: "watch the build" } },
    // A sub-agent in the background is in the sub-agent group, never here.
    { id: "agent-c", type: "claudeToolUse", name: "Agent", status: "completed", input: { description: "Read c.txt", prompt: "Do: Read c.txt" },
      subAgent: { taskId: "task-c", status: "running", background: true, description: "Read c.txt" } },
  ] },
];
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(respond = (url) => (url.endsWith("/stop") ? { requested: true } : null)) {
  const errors = [], requests = [], vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.fetch = async (url, init = {}) => {
    requests.push([init.method || "GET", String(url)]);
    const answer = respond(String(url));
    if (!answer) return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
    const ok = !answer.error;
    return { ok, status: ok ? 200 : 400, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  window.eval(bundle);
  const document = window.document;
  const group = (label) => document.querySelector(`.work-dock-group[aria-label='${label}']`);
  const nodes = (label) => [...(group(label)?.querySelectorAll(".work-dock-item") ?? [])];
  const row = (n) => [n.querySelector(".work-dock-label strong").textContent, n.querySelector(".work-dock-label small").textContent,
    n.className.match(/state-(\w+)/)[1]];
  const card = () => document.querySelector(".subagent-card");
  const button = (scope, text) => [...scope.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).includes(text));
  return { window, document, errors, requests, group, nodes, row, card, button, close: () => window.close() };
}
const open = async (page, label) => {
  page.nodes("Background tasks").find((n) => n.querySelector(".work-dock-label strong").textContent === label).click();
  await tick();
};

test("background shells and monitors are one dock group: each its own status, command, result and Turn; sub-agents and foreground shells are not in it", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock(turns(), agent());
  assert.ok(page.group("Background tasks"), "a group of the dock");
  // Still running first; housekeeping is never waiting.
  assert.deepEqual(page.nodes("Background tasks").map(page.row), [
    ["sleep 25; echo alpha-done", "Shell", "running"],
    ["watch the build", "Monitor", "running"],
    ["sleep 50; echo beta-done", "Stopped", "cancelled"],
  ]);
  assert.deepEqual(page.nodes("Sub-agents").map((n) => n.querySelector(".work-dock-label strong").textContent), ["Read c.txt"]);
  await open(page, "sleep 50; echo beta-done");
  assert.equal(page.card().getAttribute("aria-label"), "Background task sleep 50; echo beta-done");
  const text = page.card().textContent;
  assert.match(text, /Status\s*Stopped/);
  assert.match(text, /Kind\s*Shell/);
  assert.match(text, /Task\s*bownir676/);
  assert.match(text, /RUNS\s*sleep 50; echo beta-done/);
  assert.match(text, /RESULT\s*sleep 50; echo beta-done/);
  assert.match(text, /Output on the Core host: \/tmp\/claude-1000\/tasks\/bownir676\.output/);
  assert.ok(!page.button(page.card(), "Stop"), "an ended task has no stop");
  assert.match(page.card().querySelector(".claude-task-evidence pre").textContent, /"status": "stopped"/);
  page.button(page.card(), "Go to its Turn").click();
  await tick();
  assert.deepEqual([...page.window.navigated], ["t1"]);
  assert.deepEqual(page.requests, [], "nothing is read: the card shows what the Turn holds");
  assert.deepEqual(page.errors, []);
});

test("Stop sends one request for that task only; Stopping… waits for its end, and a second click sends nothing", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock(turns(), agent());
  await open(page, "sleep 25; echo alpha-done");
  assert.match(page.card().textContent, /Status\s*Running in the background/);
  assert.match(page.card().textContent, /Stops only this task\. The conversation and other tasks keep running\./);
  page.button(page.card(), "Stop sleep 25; echo alpha-done").click();
  await tick();
  assert.deepEqual(page.requests, [["POST", "/api/agents/a/tasks/b4b36jo7p/stop"]]);
  // Core recorded the stop; Claude has not reported the end yet.
  page.window.renderDock(turns({ alphaRecord: alpha({ stopRequestedAt: new Date().toISOString() }) }), agent());
  await tick();
  const stopping = page.button(page.card(), "Stop sleep 25; echo alpha-done");
  assert.ok(stopping.disabled);
  assert.match(stopping.textContent, /Stopping…/);
  assert.match(page.card().textContent, /Status\s*Stopping…/);
  stopping.click();
  await tick();
  assert.equal(page.requests.length, 1, "a second click sends nothing");
  assert.equal(page.row(page.nodes("Background tasks")[0])[1], "Stopping…");
  // Its own end came: stopped, nothing left to stop.
  page.window.renderDock(turns({ alphaRecord: alpha({ status: "stopped", stopRequestedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    result: "sleep 25; echo alpha-done" }) }), agent());
  await tick();
  assert.match(page.card().textContent, /Status\s*Stopped/);
  assert.ok(!page.button(page.card(), "Stop"));
  assert.deepEqual(page.errors, []);
});

test("a stop with no end reported, a refused stop, no task id, a disconnected Claude and a Codex Agent each say what they are", async (t) => {
  const page = mount((url) => (url.endsWith("/stop") ? { error: "Claude 当前报告的运行中任务里没有它，不能确认它还在运行" } : null));
  t.after(page.close);
  const long = new Date(Date.now() - 20_000).toISOString();
  page.window.renderDock(turns({ alphaRecord: alpha({ stopRequestedAt: long }) }), agent());
  await open(page, "sleep 25; echo alpha-done");
  assert.match(page.card().textContent, /Still running · no end reported since the stop/);
  assert.match(page.card().textContent, /Claude hasn't reported it ending since the stop was sent\./);
  const again = page.button(page.card(), "Stop sleep 25; echo alpha-done");
  assert.match(again.textContent, /Stop again/);
  again.click();
  await tick();
  assert.match(page.card().querySelector("[role=alert]").textContent, /Couldn’t stop it: Claude 当前报告的运行中任务里没有它/);
  // A refusal Core recorded stays on the task: on a page that never clicked
  // Stop, so it is the record's error that shows, not this click's.
  const recorded = mount(() => null);
  t.after(recorded.close);
  recorded.window.renderDock(turns({ alphaRecord: alpha({ stopRequestedAt: long, stopError: "stop refused" }) }), agent());
  await open(recorded, "sleep 25; echo alpha-done");
  assert.equal(recorded.card().querySelector("[role=alert]")?.textContent, "Couldn’t stop it: stop refused");
  page.window.renderDock(turns({ alphaRecord: alpha({ taskId: undefined }) }), agent());
  await tick();
  assert.match(page.card().textContent, /Claude didn't report a task id for it, so it can't be stopped on its own\./);
  assert.ok(!page.button(page.card(), "Stop sleep"));
  page.window.renderDock(turns(), agent("claude", "disconnected"));
  await tick();
  assert.match(page.card().textContent, /Not confirmed · was running when Claude was last connected/);
  assert.match(page.card().textContent, /Claude isn't connected, so nothing can be stopped now\./);
  page.window.renderDock(turns(), agent("codex"));
  await tick();
  assert.ok(!page.group("Background tasks"));
});

test("a task Claude described in its own words shows that as its name and what its call really runs", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock([{ id: "t1", status: "completed", items: [
    bash("toolu-d", "npm run dev -- --port 5173", { taskId: "bdev", type: "local_bash", status: "running", background: true, description: "Start the dev server" }),
  ] }], agent());
  await open(page, "Start the dev server");
  assert.match(page.card().textContent, /RUNS\s*Start the dev server\s*npm run dev -- --port 5173/);
  assert.ok(page.button(page.card(), "Stop Start the dev server"));
});

test("a sub-agent running in the background stops from its own card, by its task id", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderDock(turns(), agent());
  page.nodes("Sub-agents")[0].click();
  await tick();
  assert.equal(page.card().getAttribute("aria-label"), "Sub-agent Read c.txt");
  page.button(page.card(), "Stop Read c.txt").click();
  await tick();
  assert.deepEqual(page.requests.filter(([method]) => method === "POST"), [["POST", "/api/agents/a/tasks/task-c/stop"]]);
});
