import test from "node:test";
import assert from "node:assert/strict";
import { callToward, claudeSubAgents, formatUsage, subAgentCalls, turnSubAgents } from "../src/claude-subagents.ts";
import { blockItems, conversationBlocks, shownItemId, toolActivityCounts } from "../src/conversation-blocks.ts";

// T-26: Claude sub-agents as Core records them from CLI 2.1.280 (recorded
// probe: two in parallel, one in the background). The Agent call carries
// `subAgent`; the sub-agent's own calls name it as `parentToolUseId`.
const agentCall = (id, description, subAgent, extra = {}) => ({
  id, type: "claudeToolUse", name: "Agent", status: "completed",
  input: { description, prompt: `Do: ${description}`, subagent_type: "general-purpose" }, subAgent, ...extra,
});
const call = (id, parent, name = "Read", status = "completed") => ({
  id, type: "claudeToolUse", name, status, input: { file_path: `${id}.txt` }, parentToolUseId: parent, output: "x",
});
const turn = (items, status = "completed") => ({ id: "t", status, items });
const items = [
  { id: "u", type: "userMessage", content: [{ type: "text", text: "Use three sub-agents" }] },
  { id: "m1", type: "agentMessage", text: "Starting them.", phase: "commentary" },
  agentCall("agent-a", "List and read files in ./a", {
    taskId: "task-a", type: "general-purpose", status: "completed", background: false, result: "a.txt: alpha 1",
    usage: { tokens: 27800, toolUses: 3, durationMs: 8079 },
  }),
  agentCall("agent-b", "Read b.txt", { taskId: "task-b", type: "general-purpose", status: "completed", background: false, result: "bravo" }),
  agentCall("agent-c", "Read c.txt", { taskId: "task-c", type: "general-purpose", status: "running", background: true }),
  call("a-ls", "agent-a", "Bash"),
  call("b-read", "agent-b"),
  call("a-read", "agent-a"),
  { id: "m2", type: "agentMessage", text: "a.txt: alpha 1, b.txt: bravo" },
  call("c-read", "agent-c", "Read", "inProgress"),
  { id: "main-bash", type: "claudeToolUse", name: "Bash", status: "completed", input: { command: "ls" } },
];

test("each sub-agent's own calls stay under its Agent call, never another's", () => {
  const calls = subAgentCalls(items);
  assert.deepEqual([...calls].map(([agent, own]) => [agent, own.map((c) => c.id)]), [
    ["agent-a", ["a-ls", "a-read"]], ["agent-b", ["b-read"]], ["agent-c", ["c-read"]],
  ]);
  const entries = turnSubAgents(turn(items), true);
  assert.deepEqual(entries.map((e) => [e.key, e.label, e.status, e.state, e.sub]), [
    ["agent-a", "List and read files in ./a", "succeeded", "Completed", "general-purpose · 3 tool calls"],
    ["agent-b", "Read b.txt", "succeeded", "Completed", "general-purpose · 1 tool call"],
    ["agent-c", "Read c.txt", "running", "Running in the background", "general-purpose · Background · 1 tool call"],
  ]);
  assert.deepEqual(entries.map((e) => [e.turnId, e.itemId, e.waiting]), [["t", "agent-a", false], ["t", "agent-b", false], ["t", "agent-c", false]]);
});

test("the Turn's own tool activity keeps the Agent calls and its own tools; the sub-agents' calls are found on their block", () => {
  const blocks = conversationBlocks(items);
  assert.deepEqual(blocks.map((b) => b.kind), ["user", "message", "tools", "message", "tools"]);
  assert.deepEqual(blocks[2].items.map((i) => i.id), ["agent-a", "agent-b", "agent-c"]);
  assert.deepEqual(blocks[2].calls.map((i) => i.id), ["a-ls", "b-read", "a-read", "c-read"], "even one arriving after a reply");
  assert.deepEqual(blocks[4].items.map((i) => i.id), ["main-bash"]);
  assert.deepEqual(toolActivityCounts(blocks[2].items).map((c) => [c.label, c.count]), [["Agent", 3]]);
  assert.deepEqual(blockItems(blocks[2]).map((i) => i.id), ["agent-a", "agent-b", "agent-c", "a-ls", "b-read", "a-read", "c-read"]);
  // A source link to a sub-agent's call shows its Agent call.
  assert.equal(shownItemId(blocks[2], "c-read"), "agent-c");
  assert.equal(shownItemId(blocks[2], "agent-b"), "agent-b");
  assert.equal(shownItemId(blocks[4], "c-read"), undefined);
});

test("a call whose Agent call is not loaded, or was never seen, stays in the Turn's own activity", () => {
  const orphan = call("o-read", "agent-unseen");
  const blocks = conversationBlocks([{ id: "m", type: "agentMessage", text: "Hi" }, orphan]);
  assert.deepEqual(blocks.map((b) => [b.kind, b.items?.map((i) => i.id)]), [["message", undefined], ["tools", ["o-read"]]]);
});

test("nested sub-agents form a tree under the outermost Agent call", () => {
  const nested = [
    agentCall("outer", "Plan", { status: "running" }, { status: "inProgress" }),
    agentCall("inner", "Read", { status: "completed" }, { parentToolUseId: "outer" }),
    call("inner-read", "inner"),
  ];
  const blocks = conversationBlocks(nested);
  assert.deepEqual(blocks[0].items.map((i) => i.id), ["outer"]);
  assert.deepEqual(blocks[0].calls.map((i) => i.id), ["inner", "inner-read"]);
  assert.equal(shownItemId(blocks[0], "inner-read"), "outer");
  const entries = turnSubAgents(turn(nested, "inProgress"), true);
  assert.deepEqual(entries.map((e) => [e.key, e.parentKey, e.calls.map((c) => c.id)]), [["outer", null, ["inner"]], ["inner", "outer", ["inner-read"]]]);
  // What to open on the way to a nested call, at each level.
  const byId = new Map(nested.map((item) => [item.id, item]));
  assert.equal(callToward(byId, "inner-read", "outer"), "inner");
  assert.equal(callToward(byId, "inner-read", "inner"), "inner-read");
  assert.equal(callToward(byId, "inner", "outer"), "inner");
  assert.equal(callToward(byId, "outer", "outer"), undefined, "not under itself");
  assert.equal(callToward(byId, "inner-read", "agent-a"), undefined);
  assert.equal(callToward(byId, undefined, "outer"), undefined);
});

test("a sub-agent is running only while Claude can still report; unknown and ended states keep their reasons", () => {
  const states = (record, live = true, extra = {}) => {
    const [entry] = turnSubAgents(turn([agentCall("x", "Do it", record, extra)]), live);
    return [entry.status, entry.state, entry.waiting];
  };
  assert.deepEqual(states({ status: "running", background: true }, false),
    ["unknown", "Not confirmed · was running when Claude was last connected", true], "disconnected: never shown as running");
  assert.deepEqual(states({ status: "unknown", reason: "runtime_ended" }),
    ["unknown", "Status unknown · Claude's connection ended first", true]);
  assert.deepEqual(states({ status: "stopped", reason: "worker_restart" }), ["cancelled", "Stopped · Claude restarted", false]);
  assert.deepEqual(states({ status: "failed", error: "boom" }), ["failed", "Failed · boom", false]);
  assert.deepEqual(states({ status: "pending" }), ["running", "Starting", false]);
  // Without task events: the Agent call itself.
  assert.deepEqual(states(undefined, true, { status: "inProgress" }), ["running", "Running", false]);
  assert.deepEqual(states(undefined, true, { status: "unknown" }), ["unknown", "Status unknown", true]);
});

test("an Agent call too large for the conversation window is still a sub-agent; the Turn keeps its calls in view", () => {
  // As core/src/conversation_window.rs bounded_item sends it.
  const preview = { id: "agent-big", type: "historyPreview", status: "completed", text: "Agent", name: "Agent",
    _yuzunoWindowPreview: { type: "claudeToolUse", bytes: 40000 },
    subAgent: { taskId: "task-big", type: "general-purpose", status: "completed", description: "Summarize the log" } };
  const items = [preview, call("big-read", "agent-big")];
  const [entry] = turnSubAgents(turn(items), true);
  assert.deepEqual([entry.key, entry.label, entry.status, entry.calls.map((c) => c.id)], ["agent-big", "Summarize the log", "succeeded", ["big-read"]]);
  // The Turn shows the preview as a preview; its call stays in the Turn's own activity.
  assert.deepEqual(conversationBlocks(items).map((b) => [b.kind, (b.items ?? [b.item]).map((i) => i.id)]), [["preview", ["agent-big"]], ["tools", ["big-read"]]]);
});

test("every loaded Turn's sub-agents, and usage in plain words", () => {
  const second = { id: "t2", status: "inProgress", items: [agentCall("agent-d", "Read d.txt", { status: "running" })] };
  assert.deepEqual(claudeSubAgents([turn(items), second], true).map((e) => [e.turnId, e.key]), [
    ["t", "agent-a"], ["t", "agent-b"], ["t", "agent-c"], ["t2", "agent-d"],
  ]);
  assert.equal(formatUsage({ tokens: 27800, toolUses: 3, durationMs: 8079 }), `${(27800).toLocaleString()} tokens · 3 tool calls · 8s`);
  assert.equal(formatUsage(undefined), "");
});
