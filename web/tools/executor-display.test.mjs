import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_ROUNDS, elapsedText, executorView, prStatus } from "../src/executor-display.ts";

// T-43 S2 (g2): an executor's row says one state, the first of
// executorView's rules that holds, from its lifecycle (Core's
// executor_lifecycle.rs) and its runtime status together.
const agent = (extra = {}) => ({ status: "idle", pendingCount: 0, closedAt: null, disconnectedAt: null, ...extra });
const life = (state, extra = {}) => ({ state, agentId: "e", dispatchedAt: "2026-11-06T10:00:00Z", since: "2026-11-06T11:00:00Z", ...extra });
const shown = (lifecycle, a = agent(), more = {}) => {
  const view = executorView({ agent: a, lifecycle, ...more });
  return [view.shown, view.detail];
};

test("each lifecycle and runtime pair says exactly one state, the first rule that holds", () => {
  const rows = [
    // [lifecycle, runtime facts, more, expected state, expected detail]
    [life("archived"), agent({ closedAt: "2026-11-06T12:00:00Z" }), {}, "done", { kind: "released" }],
    [life("archiving", { reason: "Waiting to close: a Job is still running." }), agent(), {}, "done", { kind: "archiving", text: "Waiting to close: a Job is still running." }],
    [life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-06T12:00:00Z" }), {}, "failed", { kind: "reason", text: "Both starts failed" }],
    [life("closed"), agent({ closedAt: "2026-11-06T12:00:00Z" }), {}, "stopped", { kind: "closed" }],
    [life("queued", { position: 2 }), agent({ status: "offline" }), {}, "queued", { kind: "position", position: 2 }],
    [life("starting"), agent({ status: "offline" }), {}, "queued", { kind: "starting" }],
    // A request waiting comes before everything a running executor says.
    [life("running"), agent({ pendingCount: 1, status: "waiting" }), {}, "needsYou", null],
    [life("delivering"), agent({ pendingCount: 1 }), {}, "needsYou", null],
    [life("running"), agent({ status: "waiting" }), {}, "needsYou", null],
    [life("running"), agent({ status: "error" }), {}, "failed", { kind: "turnFailed" }],
    [life("running"), agent(), { unseen: "failed" }, "failed", { kind: "turnFailed" }],
    [life("running"), agent({ status: "offline" }), {}, "stopped", { kind: "offline" }],
    [life("running"), agent({ disconnectedAt: "2026-11-06T12:00:00Z" }), {}, "stopped", { kind: "offline" }],
    [life("delivering"), agent(), {}, "review", { kind: "awaitingRelease" }],
    [life("delivering"), agent(), { pr: { number: 7, state: "open", ci: "success", reviews: { approved: 1, changesRequested: false, running: false } } },
      "review", { kind: "pr", status: { kind: "rounds", approved: 1, of: REVIEW_ROUNDS, running: false } }],
    [life("running", { blocked: "Waiting for a licence" }), agent({ status: "working" }), {}, "working", { kind: "blocked", text: "Waiting for a licence" }],
    [life("running"), agent({ status: "uncertain" }), {}, "working", { kind: "check" }],
    [life("running"), agent({ status: "working" }), { pr: { number: 8, state: "draft" } }, "working", { kind: "pr", status: { kind: "draft" } }],
    [life("running"), agent(), { waiting: "Waiting · Job" }, "working", { kind: "waiting", label: "Waiting · Job" }],
    [life("running"), agent({ status: "working" }), {}, "working", null],
  ];
  for (const [lifecycle, a, more, state, detail] of rows) {
    assert.deepEqual(shown(lifecycle, a, more), [state, detail], `${lifecycle.state} with ${JSON.stringify(a)} ${JSON.stringify(more)}`);
  }
});

test("its time on the task runs from its dispatch and stops at its end; a wait for you is its oldest", () => {
  const running = executorView({ agent: agent(), lifecycle: life("running") });
  assert.deepEqual([running.started, running.ended], [Date.parse("2026-11-06T10:00:00Z"), null], "still on its task: no end");
  const archived = executorView({ agent: agent({ closedAt: "2026-11-06T12:00:00Z" }), lifecycle: life("archived") });
  assert.equal(archived.ended, Date.parse("2026-11-06T11:00:00Z"), "archived: frozen when it was archived");
  const closed = executorView({ agent: agent({ closedAt: "2026-11-06T12:00:00Z" }), lifecycle: life("closed") });
  assert.equal(closed.ended, Date.parse("2026-11-06T12:00:00Z"), "closed: frozen at its close");
  const waiting = executorView({ agent: agent({ pendingCount: 2 }), lifecycle: life("running"), waitingSince: 123 });
  assert.equal(waiting.waitingSince, 123);
  assert.equal(executorView({ agent: agent(), lifecycle: life("running"), waitingSince: 123 }).waitingSince, null, "only while it waits for you");
  assert.equal(executorView({ agent: agent(), lifecycle: { state: "running", agentId: "e" } }).started, null, "an older Core says no dispatch time");
});

test("a PR's status: merged or closed, changes, failed checks, its rounds, a draft", () => {
  const pr = (extra) => prStatus({ number: 1, state: "open", ci: "pending", reviews: { approved: 0, changesRequested: false, running: false }, ...extra });
  const reviews = (approved, changesRequested = false, running = false) => ({ approved, changesRequested, running });
  assert.deepEqual(pr({ state: "merged", ci: "failure" }), { status: { kind: "merged" }, tone: "ok" });
  assert.deepEqual(pr({ state: "closed" }), { status: { kind: "closed" }, tone: "bad" });
  assert.deepEqual(pr({ reviews: reviews(0, true) }), { status: { kind: "changes" }, tone: "bad" });
  assert.deepEqual(pr({ reviews: reviews(0, true, true) }).status, { kind: "rounds", approved: 0, of: 2, running: true },
    "a new round under way after a request for changes");
  assert.deepEqual(pr({ ci: "failure", reviews: reviews(2) }), { status: { kind: "ciFailed" }, tone: "bad" });
  assert.deepEqual(pr({ ci: "cancelled" }).status, { kind: "ciFailed" });
  assert.deepEqual(pr({ ci: "success", reviews: reviews(2) }), { status: { kind: "approved", ciPending: false }, tone: "ok" });
  assert.deepEqual(pr({ ci: "unknown", reviews: reviews(3) }), { status: { kind: "approved", ciPending: true }, tone: "wait" },
    "unknown checks are never green");
  assert.deepEqual(pr({ reviews: reviews(2, false, true) }).status, { kind: "rounds", approved: 2, of: 2, running: true },
    "a third round under way: not yet approved");
  assert.deepEqual(pr({ state: "draft" }), { status: { kind: "draft" }, tone: "wait" });
  assert.deepEqual(pr({ state: "draft", reviews: reviews(1) }).status, { kind: "rounds", approved: 1, of: 2, running: false });
  assert.deepEqual(pr({ reviews: null }).status, { kind: "rounds", approved: 0, of: 2, running: false }, "an older Core sends no rounds");
});

test("elapsed time reads as minutes, hours and minutes, or days and hours", () => {
  const minute = 60_000;
  assert.equal(elapsedText(20_000, "en"), "<1 min");
  assert.equal(elapsedText(38 * minute, "en"), "38 min");
  assert.equal(elapsedText(65 * minute, "en"), "1 h 05 min");
  assert.equal(elapsedText((52 * 60 + 3) * minute, "en"), "2 d 4 h");
  assert.equal(elapsedText(38 * minute, "zh-Hans"), "38 分钟");
  assert.equal(elapsedText(65 * minute, "zh-Hans"), "1 小时 05 分");
  assert.equal(elapsedText((52 * 60 + 3) * minute, "zh-Hans"), "2 天 4 小时");
  assert.equal(elapsedText(-5 * minute, "en"), "<1 min", "a clock behind the record shows no negative time");
});
