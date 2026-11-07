import { useLayoutEffect, type RefObject } from "react";
import { deckColumns, packDeck, type DeckItem } from "./deck-pack.ts";

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
 * A card whose reply is being written takes its row by CSS (home.css); its
 * growing grid is read again, so the cards around it close up.
 */
export function useDeckPacking(
  grid: RefObject<HTMLElement | null>,
  items: (grid: HTMLElement) => HTMLElement[],
  describe: (item: HTMLElement) => DeckItem | null,
) {
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const apply = () => {
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
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    // In the next frame, so a layout that changes the grid's size settles before it is read again.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });
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
