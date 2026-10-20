import test from "node:test";
import assert from "node:assert/strict";
import { observedEffort } from "../src/claude-effort.ts";

const turn = (id) => ({ id, status: "completed", items: [] });
const indexed = (ids) => ({
  index: ids.map((id, i) => ({ ...turn(id), number: i + 1, itemCount: 2 })),
  questions: [],
  nativeClientIds: [],
  start: null,
  end: null,
});
const detail = (reported, turns, conversation) => ({
  agent: { id: "a" },
  turns: turns.map(turn),
  claudeRuntime: reported ? { effort: reported } : null,
  ...(conversation ? { conversation } : {}),
});

test("the latest turn comes from the whole conversation, not the loaded window", () => {
  // Reading an older window: t2..t3 loaded, t4 is the conversation's latest.
  const window = indexed(["t1", "t2", "t3", "t4"]);
  assert.deepEqual(observedEffort(detail({ level: "high", turnId: "t4" }, ["t2", "t3"], window)),
    { level: "high", latest: true }, "the latest turn's report while an older window is open");
  assert.deepEqual(observedEffort(detail({ level: "low", turnId: "t3" }, ["t2", "t3"], window)),
    { level: "low", latest: false }, "an older report ending the open window is not the latest");
});

test("a detail without an index has all its turns loaded", () => {
  assert.deepEqual(observedEffort(detail({ level: "max", turnId: "t2" }, ["t1", "t2"])), { level: "max", latest: true });
  assert.deepEqual(observedEffort(detail({ level: "max", turnId: "t1" }, ["t1", "t2"])), { level: "max", latest: false });
  // A turn running now has not reported; the last report is for an earlier one.
  assert.deepEqual(observedEffort(detail({ level: "medium", turnId: "t1" }, ["t1", "running"])), { level: "medium", latest: false });
});

test("nothing reported, or no turns to compare, says only what was reported", () => {
  assert.equal(observedEffort(detail(null, ["t1"])), null);
  assert.equal(observedEffort(null), null);
  assert.deepEqual(observedEffort(detail({ level: "high", turnId: null }, [])), { level: "high", latest: false });
});
