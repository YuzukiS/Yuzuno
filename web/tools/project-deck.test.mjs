// A Project's page groups its cards (YN-86 §2.2) by what they take from the
// user, and holds each card's group for the visit: opening a report clears
// its New mark without moving it. The mapping and the grouping are pure;
// the visit's memory is tested with the page in home-ui.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { groupSections, readVersion } from "../src/home/brief-layout.ts";
import { DECK_PLACES } from "../src/home/deck-order.ts";
import { deckGroup, deckMembers, groupDeck } from "../src/home/project-deck.ts";

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const by = { agentId: "a", name: "Mina", state: "active" };
const section = (key, kind, extra = {}) => ({
  key,
  kind,
  title: key,
  version: 2,
  owner: by,
  updatedAt: at(10),
  updatedTurnId: "t1",
  body: { root: "body", elements: { body: { type: "BriefBody", props: {} } } },
  attachments: [],
  refs: {},
  seen: null,
  history: false,
  ...extra,
});
const openAsk = (key, extra = {}) =>
  section(key, "ask", { ask: { question: key, state: "open", reply: { freeText: true } }, ...extra });
const status = (key, stale = false) =>
  section(key, "status", { status: { asOf: at(30), validFor: 3600, stale } });
const report = (key, extra = {}) => section(key, "report", extra);
const read = (value) => ({ seen: { version: value, at: at(25) } });

/** The group as a Project's page works it out now: the card's place, and whether its version is unread. */
const groupOf = (cards = new Map()) => (s) => {
  const place = cards.get(s.key);
  return deckGroup(place, (readVersion(s) ?? 0) < s.version);
};

/** `places` for the cards, as card-sizes.ts holds them at a project's first showing. */
const places = (sections) =>
  new Map(sections.map((s) => [s.key, s.kind === "ask"
    ? (s.ask?.state === "replied" ? "replied" : s.ask?.deferredUntil && Date.parse(s.ask.deferredUntil) > Date.now() ? "deferred" : "ask")
    : s.kind === "status"
      ? (s.status?.stale ? "stale" : "status")
      : "report"]));

test("a place and an unread version decide a card's group (YN-86 §2.2)", () => {
  assert.equal(deckGroup("ask", true), "needs");
  assert.equal(deckGroup("deferred", true), "needs");
  assert.equal(deckGroup("status", false), "doing");
  assert.equal(deckGroup("late", false), "doing");
  assert.equal(deckGroup("replied", false), "doing");
  assert.equal(deckGroup("report", true), "doing");
  assert.equal(deckGroup("report", false), "done");
  assert.equal(deckGroup("stale", true), "done");
});

test("open, put-off and answered Asks, current and out-of-date statuses, read and unread reports (YN-86 §2.2)", () => {
  const sections = [
    openAsk("ask-open"),
    openAsk("ask-later", { ask: { question: "later", state: "open", reply: { freeText: true }, deferredUntil: new Date(Date.now() + 86_400_000).toISOString() } }),
    openAsk("ask-answered", { ask: { question: "answered", state: "replied", repliedAt: at(20), replyText: "yes", reply: { freeText: true } } }),
    status("status-now"),
    status("status-old", true),
    report("report-new"),
    report("report-read", read(2)),
  ];
  const placeOf = (s) => places(sections).get(s.key) ?? "status";
  const deck = groupDeck(groupSections(sections), groupOf(places(sections)), placeOf);
  const keys = (groups) => groups.map((group) => group.topic);
  assert.deepEqual(keys(deck.needs), ["ask-open"]);
  assert.deepEqual(keys(deck.deferred), ["ask-later"]);
  assert.deepEqual(keys(deck.replied), ["ask-answered"]);
  assert.deepEqual(keys(deck.doing), ["status-now", "report-new"]);
  assert.deepEqual(keys(deck.done), ["report-read", "status-old"]);
  assert.deepEqual(deck.counts, { needs: 1, deferred: 1, doing: 2, replied: 1, done: 2 });
  // Every card is in exactly one group.
  assert.deepEqual(
    [...deckMembers(deck.needs), ...deckMembers(deck.deferred), ...deckMembers(deck.doing), ...deckMembers(deck.replied), ...deckMembers(deck.done)].map((s) => s.key).sort(),
    sections.map((s) => s.key).sort(),
  );
});

test("a topic enters its most urgent card's group, and its cards stay together (YN-86 §2.2)", () => {
  const sections = [
    report("design/read", read(2)),
    openAsk("design/choice"),
    status("design/state"),
    report("ops/read", read(2)),
  ];
  const placeOf = (s) => places(sections).get(s.key) ?? "status";
  const deck = groupDeck(groupSections(sections), groupOf(places(sections)), placeOf);
  assert.deepEqual(deck.needs.map((g) => g.topic), ["design"]);
  assert.deepEqual(deckMembers(deck.needs).map((s) => s.key), ["design/read", "design/choice", "design/state"]);
  assert.deepEqual(deck.done.map((g) => g.topic), ["ops"]);
});

test("within a group, topics keep the deck's order (DECK_PLACES), whatever Core's order (YN-86 §2.2)", () => {
  const sections = [report("r1"), report("r2"), status("s1"), status("s2")];
  const placeOf = (s) => places(sections).get(s.key) ?? "status";
  const deck = groupDeck(groupSections(sections), groupOf(places(sections)), placeOf);
  // status before report (DECK_PLACES), then Core's order among equals.
  assert.deepEqual(deck.doing.map((g) => g.topic), ["s1", "s2", "r1", "r2"]);
  assert.ok(DECK_PLACES.indexOf("status") < DECK_PLACES.indexOf("report"));
});

test("an Ask put off alone goes to the end of Needs you; with a live Ask in its topic, the topic stays in Needs you", () => {
  const later = openAsk("a", { ask: { question: "a", state: "open", reply: { freeText: true }, deferredUntil: new Date(Date.now() + 86_400_000).toISOString() } });
  const placeOf = (s) => places([later]).get(s.key) ?? "status";
  const alone = groupDeck(groupSections([later]), groupOf(places([later])), placeOf);
  assert.deepEqual(alone.needs, []);
  assert.deepEqual(alone.deferred.map((g) => g.topic), ["a"]);
  // The same topic, with one Ask to answer: the whole topic is in Needs you.
  const live = openAsk("a/live");
  const both = [later, live];
  const placeOf2 = (s) => places(both).get(s.key) ?? "status";
  const deck = groupDeck(groupSections(both), groupOf(places(both)), placeOf2);
  assert.deepEqual(deck.deferred, []);
  assert.deepEqual(deck.needs.map((g) => g.topic), ["a"]);
  assert.deepEqual(deck.counts, { needs: 1, deferred: 0, doing: 0, replied: 0, done: 0 });
});
