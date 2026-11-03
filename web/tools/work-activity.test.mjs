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
  const one = { current: 0, done: 1, exception: 0, unrecognized: 0 };
  assert.deepEqual(seen.byKind.job, one);
  assert.deepEqual(seen.byKind.run, one);
  assert.deepEqual(seen.byKind.subAgent, one);
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

const { jobWork, runWork, subAgentWork } = await import("../src/work-activity.ts");

test("a Job's normal ending is the only one that counts as done", () => {
  assert.equal(jobWork("succeeded"), "done");
  for (const going of ["waiting", "queued", "starting", "running", "cancelling"])
    assert.equal(jobWork(going), "current", going);
  // Every other ending, including one nobody can vouch for.
  for (const bad of ["failed", "cancelled", "rejected", "interrupted", "unknown"])
    assert.equal(jobWork(bad), "exception", bad);
});

test("an outcome Core lost is never read as a success", () => {
  assert.notEqual(jobWork("unknown"), "done");
  assert.equal(jobWork("unknown"), "exception");
});

test("a status from another Core is said, not dropped", () => {
  // Never silently absent, and never read as a success.
  assert.equal(jobWork("some-new-status"), "unrecognized");
  assert.equal(subAgentWork("some-new-state"), "unrecognized");
  const seen = workActivity([{ id: "j1", kind: "job", state: jobWork("some-new-status") }]);
  assert.equal(seen.unrecognized, 1);
  assert.equal(seen.byKind.job.done, 0);
  assert.equal(seen.any, true);
});

test("CI counts by what it concluded", () => {
  assert.equal(runWork("running", null), "current");
  assert.equal(runWork("pending", null), "current");
  assert.equal(runWork("completed", "success"), "done");
  for (const bad of ["failure", "cancelled", "timed_out", "action_required"])
    assert.equal(runWork("completed", bad), "exception", bad);
  // Decided nothing: not a pass, not a problem.
  assert.equal(runWork("completed", "skipped"), "uncounted");
  assert.equal(runWork("completed", "neutral"), "uncounted");
  assert.equal(runWork("completed", null), "uncounted");
});

test("a sub-agent paused or working in the background is still going", () => {
  for (const going of ["running", "pending", "paused"])
    assert.equal(subAgentWork(going), "current", going);
  assert.equal(subAgentWork("succeeded"), "done");
  assert.equal(subAgentWork("completed"), "done");
  for (const bad of ["failed", "cancelled", "unknown"])
    assert.equal(subAgentWork(bad), "exception", bad);
});

test("uncounted work stays out of every total", () => {
  const seen = workActivity([
    { id: "r1", kind: "run", state: runWork("completed", "skipped") },
    { id: "j1", kind: "job", state: jobWork("succeeded") },
  ].filter((i) => i.state !== "uncounted"));
  assert.equal(seen.byKind.run.done, 0);
  assert.equal(seen.byKind.job.done, 1);
  assert.equal(seen.any, true);
});

// Core's own vocabulary, walked: a status added to the text tables without a
// word here fails here, before it reaches anyone. That leaves the
// unrecognized branch for a Core older or newer than this build, which is
// the only thing it should ever cover.
test("every status Core names is classified", async () => {
  // Read from the table rather than imported: jobs-text.ts imports ./i18n
  // without an extension, which the type stripper cannot resolve, and the
  // point here is the list of names, not the words beside them.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/jobs-text.ts", import.meta.url), "utf8");
  const table = source.match(/status: \{([\s\S]*?)\} as Record<string, string>/);
  assert.ok(table, "the status table in jobs-text.ts");
  const names = [...table[1].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.ok(names.length >= 11, `expected Core's statuses, saw ${names.length}`);
  const unclassified = names.filter((name) => jobWork(name) === "unrecognized");
  assert.deepEqual(unclassified, [], `classify these in work-activity.ts: ${unclassified.join(", ")}`);
  // And none of them is accidentally a success.
  const done = names.filter((name) => jobWork(name) === "done");
  assert.deepEqual(done, ["succeeded"], "only a Job Core calls succeeded is done");
});

test("every sub-agent status the harness reports is classified", () => {
  // claude-subagents.ts ClaudeSubAgentStatus, plus the words the dock marks.
  const names = ["running", "succeeded", "failed", "cancelled", "unknown", "pending", "paused", "completed", "ended"];
  const unclassified = names.filter((name) => subAgentWork(name) === "unrecognized");
  assert.deepEqual(unclassified, [], `classify these: ${unclassified.join(", ")}`);
});

test("every CI conclusion GitHub gives is classified", () => {
  const names = ["success", "failure", "cancelled", "timed_out", "action_required", "skipped", "neutral"];
  const unclassified = names.filter((name) => runWork("completed", name) === "unrecognized");
  assert.deepEqual(unclassified, [], `classify these: ${unclassified.join(", ")}`);
  assert.equal(runWork("completed", "stale"), "unrecognized", "a conclusion from another GitHub is said");
});

const { byAttention } = await import("../src/work-activity.ts");

test("a resumable stop is an exception, but not ahead of a real failure", () => {
  const held = { id: "j1", kind: "job", state: "exception", resumable: true };
  const brokenRun = { id: "r1", kind: "run", state: "exception" };
  const order = byAttention([held, brokenRun]).map((i) => i.id);
  assert.deepEqual(order, ["r1", "j1"], "the failed CI run is looked at first");
  // It is still counted among the exceptions, not hidden or made a fourth kind.
  const seen = workActivity([held, brokenRun]);
  assert.equal(seen.exception, 2);
  assert.equal(seen.byKind.job.exception, 1);
});

test("what needs a look comes before what is merely going on", () => {
  const items = [
    { id: "a", kind: "job", state: "done" },
    { id: "b", kind: "job", state: "current" },
    { id: "c", kind: "run", state: "exception" },
    { id: "d", kind: "job", state: "unrecognized" },
  ];
  assert.deepEqual(byAttention(items).map((i) => i.id), ["c", "b", "d", "a"]);
});

test("work of equal standing keeps the order it came in", () => {
  const items = [
    { id: "1", kind: "job", state: "current" },
    { id: "2", kind: "job", state: "current" },
    { id: "3", kind: "job", state: "current" },
  ];
  assert.deepEqual(byAttention(items).map((i) => i.id), ["1", "2", "3"]);
});
