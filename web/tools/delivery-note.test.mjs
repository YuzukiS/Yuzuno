import test from "node:test";
import assert from "node:assert/strict";
import { compacting, deliveryNote, steered } from "../src/delivery-note.ts";

const receipt = (fields = {}, input = {}) => ({
  input: { clientMessageId: "c", text: "More", expectedTurnId: "live", question: null, ...input },
  status: "accepted",
  turnId: "live",
  error: null,
  ...fields,
});
const detail = (status, { harness, where = "turns" } = {}) => {
  const turn = { id: "live", status, items: [] };
  return {
    agent: { id: "a", harness },
    turns: where === "turns" ? [turn] : [],
    conversation: { index: where === "index" ? [{ ...turn, number: 1, itemCount: 0 }] : [], nativeClientIds: [] },
    pending: [],
    artifacts: [],
  };
};

test("a Codex steer waits while its Turn runs and is reported unconfirmed once that Turn has ended (T-120)", () => {
  assert.equal(steered(receipt(), detail("inProgress")), "waiting");
  for (const status of ["completed", "interrupted", "failed"]) assert.equal(steered(receipt(), detail(status)), "endedUnconfirmed", status);
  assert.equal(deliveryNote("accepted", "Codex", "waiting"), "Received by Codex · added when its Turn continues");
  assert.equal(deliveryNote("accepted", "Codex", "endedUnconfirmed"),
    "Received by Codex · Turn ended; message not yet confirmed in conversation");
});

test("a steered Turn outside the shown window is found in the conversation index", () => {
  assert.equal(steered(receipt(), detail("inProgress", { where: "index" })), "waiting");
  assert.equal(steered(receipt(), detail("interrupted", { where: "index" })), "endedUnconfirmed");
});

test("only an accepted Codex steer to a known Turn is a steer", () => {
  // A new Turn (no running Turn named), another harness, another state, a
  // Turn this detail does not know, or no detail: the note is unchanged.
  assert.equal(steered(receipt({}, { expectedTurnId: null }), detail("inProgress")), null);
  assert.equal(steered(receipt(), detail("inProgress", { harness: "claude" })), null);
  assert.equal(steered(receipt(), detail("inProgress", { harness: "opencode" })), null);
  assert.equal(steered(receipt({ status: "uncertain" }), detail("completed")), null);
  assert.equal(steered(receipt({ status: "unknown" }), detail("completed")), null);
  assert.equal(steered(receipt({ turnId: "other" }), detail("completed")), null);
  assert.equal(steered(receipt(), null), null);
  // Core's receipt names the Turn it joined; the request's Turn is the fallback.
  assert.equal(steered(receipt({ turnId: null }), detail("inProgress")), "waiting");
  assert.equal(steered(receipt(), detail("inProgress", { harness: "codex" })), "waiting");
});

// A new message's receipt (turn/start): it names the Turn Codex started.
const started = (fields = {}) => receipt({ turnId: "new", ...fields }, { expectedTurnId: null });
const turns = (...list) => ({ ...detail("inProgress"), turns: list.map(([id, status, compactionId]) =>
  ({ id, status, items: [], ...(compactionId === undefined ? {} : { _yuzunoCompactionId: compactionId }) })) });

test("a new Codex message whose own Turn is compacting says so, and nothing more (T-120)", () => {
  // Codex 0.162.1 adds the message only after a compaction that begins its Turn.
  assert.equal(compacting(started(), turns(["new", "inProgress", "compaction-1"])), true);
  assert.equal(deliveryNote("accepted", "Codex", null, true), "Received by Codex · compacting conversation");
  assert.equal(compacting(started(), { ...turns(["new", "inProgress", "compaction-1"]), agent: { id: "a", harness: "codex" } }), true);
  // Once the compaction ends or fails its mark is gone; an ended Turn is not compacting.
  assert.equal(compacting(started(), turns(["new", "inProgress"])), false);
  assert.equal(compacting(started(), turns(["new", "inProgress", null])), false);
  for (const status of ["completed", "interrupted", "failed"])
    assert.equal(compacting(started(), turns(["new", status, "compaction-1"])), false, status);
});

test("only the receipt's own loaded Turn decides; anything unproven keeps the note", () => {
  // Another Turn compacting, or the receipt's Turn not loaded (only in the index).
  assert.equal(compacting(started(), turns(["old", "inProgress", "compaction-1"], ["new", "inProgress"])), false);
  assert.equal(compacting(started(), turns(["old", "inProgress", "compaction-1"])), false);
  const indexed = { ...turns(), conversation: { index: [{ id: "new", status: "inProgress", _yuzunoCompactionId: "c", number: 1, itemCount: 1 }], nativeClientIds: [] } };
  assert.equal(compacting(started(), indexed), false);
  // No Turn named, a steer, not accepted, another harness, no detail.
  assert.equal(compacting(started({ turnId: null }), turns(["new", "inProgress", "compaction-1"])), false);
  assert.equal(compacting(receipt({ turnId: "new" }, { expectedTurnId: "new" }), turns(["new", "inProgress", "compaction-1"])), false);
  for (const status of ["sending", "queued", "uncertain", "unknown", "rejected"])
    assert.equal(compacting(started({ status }), turns(["new", "inProgress", "compaction-1"])), false, status);
  for (const harness of ["claude", "opencode"])
    assert.equal(compacting(started(), { ...turns(["new", "inProgress", "compaction-1"]), agent: { id: "a", harness } }), false, harness);
  assert.equal(compacting(started(), null), false);
  // A steer's note keeps its place, and the flag never changes another state's note.
  assert.equal(deliveryNote("accepted", "Codex", "waiting", true), "Received by Codex · added when its Turn continues");
  assert.equal(deliveryNote("accepted", "Codex", "endedUnconfirmed", true),
    "Received by Codex · Turn ended; message not yet confirmed in conversation");
  for (const [status, note] of [["sending", "Sending…"], ["queued", "Sent · waiting for Codex to confirm"], ["rejected", "Not sent · draft kept"],
    ["uncertain", "Delivery unconfirmed · draft kept"], ["unknown", "Not confirmed by Codex · not sent again"]])
    assert.equal(deliveryNote(status, "Codex", null, true), note, status);
});

test("every other note is unchanged", () => {
  assert.equal(deliveryNote("accepted", "Codex"), "Received by Codex · syncing conversation");
  assert.equal(deliveryNote("accepted", null), "Sent · syncing conversation");
  assert.equal(deliveryNote("sending", "Codex"), "Sending…");
  assert.equal(deliveryNote("queued", "Claude"), "Sent · waiting for Claude to confirm");
  assert.equal(deliveryNote("rejected", "Codex"), "Not sent · draft kept");
  assert.equal(deliveryNote("uncertain", "Codex"), "Delivery unconfirmed · draft kept");
  assert.equal(deliveryNote("unknown", null), "Not confirmed by the harness · not sent again");
});
