import test from "node:test";
import assert from "node:assert/strict";
import { clockMs, islandTime, islandView, waitOn, WAIT_ORDER } from "../src/agent-island.ts";
import { executorView } from "../src/executor-display.ts";

// T-43 rail v11 (the user's answers to design/ask-rail-readability): the ring
// at an Agent row's right says one of five states (working, needs you,
// done, failed, idle); every other state is a pill that stays while it
// holds; an executor's line one is its task's short name, else its title,
// and line two what it is doing; only a lead shows updates unread, as a dot;
// needs you and failed are row islands by themselves; a click on the ring
// goes straight to its state's place, and a ring with nowhere of its own is none.
const at = (iso) => Date.parse(iso);
const agent = (extra = {}) => ({ status: "idle", pendingCount: 0, unreadCount: 0, closedAt: null, disconnectedAt: null, lastTurnEnd: null, workSummary: null, ...extra });
const ended = { seq: 9, outcome: "finished", at: "2026-11-07T03:00:00Z" };
const standing = (a, more = {}) => islandView({ agent: a, statusLabel: "Ready", ...more });
const life = (state, extra = {}) => ({ state, agentId: "e", task: { id: "YN-24", title: "Export and import device preferences", shortName: "导出设备偏好" },
  dispatchedAt: "2026-11-07T02:00:00Z", since: "2026-11-07T03:10:00Z", ...extra });
const exec = (lifecycle, a = agent(), more = {}) =>
  islandView({ agent: a, lifecycle, executor: executorView({ agent: a, lifecycle, ...more }), statusLabel: "Ready", waitingSince: more.waitingSince ?? null });
const pr = (extra = {}) => ({ pr: { number: 688, state: "open", ci: "success", reviews: { approved: 0, changesRequested: false, running: false }, ...extra } });

test("a standing Agent's ring is one of five; offline is a pill; updates unread are no state", () => {
  const rows = [
    // [agent, more, ring, pill, clock kind or null, line]
    [agent({ lastTurnEnd: ended }), {}, "idle", null, "since", { kind: "none" }],
    [agent({ status: "working", workSummary: { text: "Merging #659" } }), {}, "working", null, null, { kind: "text", text: "Merging #659" }],
    [agent({ status: "working" }), { compacting: true, statusLabel: "Compacting" }, "working", null, null, { kind: "text", text: "Compacting" }],
    [agent(), { waiting: "Waiting · Job" }, "working", null, null, { kind: "text", text: "Waiting · Job" }],
    [agent({ pendingCount: 1, status: "waiting", workSummary: { text: "Allow git push?" } }), { waitingSince: at("2026-11-07T03:20:00Z") }, "waiting", null, "live", { kind: "text", text: "Allow git push?" }],
    [agent({ status: "error", lastTurnEnd: { ...ended, outcome: "failed" } }), { statusLabel: "Needs a look" }, "failed", null, "since", { kind: "text", text: "Needs a look" }],
    // Updates unread don't make it done; a Turn it ended that this device hasn't shown does.
    [agent({ unreadCount: 3, lastTurnEnd: ended }), {}, "idle", null, "since", { kind: "none" }],
    [agent({ lastTurnEnd: ended }), { unseen: "finished" }, "done", null, "since", { kind: "none" }],
    [agent({ status: "offline", disconnectedAt: "2026-11-07T00:30:00Z" }), { statusLabel: "Offline" }, "idle", "offline", "since", { kind: "none" }],
    [agent({ closedAt: "2026-11-07T01:00:00Z" }), { statusLabel: "Closed" }, "idle", null, "since", { kind: "text", text: "Closed" }],
  ];
  for (const [a, more, ring, pill, clock, line] of rows) {
    const view = standing(a, more);
    assert.equal(view.state, ring, JSON.stringify(a));
    assert.equal(view.stay?.kind ?? null, pill, `${ring}'s pill`);
    assert.equal(view.clock?.kind ?? null, clock, `${ring}'s clock`);
    assert.deepEqual(view.line, line, `${ring}'s line`);
    assert.equal(view.title, null, "a standing Agent's line one is its name");
  }
});

test("an executor's ring is one of five, and every other state is a pill that stays", () => {
  const started = at("2026-11-07T02:00:00Z");
  const rows = [
    // [lifecycle, agent, more, ring, pill, clock]
    [life("queued", { position: 2 }), agent({ status: "offline" }), {}, "idle", { kind: "queued", position: 2 }, { kind: "live", from: started, to: null }],
    [life("starting"), agent({ status: "offline" }), {}, "idle", { kind: "starting" }, { kind: "live", from: started, to: null }],
    [life("running"), agent({ status: "working" }), {}, "working", null, { kind: "live", from: started, to: null }],
    [life("running"), agent({ pendingCount: 1, status: "waiting" }), { waitingSince: at("2026-11-07T03:19:00Z") }, "waiting", null, { kind: "live", from: at("2026-11-07T03:19:00Z"), to: null }],
    // Not in Home's Needs you yet (R3 P3): no clock, not its time since dispatch.
    [life("running"), agent({ pendingCount: 1, status: "waiting" }), {}, "waiting", null, null],
    // Handed in: the lead's turn, its pill as its PR stands; a Turn running is its next slice.
    [life("delivering"), agent(), {}, "idle", { kind: "lead" }, { kind: "live", from: at("2026-11-07T03:10:00Z"), to: null }],
    [life("delivering"), agent({ status: "working" }), pr(), "working", { kind: "lead" }, { kind: "live", from: started, to: null }],
    [life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-07T03:31:00Z" }), {}, "failed", null, { kind: "since", from: at("2026-11-07T03:31:00Z"), to: null }],
    // Archived: ✓, its whole time; the Archived fold says the rest.
    [life("archived"), agent({ closedAt: "2026-11-07T03:12:00Z" }), {}, "done", null, { kind: "total", from: started, to: at("2026-11-07T03:10:00Z") }],
    [life("closed"), agent({ closedAt: "2026-11-07T03:12:00Z" }), {}, "idle", null, { kind: "total", from: started, to: at("2026-11-07T03:12:00Z") }],
    [life("running"), agent({ status: "offline", disconnectedAt: "2026-11-07T03:00:00Z" }), {}, "idle", { kind: "offline" }, { kind: "since", from: at("2026-11-07T03:00:00Z"), to: null }],
  ];
  for (const [lifecycle, a, more, ring, pill, clock] of rows) {
    const view = exec(lifecycle, a, more);
    assert.equal(view.state, ring, `${lifecycle.state} / ${a.status}`);
    assert.deepEqual(view.stay, pill, `${lifecycle.state} / ${a.status}: pill`);
    assert.deepEqual(view.clock, clock, `${ring}'s clock`);
  }
  for (const view of [exec(life("running"), agent({ status: "working" })), exec(life("queued")), exec(life("delivering"))])
    assert.ok(["idle", "working", "waiting", "done", "failed"].includes(view.state), view.state);
});

test("a handed-in executor's pill says where its PR is, without numbers", () => {
  const pill = (extra) => exec(life("delivering"), agent(), pr(extra)).stay;
  assert.deepEqual(pill(), { kind: "lead" }, "no round under way: the lead's turn");
  assert.deepEqual(pill({ reviews: { approved: 0, changesRequested: false, running: true } }), { kind: "review" });
  assert.deepEqual(pill({ reviews: { approved: 1, changesRequested: true, running: false } }), { kind: "changes" });
  assert.deepEqual(pill({ ci: "failure" }), { kind: "ciFailed" });
  assert.deepEqual(pill({ reviews: { approved: 2, changesRequested: false, running: false } }), { kind: "ready" });
  assert.deepEqual(pill({ state: "merged" }), { kind: "merged" });
  assert.deepEqual(exec(life("delivering"), agent()).stay, { kind: "lead" }, "no PR: the lead's turn");
});

test("an executor's line one is its task's short name, else its title; line two is what it is doing", () => {
  assert.equal(exec(life("running"), agent({ status: "working" })).title, "导出设备偏好");
  assert.equal(exec(life("running", { task: { id: "YN-24", title: "Export and import device preferences", shortName: null } }), agent({ status: "working" })).title,
    "Export and import device preferences", "no short name: the title");
  assert.equal(exec(life("running", { task: { id: "YN-24", title: "Export", shortName: "  " } }), agent()).title, "Export", "a blank one is none");
  const said = { workSummary: { text: "Slice 2: evidence Job running" } };
  const text = { kind: "text", text: "Slice 2: evidence Job running" };
  const rows = [
    // [lifecycle, agent, more, line two]
    [life("running"), agent({ status: "working", ...said }), {}, text],
    // Its PR is not line two's.
    [life("running"), agent({ status: "working", ...said }), { pr: { number: 690, state: "draft" } }, text],
    [life("running"), agent({ status: "working" }), {}, { kind: "none" }],
    // A blocker comes before what it said.
    [life("running", { blocked: "Waiting for #12" }), agent({ status: "working", ...said }), {}, { kind: "detail", detail: { kind: "blocked", text: "Waiting for #12" } }],
    [life("delivering"), agent({ status: "working", ...said }), pr(), text],
    [life("running"), agent({ pendingCount: 1, status: "waiting", workSummary: { text: "Approve the design note" } }), {}, { kind: "text", text: "Approve the design note" }],
    [life("failed", { reason: "Both starts failed" }), agent({ closedAt: "2026-11-07T03:31:00Z" }), {}, { kind: "detail", detail: { kind: "reason", text: "Both starts failed" } }],
    [life("queued", { position: 2 }), agent(), {}, { kind: "none" }],
  ];
  for (const [lifecycle, a, more, line] of rows) assert.deepEqual(exec(lifecycle, a, more).line, line, `${lifecycle.state} / ${a.status}: line two`);
});

test("only a lead shows updates unread, as a dot without a count", () => {
  assert.equal(standing(agent({ unreadCount: 3, kind: "lead" })).dot, true);
  assert.equal(standing(agent({ unreadCount: 0, kind: "lead" })).dot, false);
  assert.equal(standing(agent({ unreadCount: 3 })).dot, false, "a standing Agent: nothing");
  assert.equal(exec(life("running"), agent({ unreadCount: 3, kind: "executor" })).dot, false, "an executor: nothing");
  assert.equal("unread" in standing(agent({ unreadCount: 3, kind: "lead" })), false, "no count kept");
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
  assert.deepEqual(go(exec(life("delivering"), agent())), ["idle", "result"]);
  assert.deepEqual(go(exec(life("queued", { position: 2 }), agent())), ["idle", "queue"]);
  assert.deepEqual(go(exec(life("running"), agent({ status: "working" }))), ["working", "task"]);
  assert.deepEqual(go(exec(life("archived"), agent({ closedAt: "2026-11-07T03:12:00Z" }))), ["done", "task"]);
  // A Turn that failed, or one that ended unseen: the conversation, where it is.
  assert.deepEqual(go(exec(life("running"), agent({ status: "error" }))), ["failed", "turn"]);
  assert.deepEqual(go(standing(agent({ status: "error" }))), ["failed", "turn"]);
  assert.deepEqual(go(standing(agent({ lastTurnEnd: ended }), { unseen: "finished" })), ["done", "reply"]);
  // Nowhere of its own: idle, offline, a standing Agent at work or with updates unread.
  for (const view of [standing(agent()), standing(agent({ status: "working" })), standing(agent({ status: "offline", disconnectedAt: "2026-11-07T00:30:00Z" })),
    standing(agent({ unreadCount: 3, lastTurnEnd: ended }))])
    assert.equal(view.go, null, view.state);
  assert.equal(exec(life("running"), agent()).task, "YN-24");
  assert.equal(standing(agent()).task, null);
});

test("the island writes its clock short, and shorter on request", () => {
  const m = 60_000;
  assert.deepEqual([0, 30_000, 12 * m, 60 * m, 80 * m, 26 * 60 * m].map((ms) => islandTime(ms, "zh-Hans")), ["<1分", "<1分", "12分", "1时", "1时20分", "1天"]);
  assert.deepEqual([0, 12 * m, 80 * m, 49 * 60 * m].map((ms) => islandTime(ms, "en")), ["<1m", "12m", "1h20m", "2d"]);
  assert.equal(islandTime(72 * m, "zh-Hans", true), "1时");
  assert.equal(clockMs({ kind: "live", from: 1_000, to: null }, 61_000), 60_000);
  assert.equal(clockMs({ kind: "total", from: 1_000, to: 31_000 }, 999_999), 30_000, "an ended executor's total stands still");
});

test("an executor queued for a routing candidate has a pill of its own, from when one's reason ends (YN-57)", () => {
  const waiting = exec(life("queued", { position: 1, route: { kind: "waiting", earliest: "2026-11-09T04:00:00Z" } }), agent());
  assert.equal(waiting.state, "idle");
  assert.deepEqual(waiting.stay, { kind: "candidate", earliest: at("2026-11-09T04:00:00Z") }, "not its place in the slot queue");
  assert.deepEqual(exec(life("queued", { route: { kind: "waiting" } }), agent()).stay, { kind: "candidate", earliest: null });
  // A slot's wait, routed or not, is its place in line.
  assert.deepEqual(exec(life("queued", { position: 2, route: { kind: "chosen", candidate: "c", harness: "codex", model: "m", credential: { kind: "login" } } }), agent()).stay,
    { kind: "queued", position: 2 });
  assert.deepEqual(exec(life("queued", { position: 2 }), agent()).stay, { kind: "queued", position: 2 });
});

// YN-51 (the user's answers on Home, design/yn51-ring-wait): a turning ring
// shows what it waits on, one of review > CI > Job > sub-agent > shell.
const idle = (more = {}) => ({ turn: false, call: null, ...more });
const kinds = (w) => (w ? [w.kind, ...w.also.map((a) => a.kind)] : []);

test("a running Turn waits only on the call it is stopped on, a sub-agent or a shell", () => {
  const shell = { kind: "shell", itemId: "c1", label: "cargo test" };
  assert.deepEqual(waitOn({ turn: true, call: shell }), { kind: "shell", count: 1, label: "cargo test", also: [] });
  assert.equal(waitOn({ turn: true, call: { kind: "subAgent", itemId: "a1", label: "Survey" } }).kind, "subAgent");
  // Thinking or writing: no call, no wait, whatever runs in the background.
  assert.equal(waitOn({ turn: true, call: null, jobs: { active: 1, unknown: 0 }, ci: { running: 1, discovering: 0, check: 0 },
    waits: { reviews: { running: 1, pr: 9, round: 2 }, shells: 1, subAgents: 1 } }), null);
});

test("with no Turn running, what it started and left running waits, in the user's order", () => {
  assert.deepEqual(WAIT_ORDER, ["review", "ci", "job", "subAgent", "shell"]);
  const all = idle({ jobs: { active: 2, unknown: 0, name: "web-tests" }, ci: { running: 1, discovering: 1, check: 0, waitingForRun: 1 },
    waits: { reviews: { running: 1, pr: 231, round: 2 }, shells: 1, subAgents: 2 }, pr: 231 });
  const w = waitOn(all);
  assert.deepEqual(kinds(w), ["review", "ci", "job", "subAgent", "shell"]);
  assert.deepEqual({ ...w, also: undefined }, { kind: "review", count: 1, pr: 231, round: 2, also: undefined });
  assert.deepEqual(w.also, [{ kind: "ci", count: 3 }, { kind: "job", count: 2 }, { kind: "subAgent", count: 2 }, { kind: "shell", count: 1 }]);
  // Without the review, CI is next: an executor's PR names it.
  assert.deepEqual(waitOn({ ...all, waits: { shells: 1, subAgents: 2 } }).kind, "ci");
  assert.equal(waitOn({ ...all, waits: { shells: 1, subAgents: 2 } }).pr, 231);
  assert.deepEqual(kinds(waitOn(idle({ waits: { shells: 1, subAgents: 1 } }))), ["subAgent", "shell"]);
  assert.equal(waitOn(idle({ waits: { shells: 2 } })).background, true);
});

test("a Job is named when it is the one, and an outcome to check is no wait", () => {
  assert.deepEqual(waitOn(idle({ jobs: { active: 1, unknown: 0, name: "core-lib-tests" } })), { kind: "job", count: 1, name: "core-lib-tests", also: [] });
  assert.equal(waitOn(idle({ jobs: { active: 2, unknown: 0, name: "core-lib-tests" } })).name, null, "two Jobs: how many, not one's name");
  assert.equal(waitOn(idle({ jobs: { active: 1, unknown: 1 } })), null, "a Job whose outcome is unknown is to check");
  assert.equal(waitOn(idle({ ci: { running: 0, discovering: 0, check: 2 } })), null, "CI to check is no wait either");
  assert.equal(waitOn(idle()), null);
});

test("only a turning ring holds a wait; an idle standing Agent with something running turns", () => {
  const wait = waitOn(idle({ waits: { reviews: { running: 1, pr: 9, round: 1 } } }));
  // A lead waiting on a review it started: its ring turns, and says so.
  const lead = standing(agent({ lastTurnEnd: ended }), { wait });
  assert.equal(lead.state, "working");
  assert.equal(lead.wait.kind, "review");
  // Needs you, failed, done and idle rings hold none.
  assert.equal(standing(agent({ pendingCount: 1, status: "waiting" }), { wait }).wait, null);
  assert.equal(standing(agent({ status: "error" }), { wait }).wait, null);
  assert.equal(standing(agent({ lastTurnEnd: ended }), { unseen: "finished", wait }).wait, null);
  assert.equal(standing(agent()).wait, null);
  // A handed-in executor at rest: its pill says it ("In review"), not an icon.
  const handed = exec(life("delivering"), agent(), { ...pr({ reviews: { approved: 0, changesRequested: false, running: true } }) });
  assert.equal(handed.state, "idle");
  assert.equal(islandView({ agent: agent(), lifecycle: life("delivering"), executor: executorView({ agent: agent(), lifecycle: life("delivering"), ...pr() }),
    statusLabel: "Ready", wait }).wait, null);
  // A working executor whose Turn ended: its ring keeps turning, with the wait.
  const working = islandView({ agent: agent(), lifecycle: life("running"), executor: executorView({ agent: agent(), lifecycle: life("running") }), statusLabel: "Ready", wait });
  assert.equal(working.state, "working");
  assert.equal(working.wait.kind, "review");
});

