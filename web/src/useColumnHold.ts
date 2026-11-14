import { useEffect, type RefObject } from "react";

/** What a reader's place is held by: a block of text, or a message. */
const BLOCKS = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table, summary, .turn-divider, [data-item-id]";

/**
 * Holds what is being read when the conversation's column changes width while
 * its pane does not (YN-114). On a wide pane the Jobs, CI and sub-agent dock
 * coming or going moves the column's left edge by 116px (work-dock.css: 156px
 * from 760px wide, against the turn dock's 67px), so the column narrows or
 * widens by twice that, the text rewraps and what is above the reader grows or
 * shrinks. The rows correct only rows entirely above the view, and the reading
 * anchor only its own commits (ConversationWindow), so a long reply across the
 * top of the view moved what was being read by its whole growth: 486px at
 * 1440px wide, 729px at 1100px.
 *
 * The block a quarter down the pane is noted as the reader scrolls and as the
 * conversation changes size. When the column alone changes width, that block
 * is put back where it was, in the same frame and for a few frames after, as
 * rows measured after the change move it again (as a phone's fold is held,
 * App.tsx). A pane that changes width itself (a window resized, a phone
 * folded) is left as it was; so is a conversation following its end, which
 * followGrowth keeps in view.
 */
export function useColumnHold(pane: HTMLDivElement | null, follow: RefObject<boolean>) {
  useEffect(() => {
    const column = pane?.querySelector<HTMLElement>(":scope > .conversation-inner");
    if (!pane || !column || typeof ResizeObserver === "undefined") return;
    let held: { block: Element; top: number } | null = null;
    let width = column.getBoundingClientRect().width;
    let paneWidth = pane.clientWidth;
    let frame = 0, holding = 0, noting = 0;
    const line = () => {
      const box = pane.getBoundingClientRect();
      return { box, y: box.top + box.height / 4 };
    };
    const note = () => {
      noting = 0;
      if (holding) return;
      const { box, y } = line();
      const across = column.getBoundingClientRect();
      // What is at that line; between blocks, the first block below it.
      const hit = (document.elementsFromPoint?.(across.left + across.width / 2, y) ?? [])
        .find((el) => el !== column && column.contains(el))?.closest(BLOCKS);
      let block: Element | null = hit && column.contains(hit) ? hit : null;
      if (!block)
        for (const el of column.querySelectorAll(BLOCKS)) {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.bottom > y) { block = el; break; }
        }
      held = block ? { block, top: block.getBoundingClientRect().top - box.top } : null;
    };
    const hold = () => {
      if (!held?.block.isConnected || follow.current) return;
      const drift = held.block.getBoundingClientRect().top - pane.getBoundingClientRect().top - held.top;
      if (Math.abs(drift) > 0.5) pane.scrollTop += drift;
    };
    const settle = () => {
      hold();
      if (--holding > 0) frame = requestAnimationFrame(settle);
      else note();
    };
    const observer = new ResizeObserver(() => {
      const nextWidth = column.getBoundingClientRect().width, nextPane = pane.clientWidth;
      const columnAlone = Math.abs(nextWidth - width) >= 1 && Math.abs(nextPane - paneWidth) < 1;
      width = nextWidth;
      paneWidth = nextPane;
      if (columnAlone && held && !follow.current) {
        cancelAnimationFrame(frame);
        hold();
        holding = 6;
        frame = requestAnimationFrame(settle);
      } else if (!holding && !noting) noting = requestAnimationFrame(note);
    });
    const scrolled = () => { if (!holding && !noting) noting = requestAnimationFrame(note); };
    observer.observe(column);
    observer.observe(pane);
    pane.addEventListener("scroll", scrolled, { passive: true });
    note();
    return () => {
      observer.disconnect();
      pane.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(noting);
    };
  }, [pane, follow]);
}
