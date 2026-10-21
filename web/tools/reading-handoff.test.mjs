import test from "node:test";
import assert from "node:assert/strict";

// The browser side of a reading place shared between the user's browsers
// (T-170), without a browser: write numbers, offers and where a shared place
// lands on another screen.
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
const handoff = await import("../src/reading-handoff.ts");

test("write numbers only go up: past what was used, what Core saw and the clock", () => {
  memory.clear();
  const first = handoff.nextSeq("ws-1", 1_000);
  assert.equal(first, 1_001);
  // A reload, then a clock set back an hour: the next number is still higher.
  assert.equal(handoff.nextSeq("ws-1", 1_000 - 3_600_000), 1_002);
  // Core says this browser already reached further (another tab): taken into account.
  handoff.observeSeq("ws-1", 5_000);
  assert.equal(handoff.nextSeq("ws-1", 2_000), 5_001);
  // A late answer with a lower number never lowers it; nonsense is ignored.
  for (const seen of [10, -1, 1.5, "9999999", Number.MAX_SAFE_INTEGER + 2]) handoff.observeSeq("ws-1", seen);
  assert.equal(handoff.nextSeq("ws-1", 2_000), 5_002);
  assert.equal(handoff.nextSeq("ws-2", 7), 8, "each Workspace counts on its own");
  // A damaged number restarts from the clock rather than stopping.
  localStorage.setItem('yuzuno.reading-seq.v1:["ws-3"]', "abc");
  assert.equal(handoff.nextSeq("ws-3", 42), 43);
});

test("one random source per Workspace and browser, with nothing about the device", () => {
  memory.clear();
  const source = handoff.readingSource("ws-1");
  assert.match(source, /^[0-9a-f]{32}$/);
  assert.equal(handoff.readingSource("ws-1"), source, "tabs and reloads keep it");
  assert.notEqual(handoff.readingSource("ws-2"), source);
});

test("only another browser's place at a message is offered, once per version", () => {
  memory.clear();
  const me = handoff.readingSource("ws-1");
  const other = { mode: "anchor", turnId: "t2", itemId: "t2-r", threadId: "th", progress: 0.4, source: "f".repeat(32), label: "browser", version: 3, ageSeconds: 90 };
  assert.equal(handoff.offerable("ws-1", "a", other, null), true);
  assert.equal(handoff.offerable("ws-1", "a", { ...other, source: me }, null), false, "this browser's own place");
  assert.equal(handoff.offerable("ws-1", "a", { ...other, mode: "latest", turnId: undefined }, null), false, "following the latest is no place to offer");
  assert.equal(handoff.offerable("ws-1", "a", null, null), false);
  const here = { mode: "anchor", turnId: "t2", itemId: "t2-r", offset: -40, savedAt: 1 };
  assert.equal(handoff.offerable("ws-1", "a", other, here), false, "already where this browser left it");
  handoff.markOfferHandled("ws-1", "a", 3);
  assert.equal(handoff.offerable("ws-1", "a", other, null), false, "Continue or Not now: not again");
  assert.equal(handoff.offerable("ws-1", "a", { ...other, version: 4 }, null), true, "a newer place is");
  assert.equal(handoff.offerable("ws-1", "b", other, null), true, "per Agent");
  for (let v = 0; v < handoff.OFFER_LIMIT + 50; v++) handoff.markOfferHandled("ws-1", "c", v);
  const kept = JSON.parse(localStorage.getItem('yuzuno.reading-offers.v1:["ws-1"]'));
  assert.equal(kept.length, handoff.OFFER_LIMIT, "bounded, the oldest go first");
  assert.ok(kept.includes(JSON.stringify(["c", handoff.OFFER_LIMIT + 49])));
});

test("only the message and how far into it are shared, never pixels", () => {
  assert.deepEqual(handoff.sharedPosition({ mode: "anchor", turnId: "t1", itemId: "i", offset: -300, progress: 0.25, threadId: "th", savedAt: 9 }),
    { mode: "anchor", turnId: "t1", itemId: "i", threadId: "th", progress: 0.25 });
  assert.deepEqual(handoff.sharedPosition({ mode: "latest", savedAt: 9 }), { mode: "latest" });
});

test("a shared place lands as far into the message, and some of it always shows", () => {
  const { restoredOffset } = handoff;
  // A long message: half way into it puts its top 500 px above the pane.
  assert.equal(restoredOffset(0.5, 1000, 600), -500);
  // Its very end would leave nothing visible: 48 px of it stay.
  assert.equal(restoredOffset(1, 1000, 600), -952);
  // No progress (an older record): the message's start.
  assert.equal(restoredOffset(0, 1000, 600), -0);
  // A message shorter than 48 px, or a pane shorter than the message: never an inverted range.
  for (const [progress, height, pane] of [[1, 20, 600], [0.9, 1000, 30], [1, 0, 0], [0.5, 10, 5], [2, 100, 100], [-1, 100, 100]]) {
    const offset = restoredOffset(progress, height, pane);
    const visible = Math.min(48, height, pane);
    assert.ok(Number.isFinite(offset), `${progress} ${height} ${pane}`);
    assert.ok(offset + height >= visible - 1e-9 && offset <= Math.max(0, pane - visible) + 1e-9, `${progress} ${height} ${pane}: ${offset}`);
  }
});
