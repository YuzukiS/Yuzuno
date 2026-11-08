import test from "node:test";
import assert from "node:assert/strict";
import { askingAgents, attentionRank, needsYouTargets, nextTarget, orderByAttention, unseenEnd, waitingSince } from "../src/attention.ts";

// Who needs the user, and in what order (T-42).
const agent = (id, extra = {}) => ({
  id,
  name: id,
  status: "idle",
  pendingCount: 0,
  unreadCount: 0,
  closedAt: null,
  projectId: null,
  ...extra,
});
const end = (seq, outcome = "finished") => ({ lastTurnEnd: { seq, outcome, at: "2026-11-05T00:00:00Z" } });
const ids = (agents) => agents.map((a) => a.id);

test("a Turn end is unseen until this device has shown it, and only on an Agent at rest", () => {
  const done = agent("a", end(7));
  assert.equal(unseenEnd(done, {}), "finished");
  assert.equal(unseenEnd(done, { a: 6 }), "finished");
  assert.equal(unseenEnd(done, { a: 7 }), null);
  assert.equal(unseenEnd(agent("b", { ...end(3, "failed"), status: "error" }), {}), "failed");
  for (const status of ["working", "waiting", "offline"]) assert.equal(unseenEnd({ ...done, status }, {}), null, status);
  assert.equal(unseenEnd({ ...done, closedAt: "2026-11-05T00:00:00Z" }, {}), null);
  assert.equal(unseenEnd(agent("c"), {}), null, "no Turn end yet");
});

test("a Turn end the conversation was read past is seen on any device; one after the last read is not (review 9392d7c2)", () => {
  // A new device, browser profile or cleared storage: no mark here.
  assert.equal(unseenEnd(agent("read", { ...end(7), reviewedSeq: 7 }), {}), null, "read through the end");
  assert.equal(unseenEnd(agent("past", { ...end(7), reviewedSeq: 9 }), {}), null, "read past it");
  assert.equal(unseenEnd(agent("after", { ...end(7, "failed"), status: "error", reviewedSeq: 6 }), {}), "failed", "ended after the last read");
  // Either mark is enough: this device's, or the read.
  assert.equal(unseenEnd(agent("here", { ...end(7), reviewedSeq: 3 }), { here: 7 }), null);
  assert.equal(unseenEnd(agent("old-mark", { ...end(7), reviewedSeq: 7 }), { "old-mark": 4 }), null);
});

test("the attention order: needs you oldest first, unseen failed before finished, working, ready, offline", () => {
  const agents = [
    agent("offline", { status: "offline" }),
    agent("ready"),
    agent("finished", end(5)),
    agent("needs-new", { pendingCount: 1, status: "waiting" }),
    agent("working", { status: "working" }),
    agent("failed", { ...end(4, "failed"), status: "error" }),
    agent("needs-old", { pendingCount: 2 }),
    agent("question", { pendingCount: 1, openQuestions: 1 }),
    agent("seen", end(9)),
  ];
  const since = new Map([["needs-new", 3000], ["needs-old", 1000]]);
  assert.deepEqual(ids(orderByAttention(agents, { seen: { seen: 9 }, since })), [
    "needs-old", "needs-new", "question", "failed", "finished", "working", "ready", "seen", "offline",
  ]);
  assert.equal(attentionRank(agents[7], {}), "needsYou", "an open question waits on the user");
  assert.equal(attentionRank(agent("x", { disconnectedAt: "2026-11-05T00:00:00Z" }), {}), "offline");
});

test("ties keep the list's order, and a Project's leads come first (T-36's interface)", () => {
  const agents = [agent("a"), agent("b", { status: "working" }), agent("c"), agent("d", { status: "working" })];
  assert.deepEqual(ids(orderByAttention(agents, { seen: {} })), ["b", "d", "a", "c"]);
  assert.deepEqual(ids(orderByAttention(agents, { seen: {} }, { leads: new Set(["c"]) })), ["c", "b", "d", "a"]);
  // An unchanged list is a new array, never the same one sorted in place.
  const given = [...agents];
  orderByAttention(given, { seen: {} });
  assert.deepEqual(ids(given), ["a", "b", "c", "d"]);
});

test("waiting since takes each Agent's oldest request or question, and no Ask", () => {
  const since = waitingSince([
    { kind: "approval", agentId: "a", since: "2026-11-05T00:00:02Z" },
    { kind: "question", agentId: "a", since: "2026-11-05T00:00:01Z" },
    { kind: "ask", agentId: "b", since: "2026-11-05T00:00:00Z" },
    { kind: "approval", agentId: "c", since: "not a time" },
  ]);
  assert.deepEqual([...since], [["a", Date.parse("2026-11-05T00:00:01Z")]]);
});

test("an executor's gate ask waits on the user: its wait counts, it needs you, and it goes with those waiting (T-43 S4)", () => {
  const items = [
    { kind: "ask", agentId: "g", since: "2026-11-05T00:00:03Z", gate: { taskId: "YN-1", step: 3 } },
    { kind: "ask", agentId: "b", since: "2026-11-05T00:00:00Z" },
    { kind: "approval", agentId: "w", since: "2026-11-05T00:00:04Z" },
  ];
  assert.deepEqual([...waitingSince(items)], [["g", Date.parse("2026-11-05T00:00:03Z")], ["w", Date.parse("2026-11-05T00:00:04Z")]],
    "a gate's ask counts, a plain one doesn't");
  assert.deepEqual([...askingAgents(items)], ["g"]);
  assert.deepEqual([...askingAgents(null)], []);
  // g has no request of its own: its gate's ask puts it with those waiting, oldest first.
  const order = orderByAttention([agent("idle"), agent("w", { pendingCount: 1 }), agent("g")],
    { seen: {}, since: waitingSince(items), asking: askingAgents(items) });
  assert.deepEqual(ids(order), ["g", "w", "idle"]);
  assert.deepEqual(ids(orderByAttention([agent("idle"), agent("g")], { seen: {} })), ["idle", "g"], "without it, as before");
});

test("next needs you goes through Home's Needs you in Core's order, each Agent once; a Turn end not seen here is no place in it (YN-3)", () => {
  const agents = [
    agent("p2-agent", { pendingCount: 1 }),
    agent("p1-agent", { pendingCount: 2 }),
    agent("late", { pendingCount: 1 }),
    agent("done", end(3)),
    agent("broke", { ...end(2, "failed"), status: "error" }),
    agent("gone", { pendingCount: 1, closedAt: "2026-11-05T00:00:00Z" }),
    agent("answered", { pendingCount: 0 }),
  ];
  const items = [
    { kind: "approval", projectId: "p1", agentId: "p1-agent", requestId: "r1", since: "" },
    { kind: "ask", projectId: "p1", agentId: "lead", sectionKey: "decide", since: "" },
    { kind: "question", projectId: "p1", agentId: "p1-agent", turnId: "t", itemId: "q", since: "" },
    { kind: "approval", projectId: "p2", agentId: "p2-agent", requestId: "r2", since: "" },
    { kind: "approval", projectId: "p2", agentId: "answered", requestId: "r3", since: "" },
    { kind: "approval", projectId: "p2", agentId: "gone", requestId: "r4", since: "" },
  ];
  // Nothing seen on this device ({}, which the round once took and no longer
  // needs): only what waits for the user's decision is in it. "done" and
  // "broke" ended Turns this device has not shown; the Agent list marks them (YN-3).
  const targets = needsYouTargets(items, agents, {});
  assert.deepEqual(targets, [
    { kind: "agent", agentId: "p1-agent" },
    { kind: "ask", projectId: "p1", sectionKey: "decide" },
    { kind: "agent", agentId: "p2-agent" },
    // Waiting, but not yet in the last read of Home.
    { kind: "agent", agentId: "late" },
  ]);
  assert.deepEqual(nextTarget(targets, null), { target: targets[0], index: 0 });
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "p2-agent" }), { target: targets[3], index: 3 });
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "late" }), { target: targets[0], index: 0 }, "it wraps");
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "elsewhere" }), { target: targets[0], index: 0 });
  assert.equal(nextTarget([], null), null);
  // Left out of the round, the last jump's place is kept: the round goes on
  // from where it was rather than starting over.
  const last = { target: { kind: "agent", agentId: "gone" }, index: 2 };
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "gone" }, last), { target: targets[2], index: 2 });
});

test("an executor the user dispatched goes in next needs you as its Agent, a failed and closed one too (T-36 S3)", () => {
  const agents = [agent("done"), agent("broke", { closedAt: "2026-11-05T00:00:00Z" }), agent("other")];
  const executor = (agentId, state) => ({ kind: "executor", projectId: null, agentId, agentName: agentId, state, taskId: "T-1", title: "Work", since: "2026-11-05T00:00:00Z" });
  const items = [executor("done", "delivering"), executor("broke", "failed"), executor("gone", "failed")];
  assert.deepEqual(needsYouTargets(items, agents), [{ kind: "agent", agentId: "done" }, { kind: "agent", agentId: "broke" }],
    "each listed executor once, in Home's order; one no longer listed is left out");
});
