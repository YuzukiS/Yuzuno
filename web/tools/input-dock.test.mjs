import test from "node:test";
import assert from "node:assert/strict";
import { inputEntries, readingEntry } from "../src/input-dock.ts";

// T-6: which of your inputs is being read. The Turn being read reports the
// input at or before its row at the reading line, from its rows' own
// positions (rows not drawn included), or null when the line is before any.
const turns = [{ id: "t1", status: "completed", items: [] }, { id: "t2", status: "completed", items: [] }];
const input = (turnId, itemId, i) => ({ turnId, itemId, position: [turnId === "t1" ? 0 : 1, i], by: "you", preview: itemId });
const entries = inputEntries([input("t1", "a", 0), input("t2", "b", 0), input("t2", "c", 3), input("t2", "d", 6)], turns);
const id = (turnId, itemId) => JSON.stringify([turnId, itemId]);

test("the input being read is the one the Turn being read reports", () => {
  assert.equal(readingEntry(entries, turns, "t2", "c"), id("t2", "c"), "a later input of the Turn, wherever its row is drawn");
  assert.equal(readingEntry(entries, turns, "t2", "d"), id("t2", "d"));
  assert.equal(readingEntry(entries, turns, "t2", null), id("t1", "a"), "before any input of the Turn: an earlier Turn's last");
  assert.equal(readingEntry(entries, turns, "t2", undefined), id("t2", "b"), "not reported yet: the Turn's first input");
  assert.equal(readingEntry(entries, turns, "t2", "gone"), id("t2", "b"), "an input not among those read: the Turn's first");
  assert.equal(readingEntry(entries, turns, "t1", "a"), id("t1", "a"));
  assert.equal(readingEntry(entries, turns, undefined, undefined), id("t2", "b"), "no Turn read yet: the newest Turn");
  assert.equal(readingEntry([], turns, "t2", "b"), undefined);
});
