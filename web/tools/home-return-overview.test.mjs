import test from "node:test";
import assert from "node:assert/strict";
import {
  currentOverviewSection,
  returnOverview,
} from "../src/home/return-overview.ts";

const owner = { agentId: "a", name: "Mina", state: "active" };
const section = (id, extra = {}) => ({
  id,
  key: `card-${id}`,
  kind: "report",
  title: `Card ${id}`,
  version: 2,
  owner,
  updatedAt: "2026-10-30T14:20:00Z",
  updatedTurnId: null,
  body: {},
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...extra,
});
const ask = (state, extra = {}) => ({
  question: "Which layout?",
  reply: { freeText: true },
  state,
  ...extra,
});
const home = (sections = [], history = [], id = "p1") => ({
  generatedAt: "2026-10-30T14:30:00Z",
  order: [id],
  needsYou: [],
  projects: [{ project: { id, name: id }, brief: { sections, history } }],
});

test("changes use individual Seen versions, never visits or ask counts", () => {
  const data = home([
    section(1),
    section(2, { seen: { version: 1, at: "old" } }),
    section(3, { seen: { version: 2, at: "old" } }),
    section(4, { kind: "ask", ask: ask("open") }),
  ]);
  const original = structuredClone(data);
  assert.deepEqual(
    returnOverview(data).changes.map((x) => x.section.id),
    [1, 2],
  );
  assert.deepEqual(
    data,
    original,
    "reading makes no Seen marks or other mutations",
  );
});

test("resolved without a reply is not a user's reply; submitted is not consumed", () => {
  const data = home(
    [
      section(1, {
        kind: "ask",
        ask: ask("replied", { replyText: "Keep the cards" }),
      }),
    ],
    [
      section(2, {
        kind: "ask",
        history: true,
        historyReason: "resolved",
        ask: ask("resolved"),
      }),
      section(3, {
        kind: "ask",
        history: true,
        historyReason: "resolved",
        ask: ask("resolved", { repliedAt: "2026-10-30T14:21:00Z" }),
      }),
    ],
  );
  assert.deepEqual(
    returnOverview(data).replies.map((x) => [x.section.id, x.state]),
    [
      [1, "waiting"],
      [3, "resolved"],
    ],
  );
});

test("a new question under the same key does not inherit a retired answer", () => {
  const old = section(10, {
    key: "same",
    kind: "ask",
    history: true,
    historyReason: "resolved",
    ask: ask("resolved", { replyText: "Old answer" }),
  });
  const data = home(
    [section(11, { key: "same", kind: "ask", ask: ask("open") })],
    [old],
  );
  const receipt = returnOverview(data).replies[0];
  assert.equal(receipt.section.id, 10);
  assert.equal(
    currentOverviewSection(receipt, data),
    null,
    "old receipt cannot link to rebuilt key",
  );
});

test("live lineage wins over historical resolution; removed rows are not receipts", () => {
  const old = section(10, {
    kind: "ask",
    history: true,
    historyReason: "resolved",
    ask: ask("resolved", { replyText: "First answer" }),
  });
  const open = {
    ...old,
    history: false,
    historyReason: undefined,
    version: 3,
    ask: ask("open"),
  };
  const removed = section(20, {
    kind: "ask",
    history: true,
    historyReason: "removed",
    ask: ask("replied", { replyText: "Removed" }),
  });
  assert.deepEqual(returnOverview(home([open], [old, removed])).replies, []);
});

test("old Core without ids does not join revisions or cross projects", () => {
  const old = section(undefined, {
    key: "same",
    version: 1,
    kind: "ask",
    ask: ask("replied", { replyText: "Prior" }),
  });
  const entry = returnOverview(home([old])).replies[0];
  assert.equal(
    currentOverviewSection(entry, home([{ ...old, version: 2 }])),
    null,
  );
  assert.equal(currentOverviewSection(entry, home([old], [], "other")), null);
  assert.equal(returnOverview(home([section(undefined)])).replies.length, 0);
});
