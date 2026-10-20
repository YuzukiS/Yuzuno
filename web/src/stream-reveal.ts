import { useLayoutEffect, useRef, type RefObject } from "react";

/** How long a newly streamed word takes to fade in. */
export const FADE = 420;
/** A chunk's words start one after another within this span, so a chunk
 * flows in rather than appearing at once. */
export const SPREAD = 160;

/** Text appended at `at`: characters [start, end) of the rendered text. */
export type Segment = { start: number; end: number; at: number };

/**
 * Wrap the words of still-fading segments in spans whose animation delay
 * says how far into its fade each word already is. Rendered HTML is replaced
 * on every update, so this runs again each time and a word continues its
 * fade instead of restarting it.
 */
export function revealSegments(root: HTMLElement, segments: Segment[], now: number) {
  if (!segments.length) return;
  const from = Math.min(...segments.map((s) => s.start));
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const pending: { node: Text; start: number }[] = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (offset + length > from) pending.push({ node: node as Text, start: offset });
    offset += length;
  }
  for (const entry of pending) {
    let { node, start } = entry;
    if (start < from) {
      node = node.splitText(from - start);
      start = from;
    }
    const text = node.nodeValue ?? "";
    const pieces = doc.createDocumentFragment();
    for (const match of text.matchAll(/\s+|\S+\s*/g)) {
      const at = start + (match.index ?? 0);
      const segment = segments.find((s) => at >= s.start && at < s.end);
      if (!segment || !match[0].trim()) {
        pieces.append(match[0]);
        continue;
      }
      const word = doc.createElement("span");
      word.className = "stream-word";
      const step = SPREAD / Math.max(1, segment.end - segment.start);
      word.style.animationDelay = `${Math.round(segment.at + (at - segment.start) * step - now)}ms`;
      word.textContent = match[0];
      pieces.append(word);
    }
    node.replaceWith(pieces);
  }
}

const still = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Fade in what streams onto the end of `text`, as a reply arrives. Only an
 * append animates: the first render, an edit, or a reload shows text as is.
 */
export function useStreamReveal(root: RefObject<HTMLElement | null>, text: string) {
  const state = useRef<{ text: string; length: number; segments: Segment[] } | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const length = element.textContent?.length ?? 0;
    const previous = state.current;
    const now = performance.now();
    if (!previous || !text.startsWith(previous.text) || still()) {
      state.current = { text, length, segments: [] };
      return;
    }
    const segments = previous.segments.filter(
      (s) => s.end <= length && now < s.at + SPREAD + FADE,
    );
    if (length > previous.length)
      segments.push({ start: previous.length, end: length, at: now });
    state.current = { text, length, segments };
    revealSegments(element, segments, now);
  }, [root, text]);
}
