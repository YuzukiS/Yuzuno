import test from "node:test";
import assert from "node:assert/strict";
import { callState } from "../src/tool-capsules.ts";

// The state a tool call's capsule says (T-9), from the Item's own reported
// fields. What its answer adds is tool-call.ts's (tool-call-ui.test.mjs).

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

test("a Claude sub-agent's call is left to its own row", () => {
  // Claude keeps a background sub-agent running after its Turn ends, and
  // records whether it was paused or stopped; `status` alone has none of that.
  assert.equal(callState({ id: "a", type: "claudeToolUse", name: "Agent", status: "inProgress" }, true), null);
  assert.equal(callState({ id: "b", type: "claudeToolUse", name: "Agent", status: "completed" }, false), null);
});
