import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { deckColumns, packDeck, type DeckItem } from "./deck-pack.ts";

/** One packing pass over a grid: its columns as laid out, then each card's span. */
function pack(el: HTMLElement, items: (grid: HTMLElement) => HTMLElement[], describe: (item: HTMLElement) => DeckItem | null) {
  const found = items(el);
  const columns = deckColumns(getComputedStyle(el));
  const described = found.map(describe);
  const spans = columns ? packDeck(described.map((item) => item ?? { span: 1, full: true }), columns) : null;
  found.forEach((item, i) => {
    const span = spans && described[i] ? spans[i] : null;
    if (!span) {
      item.style.removeProperty("--deck-cols");
      item.style.removeProperty("--deck-rows");
      delete item.dataset.deckCols;
      delete item.dataset.deckRows;
      return;
    }
    item.style.setProperty("--deck-cols", String(span.cols));
    item.style.setProperty("--deck-rows", String(span.rows));
    item.dataset.deckCols = String(span.cols);
    item.dataset.deckRows = String(span.rows);
  });
}

/** Each grid useDeckPacking lays out, with how it packs it now. */
const packers = new WeakMap<HTMLElement, () => void>();

/**
 * Packs the deck a card is on now, as its next render or resize would
 * (YN-21): for a card that changed size by its own state, so that what it
 * measures next is where the deck puts it. A card on no deck is left alone.
 */
export function packDeckOf(card: HTMLElement) {
  for (let el = card.parentElement; el; el = el.parentElement) {
    const repack = packers.get(el);
    if (repack) return repack();
  }
}

/**
 * Lays out a grid of cards with no holes, in order (deck-pack.ts, YN-3).
 *
 * After each render, and whenever the grid's size changes, it reads how many
 * columns the grid has as laid out. Each item described as a card then gets
 * its span, `--deck-cols` and `--deck-rows`, which the deck's CSS turns into
 * `grid-column` and `grid-row` spans. An item described as null takes its
 * whole row, as its own CSS says. Where the columns are not known (a closed
 * `<details>`, no layout at all), every item is left to the CSS.
 *
 * One ResizeObserver watches the grid element as long as it is the same
 * element (PR C1's review, P3): a render packs once, synchronously, and makes
 * no observer; a change of the grid's size packs again in the next frame.
 *
 * A card whose reply is being written takes its row by CSS (home.css); its
 * growing grid is read again, so the cards around it close up.
 */
export function useDeckPacking(
  grid: RefObject<HTMLElement | null>,
  items: (grid: HTMLElement) => HTMLElement[],
  describe: (item: HTMLElement) => DeckItem | null,
) {
  const latest = useRef({ items, describe });
  latest.current = { items, describe };
  const watched = useRef<{ el: HTMLElement | null; observer: ResizeObserver | null; frame: number }>({ el: null, observer: null, frame: 0 });
  useLayoutEffect(() => {
    const el = grid.current;
    if (el) {
      pack(el, latest.current.items, latest.current.describe);
      packers.set(el, () => pack(el, latest.current.items, latest.current.describe));
    }
    const w = watched.current;
    if (w.el === el) return;
    // Another grid element (or none): its own observer, the earlier one's gone.
    w.observer?.disconnect();
    cancelAnimationFrame(w.frame);
    w.el = el;
    w.observer = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Its first report is of the size just packed; later ones, in the next frame, so a layout settles first.
    let first = true;
    w.observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      cancelAnimationFrame(w.frame);
      w.frame = requestAnimationFrame(() => {
        if (w.el) pack(w.el, latest.current.items, latest.current.describe);
      });
    });
    w.observer.observe(el);
  });
  useEffect(
    () => () => {
      const w = watched.current;
      w.observer?.disconnect();
      cancelAnimationFrame(w.frame);
      w.el = null;
      w.observer = null;
    },
    [],
  );
}

/** Whether an element matches a selector, false where the selector is not supported (`:has` in an older engine). */
export function matches(element: Element, selector: string) {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** A deck card as an item: its size (card-preview.ts) as its author or the user gave it; null for one that takes its row. */
export function deckCard(element: HTMLElement): DeckItem | null {
  if (matches(element, ":has(.home-card-reply)")) return null;
  switch (element.dataset.cardSize) {
    case "small":
      return { span: 1 };
    case "wide":
      return { span: 2 };
    case "large":
      return { span: 2, tall: true };
    default:
      return null;
  }
}

/**
 * A deck's items in order: its grid's children, through the wrappers that
 * keep a topic's cards together (`display: contents`, home.css).
 */
export function deckItems(grid: HTMLElement): HTMLElement[] {
  const items: HTMLElement[] = [];
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.classList.contains("home-topic") || child.classList.contains("home-subs")) walk(child);
      else items.push(child as HTMLElement);
    }
  };
  walk(grid);
  return items;
}
