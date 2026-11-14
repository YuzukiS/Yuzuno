import { LARGE_TABLE_PREVIEW, TABLE_PREVIEW, type CollectionLayout } from "../card-preview.ts";

/**
 * What a Collection (YN-128, YN-113 §3.6) shows where, apart from how it is
 * drawn (Collection.tsx): how many of its items a card draws, the tags its
 * report page filters by, and which items a filter and a search leave.
 */
export type { CollectionLayout };
/** The card a Collection is the visual of, at the size it is shown; none on its page. */
export type CollectionFace = "small" | "wide" | "large";
type Item = { title: string; text?: string; meta?: string; tags?: string[] };

/** Filter tags shown before "More": as many as a form's options (the contract's collectionFilters, YN-113 §10). */
export const FILTER_TAGS = 12;
/** Page dots up to this many pages; past it, the carousel says "n / N" alone (YN-113 §3.6). */
export const CAROUSEL_DOTS = 12;
/** A grid's tiles in one row of a card: three, two where the card is one column (collection.css; YN-113 §3.6). */
export const GRID_ROW = { wide: 3, narrow: 2 } as const;

/**
 * The items a card draws, at its widest: a small card its first; a carousel
 * all of them, a page each; a grid one row of three, two on a large card; a
 * list as many rows as a table on a card (TABLE_PREVIEW). null is all.
 */
export function cardItems(layout: CollectionLayout, face: CollectionFace): number | null {
  if (face === "small") return 1;
  if (layout === "carousel") return null;
  if (layout === "grid") return GRID_ROW.wide * (face === "large" ? 2 : 1);
  return face === "large" ? LARGE_TABLE_PREVIEW.rows : TABLE_PREVIEW.rows;
}

/**
 * Whether a card leaves some items out where it is narrowest (a grid's rows
 * hold two there), and so says how many there are: nothing dropped unsaid.
 */
export function cardLeavesOut(layout: CollectionLayout, face: CollectionFace, total: number): boolean {
  const drawn = cardItems(layout, face);
  if (drawn === null) return false;
  const narrow = layout === "grid" && face !== "small" ? (drawn / GRID_ROW.wide) * GRID_ROW.narrow : drawn;
  return total > narrow;
}

/** Every tag of the items, each once, in the order it first appears. */
export function tagsOf(items: readonly Item[]): string[] {
  const seen = new Set<string>();
  for (const item of items) for (const tag of item.tags ?? []) seen.add(tag);
  return [...seen];
}

/**
 * Whether an item shows with the tag chosen (null: all) and the search: its
 * title, text or meta holds the words as typed, in any case.
 */
export function itemShows(item: Item, tag: string | null, query: string): boolean {
  if (tag !== null && !(item.tags ?? []).includes(tag)) return false;
  const words = query.trim().toLocaleLowerCase();
  if (!words) return true;
  return [item.title, item.text, item.meta].some((part) => !!part && part.toLocaleLowerCase().includes(words));
}
