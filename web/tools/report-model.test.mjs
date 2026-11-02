// A Home report's model (T-18): the summary its author named, the page's
// parts, its outline and figures, and where a report link's version is on
// Home now. Synthetic sections only.
import test from "node:test";
import assert from "node:assert/strict";
import { figuresOf, linkTo, outlineOf, partsOf, reportPlace, summaryOf } from "../src/home/report/report-model.ts";

const owner = { agentId: "a", name: "Mori", state: "active" };
const md = (text) => ({ type: "Markdown", props: { text } });
const elements = {
  answer: md("Model B lowers validation loss by 4% on the synthetic set."),
  holds: { type: "Checklist", props: { items: [{ id: "d", text: "Definition v2", done: true }] } },
  loss: { type: "Metrics", props: { items: [{ label: "Validation loss", value: 0.412 }] } },
  method: { type: "Group", props: { title: "Method" }, children: ["method-text"] },
  "method-text": md("Three seeds per arm."),
  evidence: { type: "Group", props: { title: "Evidence" }, children: ["curve", "runs"] },
  curve: { type: "LineChart", props: { id: "curve", title: "Loss by step", x: { label: "step" }, y: { label: "loss" }, series: [] } },
  runs: { type: "Table", props: { id: "runs", title: "Runs", columns: [{ key: "m", label: "Model" }], rows: [{ id: "a", cells: { m: "A" } }, { id: "b", cells: { m: "B" } }] } },
  plain: { type: "Group", props: {}, children: ["note"] },
  note: md("An untitled note."),
  refs: { type: "Sources", props: { items: [{ id: "s", label: "Run log", href: "https://example.test/log" }] } },
  shot: { type: "Attachments", props: { items: [{ name: "a.png" }] } },
  shots: { type: "Attachments", props: { items: [{ name: "a.png" }, { name: "b.png" }] } },
};
const section = (key, id, version, top, props = {}, extra = {}) => ({
  id, key, kind: "report", title: `About ${key}`, version, owner, updatedAt: "2026-11-02T10:00:00Z", updatedTurnId: null,
  body: { root: "body", elements: { body: { type: "BriefBody", props, children: top }, ...elements } },
  attachments: [], refs: {}, seen: null, history: false, ...extra,
});
const all = ["answer", "holds", "loss", "method", "evidence", "plain", "refs", "shot"];

test("the page leads with the summary its author named, each block once, then the rest in order with sources and files beside it", () => {
  const report = section("eval", 7, 3, all, { summary: { lead: "answer", visual: "loss", conditions: "holds" }, details: ["method"] });
  const parts = partsOf(report);
  assert.deepEqual(parts.summary, { lead: "answer", visual: "loss", conditions: "holds" });
  assert.deepEqual(parts.flow, ["method", "evidence", "plain"]);
  assert.deepEqual(parts.sources, ["refs"]);
  assert.deepEqual(parts.attachments, ["shot"]);
  assert.deepEqual([...parts.details], ["method"]);
  // The outline names titled Groups and figures; the figures list finds nested ones by their part.
  assert.deepEqual(outlineOf(report, parts.flow), [{ id: "method", title: "Method" }, { id: "evidence", title: "Evidence" }]);
  assert.deepEqual(figuresOf(report, parts.flow), [
    { id: "evidence", title: "Loss by step", kind: "chart" },
    { id: "evidence", title: "Runs", kind: "table", rows: 2 },
  ]);
});

test("a body that names no summary is shown as written: nothing lifted, guessed or folded", () => {
  const legacy = section("old", 1, 1, all);
  const parts = partsOf(legacy);
  assert.equal(parts.summary, null);
  assert.deepEqual(parts.flow, ["answer", "holds", "loss", "method", "evidence", "plain"]);
  assert.deepEqual([...parts.details], []);
  assert.equal(summaryOf({ ...legacy, body: null }), null);
});

test("a summary or details that do not hold are taken as none, never half-applied", () => {
  const named = (props) => partsOf(section("d", 4, 1, all, props));
  for (const summary of [{ lead: "method" }, { lead: "method-text" }, { lead: "answer", visual: "plain" }, { lead: "answer", visual: "shots" },
    { lead: "answer", visual: "answer" }, { lead: "answer", conditions: "loss" }, { visual: "loss" }, ["answer", "loss"], "answer"])
    assert.equal(named({ summary }).summary, null, JSON.stringify(summary));
  // One file is the figure only when Core keeps it as an image; otherwise it stays among the attachments.
  const withFile = (kind) => partsOf(section("d", 4, 1, all, { summary: { lead: "answer", visual: "shot" } },
    { attachments: [{ name: "a.png", kind, mime: "", size: 1, snapshot: true, mayChange: false, takenAt: "" }] }));
  assert.deepEqual(withFile("image").summary, { lead: "answer", visual: "shot", conditions: null });
  assert.deepEqual(withFile("text").summary, { lead: "answer", visual: null, conditions: null });
  assert.deepEqual(withFile("text").attachments, ["shot"]);
  // details: only titled Groups directly under the root, never a summary block.
  assert.deepEqual([...named({ details: ["plain", "note", "answer", "method", "missing"] }).details], ["method"]);
  assert.deepEqual([...named({ summary: { lead: "answer" }, details: ["answer"] }).details], []);
});

const live = (version, extra) => section("eval", 7, version, ["answer"], {}, extra);
const kept = (id, version, reason) => section("eval", id, version, ["answer"], {}, { history: true, historyReason: reason });
const panel = (sections, history = [], teamSections) => ({
  project: { id: "p1", name: "atlas-notes" }, agents: {}, errors: [], pending: [], jobs: [], unseen: 0, missing: [],
  brief: { version: 1, sections, history, ...(teamSections ? { teamSections } : {}) },
});
const link = (version, sectionId) => ({ key: "eval", version, ...(sectionId === undefined ? {} : { sectionId }) });

test("a report link shows only its very version, live or in History, and otherwise names the versions there are", () => {
  assert.deepEqual(reportPlace(link(3, 7), panel([live(3)])), { kind: "found", section: live(3), newer: null });
  assert.deepEqual(reportPlace(link(3, 7), panel([], [], [live(3)])), { kind: "found", section: live(3), newer: null });
  // Live at a later version, the linked one kept in History: that one, and the newer.
  assert.deepEqual(reportPlace(link(3, 7), panel([live(5)], [kept(7, 3, "seen")])), { kind: "found", section: kept(7, 3, "seen"), newer: live(5) });
  // Not kept: never another version under its link, but the versions there are.
  assert.deepEqual(reportPlace(link(3, 7), panel([live(5)])), { kind: "unavailable", versions: [live(5)] });
  assert.deepEqual(reportPlace(link(3, 7), panel([], [kept(7, 4, "resolved"), kept(7, 6, "seen")])),
    { kind: "unavailable", versions: [kept(7, 6, "seen"), kept(7, 4, "resolved")] });
  // The key written anew is another section: never shown as the one linked.
  assert.deepEqual(reportPlace(link(3, 7), panel([section("eval", 8, 3, ["answer"])], [kept(9, 3, "removed")])), { kind: "unknown", current: 3 });
  assert.deepEqual(reportPlace(link(3, 7), panel([])), { kind: "unknown", current: null });
  assert.deepEqual(reportPlace(link(3, 7), undefined), { kind: "gone" });
});

test("without an identity, only the very version under the key is provably the one linked", () => {
  assert.deepEqual(reportPlace(link(3), panel([live(3)])), { kind: "found", section: live(3), newer: null });
  assert.deepEqual(reportPlace(link(3), panel([live(5)])), { kind: "unknown", current: 5 });
  const removed = kept(7, 3, "removed");
  assert.deepEqual(reportPlace(link(3), panel([live(5)], [removed])), { kind: "found", section: removed, newer: null });
});

test("a card's report link carries the section's identity when Core gave one", () => {
  assert.deepEqual(linkTo("p1", live(3)), { projectId: "p1", key: "eval", version: 3, sectionId: 7 });
  const { id: _id, ...older } = live(3);
  assert.deepEqual(linkTo("p1", older), { projectId: "p1", key: "eval", version: 3 });
});
