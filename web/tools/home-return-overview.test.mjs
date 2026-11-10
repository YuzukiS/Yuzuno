import test from "node:test";
import assert from "node:assert/strict";
import {
  currentOverviewSection,
  returnOverview,
  withoutOpened,
} from "../src/home/return-overview.ts";
import { changedSinceSeen, readVersion, unreadChange } from "../src/home/brief-layout.ts";

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

test("a report opened whole is read at that version, apart from Seen, and its next version is a change again (YN-86)", () => {
  const opened = (version) => ({ opened: { version, at: "2026-11-10T02:00:00Z" } });
  const data = home([
    section(1, opened(2)),
    section(2, opened(1)),
    section(3, { seen: { version: 2, at: "old" }, ...opened(1) }),
    section(4, { seen: { version: 1, at: "old" }, ...opened(2) }),
  ]);
  assert.deepEqual(returnOverview(data).changes.map((x) => x.section.id), [2], "only a version newer than the one read");
  const [read, newer, seenLater, openedLater] = data.projects[0].brief.sections;
  assert.deepEqual([read, newer, seenLater, openedLater].map(readVersion), [2, 1, 2, 2], "the later of Seen and opened");
  assert.deepEqual([read, newer].map(unreadChange), [false, true]);
  // Seen is still offered for what is not marked seen, opened or not.
  assert.deepEqual([read, newer, seenLater, openedLater].map(changedSinceSeen), [true, true, false, true]);
  assert.equal(readVersion(section(5)), undefined, "never read");
});

test("a held reading loses only the changes opened here, up to the version opened; the rest stays as held (YN-86)", () => {
  const held = returnOverview(home([section(1), section(2), section(3, { version: 4 })]));
  assert.equal(withoutOpened(held, []), held, "nothing opened: the same reading");
  const after = withoutOpened(held, [
    { projectId: "p1", sectionId: 1, version: 2 },
    { projectId: "p1", sectionId: 3, version: 3 },
    { projectId: "p2", sectionId: 2, version: 2 },
  ]);
  assert.deepEqual(after.changes.map((x) => x.section.id), [2, 3], "an older version opened, or another project's, leaves it");
  assert.equal(after.at, held.at, "still the reading it was");
  assert.deepEqual(after.replies, held.replies);
  assert.notEqual(after.signature, held.signature);
  // The next reading, Core having the receipt, is the same as the held one less it.
  const next = returnOverview(home([section(1, { opened: { version: 2, at: "now" } }), section(2), section(3, { version: 4 })]));
  assert.equal(withoutOpened(next, [{ projectId: "p1", sectionId: 1, version: 2 }]).signature,
    withoutOpened(held, [{ projectId: "p1", sectionId: 1, version: 2 }]).signature, "no new reading offered for it alone");
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

test("null and non-integer identities use separate legacy revisions, not one shared lineage", () => {
  for (const id of [null, 1.5, "9"]) {
    const old = section(id, {
      key: "same",
      version: 1,
      kind: "ask",
      ask: ask("replied", { replyText: "Prior answer" }),
    });
    const newer = {
      ...old,
      version: 2,
      ask: ask("replied", { replyText: "New answer" }),
    };
    const previous = returnOverview(home([old])).replies[0];
    assert.equal(currentOverviewSection(previous, home([newer])), null);
    const rows = returnOverview(
      home(
        [newer],
        [
          {
            ...old,
            history: true,
            historyReason: "resolved",
            ask: { ...old.ask, state: "resolved" },
          },
        ],
      ),
    ).replies;
    assert.equal(
      rows.length,
      2,
      "different old-Core revisions are not silently joined",
    );
    assert.notEqual(rows[0].identity, rows[1].identity);
  }
});

test("unrelated history keeps Core's order; only revisions of the same identity are replaced", () => {
  const resolved = (id, version) =>
    section(id, {
      kind: "ask",
      version,
      history: true,
      historyReason: "resolved",
      ask: ask("resolved", { replyText: `Answer ${id}` }),
    });
  const result = returnOverview(
    home([], [resolved(51, 1), resolved(50, 9), resolved(51, 2)]),
  );
  assert.deepEqual(
    result.replies.map((row) => [row.section.id, row.section.version]),
    [
      [51, 2],
      [50, 9],
    ],
  );
});

test("R1 project renames change both report-only and reply-only signatures without a card revision", () => {
  for (const item of [
    section(1),
    section(2, { kind: "ask", ask: ask("replied", { replyText: "Keep it" }) }),
  ]) {
    const original = home([item]);
    const renamed = structuredClone(original);
    renamed.projects[0].project.name = "Renamed project";
    assert.equal(renamed.projects[0].brief.sections[0].version, item.version);
    assert.notEqual(
      returnOverview(renamed).signature,
      returnOverview(original).signature,
    );
  }
});

test("R1 a report owner's name and state change its signature without unrelated replies", () => {
  const original = home([section(1)]);
  for (const change of [
    { name: "Iris" },
    { state: "closed" },
    { agentId: "b" },
  ]) {
    const renamed = structuredClone(original);
    renamed.projects[0].brief.sections[0].owner = { ...owner, ...change };
    assert.equal(renamed.projects[0].brief.sections[0].version, 2);
    assert.notEqual(
      returnOverview(renamed).signature,
      returnOverview(original).signature,
    );
  }
});

test("R1 displayed receipt title and question changes are observable, but a read timestamp alone is not", () => {
  const original = home([
    section(2, { kind: "ask", ask: ask("replied", { replyText: "Keep it" }) }),
  ]);
  for (const mutate of [
    (s) => {
      s.title = "Renamed receipt";
    },
    (s) => {
      s.ask.question = "Reworded card question";
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed.projects[0].brief.sections[0]);
    assert.notEqual(
      returnOverview(changed).signature,
      returnOverview(original).signature,
    );
  }
  const reread = structuredClone(original);
  reread.generatedAt = "2026-10-30T15:30:00Z";
  assert.equal(
    returnOverview(reread).signature,
    returnOverview(original).signature,
  );
});
