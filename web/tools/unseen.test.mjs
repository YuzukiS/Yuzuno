// A Project's new count (YN-86 §2.4): the page and the project's panel count
// the same cards.
import test from "node:test";
import assert from "node:assert/strict";
import { projectUnseen } from "../src/home/unseen.ts";

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
