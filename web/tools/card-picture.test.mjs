import test from "node:test";
import assert from "node:assert/strict";
import { CARD_FILES, cardContent, cardSize, selfContained } from "../src/home/card-preview.ts";

// YN-3 PR C2: a card's picture, the files named beside it, its size from its
// picture, and when a card is its whole report. Synthetic content only.
const section = (summary, elements, attachments = [], extra = {}) => ({
  key: "design", kind: "report", title: "Ring design", version: 3,
  body: { root: "body", elements: { body: { type: "BriefBody", props: summary ? { summary } : {}, children: Object.keys(elements) }, ...elements } },
  attachments, ...extra,
});
const md = (text) => ({ type: "Markdown", props: { text } });
const files = (...names) => ({ type: "Attachments", props: { items: names.map((name) => ({ name })) } });
const kept = (name, kind = "text", size = 2048) => ({ name, kind, mime: "text/plain; charset=utf-8", size, snapshot: true, mayChange: false, takenAt: "2026-11-07T01:00:00Z" });
const referenced = (name, kind = "text") => ({ ...kept(name, kind), snapshot: false });
const picture = (card) => {
  const figure = cardContent(card).figure;
  return figure ? `${figure.kind}:${figure.name ?? figure.id}` : null;
};

test("YN-3 a card's picture is the named visual, else the first kept image or single HTML page its body shows, else an unnamed body's first figure", () => {
  const chart = { type: "LineChart", props: { id: "c", title: "Loss", data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }] } } };
  // The author's visual wins over the files.
  assert.equal(picture(section({ lead: "lead", visual: "chart" }, { lead: md("Done."), chart, shown: files("ring.html") }, [kept("ring.html")])), "block:chart");
  // No visual named: the first file a card can show, in the body's order; a referenced one is passed over.
  assert.equal(picture(section({ lead: "lead" }, { lead: md("Done."), shown: files("notes.txt", "old.html", "ring.html", "ring.png") },
    [kept("notes.txt"), referenced("old.html"), kept("ring.html"), kept("ring.png", "image")])), "page:ring.html");
  // An image first is the picture; an .htm page counts; a link named .html does not.
  assert.equal(picture(section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.png", "ring.html") }, [kept("ring.png", "image"), kept("ring.html")])), "image:ring.png");
  assert.equal(picture(section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.htm") }, [kept("ring.htm")])), "page:ring.htm");
  assert.equal(picture(section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html") }, [{ ...kept("ring.html", "link"), url: "https://example.test/ring.html" }])), null);
  // A file inside a Group is shown by the body too.
  const group = { type: "Group", props: { title: "Files" }, children: ["inner"] };
  assert.equal(picture(section({ lead: "lead" }, { lead: md("Done."), group, inner: files("ring.html") }, [kept("ring.html")])), "page:ring.html");
  // No summary named: a page before the opening's place; with no file, an opening figure as before; with a paragraph, none.
  assert.equal(picture(section(null, { lead: md("Opening."), shown: files("ring.html") }, [kept("ring.html")])), "page:ring.html");
  assert.equal(picture(section(null, { chart })), "block:chart");
  assert.equal(picture(section(null, { lead: md("Opening."), chart })), null);
});

test("YN-3 the body's other files are named beside the picture, in its order, the picture not among them", () => {
  const card = section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html", "ring.png", "spec.pdf") },
    [kept("ring.html"), kept("ring.png", "image"), { ...kept("spec.pdf", "pdf") }]);
  assert.deepEqual(cardContent(card).files, [{ name: "ring.png", kind: "image", kept: true }, { name: "spec.pdf", kind: "file", kept: true }]);
  assert.equal(CARD_FILES, 3);
});

test("YN-3 a card with no size named sizes to its picture: a page or an image large; an unnamed card too; the author's size wins", () => {
  assert.equal(cardSize(section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html") }, [kept("ring.html")])), "large");
  assert.equal(cardSize(section(null, { lead: md("Opening."), shown: files("ring.html") }, [kept("ring.html")])), "large", "no summary named, a page: large");
  assert.equal(cardSize(section(null, { lead: md("Opening.") })), "small", "no picture: small");
  assert.equal(cardSize(section({ lead: "lead", size: "small" }, { lead: md("Done."), shown: files("ring.html") }, [kept("ring.html")])), "small", "the author's small stays");
});

test("YN-3 a report whose body holds only what its card shows is the whole report; anything more, and it is not", () => {
  const page = [kept("ring.html")];
  const whole = (summary, elements, attachments = page, extra) => selfContained(section(summary, elements, attachments, extra));
  // The user's case: a paragraph and its page.
  assert.equal(whole({ lead: "lead" }, { lead: md("The ring design, interactive."), shown: files("ring.html") }), true);
  assert.equal(whole(null, { lead: md("The ring design, interactive."), shown: files("ring.html") }), true, "no summary named: one paragraph and the page");
  assert.equal(whole(null, { shown: files("ring.html") }), true, "the page alone");
  // With conditions shown with it, still whole.
  assert.equal(whole({ lead: "lead", conditions: "holds" }, { lead: md("Done."), holds: md("On the test rig."), shown: files("ring.html") }), true);
  // More than the card shows: a second paragraph, another block, Sources, more files than it names, a table's rows.
  assert.equal(whole({ lead: "lead" }, { lead: md("Done.\n\nA second paragraph."), shown: files("ring.html") }), false, "the lead's second paragraph");
  assert.equal(whole({ lead: "lead" }, { lead: md("Done."), more: md("Method."), shown: files("ring.html") }), false, "a block the card leaves to the page");
  assert.equal(whole({ lead: "lead" }, { lead: md("Done."), sources: { type: "Sources", props: { items: [] } }, shown: files("ring.html") }), false, "Sources");
  const many = ["ring.html", "a.png", "b.png", "c.png", "d.png"];
  assert.equal(whole({ lead: "lead" }, { lead: md("Done."), shown: files(...many) }, [kept("ring.html"), ...many.slice(1).map((name) => kept(name, "image"))]), false, "a file past the three named");
  const table = { type: "Table", props: { id: "t", columns: [{ key: "a", label: "A" }], rows: [{ id: "r", cells: { a: 1 } }] } };
  assert.equal(whole({ lead: "lead", visual: "table" }, { lead: md("Done."), table }), false, "a table, of which a card shows part");
  // Only a report: a status keeps its page.
  assert.equal(whole({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html") }, page, { kind: "status" }), false);
});

test("YN-3 a whole report is decided as the card is shown: a chart a small card only names, a file it can only name, keep the report page (PR C2's review)", () => {
  const chart = { type: "LineChart", props: { id: "c", title: "Loss", data: { attachment: "loss.csv", x: "step", series: [{ name: "A", column: "a" }] } } };
  const trend = section({ lead: "lead", visual: "chart" }, { lead: md("Loss falls."), chart }, [kept("loss.csv", "data")]);
  assert.equal(selfContained(trend, cardContent(trend), "wide"), true, "a chart drawn on a wide card");
  assert.equal(selfContained(trend, cardContent(trend), "small"), false, "a small card names the chart as on the report");
  // Every file named beside the picture must open in place: a kept image or page.
  const withFile = (...attachments) => section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html", "method.pdf") }, [kept("ring.html"), ...attachments]);
  assert.equal(selfContained(withFile(kept("method.pdf", "pdf"))), false, "a PDF opens on the report page");
  assert.equal(selfContained(withFile(referenced("method.pdf", "image"))), false, "an image only referenced");
  const withImage = section({ lead: "lead" }, { lead: md("Done."), shown: files("ring.html", "ring.png") }, [kept("ring.html"), kept("ring.png", "image")]);
  assert.equal(selfContained(withImage), true, "a kept image opens in place");
});

test("YN-16 a Group of inputs named as the visual is the card's live figure, drawn whole at every size", () => {
  const body = (visual, box, size) => ({
    key: "scones", kind: "report", title: "Scones", version: 2, attachments: [],
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual, ...(size ? { size } : {}) } }, children: ["lead", "box"] },
      lead: md("Scales with the guests."),
      box,
      guests: { type: "NumberInput", props: { name: "guests", label: "Guests", value: 4, min: 1, max: 12 } },
      note: md("Two trays."),
    } },
  });
  const group = (children) => ({ type: "Group", props: {}, children });
  const live = body("box", group(["guests", "note"]));
  assert.deepEqual(cardContent(live).figure, { kind: "interactive", id: "box" });
  // Its author's size, or the size a figure needing width takes; it draws whole, so a card of only it and its lead is the report.
  assert.equal(cardSize(live), "wide");
  assert.equal(cardSize(body("box", group(["guests", "note"]), "small")), "small");
  assert.equal(selfContained(live, cardContent(live), "small"), true);
  // A Group without an input is not a figure: the card names none.
  assert.equal(cardContent(body("box", group(["note"]))).figure, null);
});
