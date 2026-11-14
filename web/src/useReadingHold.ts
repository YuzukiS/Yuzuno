import { useEffect, type RefObject } from "react";

/** What a reader's place is held by: a block of text, or a message. */
const BLOCKS = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, table, summary, .turn-divider, [data-item-id]";

/**
 * Holds what is being read where it is when the conversation changes under
 * the reader in two ways nothing else holds it for (YN-114). The block a
 * quarter down the pane is noted as the reader scrolls and as the
 * conversation changes size.
 *
 * The column changes width while its pane does not. On a wide pane the Jobs,
 * CI and sub-agent dock coming or going moves the column's left edge by 116px
 * (work-dock.css: 156px from 760px wide, against the turn dock's 67px), so the
 * column narrows or widens by twice that, the text rewraps and what is above
 * the reader grows or shrinks. The rows correct only rows entirely above the
 * view, and the reading anchor only its own commits (ConversationWindow), so
 * a long reply across the top of the view moved what was being read by its
 * whole growth: 486px at 1440px wide, 729px at 1100px. That block is put back
 * where it was, in the same frame and for a few frames after, as rows
 * measured after the change move it again (as a phone's fold is held,
 * App.tsx). A pane that changes width itself (a window resized, a phone
 * folded) is left as it was.
 *
 * What is below the reader folds away near the end (the open tool group of
 * the running Turn closing as the next message arrives, or as the Turn ends):
 * the browser clamps the pane to its new end and what is being read drops by
 * what folded beyond the room below it (41px in follow-intent-check's case).
 * The column is given that much room at its end instead, and the block is put
 * back. The room only ever shrinks: the conversation growing into it, the
 * reader scrolling up from it, or following the end again takes it back, never
 * moving what is in view.
 *
 * Neither while the conversation follows its end, which followGrowth keeps in
 * view.
 */
export function useReadingHold(pane: HTMLDivElement | null, follow: RefObject<boolean>) {
  useEffect(() => {
    const column = pane?.querySelector<HTMLElement>(":scope > .conversation-inner");
    if (!pane || !column || typeof ResizeObserver === "undefined") return;
    let held: { block: Element; top: number } | null = null;
    let width = column.getBoundingClientRect().width;
    let paneWidth = pane.clientWidth;
    let frame = 0, holding = 0, noting = 0;
    // The room at the column's end, on top of its own padding. That padding
    // is read once, while there is no room: taking the room off to read it
    // again laid the column out without it and clamped the pane once more.
    let room = 0, padding = 0;
    const setRoom = (next: number) => {
      next = Math.max(0, next);
      if (Math.abs(next - room) < 0.5 && (next > 0 || room === 0)) return;
      if (!room) padding = parseFloat(getComputedStyle(column).paddingBottom) || 0;
      room = next;
      column.style.paddingBottom = room > 0 ? `${padding + room}px` : "";
    };
    // The room the view needs now: what of it is in view, or nothing while
    // following the end.
    const fitRoom = () => {
      if (!room) return;
      const end = pane.scrollHeight - room;
      setRoom(follow.current ? 0 : Math.min(room, pane.scrollTop + pane.clientHeight - end));
    };
    const line = () => {
      const box = pane.getBoundingClientRect();
      return { box, y: box.top + box.height / 4 };
    };
    const note = () => {
      noting = 0;
      if (holding) return;
      // A commit can clamp the pane in this frame before its scroll is told:
      // the place is taken back before it is noted again.
      clamped();
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
    const drift = () => held?.block.isConnected
      ? held.block.getBoundingClientRect().top - pane.getBoundingClientRect().top - held.top : 0;
    const hold = () => {
      if (!held?.block.isConnected || follow.current) return;
      const by = drift();
      if (Math.abs(by) > 0.5) pane.scrollTop += by;
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
        return;
      }
      if (!clamped()) fitRoom();
      if (!holding && !noting) noting = requestAnimationFrame(note);
    });
    // The pane clamped to its end: what is being read has dropped and the
    // pane is at its end, the reader not following. (A change the reading
    // anchor or the rows corrected left it in place; the reader's own scroll
    // moves it up, or away from the end.) Looked for wherever the place could
    // next be noted: as the conversation changes size, as a scroll, and before
    // noting it. A fold in a commit is clamped as that commit is laid out,
    // which may be in a frame's callbacks, ahead of its scroll event.
    const clamped = () => {
      if (holding || !held || follow.current) return false;
      const dropped = drift();
      if (dropped <= 0.5 || pane.scrollHeight - pane.scrollTop - pane.clientHeight >= 0.5) return false;
      setRoom(room + dropped);
      pane.scrollTop += dropped;
      return true;
    };
    const scrolled = () => {
      if (!clamped()) fitRoom();
      if (!holding && !noting) noting = requestAnimationFrame(note);
    };
    observer.observe(column);
    observer.observe(pane);
    pane.addEventListener("scroll", scrolled, { passive: true });
    note();
    return () => {
      observer.disconnect();
      pane.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(noting);
      setRoom(0);
    };
  }, [pane, follow]);
}
