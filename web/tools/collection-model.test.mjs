// YN-128 (YN-113 §3.6): what a Collection shows on a card and its page,
// apart from drawing it: how many items a card draws, the tags its page
// filters by, the search, and the card's figure, size and whether it is the
// whole report. Pure: no DOM. Synthetic content only.
import test from "node:test";
import assert from "node:assert/strict";
import { BRIEF_LIMITS, COLLECTION_CARD_ROWS, checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";
import { cardContent, cardSize, figureOf, LARGE_TABLE_PREVIEW, selfContained, TABLE_PREVIEW } from "../src/home/card-preview.ts";
import { summaryOf } from "../src/home/report/report-model.ts";
import { CAROUSEL_DOTS, cardItems, cardLeavesOut, FILTER_TAGS, GRID_ROW, itemShows, tagsOf } from "../src/home/brief/collection-model.ts";

const items = (n, make = (i) => ({})) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `Item ${i}`, ...make(i) }));
/** A report whose summary names a Collection as its visual, as the contract keeps it. */
const report = (layout, size, list = items(9)) => {
  const put = {
    key: "digest/news", kind: "report", title: "Today",
    body: { root: "body", elements: {
      body: { type: "BriefBody", props: { summary: { lead: "lead", visual: "top", ...(size ? { size } : {}) } }, children: ["lead", "top"] },
      lead: { type: "Markdown", props: { text: "Three picks today." } },
      top: { type: "Collection", props: { id: "top", layout, items: list } },
    } },
  };
  const kept = checkBriefSection(put);
  return { key: kept.key, kind: kept.kind, title: kept.title, version: 1, body: kept.body, attachments: [] };
};

test("the renderer's numbers are the contract's and the card's: filter tags, rows on a card", () => {
  assert.equal(FILTER_TAGS, BRIEF_LIMITS.collectionFilters);
  assert.equal(CAROUSEL_DOTS, 12);
  assert.deepEqual(COLLECTION_CARD_ROWS, { wide: TABLE_PREVIEW.rows, large: LARGE_TABLE_PREVIEW.rows });
  assert.deepEqual(GRID_ROW, { wide: 3, narrow: 2 });
});

test("a card draws a carousel whole, a grid's row or two, a list's first rows, a small card one item; and says how many when it leaves any out", () => {
  assert.equal(cardItems("carousel", "wide"), null);
  assert.equal(cardItems("carousel", "large"), null);
  assert.equal(cardItems("grid", "wide"), 3);
  assert.equal(cardItems("grid", "large"), 6);
  assert.equal(cardItems("list", "wide"), 3);
  assert.equal(cardItems("list", "large"), 8);
  for (const layout of ["carousel", "grid", "list"]) assert.equal(cardItems(layout, "small"), 1, layout);
  // A carousel shows every page: nothing to count.
  assert.equal(cardLeavesOut("carousel", "wide", 30), false);
  // A grid's row holds two where the card is one column: three items are then one too many.
  assert.equal(cardLeavesOut("grid", "wide", 2), false);
  assert.equal(cardLeavesOut("grid", "wide", 3), true);
  assert.equal(cardLeavesOut("grid", "large", 4), false);
  assert.equal(cardLeavesOut("grid", "large", 5), true);
  assert.equal(cardLeavesOut("list", "wide", 3), false);
  assert.equal(cardLeavesOut("list", "wide", 4), true);
  assert.equal(cardLeavesOut("list", "large", 8), false);
  assert.equal(cardLeavesOut("list", "large", 9), true);
  assert.equal(cardLeavesOut("carousel", "small", 2), true);
});

test("the tags to filter by, each once in the order they first appear; a filter and a search leave the items that hold them", () => {
  const list = [
    { title: "Token-level uncertainty", text: "Fewer wrong answers", meta: "cs.CL · 09:12", tags: ["RAG", "Agent"] },
    { title: "Data mixing laws", meta: "cs.LG · 07:40", tags: ["Data"] },
    { title: "Self-correcting tools", text: "Retries on its own", tags: ["Agent"] },
    { title: "Beam search", text: "1.6× faster" },
  ];
  assert.deepEqual(tagsOf(list), ["RAG", "Agent", "Data"]);
  const shown = (tag, query) => list.filter((item) => itemShows(item, tag, query)).map((item) => item.title);
  assert.deepEqual(shown(null, ""), list.map((item) => item.title));
  assert.deepEqual(shown("Agent", ""), ["Token-level uncertainty", "Self-correcting tools"]);
  // Any case, in the title, the line or the meta; spaces around the words don't count.
  assert.deepEqual(shown(null, "  TOKEN "), ["Token-level uncertainty"]);
  assert.deepEqual(shown(null, "retries"), ["Self-correcting tools"]);
  assert.deepEqual(shown(null, "cs.lg"), ["Data mixing laws"]);
  assert.deepEqual(shown("Agent", "retries"), ["Self-correcting tools"]);
  assert.deepEqual(shown("Data", "retries"), []);
});

test("a Collection is the card's figure: its own kind at every size, wide when its author named no size", () => {
  for (const layout of ["carousel", "grid", "list"]) {
    const section = report(layout, null);
    assert.deepEqual(figureOf(section, "top"), { kind: "collection", id: "top", layout, total: 9 });
    assert.equal(summaryOf(section)?.visual, "top", "the report page shows it in the summary");
    assert.equal(cardSize(section), "wide", layout);
    for (const size of ["small", "wide", "large"]) assert.equal(cardSize(report(layout, size)), size);
  }
  assert.equal(cardContent(report("grid", "wide")).figure.kind, "collection");
});

test("a carousel on a card not small is the whole report; a grid, a list or a small card leave the rest to the page", () => {
  const whole = (layout, size) => {
    const section = report(layout, size, items(3));
    return selfContained(section, cardContent(section), size);
  };
  assert.equal(whole("carousel", "wide"), true);
  assert.equal(whole("carousel", "large"), true);
  assert.equal(whole("carousel", "small"), false);
  for (const size of ["small", "wide", "large"]) {
    assert.equal(whole("grid", size), false, `grid ${size}`);
    assert.equal(whole("list", size), false, `list ${size}`);
  }
});
