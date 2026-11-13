// A Project's new count and its needs count (YN-86 §2.4): the page and the
// project's panel count the same cards, and an approval Core lists both in
// Needs you and as a pending request is one matter.
import test from "node:test";
import assert from "node:assert/strict";
import { projectNeeds, projectUnseen } from "../src/home/unseen.ts";

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const owner = { agentId: "a", name: "Mina", state: "active" };
const panel = (sections, unseen, pending = []) => ({
  project: { id: "p", name: "P" },
  agents: { working: 0, idle: 0, waiting: 0, error: 0, offline: 0, total: 0 },
  errors: [],
  pending,
  jobs: [],
  brief: { version: 1, sections, history: [] },
  unseen,
  missing: [],
});
const ask = (extra = {}) => ({
  key: "ask",
  kind: "ask",
  title: "Ask",
  version: 3,
  owner,
  updatedAt: at(5),
  updatedTurnId: null,
  body: {},
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ask: { question: "Ship?", state: "open", reply: { freeText: true } },
  ...extra,
});

test("a project's new count is Core's, less the Asks the user answered and their owner did not change (YN-3)", () => {
  const replied = (extra = {}) =>
    ask({ key: "replied", updatedAt: at(10), ask: { question: "Ship?", state: "replied", repliedAt: at(5), replyText: "yes", reply: { freeText: true } }, ...extra });
  // Answered at this version, its owner has not touched it since: not new.
  assert.equal(projectUnseen(panel([replied()], 2)), 1);
  // Its owner changed it after the reply: new again.
  assert.equal(projectUnseen(panel([replied({ updatedAt: at(1) })], 2)), 2);
  // Already read at this version: not counted by Core, and none is added back.
  assert.equal(projectUnseen(panel([ask({ seen: { version: 3, at: at(2) } })], 0)), 0);
  // Never below zero, whatever Core's count and the sections say.
  assert.equal(projectUnseen(panel([replied(), replied({ key: "b" })], 1)), 0);
});

test("what needs the user in a project: open Asks, its approvals and its executors, each once", () => {
  const pending = [{ id: "r-1" }, { id: "r-2" }];
  const needsYou = [
    { kind: "approval", projectId: "p", agentId: "a", agentName: "Mina", requestId: "r-1", title: "Approve", since: at(9) },
    // An approval Core lists as a request too: counted with the request, not twice.
    { kind: "approval", projectId: "p", agentId: "a", agentName: "Mina", requestId: "r-2", title: "Approve", since: at(8) },
    { kind: "executor", projectId: "p", agentId: "x", agentName: "YN-9 executor", state: "delivering", title: "Ship", since: at(7) },
    { kind: "executor", projectId: "p", agentId: "y", agentName: "YN-10 executor", state: "failed", title: "Fix", since: at(6) },
    // A question is answered in its conversation, not listed on the Project's page.
    { kind: "question", projectId: "p", agentId: "a", agentName: "Mina", title: "Question", since: at(5) },
  ];
  assert.equal(projectNeeds(needsYou, pending, 3), 3 + 2 + 2);
  assert.equal(projectNeeds([], [], 0), 0);
  // An approval Core did not list as a request is still one matter.
  assert.equal(projectNeeds([needsYou[0]], [], 0), 1);
});
