// Motion for tool activity while an Agent works: a block unfolds as it
// arrives, new rows unfold inside it, and counts, statuses and the heading
// settle in when they change. Opening and closing are CSS transitions
// (tool-activity.css). Only what changes live moves: a conversation that
// loads, or rows that land in a closed block, are shown as they are.
import { useLayoutEffect, useRef, type RefObject } from "react";

export const UNFOLD = { duration: 300, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const SETTLE = { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const RISE: Keyframe[] = [
  { opacity: 0, translate: "0 0.45em" },
  { opacity: 1, translate: "0 0" },
];

const still = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const play = (el: Element | null | undefined, keyframes: Keyframe[], id: string) => {
  if (!el || typeof el.animate !== "function") return;
  el.animate(keyframes, { ...SETTLE, id });
};

/** The height an arriving box grows to: where the browser can, its live
 * natural height, so a row landing mid-unfold is not clipped and then
 * snapped in. */
const naturalHeight = (el: HTMLElement) =>
  typeof CSS !== "undefined" && CSS.supports?.("height", "calc-size(auto, size)")
    ? "calc-size(auto, size)"
    : `${el.offsetHeight}px`;

/** Grows `el` from nothing into its place, fading in as it settles. The
 * space it takes opens smoothly, so what follows glides down rather than
 * jumping. */
export function unfold(el: HTMLElement) {
  if (typeof el.animate !== "function") return;
  const style = getComputedStyle(el);
  const box = (side: "Top" | "Bottom") => ({
    [`padding${side}`]: style[`padding${side}`],
    [`margin${side}`]: style[`margin${side}`],
  });
  el.dataset.unfolding = "";
  const animation = el.animate(
    [
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0, translate: "0 6px" },
      { height: naturalHeight(el), ...box("Top"), ...box("Bottom"), opacity: 1, translate: "0 0" },
    ],
    { ...UNFOLD, id: "tool-unfold" },
  );
  const settled = () => delete el.dataset.unfolding;
  animation.addEventListener?.("finish", settled);
  animation.addEventListener?.("cancel", settled);
}

type Look = {
  label: string;
  counts: Map<string, { chip: Element; number: string }>;
  rows: Map<string, { row: HTMLElement; result: string }>;
};

function look(block: HTMLElement): Look {
  const counts: Look["counts"] = new Map();
  for (const chip of block.querySelectorAll(":scope > summary .tool-overview-part"))
    counts.set(chip.getAttribute("data-count-key") || "", { chip, number: chip.textContent || "" });
  const rows: Look["rows"] = new Map();
  for (const row of block.querySelectorAll<HTMLElement>(":scope > .execution-items > .tool-item, :scope > .execution-items > .conversation-window > .conversation-window-row > .tool-item"))
    rows.set(row.id, {
      row,
      result: row.querySelector(":scope > summary > .tool-result")?.textContent || "",
    });
  return {
    label: block.querySelector(":scope > summary > .tool-activity-label")?.textContent || "",
    counts,
    rows,
  };
}

/** Moves a tool activity block (`details.execution.tool-activity`) as it
 * changes. `live`: the block arrived after its turn was first drawn, so it
 * unfolds into place. `signature` changes whenever its rows or state do. */
export function useToolMotion(
  block: RefObject<HTMLElement | null>,
  live: boolean,
  signature: string,
  rowsMounted = true,
  itemIds?: readonly string[],
) {
  const arrivedLive = useRef(live);
  const seen = useRef<Look | null>(null);
  const previouslyMounted = useRef(rowsMounted);
  const previousItems = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const known = previousItems.current;
    previousItems.current = itemIds ? new Set(itemIds) : null;
    const mountingRows = rowsMounted && !previouslyMounted.current;
    previouslyMounted.current = rowsMounted;
    const el = block.current;
    if (!el) return;
    const now = look(el);
    const before = seen.current;
    seen.current = now;
    if (still()) return;
    if (!before) {
      if (arrivedLive.current) unfold(el);
      return;
    }
    if (now.label !== before.label)
      play(el.querySelector(".tool-activity-label"), [{ opacity: 0 }, { opacity: 1 }], "tool-label");
    for (const [key, { chip, number }] of now.counts) {
      const was = before.counts.get(key);
      if (!was)
        play(chip, [{ opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1 }], "tool-count-in");
      else if (was.number !== number)
        play(chip, RISE, "tool-count-tick");
    }
    // Rows that land in a closed block stay out of sight until it opens.
    // First inspection exposes existing rows; record them without presenting
    // them as newly arriving tool calls on this or the next live update.
    if (!(el as HTMLDetailsElement).open || mountingRows) return;
    for (const [id, { row, result }] of now.rows) {
      const was = before.rows.get(id);
      if (!was && (!known || !known.has(id))) unfold(row);
      else if (was && was.result !== result)
        play(row.querySelector(":scope > summary > .tool-result"), RISE, "tool-result");
    }
  }, [signature, rowsMounted]);
}
