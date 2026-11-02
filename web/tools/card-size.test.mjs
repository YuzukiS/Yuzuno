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

test("the user's size comes first where the card may take it; a card with no summary may only be small", async () => {
  const { allowedSizes, cardContent, shownSize } = await import("../src/home/card-preview.ts");
  const chart = section({ lead: "lead", visual: "fig" }, { lead, fig: { type: "LineChart", props: { id: "c", title: "Loss", data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }] } } } });
  const content = cardContent(chart);
  assert.deepEqual(allowedSizes(content), ["small", "wide", "large"]);
  assert.deepEqual(shownSize(chart, content, null), { size: "wide", source: "auto" });
  assert.deepEqual(shownSize(chart, content, "small"), { size: "small", source: "user" });
  assert.deepEqual(shownSize(chart, content, "large"), { size: "large", source: "user" });
  const unnamed = section(null, { lead });
  assert.deepEqual(allowedSizes(cardContent(unnamed)), ["small"]);
  assert.deepEqual(shownSize(unnamed, cardContent(unnamed), "large"), { size: "small", source: "auto" });
});

test("the choices are kept per Workspace, by project and key; anything else in storage is ignored", async () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const { readSizeChoices, sizeKey } = await import("../src/home/card-sizes.ts");
  assert.equal(sizeKey("p1", "eval/sub"), "p1:eval/sub");
  assert.deepEqual(readSizeChoices("ws-1"), {});
  store.set("yuzuno.homeCardSizes.ws-1", JSON.stringify({ "p1:eval": "large", "p1:old": "huge", "p2:x": 3 }));
  assert.deepEqual(readSizeChoices("ws-1"), { "p1:eval": "large" });
  assert.deepEqual(readSizeChoices("ws-2"), {}, "another Workspace has its own");
  store.set("yuzuno.homeCardSizes.ws-3", "not json");
  assert.deepEqual(readSizeChoices("ws-3"), {});
  store.set("yuzuno.homeCardSizes.ws-4", JSON.stringify(["large"]));
  assert.deepEqual(readSizeChoices("ws-4"), {});
});
