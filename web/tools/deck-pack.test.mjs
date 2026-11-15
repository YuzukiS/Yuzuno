import test from "node:test";
import assert from "node:assert/strict";
import { deckColumns, packDeck } from "../src/home/deck-pack.ts";

// YN-3: Home's deck, in order. Every sequence of up to six items of the four
// kinds, at one, two, three and four columns, laid out here as the grid's own
// row flow lays out items with the spans packDeck gives (CSS Grid's sparse
// auto-placement, written apart from deck-pack.ts). YN-157 adds the third
// column, where a row may end empty beside cards already at twice their size.
const kinds = {
  small: { span: 1 },
  wide: { span: 2 },
  large: { span: 2, tall: true },
  full: { span: 1, full: true },
};

function gridFlow(spans, columns) {
  const taken = [];
  const fits = (row, col, { cols, rows }) => {
    if (col + cols > columns) return false;
    for (let y = row; y < row + rows; y++) for (let x = col; x < col + cols; x++) if (taken[y]?.[x] !== undefined) return false;
    return true;
  };
  let row = 0, col = 0;
  return spans.map((span, i) => {
    // The cursor: the row of the item before, and the column after it.
    for (;;) {
      if (col + span.cols > columns) {
        row++;
        col = 0;
        continue;
      }
      if (fits(row, col, span)) break;
      col++;
    }
    for (let y = row; y < row + span.rows; y++) for (let x = col; x < col + span.cols; x++) (taken[y] ??= [])[x] = i;
    const box = { row, col, ...span };
    col += span.cols;
    return box;
  }).map((box, i, boxes) => ({ ...box, taken, height: boxes.reduce((m, b) => Math.max(m, b.row + b.rows), 0) }));
}

function* sequences(length) {
  const names = Object.keys(kinds);
  if (length === 0) return yield [];
  for (const rest of sequences(length - 1)) for (const name of names) yield [...rest, name];
}

test("YN-3 every deck of up to six cards keeps its order, and a row ends empty only beside cards at twice their size", () => {
  let decks = 0;
  for (const columns of [1, 2, 3, 4])
    for (let length = 1; length <= 6; length++)
      for (const names of sequences(length)) {
        const items = names.map((name) => kinds[name]);
        const spans = packDeck(items, columns);
        const boxes = gridFlow(spans, columns);
        const where = `${columns} columns: ${names.join(", ")} → ${JSON.stringify(spans)}`;
        const { taken, height } = boxes[0];
        // A hole only at the end of a row, beside cards already at twice their own size (YN-157).
        for (let y = 0; y < height; y++) {
          const cells = [...Array(columns).keys()].map((x) => taken[y]?.[x]);
          const first = cells.indexOf(undefined);
          if (first < 0) continue;
          assert.ok(cells.slice(first).every((cell) => cell === undefined), `a hole inside row ${y + 1}: ${where}`);
          for (const i of new Set(cells.filter((cell) => cell !== undefined))) {
            const own = Math.min(items[i].span, columns);
            assert.equal(boxes[i].rows, 1, `only one-row cards beside a hole: ${where}`);
            assert.equal(boxes[i].cols, 2 * own, `a card beside a hole is at twice its size: ${where}`);
          }
        }
        boxes.forEach((box, i) => {
          const own = Math.min(items[i].span, columns);
          if (items[i].full) assert.equal(box.cols, columns, `a full item takes its row: ${where}`);
          else assert.ok(box.cols >= own, `never narrower than its own size: ${where}`);
          // In order: each starts after the one before, row by row.
          if (i > 0) {
            const before = boxes[i - 1];
            assert.ok(box.row > before.row || (box.row === before.row && box.col > before.col), `in order: ${where}`);
          }
          // Two rows only where the deck has four columns.
          if (columns < 4) assert.equal(box.rows, 1, `one row below four columns: ${where}`);
        });
        decks++;
      }
  assert.equal(decks, 4 * [1, 2, 3, 4, 5, 6].reduce((n, k) => n + 4 ** k, 0));
});

/** YN-3's packing, as it stood at one and two columns: a row that ends short grows its last card to the row's end. */
function packBelowThree(items, columns) {
  const spans = items.map((item) => ({
    cols: item.full ? columns : Math.min(Math.max(1, Math.round(item.span)), columns),
    rows: 1,
  }));
  const rows = new Map();
  gridFlow(spans, columns).forEach((box, i) => rows.set(box.row, [...(rows.get(box.row) ?? []), i]));
  for (const members of rows.values()) {
    const free = columns - members.reduce((sum, i) => sum + spans[i].cols, 0);
    if (free > 0) spans[members[members.length - 1]].cols += free;
  }
  return spans;
}

test("YN-157 one and two columns are packed as YN-3 packed them", () => {
  // The twice-the-size cap cannot stop a card before the row's end below three columns, so the spans must be
  // exactly YN-3's; packBelowThree is that rule for one and two columns only.
  for (const columns of [1, 2])
    for (let length = 1; length <= 6; length++)
      for (const names of sequences(length)) {
        const items = names.map((name) => kinds[name]);
        assert.deepEqual(packDeck(items, columns), packBelowThree(items, columns), `${columns} columns: ${names.join(", ")}`);
      }
});

test("YN-3 a large card keeps two rows when two cards stand beside it, and takes one when nothing does", () => {
  const [large, wide1, wide2] = packDeck([kinds.large, kinds.wide, kinds.wide], 4);
  assert.deepEqual([large, wide1, wide2], [{ cols: 2, rows: 2 }, { cols: 2, rows: 1 }, { cols: 2, rows: 1 }]);
  // Nothing beside it in its second row: one row, and it takes the row's end.
  assert.deepEqual(packDeck([kinds.small, kinds.large], 4), [{ cols: 1, rows: 1 }, { cols: 3, rows: 1 }]);
  // The user's screenshot: small, wide, large, then an Ask. Column 4 and the 2×2 beside the large card were empty.
  assert.deepEqual(packDeck([kinds.small, kinds.wide, kinds.large, kinds.full], 4),
    [{ cols: 1, rows: 1 }, { cols: 3, rows: 1 }, { cols: 4, rows: 1 }, { cols: 4, rows: 1 }]);
  // A small card that would leave the row's end empty grows to it.
  assert.deepEqual(packDeck([kinds.small, kinds.wide], 2), [{ cols: 2, rows: 1 }, { cols: 2, rows: 1 }]);
  assert.deepEqual(packDeck([kinds.small, kinds.small, kinds.small], 2), [{ cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 2, rows: 1 }]);
  assert.deepEqual(packDeck([], 4), []);
});

test("YN-3 a deck's columns are read from its grid as laid out, and are not known otherwise", () => {
  assert.equal(deckColumns({ gridTemplateColumns: "300px 300px 300px 300px" }), 4);
  assert.equal(deckColumns({ gridTemplateColumns: "512.5px 512.5px" }), 2);
  assert.equal(deckColumns({ gridTemplateColumns: "repeat(2, minmax(0px, 1fr))" }), null, "not laid out");
  assert.equal(deckColumns({ gridTemplateColumns: "none" }), null);
  assert.equal(deckColumns({ gridTemplateColumns: "" }), null);
  assert.equal(deckColumns(null), null);
});

test("YN-3 the cards of a row that ends short share what is left, from the last back; a row a large card reaches is filled as before", () => {
  // Two answer cards, or two small cards, on four columns: two columns each.
  assert.deepEqual(packDeck([kinds.small, kinds.small], 4), [{ cols: 2, rows: 1 }, { cols: 2, rows: 1 }]);
  assert.deepEqual(packDeck([kinds.small, kinds.small, kinds.small], 4), [{ cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 2, rows: 1 }]);
  // A heading between two groups: each group's row is shared on its own.
  assert.deepEqual(packDeck([kinds.wide, kinds.full, kinds.small, kinds.small], 4),
    [{ cols: 4, rows: 1 }, { cols: 4, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 1 }]);
  // A lone small card takes two columns, not the row (YN-157); the rest stays empty.
  assert.deepEqual(packDeck([kinds.small], 4), [{ cols: 2, rows: 1 }]);
  // Beside a large card that keeps two rows, the cells left are filled as before.
  assert.deepEqual(packDeck([kinds.large, kinds.small, kinds.wide], 4),
    [{ cols: 2, rows: 2 }, { cols: 2, rows: 1 }, { cols: 2, rows: 1 }]);
});

test("YN-157 three columns: two cards share the third, a lone small card takes two and leaves the rest", () => {
  // The user's screenshot: a wide status with a table and a small task card side by side.
  assert.deepEqual(packDeck([kinds.wide, kinds.small], 3), [{ cols: 2, rows: 1 }, { cols: 1, rows: 1 }]);
  // A lone small card: two columns, not the row.
  assert.deepEqual(packDeck([kinds.small], 3), [{ cols: 2, rows: 1 }]);
  // Two small cards: one and two, filled from the last back.
  assert.deepEqual(packDeck([kinds.small, kinds.small], 3), [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }]);
  // A wide card grows to three (twice its size is four), so it still fills the row.
  assert.deepEqual(packDeck([kinds.wide], 3), [{ cols: 3, rows: 1 }]);
  // Two wide cards each take their row, as they do on two columns.
  assert.deepEqual(packDeck([kinds.wide, kinds.wide], 3), [{ cols: 3, rows: 1 }, { cols: 3, rows: 1 }]);
  // A large card is one row below four columns, and fills the three.
  assert.deepEqual(packDeck([kinds.large], 3), [{ cols: 3, rows: 1 }]);
  // A full item takes its row; a small card alone after it keeps two columns.
  assert.deepEqual(packDeck([kinds.small, kinds.full, kinds.small], 3),
    [{ cols: 2, rows: 1 }, { cols: 3, rows: 1 }, { cols: 2, rows: 1 }]);
});
