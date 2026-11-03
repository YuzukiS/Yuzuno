// The conversation's work, counted (T-15). Pure module, no DOM.
import test from "node:test";
import assert from "node:assert/strict";

const { workActivity } = await import("../src/work-activity.ts");
const item = (id, kind, state) => ({ id, kind, state });

test("each kind is counted on its own, never added together", () => {
  const seen = workActivity([
    item("j1", "job", "done"),
    item("r1", "run", "done"),
    item("s1", "subAgent", "done"),
  ]);
  assert.deepEqual(seen.byKind.job, { current: 0, done: 1, exception: 0 });
  assert.deepEqual(seen.byKind.run, { current: 0, done: 1, exception: 0 });
  assert.deepEqual(seen.byKind.subAgent, { current: 0, done: 1, exception: 0 });
  // A Job that succeeded, a check that passed and a sub-agent that returned
  // are three facts, so nothing reads "3 succeeded".
  assert.equal(seen.current, 0);
  assert.equal(seen.exception, 0);
  assert.equal(seen.any, true);
});

test("the same work twice is one piece of work", () => {
  const seen = workActivity([
    item("j1", "job", "current"),
    item("j1", "job", "current"),
    item("j1", "job", "done"),
  ]);
  assert.equal(seen.byKind.job.current, 1);
  assert.equal(seen.byKind.job.done, 0, "the first state seen is the one kept");
  assert.equal(seen.current, 1);
});

test("the same id in two kinds is two pieces of work", () => {
  const seen = workActivity([item("1", "job", "current"), item("1", "run", "current")]);
  assert.equal(seen.current, 2);
});

test("what went wrong is never folded into what ended well", () => {
  const seen = workActivity([
    item("j1", "job", "exception"),
    item("j2", "job", "done"),
    item("r1", "run", "exception"),
  ]);
  assert.equal(seen.exception, 2);
  assert.equal(seen.byKind.job.exception, 1);
  assert.equal(seen.byKind.run.exception, 1);
  assert.equal(seen.byKind.job.done, 1);
});

test("nothing to show is said plainly", () => {
  const seen = workActivity([]);
  assert.equal(seen.any, false);
  assert.equal(seen.current, 0);
  assert.equal(seen.exception, 0);
});

test("work that is not of a known kind is ignored rather than guessed at", () => {
  const seen = workActivity([
    { id: "x", kind: "other", state: "current" },
    { id: "", kind: "job", state: "current" },
    item("j1", "job", "current"),
  ]);
  assert.equal(seen.current, 1);
});
