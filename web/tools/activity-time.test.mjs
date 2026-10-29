import test from "node:test";
import assert from "node:assert/strict";
import { activityStartedAt, formatElapsed } from "../src/activity-time.ts";
import { conversationBlocks, hasAgentContent } from "../src/conversation-blocks.ts";

test("Working uses native start or persisted fallback; Compacting has its own clock", () => {
  const turn = { startedAt: 1700000000, _yuzunoStartedAt: 1700000002000, _yuzunoCompactionStartedAt: 1700000080000 };
  assert.equal(activityStartedAt(turn, "working"), 1700000000000);
  assert.equal(activityStartedAt(turn, "compacting"), 1700000080000);
  assert.equal(activityStartedAt({ ...turn, startedAt: null }, "working"), 1700000002000);
  assert.equal(activityStartedAt({}, "working"), undefined);
  assert.equal(activityStartedAt(turn, "working"), activityStartedAt(JSON.parse(JSON.stringify(turn)), "working"));
});

test("elapsed display carries into minutes and hours and clamps future timestamps", () => {
  for (const [ms, text] of [[-1000, "0s"], [999, "0s"], [59000, "59s"], [60000, "1m 00s"], [62000, "1m 02s"], [3661000, "1h 01m 01s"]])
    assert.equal(formatElapsed(ms), text);
});

test("empty reasoning does not create cards, counts, or split real tool groups", () => {
  const hidden = [
    { id: "r0", type: "reasoning", summary: [] },
    { id: "r1", type: "reasoning", summary: ["", " \n"] },
    { id: "r2", type: "reasoning", content: ["Raw-only fixture"] },
  ];
  assert.ok(hidden.every((item) => !hasAgentContent(item)));
  assert.deepEqual(conversationBlocks(hidden), []);
  const blocks = conversationBlocks([
    { id: "shell1", type: "commandExecution" }, ...hidden,
    { id: "public", type: "reasoning", summary: ["检查布局"] },
    { id: "shell2", type: "commandExecution" },
  ]);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].items.map((i) => i.id), ["shell1", "public", "shell2"]);
});
