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
  revealWords([root], 0, segments, now);
}

/**
 * `revealSegments` over some nodes only, their text being the root's from
 * `offset` on: the nodes a reply drew anew, where words drawn before keep the
 * spans they have (ProseBlocks, YN-234). Returns the spans it made, each with
 * the time its segment's fade is over.
 */
export function revealWords(
  nodes: readonly Node[],
  offset: number,
  segments: Segment[],
  now: number,
): { span: HTMLElement; until: number }[] {
  if (!segments.length || !nodes.length) return [];
  const from = Math.max(offset, Math.min(...segments.map((s) => s.start)));
  const doc = nodes[0].ownerDocument!;
  const pending: { node: Text; start: number }[] = [];
  let at = offset;
  const visit = (node: Node) => {
    const length = node.nodeValue?.length ?? 0;
    if (at + length > from) pending.push({ node: node as Text, start: at });
    at += length;
  };
  for (const top of nodes) {
    if (top.nodeType === 3 /* Node.TEXT_NODE */) {
      visit(top);
      continue;
    }
    if (top.nodeType !== 1 /* Node.ELEMENT_NODE */) continue;
    const walker = doc.createTreeWalker(top, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) visit(node);
  }
  const made: { span: HTMLElement; until: number }[] = [];
  for (const entry of pending) {
    let { node, start } = entry;
    const skip = Math.max(0, from - start);
    const words = [...(node.nodeValue ?? "").slice(skip).matchAll(/\s+|\S+\s*/g)].map((match) => {
      const at = start + skip + (match.index ?? 0);
      return { text: match[0], at, segment: match[0].trim() ? segments.find((s) => at >= s.start && at < s.end) : undefined };
    });
    // A node with no word to fade is left as it is (a block's nodes stay its own).
    if (!words.some((word) => word.segment)) continue;
    if (skip) {
      node = node.splitText(skip);
      start += skip;
    }
    const pieces = doc.createDocumentFragment();
    for (const { text, at, segment } of words) {
      if (!segment) {
        pieces.append(text);
        continue;
      }
      const word = doc.createElement("span");
      word.className = "stream-word";
      const step = SPREAD / Math.max(1, segment.end - segment.start);
      word.style.animationDelay = `${Math.round(segment.at + (at - segment.start) * step - now)}ms`;
      word.textContent = text;
      pieces.append(word);
      made.push({ span: word, until: segment.at + SPREAD + FADE });
    }
    node.replaceWith(pieces);
  }
  return made;
}

/** Whether the reader asked for less motion: nothing fades in then. */
export const reducedMotion = () =>
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
    if (!previous || !text.startsWith(previous.text) || reducedMotion()) {
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
