import test from "node:test";
import assert from "node:assert/strict";
import {
  QuestionIndex,
  questionKey,
  questionReceipts,
  answerDraftKey,
  questionDismissalKey,
} from "../src/pending-questions.ts";

const source = { turnId: "old-turn", itemId: "question" };
const input = (id = "one", question = source) => ({
  clientMessageId: id,
  text: "Answer",
  expectedTurnId: null,
  question,
});
const receipt = (status, id = "one") => ({
  input: input(id),
  status,
  turnId: null,
  error: null,
});

test("native accepted evidence resolves a lost local response; rejected attempts do not hide a newer pending answer", () => {
  const accepted = receipt("accepted");
  assert.equal(
    questionReceipts(
      "a",
      [accepted],
      [{ agentId: "a", receipt: receipt("uncertain") }],
      { "a:old-turn:question": input() },
    ).get(questionKey(source)).status,
    "accepted",
  );
  const resolved = questionReceipts(
    "a",
    [receipt("rejected")],
    [{ agentId: "a", receipt: receipt("uncertain") }],
    { "a:old-turn:question": input() },
  );
  assert.equal(resolved.get(questionKey(source)).status, "rejected");
  const newer = questionReceipts(
    "a",
    [receipt("rejected")],
    [{ agentId: "a", receipt: receipt("sending", "two") }],
    {},
  );
  assert.equal(newer.get(questionKey(source)).status, "sending");
});

test("outbox restores uncertainty without inventing acceptance or mixing Agents", () => {
  const pending = questionReceipts("a", [], [], {
    "a:old-turn:question": input(),
    "b:old-turn:question": input("other"),
  });
  assert.equal(pending.size, 1);
  assert.equal(pending.get(questionKey(source)).status, "uncertain");
  assert.equal(pending.get(questionKey(source)).input.clientMessageId, "one");
  assert.equal(
    questionReceipts(
      "c",
      [],
      [{ agentId: "a", receipt: receipt("accepted") }],
      {},
    ).size,
    0,
  );
});

test("question and draft identities distinguish repeated IDs and delimiter-bearing names", () => {
  assert.notEqual(
    questionKey({ turnId: "a:b", itemId: "c" }),
    questionKey({ turnId: "a", itemId: "b:c" }),
  );
  assert.notEqual(
    answerDraftKey("workspace", "a", source),
    answerDraftKey("workspace", "b", source),
  );
  assert.notEqual(
    answerDraftKey("workspace", "a", source),
    answerDraftKey("other", "a", source),
  );
});

test("streamed output reuses untouched history and never reads message bodies", () => {
  let historyReads = 0;
  const question = {
    type: "agentMessage",
    id: source.itemId,
    delivery: "async",
    questions: [{ title: "Which?" }],
  };
  const old = {
    id: source.turnId,
    status: "completed",
    get items() {
      historyReads++;
      return [question];
    },
  };
  const live = {
    id: "live",
    status: "inProgress",
    items: [
      {
        id: "text",
        type: "agentMessage",
        get text() {
          throw new Error("Do not inspect a large body");
        },
      },
    ],
  };
  const index = new QuestionIndex();
  const first = index.read([old, live]);
  for (let i = 0; i < 100; i++)
    assert.equal(index.read([old, { ...live, items: [...live.items] }]), first);
  assert.equal(historyReads, 1);
  assert.equal(first.length, 1);
  const newer = index.read([
    old,
    { ...live, items: [...live.items, { ...question, id: "new" }] },
  ]);
  assert.equal(newer.length, 2);
});


test("import evidence changes projection without treating completed Turns as answered", () => {
  const item = { id: "q", type: "agentMessage", delivery: "async", questions: [{ title: "Still relevant?" }] };
  const turn = { id: "old", status: "completed", items: [item] };
  const index = new QuestionIndex();
  assert.equal(index.read([turn])[0].historical, false);
  assert.equal(index.read([{ ...turn, _yuzunoImportedQuestions: true }])[0].historical, true);
  assert.notEqual(questionDismissalKey("workspace", "a"), questionDismissalKey("other", "a"));
  assert.notEqual(questionDismissalKey("workspace", "a"), questionDismissalKey("workspace", "b"));
});

test("terminal unknown evidence overrides a stale sending preview without accepting the answer", () => {
  assert.equal(questionReceipts("a", [receipt("unknown")], [{ agentId: "a", receipt: receipt("sending") }], {}).get(questionKey(source)).status, "unknown");
});
