import test from "node:test";
import assert from "node:assert/strict";
import { attentionRank, needsYouTargets, nextTarget, orderByAttention, unseenEnd, waitingSince } from "../src/attention.ts";

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

test("next needs you goes through Home's Needs you in Core's order, each Agent once, then unseen failed and finished", () => {
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
  const targets = needsYouTargets(items, agents, {});
  assert.deepEqual(targets, [
    { kind: "agent", agentId: "p1-agent" },
    { kind: "ask", projectId: "p1", sectionKey: "decide" },
    { kind: "agent", agentId: "p2-agent" },
    // Waiting, but not yet in the last read of Home.
    { kind: "agent", agentId: "late" },
    { kind: "agent", agentId: "broke" },
    { kind: "agent", agentId: "done" },
  ]);
  assert.deepEqual(nextTarget(targets, null), { target: targets[0], index: 0 });
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "p2-agent" }), { target: targets[3], index: 3 });
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "done" }), { target: targets[0], index: 0 }, "it wraps");
  assert.deepEqual(nextTarget(targets, { kind: "agent", agentId: "elsewhere" }), { target: targets[0], index: 0 });
  assert.equal(nextTarget([], null), null);
  // Seen here, a Turn end is no longer a place to go; the round goes on
  // from where the last jump was rather than starting over.
  const seen = needsYouTargets(items, agents, { broke: 2 });
  assert.equal(seen.length, 5);
  const last = { target: { kind: "agent", agentId: "broke" }, index: 4 };
  assert.deepEqual(nextTarget(seen, { kind: "agent", agentId: "broke" }, last), { target: { kind: "agent", agentId: "done" }, index: 4 });
  assert.equal(needsYouTargets(items, agents, { done: 3, broke: 2 }).length, 4);
});
