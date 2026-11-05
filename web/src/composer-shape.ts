import { useLayoutEffect, useRef, useState } from "react";

/**
 * The composer's two shapes (T-44), as in the ChatGPT app: `line` puts "+",
 * the text and the controls on one row; `block` puts the text on top at the
 * full width and the tools on a row below it. Both are one DOM, so the editor
 * keeps its focus, caret and scroll across a switch.
 */
export type ComposerShape = "line" | "block";

/** The editor's first line as laid out: the draft, or its placeholder when empty. */
export type LineExtent = {
  /** Lines in the draft; more than one is always a block. */
  lines: number;
  width: number;
  height: number;
  lineHeight: number;
};

/** How much narrower than the line shape's room a block's text must be to go
    back to one line, so a draft at the edge switches once each way. */
export const LINE_RETURN_MARGIN = 8;

/**
 * The shape for what the editor shows now. A line becomes a block as soon as
 * its text wraps; a block becomes a line only when its text, measured at the
 * full width, is narrower than the line's room by the margin.
 */
export function nextShape(current: ComposerShape, forced: boolean, line: LineExtent | null, room: number): ComposerShape {
  if (forced || !line || line.lines > 1 || !(room > 0)) return "block";
  const wraps = line.height > line.lineHeight * 1.5;
  if (current === "line") return wraps ? "block" : "line";
  return !wraps && line.width < room - LINE_RETURN_MARGIN ? "line" : "block";
}

const px = (style: CSSStyleDeclaration, name: string) => parseFloat(style.getPropertyValue(name)) || 0;

/**
 * The text's width in the line shape, worked out in either shape: the box
 * less "+" and the controls (the same size in both shapes), their insets and
 * the text's own padding, as styles.css lays the line out.
 */
export function lineRoom(box: HTMLElement): number {
  const tools = box.querySelector(".composer-tools");
  const send = box.querySelector(".composer-send-actions");
  if (!tools || !send || !box.clientWidth) return 0;
  const style = getComputedStyle(box);
  return box.clientWidth
    - tools.getBoundingClientRect().width
    - send.getBoundingClientRect().width
    - px(style, "--composer-inset-start")
    - px(style, "--composer-inset-end")
    - 2 * px(style, "--composer-line-text-x");
}

let measuring: CanvasRenderingContext2D | null | undefined;
/** The width `text` takes in the editor's font, or null where nothing can measure it. */
function textWidth(box: HTMLElement, text: string): number | null {
  const content = box.querySelector(".cm-content");
  measuring ??= document.createElement("canvas").getContext?.("2d") ?? null;
  if (!content || typeof measuring?.measureText !== "function") return null;
  const style = getComputedStyle(content);
  measuring.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return measuring.measureText(text).width;
}

/**
 * The composer's shape, decided before the box is painted: on every change to
 * what it shows (`deps`), and when the box is resized. `forced` holds it a
 * block: something under the text (images, skills, an error, a notice).
 * `placeholder` gives the long placeholder and its short form; `short` says
 * whether the long one is too wide for the line's room (a phone's, or with
 * Interrupt), so the short form shows instead.
 */
export function useComposerShape(
  box: HTMLElement | null,
  measure: () => LineExtent | null,
  forced: boolean,
  deps: readonly unknown[],
  placeholder?: string,
): { shape: ComposerShape; short: boolean } {
  const [shape, setShape] = useState<ComposerShape>("block");
  const [short, setShort] = useState(false);
  const current = useRef(shape);
  current.current = shape;
  // A line that wrapped for exactly this content and width stays a block,
  // even if the arithmetic above says it would fit: it never flaps.
  const wrapped = useRef<{ deps: readonly unknown[]; width: number } | null>(null);
  const evaluate = useRef(() => {});
  evaluate.current = () => {
    if (!box) return;
    const room = lineRoom(box);
    // Only a laid-out box is measured (not jsdom's, which has no room).
    const long = placeholder && room > 0 ? textWidth(box, placeholder) : null;
    const tooWide = long !== null && room > 0 && !(long < room - LINE_RETURN_MARGIN);
    if (tooWide !== short) setShort(tooWide);
    const line = measure();
    let next = nextShape(current.current, forced, line, room);
    const same = (held: typeof wrapped.current) =>
      !!held && held.width === box.clientWidth && held.deps.length === deps.length && held.deps.every((d, i) => Object.is(d, deps[i]));
    if (current.current === "line" && next === "block" && !forced) wrapped.current = { deps, width: box.clientWidth };
    else if (next === "line" && same(wrapped.current)) next = "block";
    if (next !== current.current) {
      current.current = next;
      setShape(next);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => evaluate.current(), [box, forced, shape, short, placeholder, ...deps]);
  useLayoutEffect(() => {
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => evaluate.current());
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  return { shape, short };
}
