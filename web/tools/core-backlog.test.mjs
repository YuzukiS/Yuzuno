import test from "node:test";
import assert from "node:assert/strict";
import { BEHIND_MS, behindAgents, nextStreaks } from "../src/core-backlog.ts";

const read = (agents) => ({ observedAt: "2026-10-15T20:00:00Z", agents });
const at = (oldestMs, pending = 3) => ({ generation: 1, pending, oldestMs });

test("an Agent is behind only after two reads in a row at the threshold", () => {
  let streaks = nextStreaks({}, read({ a: at(BEHIND_MS) }));
  assert.equal(
    behindAgents(streaks, read({ a: at(BEHIND_MS) })).length,
    0,
    "one read is a spike",
  );
  const second = read({ a: at(BEHIND_MS + 5000, 40) });
  streaks = nextStreaks(streaks, second);
  assert.deepEqual(behindAgents(streaks, second), [
    { id: "a", generation: 1, pending: 40, oldestMs: BEHIND_MS + 5000 },
  ]);
});

test("catching up, a short burst, a missing Agent or no read clears it", () => {
  const behind = nextStreaks(
    nextStreaks({}, read({ a: at(9000) })),
    read({ a: at(9000) }),
  );
  assert.equal(behindAgents(behind, read({ a: at(9000) })).length, 1);
  assert.deepEqual(
    nextStreaks(behind, read({ a: at(BEHIND_MS - 1) })),
    {},
    "caught up",
  );
  assert.deepEqual(
    nextStreaks(behind, read({})),
    {},
    "no connection: unknown, not behind",
  );
  assert.deepEqual(nextStreaks(behind, null), {}, "no read: nothing stale");
  const burst = nextStreaks(
    nextStreaks({}, read({ a: at(800, 2000) })),
    read({ a: at(0, 0) }),
  );
  assert.deepEqual(
    burst,
    {},
    "thousands of events applied within a second never count",
  );
});

test("Agents are judged separately", () => {
  const first = read({ a: at(7000), b: at(10) });
  const second = read({ a: at(12000), b: at(7000) });
  const streaks = nextStreaks(nextStreaks({}, first), second);
  assert.deepEqual(
    behindAgents(streaks, second).map((agent) => agent.id),
    ["a"],
  );
});
