import { Component, type RefObject } from "react";

/** A larger dialog closes at once: copying and laying it out again would hold
    up the close (a History original is one text node of any length). */
const MAX_ELEMENTS = 3000;
const MAX_CHARACTERS = 100_000;
/** The copy is gone by then even if its animationend never comes. */
const FALLBACK_MS = 400;
/** Without these the copy is no dialog, form control, label or tab stop that
    code finding the open dialog (App.tsx, useAutoRead.ts, ConversationSearch.tsx)
    or a radio group could count, and carries no mark of Radix's aria-hidden on
    the page (its overlay has one), which that release would never remove. */
const STRIPPED = ["id", "name", "for", "form", "role", "aria-modal", "aria-labelledby", "aria-describedby", "aria-controls", "autofocus", "tabindex", "data-aria-hidden"];
/** Copied as an empty box of the same size: a copy would load or play again. */
const MEDIA = "iframe, video, audio, object, embed, canvas";

type Parts = readonly RefObject<HTMLElement | null>[];
type Ghost = { layer: HTMLElement; scrolls: [HTMLElement, number, number][] };

/**
 * A dialog's visible exit (T-19 M1). Radix still unmounts the dialog in the
 * commit that closes it, so focus goes back, the rest of the page loses
 * Radix's aria-hidden and the scroll lock ends, all at once. What fades out is
 * a copy of its overlay and box: aria-hidden, inert and clicked through, in a
 * layer of its own in <body>, removed when its animation ends.
 *
 * A class for getSnapshotBeforeUpdate: the copy is taken before the commit
 * changes the dialog. componentWillUnmount takes it for a dialog mounted as
 * `{open && …}`, removed while open. Put it first in the dialog's Root, with
 * the Root's `open`: React unmounts children in order, so this runs before
 * the dialog's nodes are removed. `confirm` (Modal's) is read as it was just
 * before the close: such a copy only fades.
 */
export class DialogExitGhost extends Component<{ open: boolean; confirm?: boolean; parts: Parts }> {
  getSnapshotBeforeUpdate(previous: Readonly<{ open: boolean; confirm?: boolean }>): Ghost | null {
    return previous.open && !this.props.open ? capture(this.props.parts, !!previous.confirm) : null;
  }
  componentDidUpdate(_props: unknown, _state: unknown, ghost?: Ghost | null) {
    if (ghost) play(ghost);
  }
  componentWillUnmount() {
    if (!this.props.open) return;
    const ghost = capture(this.props.parts, !!this.props.confirm);
    if (ghost) play(ghost);
  }
  render() {
    return null;
  }
}

function capture(parts: Parts, confirm: boolean): Ghost | null {
  // Without the Web Animations API (jsdom) nothing would play; with reduced
  // motion the dialog simply goes.
  if (typeof Element.prototype.animate !== "function") return null;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const nodes = parts.map((part) => part.current).filter((node): node is HTMLElement => !!node?.isConnected);
  if (!nodes.length) return null;
  if (nodes.reduce((count, node) => count + 1 + node.getElementsByTagName("*").length, 0) > MAX_ELEMENTS) return null;
  if (!withinCharacters(nodes)) return null;
  const layer = document.createElement("div");
  layer.className = "dialog-exit-ghost";
  layer.setAttribute("aria-hidden", "true");
  layer.setAttribute("inert", "");
  if (confirm) layer.dataset.confirm = "";
  const scrolls: Ghost["scrolls"] = [];
  for (const node of nodes) {
    const copy = node.cloneNode(true) as HTMLElement;
    const from = [node, ...node.querySelectorAll<HTMLElement>("*")];
    const to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
    from.forEach((original, i) => {
      const element = to[i];
      for (const name of STRIPPED) element.removeAttribute(name);
      if (original.scrollTop || original.scrollLeft) scrolls.push([element, original.scrollTop, original.scrollLeft]);
      if (original instanceof HTMLInputElement && element instanceof HTMLInputElement && original.type !== "file") {
        element.value = original.value;
        element.checked = original.checked;
      } else if (original instanceof HTMLTextAreaElement && element instanceof HTMLTextAreaElement) {
        element.value = original.value;
      } else if (original instanceof HTMLSelectElement && element instanceof HTMLSelectElement) {
        element.selectedIndex = original.selectedIndex;
      }
    });
    for (const [i, original] of from.entries()) {
      if (!original.matches(MEDIA)) continue;
      const { width, height } = original.getBoundingClientRect();
      const box = document.createElement("div");
      box.className = original.className;
      box.style.cssText = `display: block; width: ${width}px; height: ${height}px`;
      to[i].replaceWith(box);
    }
    layer.append(copy);
  }
  return { layer, scrolls };
}

function withinCharacters(nodes: HTMLElement[]) {
  let characters = 0;
  for (const node of nodes) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if ((characters += (walker.currentNode as Text).length) > MAX_CHARACTERS) return false;
  }
  return true;
}

function play({ layer, scrolls }: Ghost) {
  document.body.append(layer);
  for (const [element, top, left] of scrolls) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
  const remove = () => {
    clearTimeout(timer);
    layer.remove();
  };
  const timer = setTimeout(remove, FALLBACK_MS);
  layer.addEventListener("animationend", (event) => {
    if (event.target instanceof Element && event.target.parentElement === layer) remove();
  });
}
