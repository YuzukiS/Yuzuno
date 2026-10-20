import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationSubAgents,
  threadStatusLabel,
  turnStatusLabel,
} from "../src/subagents.ts";
import { conversationBlocks } from "../src/conversation-blocks.ts";

// Codex 0.162.1 as recorded on a real parent Turn (target/t60/probe-3).
const A = "01a1418f-8744-7533-af1c-da150088054d";
const B = "01a1418f-9dc3-7f00-98af-5fc645888bb8";
const activity = (kind, child, path, extra = {}) => ({
  type: "subAgentActivity",
  id: kind === "started" ? `call_${path}` : `subagent-${kind}-${child}`,
  kind,
  agentThreadId: child,
  agentPath: path,
  model: kind === "started" ? "gpt-6-astra" : null,
  ...extra,
});
const started = [
  activity("started", A, "/root/alpha"),
  activity("started", B, "/root/beta"),
];
// The sub-agents of one parent Turn, through the entry point the
// conversation uses; `running` is whether that Turn is still in progress.
const inTurn = (items, running) =>
  conversationSubAgents([
    { id: "t", status: running ? "inProgress" : "completed", items },
  ]);

test("each child is one row in start order; only a completed activity ends it", () => {
  const items = [...started, activity("completed", A, "/root/alpha")];
  const rows = inTurn(items, true);
  assert.deepEqual(
    rows.map((r) => [r.label, r.state, r.model]),
    [
      ["alpha", "ended", "gpt-6-astra"],
      ["beta", "started", "gpt-6-astra"],
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.threadId),
    [A, B],
    "Codex's own thread IDs, nothing inferred",
  );
});

test("an Item's own start and completion events are one fact, not the child finishing", () => {
  // As the probe recorded it: item/started and item/completed of the same started activity.
  const rows = inTurn([started[0], { ...started[0] }, started[1]], true);
  assert.deepEqual(
    rows.map((r) => r.state),
    ["started", "started"],
  );
});

test("interacted is input to the child, never a state; the last known fact stays", () => {
  const after = inTurn(
    [
      ...started,
      activity("completed", A, "/root/alpha"),
      activity("interacted", A, "/root/alpha"),
    ],
    true,
  );
  assert.equal(
    after[0].state,
    "ended",
    "a message to a finished child does not make it run",
  );
  const before = inTurn(
    [started[0], activity("interacted", A, "/root/alpha")],
    true,
  );
  assert.equal(before[0].state, "started");
});

test("without an ending, an ended parent Turn leaves the child unknown; interrupted is its own fact", () => {
  assert.deepEqual(
    inTurn(
      [...started, activity("interrupted", B, "/root/beta")],
      false,
    ).map((r) => r.state),
    ["unknown", "interrupted"],
  );
  assert.deepEqual(
    inTurn([activity("interacted", A, "/root/alpha")], true).map(
      (r) => r.state,
    ),
    ["unknown"],
    "no start or end seen: unknown",
  );
});

test("activity without a child thread is not a row", () => {
  assert.deepEqual(
    inTurn(
      [{ type: "subAgentActivity", id: "x", kind: "started" }],
      true,
    ),
    [],
  );
});

test("sub-agent activity is one block where it first appears, never a tool or a reply", () => {
  const items = [
    { type: "userMessage", id: "u", content: [] },
    { type: "agentMessage", id: "m1", text: "Starting both." },
    started[0],
    { type: "commandExecution", id: "c", command: "ls", status: "completed" },
    started[1],
    { type: "collabAgentToolCall", id: "w", tool: "wait", status: "completed" },
    activity("completed", A, "/root/alpha"),
    { type: "agentMessage", id: "m2", text: "ALPHA=ALPHA" },
  ];
  const blocks = conversationBlocks(items);
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["user", "message", "subagents", "tools", "message"],
  );
  assert.deepEqual(
    blocks[2].items.map((i) => i.id),
    [started[0].id, started[1].id, `subagent-completed-${A}`],
  );
  assert.deepEqual(
    blocks[3].items.map((i) => i.id),
    ["c", "w"],
    "the wait call stays with the tools",
  );
});

test("Codex's own thread and Turn statuses get plain names; idle is not a result", () => {
  assert.deepEqual(
    ["active", "idle", "notLoaded", "systemError", "x"].map(threadStatusLabel),
    ["Working", "Idle", "Not loaded", "System error", "x"],
  );
  assert.deepEqual(
    ["completed", "failed", "interrupted", "inProgress"].map(turnStatusLabel),
    ["Completed", "Failed", "Interrupted", "In progress"],
  );
});

test("a child worked with again in a later Turn is one entry: where it started, its latest fact", () => {
  const turns = [
    { id: "t1", status: "completed", items: [...started, activity("completed", A, "/root/alpha")] },
    // Later: input to alpha (not a fact) and beta started again while t2 runs.
    {
      id: "t2",
      status: "inProgress",
      items: [
        activity("interacted", A, "/root/alpha", { id: "interacted-alpha" }),
        activity("started", B, "/root/beta", { id: "call_beta_again" }),
      ],
    },
  ];
  const children = conversationSubAgents(turns);
  assert.deepEqual(
    children.map((c) => [c.label, c.state, c.turnId, c.itemId]),
    [
      ["alpha", "ended", "t1", "call_/root/alpha"],
      ["beta", "started", "t1", "call_/root/beta"],
    ],
  );
  assert.equal(new Set(children.map((c) => c.threadId)).size, children.length, "one entry per thread");
  // Once t2 ends without beta ending, beta's last fact is a start in an
  // ended Turn: unknown, as for a single Turn.
  turns[1].status = "completed";
  assert.equal(conversationSubAgents(turns).find((c) => c.threadId === B).state, "unknown");
});
