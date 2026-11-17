// YN-209: a card's face, as brief_update tells its author. Exact fields from
// Home's own rules; the estimate's CSS found in Home's stylesheets; bounded;
// never a path or a file's content. Synthetic sections only. The estimate
// against Chromium is card-face-check.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { advance, cardFace, FACE_CSS, FACE_LIMITS, FACE_NOTE, FACE_REFERENCE, visibleRuns, wrap } from "../src/home/card-face.ts";
import { CARD_LINES, LARGE_TABLE_PREVIEW, MORE_METRICS, TABLE_PREVIEW } from "../src/home/card-preview.ts";
import { CARD_FACE_FIXTURES } from "./card-face-fixtures.mjs";

const fixture = (id) => CARD_FACE_FIXTURES.find((f) => f.id === id);
const face = (id) => {
  const f = fixture(id);
  return cardFace(f.section, { refreshes: f.refreshes, requested: f.requested });
};
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

test("YN-209 the lead, picture, what a size draws, files and Open report are Home's own choice", () => {
  const cpu = face("long-lead");
  assert.deepEqual([cpu.size, cpu.sizeFrom, cpu.summary, cpu.lead.block, cpu.lead.otherParagraphs], ["wide", "author", "named", "lead", 1]);
  assert.match(cpu.lead.text, /^日用 Core 在合成的 20 分钟窗口里/);
  assert.equal(cpu.lead.text.includes("**"), false, "the lead as read, without its emphasis marks");
  assert.deepEqual(cpu.conditions, { block: "limits", type: "Checklist", items: 5 });
  assert.deepEqual(cpu.visual, { from: "named", block: "numbers", type: "Metrics", drawn: { as: "values", shown: 1 + MORE_METRICS, of: 4 } });
  assert.deepEqual(cpu.notOnCard, [{ block: "findings", type: "Findings", items: 4 }, { block: "sources", type: "Sources", items: 3 }]);
  assert.equal(cpu.opensReport, true);

  // A 5 × 5 table: a wide card draws 3 × 3, a large one all it has up to 8 × 6.
  assert.deepEqual(face("table-wide").visual.drawn, { as: "table", rows: TABLE_PREVIEW.rows, ofRows: 5, columns: TABLE_PREVIEW.columns, ofColumns: 5 });
  assert.deepEqual(face("table-large").visual.drawn, { as: "table", rows: 5, ofRows: 5, columns: Math.min(6, LARGE_TABLE_PREVIEW.columns), ofColumns: 6 });

  // Only the lead named: the first kept image the body shows is the picture, the rest named beside it.
  const fallback = face("fallback");
  assert.deepEqual(fallback.visual, { from: "file", block: "files", type: "image", file: "conversation.svg", kept: true, drawn: { as: "image", whole: true } });
  assert.deepEqual(fallback.files, { named: ["comparison.svg", "notes.pdf"], more: 0 });
  assert.deepEqual(fallback.notOnCard, [{ block: "detail", type: "Markdown", chars: 15 }]);
  assert.equal(fallback.dropped, undefined, "nothing named was dropped: no visual was named");

  // A visual naming a PDF is no picture: said, with the fallback; a small card's two numbers; a one-line status.
  const pdf = face("visual-dropped");
  assert.deepEqual(pdf.dropped, [{ slot: "visual", block: "pdf", reason: "\"review.pdf\" is kept as a pdf file; a card's picture is one image" }]);
  assert.deepEqual([pdf.visual.from, pdf.visual.file], ["file", "comparison.svg"]);
  assert.deepEqual(face("small-numbers").visual.drawn, { as: "values", shown: 2, of: 2 });
  assert.equal(face("small-numbers").wide.layout, "line");
  const text = face("simple-text");
  assert.deepEqual([text.size, text.visual, text.wide.layout, text.phone.layout], ["small", { from: "none" }, "none", "none"]);
  assert.deepEqual(face("en-bold-metrics").visual.drawn, { as: "values", shown: 4, of: 5 });

  // No summary named: the opening paragraph; the table after it is left to the page.
  const unnamed = face("unnamed-en");
  assert.deepEqual([unnamed.summary, unnamed.lead.block, unnamed.visual.from], ["unnamed", "opening", "none"]);
  assert.deepEqual(unnamed.notOnCard, [{ block: "rows", type: "Table", items: 4 }]);

  // A refreshing card is wide unless its author named a size, and keeps its page.
  const refreshing = face("refreshing");
  assert.deepEqual([refreshing.size, refreshing.sizeFrom, refreshing.opensReport], ["wide", "refresh", true]);
  // A visual Core's repair removed is named, with the fallback the card shows.
  const repaired = face("repaired-visual");
  assert.deepEqual(repaired.dropped, [{ slot: "visual", block: "tabs", reason: "Core removed summary.visual to accept the section (its repairs say why)" }]);
  assert.deepEqual([repaired.visual.from, repaired.visual.file], ["file", "after.svg"]);
  // An Ask has no face here.
  assert.equal(cardFace({ key: "q", kind: "ask", title: "Q", body: {}, attachments: [] }), null);
});

test("YN-209 the estimate tells where the clamp cuts, and what fits fully or partly", () => {
  const cpu = face("long-lead");
  for (const width of ["wide", "phone"]) {
    const lead = cpu[width].estimate.lead;
    assert.equal(lead.cut, true, `${width}: the limit at the paragraph's end is past ${CARD_LINES.lead} lines`);
    assert.equal(lead.shownLines, CARD_LINES.lead);
    assert.ok(lead.hiddenChars > 30 && !lead.endsWith.includes("根因未定"), JSON.stringify(lead));
  }
  assert.deepEqual([cpu.wide.layout, cpu.phone.layout], ["beside", "under"]);
  assert.equal(cpu.wide.estimate.metrics.full, 4, "beside the text the frame grows to hold all four");
  assert.ok(cpu.phone.estimate.metrics.full < 4, "a phone's 140 px frame does not");
  // Six columns on a phone: one is past the frame's edge.
  assert.deepEqual(face("table-large").phone.estimate.table.columns, { full: 5, partial: 1 });
  assert.deepEqual(face("table-wide").phone.estimate.table, { rows: { full: 3, partial: 0 }, columns: { full: 3, partial: 0 } });
  assert.equal(face("md-conditions").phone.estimate.conditions.cut, true);
  for (const f of CARD_FACE_FIXTURES) {
    const one = face(f.id);
    assert.ok(one.phone.estimate.heightPx > 100 && one.wide.estimate.heightPx >= FACE_CSS.deck.minHeight, f.id);
    assert.equal(one.phone.columns, 1);
    assert.equal(one.wide.columns, 3);
  }
});

test("YN-209 text is broken as a browser fills lines: CJK anywhere but before closing punctuation, words at spaces", () => {
  assert.equal(advance("中"), 1);
  assert.equal(advance("i"), 0.222);
  assert.equal(advance("W", true), 0.944);
  const cjk = wrap(visibleRuns("一二三四五六七八九十"), 14 * 5, 14);
  assert.deepEqual(cjk.ends, [5, 10]);
  // "。" never starts a line: the character before it goes down with it.
  assert.deepEqual(wrap(visibleRuns("一二三四五。六"), 14 * 5, 14).ends, [4, 7]);
  const words = wrap(visibleRuns("aaaa bbbb cccc"), advance("a") * 14 * 9 + 1, 14);
  assert.deepEqual(words.ends, [10, 14], "breaks after the space, never inside a word that fits");
  // A list item starts a line of its own; emphasis and link targets are not text.
  assert.equal(wrap(visibleRuns("- one\n- two"), 1000, 14).lines, 2);
  assert.equal(visibleRuns("**bold** and [a link](https://example.test/x)").map((run) => run.text).join(""), "bold and a link");
});

test("YN-209 a face is bounded, and never holds a path or a file's content", () => {
  const long = "长".repeat(400);
  const elements = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`block-${String(i).padStart(2, "0")}-${"x".repeat(40)}`, { type: "Markdown", props: { text: `Note ${i}.` } }]));
  const section = {
    key: "big", kind: "report", title: "Big",
    body: { root: "body", elements: { body: { type: "BriefBody", props: { summary: { lead: "lead", size: "wide" } }, children: ["lead", "files", ...Object.keys(elements)] },
      lead: { type: "Markdown", props: { text: long } },
      files: { type: "Attachments", props: { items: Array.from({ length: 9 }, (_, i) => ({ name: `file-${i}.pdf` })) } }, ...elements } },
    attachments: Array.from({ length: 9 }, (_, i) => ({ name: `file-${i}.pdf`, kind: "pdf", mime: "application/pdf", size: 10, snapshot: false, mayChange: true,
      takenAt: "2026-11-17T20:00:00Z", path: `/home/someone/private/file-${i}.pdf` })),
  };
  const big = cardFace(section);
  assert.equal([...big.lead.text].length, FACE_LIMITS.text);
  assert.equal(big.lead.chars, 400);
  assert.deepEqual([big.notOnCard.length, big.moreNotOnCard], [FACE_LIMITS.notOnCard, 14]);
  assert.ok(big.notOnCard.every((entry) => [...entry.block].length <= FACE_LIMITS.name));
  assert.deepEqual([big.files.named.length, big.files.more], [3, 6]);
  assert.ok([...big.wide.estimate.lead.endsWith].length <= FACE_LIMITS.tail + 1);
  assert.ok(bytes(big) < 2048, `${bytes(big)} bytes`);
  assert.equal(JSON.stringify(big).includes("/home/"), false, "no path");
  for (const f of CARD_FACE_FIXTURES) assert.ok(bytes(face(f.id)) < 2048, `${f.id}: ${bytes(face(f.id))} bytes`);
  assert.ok(Buffer.byteLength(FACE_NOTE) < 1024);
  // Bodies a face cannot read have no lead and no picture, and never throw.
  for (const body of [null, {}, { root: "x" }, { root: "body", elements: { body: { type: "BriefBody", children: ["gone"] } } }]) {
    const odd = cardFace({ key: "odd", kind: "status", title: "Odd", body, attachments: undefined });
    assert.deepEqual([odd.lead, odd.visual.from], [null, "none"]);
  }
});

test("YN-209 the CSS a face estimates with is Home's", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const card = read("../src/home/summary-card.css");
  const home = read("../src/home/home.css");
  const brief = read("../src/home/brief/brief.css");
  /** The declarations of every rule whose selector ends with this one, after `from` when given. */
  const rule = (css, selector, from = "") => {
    const start = css.indexOf(from);
    assert.ok(start >= 0, `${from} not found`);
    const blocks = [];
    for (let at = css.indexOf(`${selector} {`, start); at >= 0; at = css.indexOf(`${selector} {`, at + 1))
      blocks.push(css.slice(at, css.indexOf("}", at)));
    assert.ok(blocks.length, `${selector} not found`);
    return blocks;
  };
  const has = (blocks, ...declarations) =>
    declarations.forEach((d) => assert.ok(blocks.some((block) => block.includes(d)), `${d} in ${blocks[0].split("{")[0]}`));
  const C = FACE_CSS;
  has(rule(card, ".home-section.home-summary-card"), `padding: ${C.card.padY}px ${C.card.padX}px`, `border: ${C.card.border}px solid`, `gap: ${C.card.gap}px`);
  has(rule(card, ".home-summary-head"), `min-height: ${C.card.head}px`);
  has(rule(card, ".home-summary-actions .icon-button", "@media (pointer: coarse)"), `min-height: ${C.card.touchHead}px`);
  has(rule(card, ".home-summary-title"), "font-size: calc(13.5px + var(--font-adjust, 3px))", `line-height: ${C.title.line}`);
  has(rule(card, ".home-summary-title-link"), `-webkit-line-clamp: ${CARD_LINES.title}`);
  has(rule(card, ".home-summary-lead .brief-markdown"), `-webkit-line-clamp: ${CARD_LINES.lead}`, "font-size: calc(11px + var(--font-adjust, 3px))", `line-height: ${C.lead.line}`);
  has(rule(card, ".home-summary-lead .brief-markdown", "@container deck (min-width: 560px)"), `min-height: calc(${CARD_LINES.lead} * ${C.lead.line}em)`);
  has(rule(card, ":is(.home-brief, .home-widget-grid) .home-summary-card.size-large .home-summary-lead .brief-markdown"), `-webkit-line-clamp: ${CARD_LINES.largeLead}`);
  has(rule(card, ".home-summary-foot"), `padding-top: ${C.card.footPad}px`);
  has(rule(card, ".home-report-open"), `min-height: ${C.card.open}px`);
  has(rule(card, ".home-card-frame-body"), `padding: ${C.frame.padY}px ${C.frame.padX}px`);
  has(rule(card, ":is(.home-brief, .home-widget-grid) .home-summary-card.size-wide .home-card-frame-body"), `height: ${C.frame.wide}px`);
  has(rule(card, ":is(.home-brief, .home-widget-grid) .home-summary-card.size-large .home-card-frame-body"), `min-height: ${C.frame.large}px`);
  has(rule(card, ":is(.home-brief, .home-widget-grid) .home-summary-card.size-large .home-card-frame-body", "@container deck (min-width: 560px)"), `min-height: ${C.frame.deckLarge}px`);
  has(rule(card, ".home-card-frame.is-chart .home-card-frame-body"), "height: calc(125px + 9 * var(--font-adjust, 3px))");
  has(rule(card, ":is(.home-brief, .home-widget-grid) .home-summary-card.size-wide .home-summary-body.has-figure", "@container deck (min-width: 560px)"), `gap: ${C.beside.gap}px`);
  has(rule(card, ".home-card-table"), "font-size: calc(9px + var(--font-adjust, 3px))");
  has(rule(card, ".home-card-table :is(th, td)"), `padding: 3px ${C.table.padX}px`, `max-width: ${C.table.maxEm}em`);
  has(rule(card, ".home-card-condition-chips"), `gap: ${C.conditions.chipGap}px`);
  has(rule(card, ".home-card-condition-chips li"), `padding: 1px ${C.conditions.chipPadX}px`, `border: ${C.conditions.chipBorder}px solid`, "font-size: calc(9px + var(--font-adjust, 3px))");
  has(rule(card, ".home-card-condition-text.is-clamped"), "max-height: calc(2 * 1.6em)");
  has(rule(home, ".home-card-conditions"), `margin-top: ${C.conditions.margin}px`, `padding: ${C.conditions.padY}px ${C.conditions.padX}px`, `gap: ${C.conditions.rowGap}px 10px`);
  has(rule(home, ".home-card-conditions-label"), "font-size: calc(9px + var(--font-adjust, 3px))");
  has(rule(home, ".home-brief"), `gap: ${C.deck.gap}px`);
  for (const at of C.deck.breaks) assert.ok(home.includes(`@container deck (min-width: ${at}px) {\n  .home-brief {`), `deck columns at ${at}px`);
  has(rule(home, ".home-brief .home-summary-card", "@container deck (min-width: 560px)"), `min-height: ${C.deck.minHeight}px`);
  has(rule(home, ".home-view", "@media (max-width: 520px)"), `padding: var(--home-pad-top) ${(FACE_REFERENCE.phone.window - FACE_REFERENCE.phone.deck) / 2}px 28px`);
  // Metrics on a card's front: low density, in a frame narrower than 520 px.
  has(rule(brief, ".brief-metrics", "@container brief-body (max-width: 520px)"), `gap: ${C.metrics.gapY}px ${C.metrics.gapX}px`);
  has(rule(brief, ".brief-metrics dd", "@container brief-body (max-width: 520px)"), `font-size: ${C.metrics.value / 16}rem`);
  has(rule(brief, '.brief-metrics[data-density="low"]'), `minmax(${C.metrics.min}px, 1fr)`);
  has(rule(brief, '.brief-metrics[data-density="low"] > [data-lead] dd'), "font-size: 2.4rem", "line-height: 1.1");
  has(rule(brief, ".brief-metrics small"), `font-size: ${C.metrics.label / 16}rem`);
  has(rule(brief, ".brief-metrics > div"), `gap: ${C.metrics.labelGap}px`);
  has(rule(brief, ".brief-body .brief-markdown"), `font-size: ${C.conditions.textFont / 16}rem`, `line-height: ${C.conditions.textLine}`);
  has(rule(card, ".quiet-button.home-card-conditions-toggle"), `padding: ${C.conditions.togglePadY}px 0`);
  const coarse = card.slice(card.indexOf("@media (pointer: coarse)"));
  const toggle = coarse.indexOf(".home-card-conditions-toggle,");
  assert.ok(toggle >= 0 && coarse.slice(toggle, coarse.indexOf("}", toggle)).includes(`min-height: ${C.conditions.touchToggle}px`), "the conditions toggle is touch-sized");
  has(rule(read("../src/styles.css"), ".quiet-button"), "font-size: calc(10px + var(--font-adjust, 3px))");
  has(rule(card, ".home-summary-foot"), "font-size: calc(9px + var(--font-adjust, 3px))");
  has(rule(card, ".home-card-frame figcaption"), "font-size: calc(8.5px + var(--font-adjust, 3px))");
});
