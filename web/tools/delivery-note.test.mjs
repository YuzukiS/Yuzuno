import test from "node:test";
import assert from "node:assert/strict";
import { deliveryNote, steered } from "../src/delivery-note.ts";

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

test("every other note is unchanged", () => {
  assert.equal(deliveryNote("accepted", "Codex"), "Received by Codex · syncing conversation");
  assert.equal(deliveryNote("accepted", null), "Sent · syncing conversation");
  assert.equal(deliveryNote("sending", "Codex"), "Sending…");
  assert.equal(deliveryNote("queued", "Claude"), "Sent · waiting for Claude to confirm");
  assert.equal(deliveryNote("rejected", "Codex"), "Not sent · draft kept");
  assert.equal(deliveryNote("uncertain", "Codex"), "Delivery unconfirmed · draft kept");
  assert.equal(deliveryNote("unknown", null), "Not confirmed by the harness · not sent again");
});
