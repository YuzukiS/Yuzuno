import test from "node:test";
import assert from "node:assert/strict";
import { cardSize, SMALL_METRICS } from "../src/home/card-preview.ts";

// T-18 (Lead 2377): a card's size on Home's deck comes from the figure its
// author named, never from how long its text is. Synthetic content only.
const section = (summary, elements, extra = {}) => ({
  key: "overview", kind: "report", title: "Overview", version: 1,
  body: { root: "body", elements: { body: { type: "BriefBody", props: summary ? { summary } : {}, children: Object.keys(elements) }, ...elements } },
  attachments: [], ...extra,
});
const lead = { type: "Markdown", props: { text: "The conclusion." } };
const metrics = (n) => ({ type: "Metrics", props: { items: Array.from({ length: n }, (_, i) => ({ label: `M${i}`, value: i })) } });
const chart = (type) => ({ type, props: { id: "c", title: "Loss", data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }] } } });
const withFigure = (figure, extra) => cardSize(section({ lead: "lead", visual: "fig" }, { lead, fig: figure }, extra));

test("no summary named, or a lead with no figure, is small, however long the text or its conditions", () => {
  assert.equal(cardSize(section(null, { lead })), "small");
  const long = { type: "Markdown", props: { text: "A long conclusion. ".repeat(80) } };
  const holds = { type: "Checklist", props: { items: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, text: `Condition ${i}`, done: true })) } };
  assert.equal(cardSize(section({ lead: "lead", conditions: "holds" }, { lead: long, holds })), "small");
});

test("Metrics with up to two values is small; more is wide", () => {
  assert.equal(SMALL_METRICS, 2);
  assert.equal(withFigure(metrics(1)), "small");
  assert.equal(withFigure(metrics(2)), "small");
  assert.equal(withFigure(metrics(3)), "wide");
});

test("a table, a line or bar chart and a research desk are wide; an image and a scatter chart are large", () => {
  assert.equal(withFigure({ type: "Table", props: { id: "t", columns: [{ key: "a", label: "A" }], rows: [{ id: "r", cells: { a: 1 } }] } }), "wide");
  assert.equal(withFigure(chart("LineChart")), "wide");
  assert.equal(withFigure(chart("BarChart")), "wide");
  assert.equal(withFigure({ type: "ResearchDesk", props: { title: "Q", claims: [], plots: [] } }), "wide");
  assert.equal(withFigure(chart("ScatterChart")), "large");
  const shot = { type: "Attachments", props: { items: [{ name: "shot.png" }] } };
  assert.equal(withFigure(shot, { attachments: [{ name: "shot.png", kind: "image" }] }), "large");
});

test("a figure the card cannot show is as no figure: small", () => {
  const notImage = { type: "Attachments", props: { items: [{ name: "runs.csv" }] } };
  assert.equal(withFigure(notImage, { attachments: [{ name: "runs.csv", kind: "data" }] }), "small");
  assert.equal(cardSize(section({ lead: "lead", visual: "gone" }, { lead })), "small");
});

test("the author's size is the card's, whatever its figure; a summary kept from before sizes takes its figure's (T-18, Lead 2457, 2473)", async () => {
  const { cardContent, shownSize, sizeSource } = await import("../src/home/card-preview.ts");
  const table = { type: "Table", props: { id: "t", columns: [{ key: "a", label: "A" }], rows: [{ id: "r", cells: { a: 1 } }] } };
  const sized = (size) => section({ lead: "lead", visual: "fig", ...(size ? { size } : {}) }, { lead, fig: table });
  for (const size of ["small", "wide", "large"]) {
    const card = sized(size);
    assert.equal(cardSize(card), size, `the author's ${size}, not the table's wide`);
    assert.deepEqual(shownSize(card, cardContent(card), null), { size, source: "author", own: size });
  }
  const kept = sized(null);
  assert.equal(sizeSource(cardContent(kept)), "content");
  assert.deepEqual(shownSize(kept, cardContent(kept), null), { size: "wide", source: "content", own: "wide" });
  // A size that is not one of the three is no size: the figure's.
  assert.equal(cardSize(sized("huge")), "wide");
  // No summary named: small, and nothing for an author's size to fill.
  const unnamed = section(null, { lead });
  assert.deepEqual(shownSize(unnamed, cardContent(unnamed), null), { size: "small", source: "content", own: "small" });
});

test("on the user's widgets the user's size comes first; the card keeps its own (T-18, Lead 2457)", async () => {
  const { cardContent, shownSize } = await import("../src/home/card-preview.ts");
  const card = section({ lead: "lead", size: "wide" }, { lead });
  assert.deepEqual(shownSize(card, cardContent(card), "large"), { size: "large", source: "user", own: "wide" });
  assert.deepEqual(shownSize(card, cardContent(card), null), { size: "wide", source: "author", own: "wide" });
});

test("in one visit to Home a card keeps the size it was first shown at (Lead 2414)", async () => {
  const { cardContent, shownSize } = await import("../src/home/card-preview.ts");
  const first = section({ lead: "lead", size: "small" }, { lead }), next = section({ lead: "lead", size: "large" }, { lead });
  const held = new Map();
  const hold = (size) => { if (!held.has("p1:7")) held.set("p1:7", size); return held.get("p1:7"); };
  assert.equal(shownSize(first, cardContent(first), null, hold).size, "small");
  assert.equal(shownSize(next, cardContent(next), null, hold).size, "small", "the newer version waits for the next visit");
  held.clear();
  assert.equal(shownSize(next, cardContent(next), null, hold).size, "large");
});

test("a card is named by its project and Home's id of the section, never its key", async () => {
  const { sizable, sizeKey } = await import("../src/home/card-sizes.ts");
  // A section written again under the same key has another id, so it is another card.
  assert.equal(sizeKey("p1", 7), "p1:7");
  assert.notEqual(sizeKey("p1", 7), sizeKey("p1", 40));
  assert.equal(sizable({ id: 7 }), true);
  assert.equal(sizable({}), false, "an older Core names no id");
});
