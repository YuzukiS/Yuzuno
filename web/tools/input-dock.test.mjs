import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { inputEntries, readingEntry } from "../src/input-dock.ts";

// T-6: which of your inputs is being read, against the reading line at 100.
// ConversationRows draws the rows around what is on screen: an input not
// drawn comes before the first drawn row or after the last one.
const turns = [{ id: "t1", status: "completed", items: [] }, { id: "t2", status: "completed", items: [] }];
const input = (turnId, itemId, i) => ({ turnId, itemId, position: [turnId === "t1" ? 0 : 1, i], by: "you", preview: itemId });
const entries = inputEntries([input("t1", "a", 0), input("t2", "b", 0), input("t2", "c", 3), input("t2", "d", 6)], turns);
const id = (turnId, itemId) => JSON.stringify([turnId, itemId]);

/** Draws the Turns with only these inputs, each at the top it is given. */
function drawn(tops) {
  const dom = new JSDOM(`<article id="turn-t1"></article><article id="turn-t2"></article>`);
  globalThis.document = dom.window.document;
  for (const [itemId, top] of Object.entries(tops)) {
    const element = dom.window.document.createElement("div");
    element.dataset.itemId = itemId;
    element.getBoundingClientRect = () => ({ top });
    dom.window.document.getElementById(itemId === "a" ? "turn-t1" : "turn-t2").append(element);
  }
}

test("an input of the Turn being read is the last drawn above the line, wherever the others are", () => {
  drawn({ b: 50, c: 300 });
  assert.equal(readingEntry(entries, turns, "t2", 100), id("t2", "b"), "d, not drawn, is after c: not reached");
  drawn({ c: 40, d: 600 });
  assert.equal(readingEntry(entries, turns, "t2", 100), id("t2", "c"), "b, not drawn, is before c: passed");
  drawn({ c: 300, d: 600 });
  assert.equal(readingEntry(entries, turns, "t2", 100), id("t2", "b"), "the one before the first drawn below the line");
  drawn({ b: 300 });
  assert.equal(readingEntry(entries, turns, "t2", 100), id("t1", "a"), "before the Turn's first input: the previous Turn's last");
  drawn({});
  assert.equal(readingEntry(entries, turns, "t2", 100), id("t2", "b"), "none drawn while the Turn is read: its first is passed");
  drawn({ a: 20 });
  assert.equal(readingEntry(entries, turns, "t1", 100), id("t1", "a"));
  assert.equal(readingEntry([], turns, "t2", 100), undefined);
});
