// A Home report's model (T-18): which blocks are its summary, what follows
// them, its outline, and where a report link's section is on Home now.
// Synthetic sections only.
import test from "node:test";
import assert from "node:assert/strict";
import { linkTo, outlineOf, reportPlace, restOf, summaryOf } from "../src/home/report/report-model.ts";

const owner = { agentId: "a", name: "Mori", state: "active" };
const section = (key, id, version, elements, top, extra = {}) => ({
  id, key, kind: "report", title: `About ${key}`, version, owner, updatedAt: "2026-11-02T10:00:00Z", updatedTurnId: null,
  body: { root: "body", elements: { body: { type: "BriefBody", props: extra.rootProps ?? {}, children: top }, ...elements } },
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const md = (text) => ({ type: "Markdown", props: { text } });
const metrics = { type: "Metrics", props: { items: [{ label: "Validation loss", value: 0.412 }] } };
const table = { type: "Table", props: { id: "results", title: "Results", columns: [{ key: "m", label: "Model" }], rows: [] } };
const elements = {
  answer: { type: "Group", props: { tone: "accent" }, children: ["answer-text"] },
  "answer-text": md("Model B lowers validation loss by 4% on the synthetic set."),
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": md("Three seeds per arm."),
  loss: metrics,
  results: table,
  notes: md("Untitled notes."),
  plain: { type: "Group", props: {}, children: [] },
};

test("an accent Group first is the lead and the first chart or Metrics the visual; the rest keeps the author's order", () => {
  const report = section("eval", 7, 3, elements, ["answer", "method", "loss", "results", "notes", "plain"]);
  const summary = summaryOf(report);
  assert.deepEqual(summary, { lead: "answer", visual: "loss" });
  assert.deepEqual(restOf(report, summary), ["method", "results", "notes", "plain"]);
  // The outline names titled Groups and figures, by the author's titles.
  assert.deepEqual(outlineOf(report, restOf(report, summary)), [
    { id: "method", title: "Method", figure: false },
    { id: "results", title: "Results", figure: true },
  ]);
});

test("without an accent Group, a block named summary or a Markdown first is the lead; nothing else is guessed", () => {
  const named = section("a", 1, 1, { ...elements, summary: { type: "Group", props: {}, children: ["s-text"] }, "s-text": md("So far, so good.") }, ["method", "summary", "results"]);
  assert.deepEqual(summaryOf(named), { lead: "summary", visual: null });
  const first = section("b", 2, 1, elements, ["notes", "results", "loss"]);
  assert.deepEqual(summaryOf(first), { lead: "notes", visual: "loss" });
  // A table is never taken as the visual unless named; a Group first that is not accent is no lead.
  const none = section("c", 3, 1, elements, ["method", "results"]);
  assert.deepEqual(summaryOf(none), { lead: null, visual: null });
  assert.deepEqual(restOf(none, summaryOf(none)), ["method", "results"]);
  // An unreadable body has none.
  assert.deepEqual(summaryOf({ ...none, body: null }), { lead: null, visual: null });
});

test("a body that names its summary is followed, and one that names it wrongly falls back", () => {
  const top = ["method", "notes", "results", "loss"];
  const named = (summary) => section("d", 4, 1, elements, top, { rootProps: { summary } });
  assert.deepEqual(summaryOf(named(["notes", "results"])), { lead: "notes", visual: "results" });
  assert.deepEqual(summaryOf(named(["method"])), { lead: "method", visual: null });
  const fallback = { lead: null, visual: "loss" };
  for (const wrong of [["missing"], ["answer"], ["results"], ["notes", "notes"], ["notes", "method"], ["notes", "results", "loss"], [], "notes", [1]])
    assert.deepEqual(summaryOf(named(wrong)), fallback, JSON.stringify(wrong));
});

const live = (version, extra) => section("eval", 7, version, elements, ["answer"], extra);
const ended = (id, version, reason) => section("eval", id, version, elements, ["answer"], { history: true, historyReason: reason });
const panel = (sections, history = [], teamSections) => ({
  project: { id: "p1", name: "atlas-notes" }, agents: {}, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 1, sections, history, ...(teamSections ? { teamSections } : {}) },
});
const link = (version, sectionId) => ({ key: "eval", version, ...(sectionId === undefined ? {} : { sectionId }) });

test("a report link finds its section by identity: the very version, a later one, History, or nothing provable", () => {
  assert.deepEqual(reportPlace(link(3, 7), panel([live(3)])), { kind: "live", section: live(3) });
  assert.deepEqual(reportPlace(link(3, 7), panel([], [], [live(3)])), { kind: "live", section: live(3) });
  assert.deepEqual(reportPlace(link(3, 7), panel([live(5)])), { kind: "later", section: live(5) });
  // A live version below the link's is not that section's history: nothing is claimed.
  assert.deepEqual(reportPlace(link(6, 7), panel([live(5)])), { kind: "unknown", current: 5 });
  // History: the newest row of that identity, with its reason.
  const seen = ended(7, 4, "seen");
  assert.deepEqual(reportPlace(link(3, 7), panel([], [ended(7, 3, "resolved"), seen])), { kind: "history", section: seen });
  // The key written anew is another section: never shown as the one linked.
  assert.deepEqual(reportPlace(link(3, 7), panel([section("eval", 8, 4, elements, ["answer"])], [ended(9, 3, "removed")])), { kind: "unknown", current: 4 });
  assert.deepEqual(reportPlace(link(3, 7), panel([])), { kind: "unknown", current: null });
  assert.deepEqual(reportPlace(link(3, 7), undefined), { kind: "gone" });
});

test("without an identity, only the very version is provably the section linked", () => {
  assert.deepEqual(reportPlace(link(3), panel([live(3)])), { kind: "live", section: live(3) });
  assert.deepEqual(reportPlace(link(3), panel([live(5)])), { kind: "unknown", current: 5 });
  const removed = ended(7, 3, "removed");
  assert.deepEqual(reportPlace(link(3), panel([live(5)], [removed])), { kind: "history", section: removed });
});

test("a card's report link carries the section's identity when Core gave one", () => {
  assert.deepEqual(linkTo("p1", live(3)), { projectId: "p1", key: "eval", version: 3, sectionId: 7 });
  const { id: _id, ...older } = live(3);
  assert.deepEqual(linkTo("p1", older), { projectId: "p1", key: "eval", version: 3 });
});
