/**
 * How Home lays out a deck of cards with no holes, in their order (YN-3).
 *
 * Each card keeps its own size (card-preview.ts): small is one column, wide
 * two, large two columns and, on a four-column deck, two rows. A full item
 * (an Ask, a heading) takes its row. The grid places them as its own row
 * flow does, never dense, so the order on screen and the keyboard's order
 * stay the deck's. Where that flow would leave a row short, its cards share
 * the rest, from the last back; where a taller card makes a cell empty, the
 * card before it takes it: the card to its left grows to the row's end, or,
 * where that card is taller, the card above it grows down. A large card keeps its
 * second row only when another card reaches that row beside it; otherwise it
 * is one row, as on two columns.
 *
 * What it gives is each item's span, columns and rows. Laid out by the
 * grid's own flow with those spans, the items fill their rows exactly, in
 * order: the cells a card grows into are ones the flow left to nobody, so
 * nothing after it moves.
 */
export type DeckItem = {
  /** Columns of its own size: 1 for small, 2 for wide and large. */
  span: number;
  /** A large card: two rows where the deck has four columns. */
  tall?: boolean;
  /** Takes its whole row. */
  full?: boolean;
};
export type DeckSpan = { cols: number; rows: number };

type Box = { row: number; col: number; cols: number; rows: number };

/** The grid's row flow: each item at the first place, at or after the one before, where it fits. */
function flow(sizes: DeckSpan[], columns: number): Box[] {
  const taken: boolean[][] = [];
  const fits = (row: number, col: number, size: DeckSpan) => {
    if (col + size.cols > columns) return false;
    for (let y = row; y < row + size.rows; y++) for (let x = col; x < col + size.cols; x++) if (taken[y]?.[x]) return false;
    return true;
  };
  let row = 0, col = 0;
  return sizes.map((size) => {
    while (!fits(row, col, size)) {
      col++;
      if (col + size.cols > columns) {
        row++;
        col = 0;
      }
    }
    for (let y = row; y < row + size.rows; y++) for (let x = col; x < col + size.cols; x++) (taken[y] ??= [])[x] = true;
    const box = { row, col, ...size };
    col += size.cols;
    return box;
  });
}

const rowsOf = (box: Box) => ({ first: box.row, last: box.row + box.rows - 1 });

export function packDeck(items: readonly DeckItem[], columns: number): DeckSpan[] {
  if (columns < 1) return items.map(() => ({ cols: 1, rows: 1 }));
  const sizes: DeckSpan[] = items.map((item) => ({
    cols: item.full ? columns : Math.min(Math.max(1, Math.round(item.span)), columns),
    rows: item.tall && !item.full && columns >= 4 ? 2 : 1,
  }));
  // A large card with nothing beside it in its second row takes one row.
  for (;;) {
    const boxes = flow(sizes, columns);
    const lone = boxes.findIndex((box, i) => {
      if (box.rows < 2) return false;
      const second = box.row + 1;
      return !boxes.some((other, j) => j !== i && rowsOf(other).first <= second && rowsOf(other).last >= second);
    });
    if (lone < 0) break;
    sizes[lone].rows = 1;
  }
  // A row of one-row cards that ends short shares what is left, a column at a
  // time from its last card back: two small cards on four columns are two
  // columns each, not one and three (YN-3, the answer cards). Rows a taller
  // card reaches are left to the filling below.
  {
    const laid = flow(sizes, columns);
    const rows = new Map<number, number[]>();
    laid.forEach((box, i) => rows.set(box.row, [...(rows.get(box.row) ?? []), i]));
    for (const [row, members] of rows) {
      if (laid.some((box) => box.rows > 1 && box.row <= row && box.row + box.rows > row)) continue;
      let free = columns - members.reduce((sum, i) => sum + sizes[i].cols, 0);
      for (let k = members.length - 1; free > 0; k = k > 0 ? k - 1 : members.length - 1, free--) sizes[members[k]].cols++;
    }
  }
  const boxes = flow(sizes, columns);
  const height = boxes.reduce((most, box) => Math.max(most, box.row + box.rows), 0);
  const owner: number[][] = Array.from({ length: height }, () => Array<number>(columns).fill(-1));
  boxes.forEach((box, i) => {
    for (let y = box.row; y < box.row + box.rows; y++) for (let x = box.col; x < box.col + box.cols; x++) owner[y][x] = i;
  });
  const growRight = (i: number) => {
    const box = boxes[i], x = box.col + box.cols;
    if (x >= columns) return false;
    for (let y = box.row; y < box.row + box.rows; y++) if (owner[y][x] !== -1) return false;
    for (let y = box.row; y < box.row + box.rows; y++) owner[y][x] = i;
    box.cols++;
    return true;
  };
  const growDown = (i: number) => {
    const box = boxes[i], y = box.row + box.rows;
    if (y >= height) return false;
    for (let x = box.col; x < box.col + box.cols; x++) if (owner[y][x] !== -1) return false;
    for (let x = box.col; x < box.col + box.cols; x++) owner[y][x] = i;
    box.rows++;
    return true;
  };
  // Every cell the flow left empty goes to the card before it: the one to its left, else the one above.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < columns; x++) {
      if (owner[y][x] !== -1) continue;
      const left = x > 0 ? owner[y][x - 1] : -1;
      if (left >= 0 && !items[left].full && growRight(left)) continue;
      const above = y > 0 ? owner[y - 1][x] : -1;
      if (above >= 0 && !items[above].full) growDown(above);
    }
  return boxes.map(({ cols, rows }) => ({ cols, rows }));
}

/**
 * How many columns a grid has, as the browser laid it out (its resolved
 * `grid-template-columns`, one length per column); null where that is not
 * known (not laid out, as in a closed `<details>`, or no layout at all).
 */
export function deckColumns(style: { gridTemplateColumns?: string } | null | undefined): number | null {
  const tracks = style?.gridTemplateColumns?.trim().split(/\s+/) ?? [];
  return tracks.length > 0 && tracks.every((track) => /^\d+(\.\d+)?px$/.test(track)) ? tracks.length : null;
}
