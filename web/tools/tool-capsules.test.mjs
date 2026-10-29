import test from "node:test";
import assert from "node:assert/strict";
import { toolActivityCounts } from "../src/conversation-blocks.ts";
import { callState, toolCapsules } from "../src/tool-capsules.ts";

// What a Tool activity capsule says (T-9), from the Items' own reported
// fields. How a tool is named and counted stays toolActivityCounts': nothing
// here derives, splits or guesses a tool's name.

test("a call's state is only what its own fields report", () => {
  const state = (item, unconfirmed = false) => callState({ id: "i", ...item }, unconfirmed);
  assert.equal(state({ type: "mcpToolCall", status: "inProgress" }), "running");
  // The same call, with this turn's execution no longer followed.
  assert.equal(state({ type: "mcpToolCall", status: "inProgress" }, true), "unconfirmed");
  assert.equal(state({ type: "claudeToolUse", status: "unknown" }), "unconfirmed");
  assert.equal(state({ type: "claudeToolUse", status: "failed" }), "failed");
  assert.equal(state({ type: "mcpToolCall", status: "completed" }), "returned");
  assert.equal(state({ type: "commandExecution", status: "completed", exitCode: 0 }), "returned");
  assert.equal(state({ type: "commandExecution", status: "completed", exitCode: 2 }), "failed");
  // Still running: its own status decides, not the exit code it lacks.
  assert.equal(state({ type: "commandExecution", status: "inProgress", exitCode: null }), "running");
  // Items that report no state of their own.
  assert.equal(state({ type: "reasoning", summary: ["why"] }), null);
  assert.equal(state({ type: "plan", text: "# Plan" }, true), null);
});

test("a group's capsule names its most notable state and how many calls hold it", () => {
  const items = [
    { id: "m1", type: "mcpToolCall", server: "docs", tool: "search", status: "completed" },
    { id: "m2", type: "mcpToolCall", server: "docs", tool: "search", status: "failed" },
    { id: "m3", type: "mcpToolCall", server: "docs", tool: "search", status: "completed" },
    { id: "r", type: "reasoning", summary: ["why"] },
  ];
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), false).map((c) => [c.label, c.count, c.state, c.part]),
    [
      ["docs/search", 3, "failed", 1],
      ["Reasoning", 1, null, 0],
    ],
  );
});

test("a group of calls that returned says nothing more; a group's number is the calls, not their output", () => {
  const items = [
    { id: "s1", type: "commandExecution", command: "pwd", status: "completed", exitCode: 0, aggregatedOutput: "a\nb\nc" },
    { id: "s2", type: "commandExecution", command: "ls", status: "completed", exitCode: 0 },
  ];
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), false).map((c) => [c.label, c.count, c.state, c.part]),
    [["Shell", 2, "returned", 2]],
  );
});

test("running is running only while the turn is followed", () => {
  const items = [
    { id: "c1", type: "claudeToolUse", name: "mcp__yuzuno__task_get", status: "inProgress" },
    { id: "c2", type: "claudeToolUse", name: "mcp__yuzuno__task_get", status: "completed" },
  ];
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), false).map((c) => [c.label, c.count, c.state, c.part]),
    [["mcp__yuzuno__task_get", 2, "running", 1]],
  );
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), true).map((c) => [c.state, c.part]),
    [["unconfirmed", 1]],
  );
});

test("the capsule keeps the name the harness gave it", () => {
  const items = [
    { id: "m", type: "mcpToolCall", server: "docs", tool: "search" },
    { id: "c", type: "claudeToolUse", name: "mcp__yuzuno__task_get" },
    // A call whose server and tool this version does not have: its kind, not
    // a guessed name (T-9: "MCP tool", as its own row says).
    { id: "u", type: "mcpToolCall" },
  ];
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), false).map((c) => c.label),
    ["docs/search", "mcp__yuzuno__task_get", "MCP tool"],
  );
  // The interface language reaches a kind's own word, never a tool's name.
  assert.deepEqual(
    toolCapsules(toolActivityCounts([{ id: "e", type: "fileChange", changes: [{ path: "a" }] }], "zh-Hans"), false)
      .map((c) => c.label),
    ["编辑"],
  );
});

test("a Claude sub-agent's call is left to its own row", () => {
  // Claude keeps a background sub-agent running after its Turn ends, and
  // records whether it was paused or stopped; `status` alone has none of that.
  assert.equal(callState({ id: "a", type: "claudeToolUse", name: "Agent", status: "inProgress" }, true), null);
  const items = [
    { id: "a1", type: "claudeToolUse", name: "Agent", status: "inProgress" },
    { id: "a2", type: "claudeToolUse", name: "Agent", status: "completed" },
  ];
  assert.deepEqual(
    toolCapsules(toolActivityCounts(items), true).map((c) => [c.label, c.count, c.state, c.part]),
    [["Agent", 2, null, 0]],
  );
});
