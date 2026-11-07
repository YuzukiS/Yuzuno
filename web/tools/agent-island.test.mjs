import test from "node:test";
import assert from "node:assert/strict";
import { clockMs, islandTime, islandView } from "../src/agent-island.ts";
import { executorView } from "../src/executor-display.ts";

// T-43, 灵动环 v10.2 (the user's design): the ring at an Agent row's top
// right is its state; an executor's line one is what it is doing; needs you
// and failed are row islands by themselves; a click on the ring goes
// straight to its state's place, and a ring with nowhere of its own is none.
const at = (iso) => Date.parse(iso);
const agent = (extra = {}) => ({ status: "idle", pendingCount: 0, unreadCount: 0, closedAt: null, disconnectedAt: null, lastTurnEnd: null, workSummary: null, ...extra });
const ended = { seq: 9, outcome: "finished", at: "2026-11-07T03:00:00Z" };
const standing = (a, more = {}) => islandView({ agent: a, statusLabel: "Ready", ...more });
const life = (state, extra = {}) => ({ state, agentId: "e", task: { id: "YN-24", title: "Design first" }, dispatchedAt: "2026-11-07T02:00:00Z", since: "2026-11-07T03:10:00Z", ...extra });
const exec = (lifecycle, a = agent(), more = {}) =>
  islandView({ agent: a, lifecycle, executor: executorView({ agent: a, lifecycle, ...more }), statusLabel: "Ready", waitingSince: more.waitingSince ?? null });

test("a standing Agent's island: the first rule that holds, with a clock only where its record has one", () => {
  const rows = [
    // [agent, more, state, clock kind or null, line]
    [agent({ lastTurnEnd: ended }), {}, "idle", "since", { kind: "none" }],
    [agent({ status: "working", workSummary: { text: "Merging #659" } }), {}, "working", null, { kind: "text", text: "Merging #659" }],
    [agent({ status: "working" }), { compacting: true, statusLabel: "Compacting" }, "working", null, { kind: "text", text: "Compacting" }],
    [agent(), { waiting: "Waiting · Job" }, "working", null, { kind: "text", text: "Waiting · Job" }],
    [agent({ pendingCount: 1, status: "waiting", workSummary: { text: "Allow git push?" } }), { waitingSince: at("2026-11-07T03:20:00Z") }, "waiting", "live", { kind: "text", text: "Allow git push?" }],
    [agent({ status: "error", lastTurnEnd: { ...ended, outcome: "failed" } }), { statusLabel: "Needs a look" }, "failed", "since", { kind: "text", text: "Needs a look" }],
    [agent({ unreadCount: 3, lastTurnEnd: ended }), {}, "done", "since", { kind: "none" }],
    [agent({ lastTurnEnd: ended }), { unseen: "finished" }, "done", "since", { kind: "none" }],
    [agent({ status: "offline", disconnectedAt: "2026-11-07T00:30:00Z" }), { statusLabel: "Offline" }, "offline", "since", { kind: "text", text: "Offline" }],
    [agent({ closedAt: "2026-11-07T01:00:00Z" }), { statusLabel: "Closed" }, "archived", "since", { kind: "text", text: "Closed" }],
  ];
  for (const [a, more, state, clock, line] of rows) {
    const view = standing(a, more);
    assert.equal(view.state, state, JSON.stringify(a));
    assert.equal(view.clock?.kind ?? null, clock, `${state}'s clock`);
    assert.deepEqual(view.line, line, `${state}'s line`);
  }
});

test("an executor's island follows its one state; delivering splits into working and handed in", () => {
  const started = at("2026-11-07T02:00:00Z");
  const rows = [
    // [lifecycle, agent, more, state, clock]
    [life("queued", { position: 2 }), agent({ status: "offline" }), {}, "queued", { kind: "live", from: started, to: null }],
    [life("running"), agent({ status: "working" }), {}, "working", { kind: "live", from: started, to: null }],
    [life("running"), agent({ pendingCount: 1, status: "waiting" }), { waitingSince: at("2026-11-07T03:19:00Z") }, "waiting", { kind: "live", from: at("2026-11-07T03:19:00Z"), to: null }],
    // Not in Home's Needs you yet (R3 P3): no clock, not its time since dispatch.
    [life("running"), agent({ pendingCount: 1, status: "waiting" }), {}, "waiting", null],
    // Handed in (Lead 7224): a Turn running means it is on its next slice.
    [life("delivering"), agent({ status: "working" }), { pr: { number: 681, state: "open" } }, "working", { kind: "live", from: started, to: null }],
    [life("delivering"), agent(), { pr: { number: 688, state: "open" } }, "handed", { kind: "live", from: at("2026-11-07T03:10:00Z"), to: null }],
    [life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-07T03:31:00Z" }), {}, "failed", { kind: "since", from: at("2026-11-07T03:31:00Z"), to: null }],
    [life("archived"), agent({ closedAt: "2026-11-07T03:12:00Z" }), {}, "archived", { kind: "total", from: started, to: at("2026-11-07T03:10:00Z") }],
    [life("closed"), agent({ closedAt: "2026-11-07T03:12:00Z" }), {}, "archived", { kind: "total", from: started, to: at("2026-11-07T03:12:00Z") }],
    [life("running"), agent({ status: "offline", disconnectedAt: "2026-11-07T03:00:00Z" }), {}, "offline", { kind: "since", from: at("2026-11-07T03:00:00Z"), to: null }],
  ];
  for (const [lifecycle, a, more, state, clock] of rows) {
    const view = exec(lifecycle, a, more);
    assert.equal(view.state, state, `${lifecycle.state} / ${a.status}`);
    assert.deepEqual(view.clock, clock, `${state}'s clock`);
  }
  assert.deepEqual(exec(life("delivering"), agent({ status: "working" }), { pr: { number: 681, state: "open" } }).line, { kind: "handed", pr: 681 });
  assert.deepEqual(exec(life("queued", { position: 2 }), agent({ status: "offline" })).line, { kind: "detail", detail: { kind: "position", position: 2 } });
});

test("an executor's line one is what it is doing", () => {
  const said = { workSummary: { text: "Slice 2: evidence Job running" } };
  const text = { kind: "text", text: "Slice 2: evidence Job running" };
  const task = { kind: "task", title: "Design first" };
  const rows = [
    // [lifecycle, agent, more, line one]
    [life("running"), agent({ status: "working", ...said }), {}, text],
    // Its PR is not line one's.
    [life("running"), agent({ status: "working", ...said }), { pr: { number: 690, state: "draft" } }, text],
    // Nothing said yet: its task's title.
    [life("running"), agent({ status: "working" }), {}, task],
    // A blocker comes before what it said.
    [life("running", { blocked: "Waiting for #12" }), agent({ status: "working", ...said }), {}, { kind: "detail", detail: { kind: "blocked", text: "Waiting for #12" } }],
    // Handed in and on its next slice: what it says now.
    [life("delivering"), agent({ status: "working", ...said }), { pr: { number: 681, state: "open" } }, text],
    [life("delivering"), agent(), { pr: { number: 688, state: "open" } }, { kind: "handed", pr: 688 }],
    [life("running"), agent({ pendingCount: 1, status: "waiting", workSummary: { text: "Approve the design note" } }), {}, { kind: "text", text: "Approve the design note" }],
    [life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-07T03:31:00Z" }), {}, { kind: "detail", detail: { kind: "reason", text: "Both starts failed" } }],
    [life("archived"), agent({ closedAt: "2026-11-07T03:12:00Z" }), {}, task],
  ];
  for (const [lifecycle, a, more, line] of rows) assert.deepEqual(exec(lifecycle, a, more).line, line, `${lifecycle.state} / ${a.status}: line one`);
  assert.equal(exec(life("delivering"), agent(), { pr: { number: 688, state: "open" } }).pr, 688, "handed in names its PR");
});

test("the ring's fill: handed in's review rounds; working's arc until templates carry steps", () => {
  const reviews = (approved) => ({ pr: { number: 688, state: "open", ci: "success", reviews: { approved, changesRequested: false, running: false } } });
  assert.equal(exec(life("delivering"), agent(), reviews(0)).progress, 0);
  assert.equal(exec(life("delivering"), agent(), reviews(1)).progress, 0.5);
  assert.equal(exec(life("delivering"), agent(), reviews(2)).progress, 1);
  assert.equal(exec(life("delivering"), agent()).progress, null, "no PR, no rounds");
  assert.equal(exec(life("running"), agent({ status: "working" })).progress, null, "a fixed quarter: no steps yet");
  assert.equal(standing(agent()).progress, null);
});

test("only needs you and failed are row islands by themselves", () => {
  const auto = (view) => [view.state, view.auto];
  assert.deepEqual(auto(standing(agent({ pendingCount: 1, status: "waiting" }))), ["waiting", true]);
  assert.deepEqual(auto(standing(agent({ status: "error" }))), ["failed", true]);
  for (const view of [standing(agent()), standing(agent({ status: "working" })), standing(agent({ unreadCount: 2 })), exec(life("delivering"), agent()), exec(life("queued"), agent())])
    assert.equal(view.auto, false, view.state);
});

test("a click on the ring goes straight to its state's place; with nowhere of its own it is no button", () => {
  const go = (view) => [view.state, view.go];
  // Needs you: Home's Needs you, an executor's or a standing Agent's.
  assert.deepEqual(go(exec(life("running"), agent({ pendingCount: 1, status: "waiting" }))), ["waiting", "answer"]);
  assert.deepEqual(go(standing(agent({ pendingCount: 1, status: "waiting" }))), ["waiting", "answer"]);
  // An executor's: its task, for why its start failed, its result, its place in line, or itself.
  assert.deepEqual(go(exec(life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-07T03:31:00Z" }))), ["failed", "why"]);
  assert.deepEqual(go(exec(life("delivering"), agent())), ["handed", "result"]);
  assert.deepEqual(go(exec(life("queued", { position: 2 }), agent())), ["queued", "queue"]);
  assert.deepEqual(go(exec(life("running"), agent({ status: "working" }))), ["working", "task"]);
  assert.deepEqual(go(exec(life("archived"), agent({ closedAt: "2026-11-07T03:12:00Z" }))), ["archived", "task"]);
  // A Turn that failed, or updates unread: the conversation, where they are.
  assert.deepEqual(go(exec(life("running"), agent({ status: "error" }))), ["failed", "turn"]);
  assert.deepEqual(go(standing(agent({ status: "error" }))), ["failed", "turn"]);
  assert.deepEqual(go(standing(agent({ unreadCount: 3, lastTurnEnd: ended }))), ["done", "unread"]);
  // Nowhere of its own: idle, offline, a standing Agent at work, a done one with nothing unread.
  for (const view of [standing(agent()), standing(agent({ status: "working" })), standing(agent({ status: "offline", disconnectedAt: "2026-11-07T00:30:00Z" })),
    standing(agent({ lastTurnEnd: ended }), { unseen: "finished" }), exec(life("running"), agent({ status: "offline", disconnectedAt: "2026-11-07T03:00:00Z" }))])
    assert.equal(view.go, null, view.state);
  assert.equal(exec(life("running"), agent()).task, "YN-24");
  assert.equal(standing(agent()).task, null);
});

test("the unread count is the Agent's, never below zero", () => {
  assert.equal(standing(agent({ unreadCount: 12 })).unread, 12);
  assert.equal(standing(agent({ unreadCount: -1 })).unread, 0);
});

test("the island writes its clock short, and shorter on request", () => {
  const m = 60_000;
  assert.deepEqual([0, 30_000, 12 * m, 60 * m, 80 * m, 26 * 60 * m].map((ms) => islandTime(ms, "zh-Hans")), ["<1分", "<1分", "12分", "1时", "1时20分", "1天"]);
  assert.deepEqual([0, 12 * m, 80 * m, 49 * 60 * m].map((ms) => islandTime(ms, "en")), ["<1m", "12m", "1h20m", "2d"]);
  assert.equal(islandTime(72 * m, "zh-Hans", true), "1时");
  assert.equal(clockMs({ kind: "live", from: 1_000, to: null }, 61_000), 60_000);
  assert.equal(clockMs({ kind: "total", from: 1_000, to: 31_000 }, 999_999), 30_000, "an ended executor's total stands still");
});
