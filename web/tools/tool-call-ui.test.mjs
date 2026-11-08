import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// One capsule per tool call (T-9), through the real Turn component: its
// name and short result on one line, read only from the answer the row
// already holds; a few more facts on hover or keyboard focus, which Escape
// hides; the raw input and result when the row is opened. Yuzuno's six
// tools are read from each harness's own record of the call. No Core, no
// browser, no web/dist writes, and nothing is fetched.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "tool-call-ui-"));
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
    build: { write: false, lib: { entry, name: "ToolCallUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = (harness = "codex") => ({
  id: "a", name: "Mori", harness, color: "green", status: "idle", cwd: "/work", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
});

// Core's answers, shaped as Core gives them (mcp_views.rs receipts, the
// Brief and the mailbox). Synthetic values only.
const answers = {
  task_comment: { task: { id: "T-9", title: "Tool call capsules", status: "doing", version: 49 }, activity: { seq: 640, kind: "comment" } },
  task_update: { task: { id: "T-9", title: "Tool call capsules", status: "done", version: 50 }, activity: { seq: 641, kind: "updated" } },
  brief_get_index: { projectId: "p", projectName: "Example", version: 12, sections: [], index: [{ key: "a" }, { key: "b" }, { key: "c" }], missingKeys: [] },
  brief_get_full: { projectId: "p", projectName: "Example", version: 12, sections: [{ key: "a" }, { key: "b" }] },
  brief_update: { accepted: true, receipt: { kind: "updated" }, version: 13, sections: [{ key: "progress", version: 4 }] },
  brief_conflict: { accepted: false, error: "brief_rejected: version_conflict. Nothing was changed", problems: [{ code: "version_conflict" }], latest: { version: 14 } },
  peer_read: { messages: [{ seq: 7, sender: { name: "Dev Lead" } }, { seq: 8, sender: { name: "Dev Lead" } }], nextAfterSeq: 8, hasMore: true },
  peer_send: { message: { id: "m", seq: 9, recipient: { id: "x", name: "Dev 7" }, delivery: { state: "pending", detail: {} }, firstReadAt: null, taskId: "T-9" } },
  peer_sent: { message: { id: "m", seq: 10, recipient: { id: "x", name: "Dev 7" }, delivery: { state: "delivered" }, firstReadAt: null } },
  // The executor flow (T-43 S3): task_get's current view, a page of its
  // history and a dispatch's materials; a result's and a dispatch's
  // receipts; a release that archived and one that waits.
  task_get_current: { current: { taskId: "T-9", title: "Tool call capsules", status: "review", version: 51 }, keys: { global: "T-9", history: [] } },
  task_get_history: { task: { title: "Tool call capsules" }, activities: [{ seq: 1 }, { seq: 2 }, { seq: 3 }], executions: [], nextAfterSeq: 3, hasMore: true, keys: { global: "T-9" } },
  task_get_materials: { dispatchMaterials: { schemaVersion: 1 }, latestTask: { taskId: "T-9" } },
  task_submit_result: { activity: { seq: 650, kind: "result" }, task: { id: "T-9", title: "Tool call capsules", status: "review", version: 52,
    result: { id: "a5fe340b-0000-4000-8000-000000000001", dispatchId: "d", notification: { state: "pending" } } } },
  task_dispatch: { activity: { seq: 651, kind: "dispatched" }, task: { id: "T-9", title: "Tool call capsules", status: "doing", version: 53,
    assignee: { id: "x", kind: "agent", name: "Dev 7" }, dispatch: { id: "d4bdf4a5-0000-4000-8000-000000000002", active: true } } },
  executor_released: { agentId: "e", closedAt: "2026-11-07T00:00:00Z", releasedAt: "2026-11-07T00:00:00Z", releasedBy: "user" },
  executor_archiving: { agentId: "e", closedAt: null, releasedAt: null, releasedBy: null,
    archiving: { since: "2026-11-07T00:00:00Z", releasedBy: "user", reason: "a Job is still running: build (j1)." } },
};
// Codex keeps Core's structured answer; Claude and OpenCode its JSON text.
const codex = (id, tool, answer, extra = {}) => ({ id, type: "mcpToolCall", server: "yuzuno", tool, status: "completed",
  arguments: { taskId: "T-9" }, result: { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer }, ...extra });
const claude = (id, tool, answer, extra = {}) => ({ id, type: "claudeToolUse", name: `mcp__yuzuno__${tool}`, status: "completed",
  input: { taskId: "T-9" }, output: [{ type: "text", text: JSON.stringify(answer) }], ...extra });
const opencode = (id, tool, answer, extra = {}) => ({ id, type: "opencodeTool", name: `yuzuno_${tool}`, status: "completed",
  input: {}, output: JSON.stringify(answer), ...extra });

function mount() {
  const errors = [];
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" }; };
  window.eval(bundle);
  const document = window.document;
  const speak = (language) => {
    window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    window.dispatchEvent(new window.StorageEvent("storage", { key: "yuzuno.language" }));
  };
  const render = (items, { harness = "codex", status = "completed" } = {}) =>
    window.renderTurn({
      turn: JSON.parse(JSON.stringify({ id: "t1", status, items: [{ id: "u", type: "userMessage", content: [{ type: "text", text: "Go" }] }, ...items] })),
      // A turn still running is followed while its Agent works.
      agent: { ...agent(harness), status: status === "inProgress" ? "working" : "idle" },
    });
  const openTools = async () => {
    for (const group of document.querySelectorAll(".tool-activity")) if (!group.open) group.querySelector(":scope > summary").click();
    await tick();
  };
  const row = (id) => document.getElementById(`item-${id}`);
  /** A capsule as the reader sees it. */
  const capsule = (id) => {
    const summary = row(id).querySelector(":scope > summary");
    return {
      name: summary.querySelector(".tool-call-name")?.textContent,
      note: summary.querySelector(".tool-call-note")?.textContent ?? null,
      end: summary.querySelector(".tool-result")?.textContent ?? null,
      tone: summary.getAttribute("data-tone"),
    };
  };
  const pointer = (target, type, pointerType = "mouse") => {
    const Event = window.PointerEvent ?? window.MouseEvent;
    const event = new Event(type, { bubbles: true, cancelable: true, pointerType });
    if (!("pointerType" in event) || event.pointerType !== pointerType) Object.defineProperty(event, "pointerType", { value: pointerType });
    target.dispatchEvent(event);
  };
  // The app's one tip (Tip.tsx, YN-44): Radix draws it in a wrapper of its own in the body.
  const tip = () => document.querySelector('.tip.tool-call-tip[role="tooltip"]');
  // A keyboard's focus (a key first) opens a tip; a press's does not.
  const keyFocus = (target) => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    target.focus();
  };
  const key = (name) => (document.activeElement ?? document.body).dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  return { window, document, errors, calls, render, speak, openTools, row, capsule, pointer, tip, keyFocus, key, close: () => window.close() };
}
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test("each Yuzuno call says its own short result in its capsule, on one line, from each harness's record", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    codex("c1", "task_comment", answers.task_comment),
    codex("c2", "task_update", answers.task_update),
    codex("c3", "brief_get", answers.brief_get_index),
    codex("c4", "brief_get", answers.brief_get_full),
    codex("c5", "brief_update", answers.brief_update),
    codex("c6", "peer_read", answers.peer_read),
    codex("c7", "peer_send", answers.peer_send),
    codex("c8", "peer_send", answers.peer_sent),
    codex("c9", "task_get", answers.task_get_current),
    codex("c10", "task_get", answers.task_get_history),
    codex("c11", "task_get", answers.task_get_materials),
    codex("c12", "task_submit_result", answers.task_submit_result),
    codex("c13", "task_dispatch", answers.task_dispatch),
    codex("c14", "executor_release", answers.executor_released),
    codex("c15", "executor_release", answers.executor_archiving),
  ]);
  await page.openTools();
  assert.deepEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15"].map(page.capsule), [
    { name: "yuzuno/task_comment", note: "comment saved on T-9", end: null, tone: "returned" },
    // The task's status as the receipt has it: the task record, not a release.
    { name: "yuzuno/task_update", note: "T-9 updated · Done", end: null, tone: "returned" },
    // An index is told apart from sections read in full.
    { name: "yuzuno/brief_get", note: "Brief v12 · index of 3, no bodies", end: null, tone: "returned" },
    { name: "yuzuno/brief_get", note: "Brief v12 · 2 sections in full", end: null, tone: "returned" },
    { name: "yuzuno/brief_update", note: "Brief v13 · 1 section updated", end: null, tone: "returned" },
    { name: "yuzuno/peer_read", note: "2 messages · more to read", end: null, tone: "returned" },
    // Delivery as it stood when sent: queued is not read, delivered is not handled.
    { name: "yuzuno/peer_send", note: "to Dev 7", end: "queued", tone: "queued" },
    { name: "yuzuno/peer_send", note: "to Dev 7", end: "delivered", tone: "returned" },
    // The executor flow: what was read, a result and a dispatch as receipts
    // (not accepted, not started), and a release.
    { name: "yuzuno/task_get", note: "read T-9 · To review", end: null, tone: "returned" },
    { name: "yuzuno/task_get", note: "T-9 · 3 activities · more to read", end: null, tone: "returned" },
    { name: "yuzuno/task_get", note: "dispatch materials of T-9", end: null, tone: "returned" },
    { name: "yuzuno/task_submit_result", note: "result submitted on T-9 · To review", end: null, tone: "returned" },
    { name: "yuzuno/task_dispatch", note: "T-9 dispatched to Dev 7", end: null, tone: "returned" },
    { name: "yuzuno/executor_release", note: "executor released · archived", end: null, tone: "returned" },
    { name: "yuzuno/executor_release", note: "executor released · archiving once its work ends", end: null, tone: "returned" },
  ]);
  // One line: every part of the capsule is in its single summary, nothing under it.
  for (const id of ["c1", "c7"]) {
    const summary = page.row(id).querySelector(":scope > summary");
    assert.equal(summary.className, "tool-call");
    assert.equal(summary.nextElementSibling.className, "tool-content");
  }
  // The server is quieter than the tool; the name reads whole.
  assert.equal(page.row("c1").querySelector(".tool-call-server").textContent, "yuzuno/");
  assert.equal(page.row("c1").querySelector(".tool-call-name strong").textContent, "task_comment");

  // Claude's and OpenCode's records of the same calls read the same, named as Codex names them.
  page.render([claude("k1", "task_update", answers.task_update), claude("k2", "peer_send", answers.peer_send),
    claude("k3", "job_get", { id: "j" })], { harness: "claude" });
  await page.openTools();
  assert.deepEqual(["k1", "k2"].map(page.capsule).map((c) => [c.name, c.note, c.end]),
    [["yuzuno/task_update", "T-9 updated · Done", null], ["yuzuno/peer_send", "to Dev 7", "queued"]]);
  // Another Yuzuno tool is named the same way and says only that it returned.
  assert.deepEqual(page.capsule("k3"), { name: "yuzuno/job_get", note: null, end: "returned", tone: "returned" });
  page.render([opencode("o1", "brief_get", answers.brief_get_full), opencode("o2", "peer_read", { messages: [], hasMore: false, nextAfterSeq: 0 })],
    { harness: "opencode" });
  await page.openTools();
  assert.deepEqual(["o1", "o2"].map(page.capsule).map((c) => [c.name, c.note]),
    [["yuzuno/brief_get", "Brief v12 · 2 sections in full"], ["yuzuno/peer_read", "no new mail"]]);
  assert.deepEqual(page.calls, [], "nothing is fetched to say a result");
  assert.deepEqual(page.errors, []);
});

test("a refusal comes first; a cut or unreadable answer is left to expand; other tools only say their state", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    // Core refused, whatever the harness made of the call.
    codex("r1", "brief_update", answers.brief_conflict),
    codex("r2", "task_update", { error: "version_conflict: expected 48, the task is at 49" }, { status: "failed" }),
    // The harness failed the call before Core answered.
    { id: "r3", type: "mcpToolCall", server: "yuzuno", tool: "peer_send", status: "failed", result: null, error: { message: "MCP server closed" } },
    // The preview cut the answer short: never counted from what is left.
    codex("r4", "peer_read", answers.peer_read, { _yuzunoTruncated: { result: { bytes: 90_000, keep: "head" } } }),
    // Not the answer expected, or not JSON at all.
    codex("r5", "task_comment", { ok: true }),
    { id: "r6", type: "mcpToolCall", server: "yuzuno", tool: "brief_get", status: "completed", result: { content: [{ type: "text", text: "{\"version\": 1" }] } },
    { id: "r7", type: "mcpToolCall", server: "docs", tool: "search", status: "completed", result: { content: [{ type: "text", text: "{\"task\":{\"id\":\"T-1\"}}" }] } },
    { id: "r8", type: "mcpToolCall", server: "yuzuno", tool: "peer_read", status: "inProgress" },
    { id: "sh", type: "commandExecution", command: "npm test", status: "completed", exitCode: 1 },
  ], { status: "inProgress" });
  await page.openTools();
  assert.deepEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "sh"].map(page.capsule), [
    { name: "yuzuno/brief_update", note: "version_conflict", end: "refused", tone: "refused" },
    { name: "yuzuno/task_update", note: "version_conflict", end: "refused", tone: "refused" },
    { name: "yuzuno/peer_send", note: "MCP server closed", end: "failed", tone: "failed" },
    { name: "yuzuno/peer_read", note: "result to expand", end: null, tone: "returned" },
    { name: "yuzuno/task_comment", note: "result to expand", end: null, tone: "returned" },
    { name: "yuzuno/brief_get", note: "result to expand", end: null, tone: "returned" },
    // Another server's answer is not read as Yuzuno's.
    { name: "docs/search", note: null, end: "returned", tone: "returned" },
    { name: "yuzuno/peer_read", note: null, end: "running", tone: "running" },
    { name: "npm test", note: null, end: "exit 1", tone: "failed" },
  ]);
  assert.equal(page.row("r4").querySelector(":scope > summary").hasAttribute("data-to-expand"), true);
  // The heading keeps only an overview: how many steps, how many returned
  // beside the ones that did not (T-15), and what went wrong.
  const heading = page.document.querySelector(".tool-activity > summary");
  assert.equal(heading.querySelectorAll(".tool-count").length, 0, "no capsule stack in the heading");
  assert.deepEqual([...heading.querySelectorAll(".tool-overview-part")].map((part) => [part.dataset.countKey, part.textContent]),
    [["steps", "9 tool steps"], ["returned", "4 returned"], ["failed", "2 failed"], ["refused", "2 refused"]]);
  assert.deepEqual(page.calls, [], "a cut answer is not fetched to say a result");
  assert.deepEqual(page.errors, []);
});

test("a call's own error flag comes first: never returned, never a summary of what it returned, always counted", async (t) => {
  const page = mount();
  t.after(page.close);
  const text = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
  page.render([
    // Codex can call a call completed whose MCP result says isError.
    codex("e1", "task_comment", null, { result: { content: text("Error: the tool crashed\nat line 3"), isError: true } }),
    // An error flag on what looks like an answer: still not that answer.
    codex("e2", "task_comment", null, { result: { content: text(answers.task_comment), structuredContent: answers.task_comment, isError: true } }),
    // Core's own error, flagged: refused, in Core's words.
    codex("e3", "task_update", null, { result: { content: text({ error: "forbidden: not your task" }), structuredContent: { error: "forbidden: not your task" }, isError: true } }),
    // Any other tool's error flag, and a dynamic tool that did not succeed.
    { id: "e4", type: "mcpToolCall", server: "docs", tool: "search", status: "completed", result: { content: text("rate limited"), isError: true } },
    { id: "e5", type: "dynamicToolCall", tool: "lookup", status: "completed", success: false, contentItems: [] },
    // Claude's is_error is its status.
    claude("e6", "task_comment", answers.task_comment, { status: "failed" }),
  ]);
  await page.openTools();
  assert.deepEqual(["e1", "e2", "e3", "e4", "e5", "e6"].map(page.capsule), [
    { name: "yuzuno/task_comment", note: "Error: the tool crashed", end: "failed", tone: "failed" },
    { name: "yuzuno/task_comment", note: null, end: "failed", tone: "failed" },
    { name: "yuzuno/task_update", note: "forbidden", end: "refused", tone: "refused" },
    { name: "docs/search", note: null, end: "failed", tone: "failed" },
    { name: "lookup", note: null, end: "failed", tone: "failed" },
    { name: "yuzuno/task_comment", note: null, end: "failed", tone: "failed" },
  ]);
  assert.deepEqual([...page.document.querySelectorAll(".tool-overview-part")].map((part) => part.textContent),
    ["6 tool steps", "5 failed", "1 refused"]);
  // Nor does its tip or its opened row read it as saved.
  const summary = page.row("e2").querySelector(":scope > summary");
  page.keyFocus(summary);
  await tick();
  assert.match(page.tip().textContent, /failed/);
  assert.doesNotMatch(page.tip().textContent, /saved/);
  summary.click();
  await tick();
  assert.equal(page.row("e2").querySelector(".tool-call-details"), null);
  assert.deepEqual(page.calls, []);
  assert.deepEqual(page.errors, []);
});

test("an answer longer than the limit is left to expand and never parsed whole", async (t) => {
  const page = mount();
  t.after(page.close);
  const sizes = [];
  const parse = page.window.JSON.parse;
  page.window.JSON.parse = function (value, reviver) {
    if (typeof value === "string") sizes.push(value.length);
    return parse.call(this, value, reviver);
  };
  const long = JSON.stringify({ ...answers.task_comment, padding: "x".repeat(70_000) });
  page.render([
    // Read in full (no preview mark), and longer than the limit.
    { id: "big", type: "mcpToolCall", server: "yuzuno", tool: "task_comment", status: "completed", result: { content: [{ type: "text", text: long }] } },
    claude("cbig", "peer_read", null, { output: long }),
    // A long error says its first line.
    { id: "ebig", type: "mcpToolCall", server: "yuzuno", tool: "peer_send", status: "completed",
      result: { content: [{ type: "text", text: `Error: queue full\n${"y".repeat(100_000)}` }], isError: true } },
  ]);
  await page.openTools();
  assert.deepEqual(["big", "cbig", "ebig"].map(page.capsule).map((c) => [c.note, c.end, c.tone]), [
    ["result to expand", null, "returned"],
    ["result to expand", null, "returned"],
    ["Error: queue full", "failed", "failed"],
  ]);
  assert.ok(Math.max(0, ...sizes) <= 64 * 1024, `nothing past the limit is parsed: ${Math.max(0, ...sizes)}`);
  assert.deepEqual(page.calls, []);
  assert.deepEqual(page.errors, []);
});

test("a call still reported as running is not confirmed once its turn is no longer followed", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render([{ id: "g", type: "mcpToolCall", server: "yuzuno", tool: "peer_read", status: "inProgress" }]);
  await page.openTools();
  assert.deepEqual(page.capsule("g"), { name: "yuzuno/peer_read", note: null, end: "Unconfirmed", tone: "unconfirmed" });
  assert.deepEqual([...page.document.querySelectorAll(".tool-overview-part")].map((part) => part.textContent),
    ["1 tool step", "1 not confirmed"]);
  assert.deepEqual(page.errors, []);
});

test("a Tool activity says how many returned only beside a call that did not, each counted by its own state (T-15)", async (t) => {
  const page = mount();
  t.after(page.close);
  const run = (id, exitCode) => ({ id, type: "commandExecution", command: `step ${id}`, status: "completed", exitCode });
  const live = (id) => ({ id, type: "commandExecution", command: `step ${id}`, status: "inProgress" });
  const parts = () => [...page.document.querySelectorAll(".tool-activity > summary .tool-overview-part")]
    .map((part) => [part.dataset.countKey, part.textContent]);
  for (const [case_, items, status, expected] of [
    // Every call returned: the steps say it, and no word is added.
    ["all returned", [run("a", 0), run("b", 0), run("c", 0)], "completed", [["steps", "3 tool steps"]]],
    // Beside a failure, how many returned is said apart from it.
    ["mixed", [run("a", 0), run("b", 0), run("c", 1)], "completed", [["steps", "3 tool steps"], ["returned", "2 returned"], ["failed", "1 failed"]]],
    // Beside a running call, and beside one no longer confirmed.
    ["running", [run("a", 0), live("b")], "inProgress", [["steps", "2 tool steps"], ["returned", "1 returned"]]],
    ["unconfirmed", [run("a", 0), live("b")], "completed", [["steps", "2 tool steps"], ["returned", "1 returned"], ["unconfirmed", "1 not confirmed"]]],
    // None returned: no returned part, not a zero.
    ["none returned", [run("a", 1), live("b")], "completed", [["steps", "2 tool steps"], ["failed", "1 failed"], ["unconfirmed", "1 not confirmed"]]],
    // A step with no state of its own is not counted as returned: never the
    // steps less the failures.
    ["no state", [{ id: "think", type: "reasoning", summary: ["Reading the logs."] }, run("a", 1)], "completed",
      [["steps", "2 tool steps"], ["failed", "1 failed"]]],
    // A call shown twice is one call.
    ["duplicate", [run("a", 0), run("a", 0), run("c", 1)], "completed", [["steps", "2 tool steps"], ["returned", "1 returned"], ["failed", "1 failed"]]],
  ]) {
    page.render(items, { status });
    await tick();
    assert.deepEqual(parts(), expected, case_);
  }
  // Neutral in Chinese too, and never a word of success in either.
  page.speak("zh-Hans");
  page.render([run("a", 0), run("b", 0), run("c", 1)]);
  await tick();
  assert.deepEqual(parts().map(([, text]) => text), ["3 个工具步骤", "已返回 2 次", "1 个失败"]);
  assert.doesNotMatch(page.document.querySelector(".tool-overview").textContent, /成功|succeed|success/i);
  assert.deepEqual(page.calls, []);
  assert.deepEqual(page.errors, []);
});

test("hover and keyboard focus show a few more facts, which Escape hides; a touch never shows them", async (t) => {
  const page = mount();
  t.after(page.close);
  page.render([codex("c2", "task_update", answers.task_update), codex("c7", "peer_send", answers.peer_send)]);
  await page.openTools();
  const summary = page.row("c2").querySelector(":scope > summary");
  page.pointer(summary, "pointermove");
  await tick(150);
  assert.equal(page.tip(), null, "not at once: a pointer passing over shows nothing");
  await tick(250);
  const tip = page.tip();
  assert.ok(tip, "a resting mouse shows the tip");
  assert.equal(summary.getAttribute("aria-describedby"), tip.id);
  assert.match(tip.textContent, /yuzuno\/task_update/);
  assert.match(tip.textContent, /Task\s*T-9 · Tool call capsules/);
  assert.match(tip.textContent, /Status at receipt\s*Done/);
  assert.match(tip.textContent, /Version\s*50/);
  assert.match(tip.textContent, /doesn't mean code was merged or released/);
  page.key("Escape");
  await tick();
  assert.equal(page.tip(), null, "Escape hides it");
  assert.equal(summary.hasAttribute("aria-describedby"), false);
  // Leaving hides it too.
  page.pointer(summary, "pointerout");
  await tick(500);
  page.pointer(summary, "pointermove");
  await tick(400);
  assert.ok(page.tip());
  page.pointer(summary, "pointerout");
  await tick();
  assert.equal(page.tip(), null);
  // A touch opens no tip; the tap opens the row, which leads with the same facts.
  const mail = page.row("c7").querySelector(":scope > summary");
  page.pointer(mail, "pointermove", "touch");
  await tick(400);
  assert.equal(page.tip(), null, "no tip from a touch");
  mail.click();
  await tick();
  assert.equal(page.row("c7").open, true);
  const opened = page.row("c7").querySelector(".tool-content");
  assert.match(opened.querySelector(".tool-call-details").textContent, /To\s*Dev 7\s*Delivery when sent\s*queued\s*Message\s*#9\s*Task\s*T-9/);
  assert.match(opened.querySelector(".tool-call-details").textContent, /Delivered doesn't mean it was read or acted on/);
  // The raw input and result stay under it, as text.
  assert.match(opened.querySelector("pre").textContent, /"recipient"/);
  // Keyboard focus shows the tip at once; leaving the capsule hides it. It
  // says what the call is, never what a click does (the user, YN-44).
  page.keyFocus(summary);
  assert.equal(page.document.activeElement, summary);
  await tick();
  assert.ok(page.tip(), "keyboard focus shows the tip");
  assert.doesNotMatch(page.tip().textContent, /Open the row|Close the row/);
  summary.blur();
  await tick();
  assert.equal(page.tip(), null);
  // A press that focuses the capsule on its way to opening the row shows none.
  page.pointer(summary, "pointerdown");
  summary.focus();
  await tick();
  assert.equal(page.tip(), null, "no tip from a press");
  summary.blur();
  assert.deepEqual(page.calls, []);
  assert.deepEqual(page.errors, []);
});

test("an answer's text stays text, in the capsule, the tip and the opened row", async (t) => {
  const page = mount();
  t.after(page.close);
  const markup = '<img src=x onerror="window.ran=1">';
  page.render([codex("x1", "task_update", { task: { id: markup, title: markup, status: "doing", version: 1 } }),
    codex("x2", "peer_send", { message: { seq: 3, recipient: { name: markup }, delivery: { state: "sending" } } })]);
  await page.openTools();
  assert.equal(page.capsule("x1").note, `${markup} updated · In progress`);
  assert.equal(page.capsule("x2").note, `to ${markup}`);
  assert.equal(page.capsule("x2").end, "sending");
  page.keyFocus(page.row("x1").querySelector(":scope > summary"));
  await tick();
  assert.match(page.tip().textContent, /onerror/);
  page.row("x1").querySelector(":scope > summary").click();
  await tick();
  assert.equal(page.document.querySelectorAll("img").length, 0, "no markup from an answer");
  assert.equal(page.window.ran, undefined);
  assert.deepEqual(page.errors, []);
});

test("in Chinese the capsule's words are Chinese; names, IDs and Core's codes stay as given", async (t) => {
  const page = mount();
  t.after(page.close);
  page.speak("zh-Hans");
  page.render([
    codex("c1", "task_comment", answers.task_comment),
    codex("c2", "task_update", answers.task_update),
    codex("c3", "brief_get", answers.brief_get_index),
    codex("c5", "brief_update", answers.brief_update),
    codex("c6", "peer_read", answers.peer_read),
    codex("c7", "peer_send", answers.peer_send),
    codex("r1", "brief_update", answers.brief_conflict),
    codex("r4", "peer_read", answers.peer_read, { _yuzunoTruncated: { result: { bytes: 90_000, keep: "head" } } }),
  ]);
  await page.openTools();
  assert.deepEqual(["c1", "c2", "c3", "c5", "c6", "c7", "r1", "r4"].map(page.capsule).map((c) => [c.note, c.end]), [
    ["T-9 备注已保存", null],
    ["T-9 已更新 · 已完成", null],
    ["Brief v12 · 索引 3 个区块（无正文）", null],
    ["Brief v13 · 已更新 1 个区块", null],
    ["2 条消息 · 还有更多", null],
    ["给 Dev 7", "排队中"],
    ["version_conflict", "被拒绝"],
    ["结果待展开", null],
  ]);
  assert.equal(page.row("r1").querySelector(".tool-call-note").getAttribute("lang"), "", "Core's code is in no language of the page's");
  const heading = page.document.querySelector(".tool-activity > summary .tool-overview");
  assert.equal(heading.textContent, "8 个工具步骤已返回 6 次1 个被拒绝");
  page.keyFocus(page.row("c2").querySelector(":scope > summary"));
  await tick();
  assert.equal(page.tip().getAttribute("lang"), "zh-Hans");
  assert.match(page.tip().textContent, /回执时状态\s*已完成/);
  assert.match(page.tip().textContent, /不表示代码已合并或发布/);
  assert.deepEqual(page.errors, []);
});
