import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export const AUTO_READ_DWELL_MS = 1_200;
const BOTTOM_TOLERANCE_PX = 8;

export interface AutoReadOptions {
  agentId: string | null;
  /** Watermark of the detail that has actually rendered, never the rail snapshot. */
  throughSeq: number;
  reviewedSeq: number;
  unreadCount: number;
  enabled: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  /** A small, visible-in-layout sentinel after the latest conversation content. */
  endRef: RefObject<HTMLElement | null>;
  onRead: (agentId: string, throughSeq: number) => Promise<void>;
}

interface ReadProgress {
  acknowledged: number;
  inFlight: boolean;
  failed: boolean;
  failedUnreadCount: number;
}

/** Auto-read changes only the read cursor. Approval/question responses are separate. */
export function useAutoRead(options: AutoReadOptions) {
  const latest = useRef(options);
  latest.current = options;
  const progress = useRef(new Map<string, ReadProgress>());
  const check = useRef<(() => void) | null>(null);
  const [readingAgent, setReadingAgent] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    agentId: string;
    message: string;
  } | null>(null);

  const { agentId, enabled, scrollRef, endRef } = options;
  useEffect(() => {
    if (!agentId || !enabled) {
      setReadingAgent(null);
      return;
    }
    const scrollElement = scrollRef.current;
    const endElement = endRef.current;
    const ownerDocument = scrollElement?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!scrollElement || !endElement || !ownerDocument || !ownerWindow) return;
    const scroll = scrollElement;
    const end = endElement;
    const doc = ownerDocument;
    const view = ownerWindow;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: { throughSeq: number; unreadCount: number } | null = null;
    let record = progress.current.get(agentId);
    if (!record) {
      record = {
        acknowledged: 0,
        inFlight: false,
        failed: false,
        failedUnreadCount: 0,
      };
      progress.current.set(agentId, record);
    }
    const state = record;

    function cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      target = null;
      if (active) setReadingAgent((id) => (id === agentId ? null : id));
    }

    function visibleAtEnd() {
      const current = latest.current;
      if (
        !active ||
        !current.enabled ||
        current.agentId !== agentId ||
        current.scrollRef.current !== scroll ||
        current.endRef.current !== end ||
        !scroll.isConnected ||
        !end.isConnected ||
        doc.visibilityState !== "visible" ||
        !doc.hasFocus()
      )
        return false;
      if (
        scroll.clientHeight <= 0 ||
        scroll.clientWidth <= 0 ||
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >
          BOTTOM_TOLERANCE_PX
      )
        return false;
      const container = scroll.getBoundingClientRect();
      const tail = end.getBoundingClientRect();
      if (
        container.width <= 0 ||
        container.height <= 0 ||
        tail.width <= 0 ||
        tail.height <= 0
      )
        return false;
      const top = Math.max(0, container.top + scroll.clientTop);
      const left = Math.max(0, container.left + scroll.clientLeft);
      const bottom = Math.min(
        view.innerHeight,
        container.top + scroll.clientTop + scroll.clientHeight,
      );
      const right = Math.min(
        view.innerWidth,
        container.left + scroll.clientLeft + scroll.clientWidth,
      );
      const inView =
        tail.top >= top - 1 &&
        tail.bottom <= bottom + 1 &&
        tail.left >= left - 1 &&
        tail.right <= right + 1;
      if (!inView) return false;
      // A document-wide selector scales with loaded history. Only inspect
      // overlays when this view could actually acknowledge unread content.
      for (const overlay of doc.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]',
      )) {
        const style = view.getComputedStyle(overlay);
        if (
          !overlay.hidden &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          overlay.getClientRects().length > 0
        )
          return false;
      }
      return true;
    }

    function eligible() {
      const current = latest.current;
      return (
        current.unreadCount > 0 &&
        Number.isSafeInteger(current.throughSeq) &&
        current.throughSeq > 0 &&
        current.throughSeq > current.reviewedSeq &&
        !state.inFlight &&
        // Wait for the server's read cursor to appear in rendered detail before
        // handling later updates. Stale detail cannot cause a review request loop.
        (state.acknowledged === 0 ||
          current.reviewedSeq >= state.acknowledged) &&
        current.throughSeq > state.acknowledged
      );
    }

    function evaluate() {
      const current = latest.current;
      if (state.failed && current.unreadCount !== state.failedUnreadCount)
        state.failed = false;
      if (!eligible() || state.failed || !visibleAtEnd()) {
        cancel();
        return;
      }
      if (
        target &&
        (target.unreadCount !== current.unreadCount ||
          target.throughSeq > current.throughSeq)
      )
        cancel();
      if (timer !== undefined) return;
      // Keep this earlier, rendered watermark when tool-stream events advance
      // lastSeq. Extending it at the deadline would mark unseen updates as read;
      // restarting on every token would make reading an active agent impossible.
      target = {
        throughSeq: current.throughSeq,
        unreadCount: current.unreadCount,
      };
      const captured = target;
      setReadingAgent(agentId);
      timer = setTimeout(() => {
        timer = undefined;
        target = null;
        setReadingAgent((id) => (id === agentId ? null : id));
        if (
          !eligible() ||
          latest.current.unreadCount !== captured.unreadCount ||
          latest.current.throughSeq < captured.throughSeq ||
          !visibleAtEnd()
        ) {
          evaluate();
          return;
        }
        state.inFlight = true;
        void Promise.resolve()
          .then(() => latest.current.onRead(agentId!, captured.throughSeq))
          .then(
            () => {
              state.inFlight = false;
              state.acknowledged = Math.max(
                state.acknowledged,
                captured.throughSeq,
              );
              state.failed = false;
              if (active) {
                setFailure((previous) =>
                  previous?.agentId === agentId ? null : previous,
                );
                evaluate();
              } else if (latest.current.agentId === agentId) {
                check.current?.();
              }
            },
            (error: unknown) => {
              state.inFlight = false;
              state.failed = true;
              state.failedUnreadCount =
                latest.current.agentId === agentId
                  ? latest.current.unreadCount
                  : captured.unreadCount;
              if (active) {
                setFailure({
                  agentId: agentId!,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
                cancel();
              }
            },
          );
      }, AUTO_READ_DWELL_MS);
    }

    function retryAfterInteraction() {
      state.failed = false;
      evaluate();
    }
    const blur = () => cancel();
    check.current = evaluate;
    scroll.addEventListener("scroll", evaluate, { passive: true });
    scroll.addEventListener("wheel", retryAfterInteraction, { passive: true });
    scroll.addEventListener("pointerdown", retryAfterInteraction, {
      passive: true,
    });
    scroll.addEventListener("keydown", retryAfterInteraction);
    view.addEventListener("focus", retryAfterInteraction);
    view.addEventListener("blur", blur);
    view.addEventListener("resize", evaluate);
    doc.addEventListener("visibilitychange", retryAfterInteraction);
    const intersection =
      typeof view.IntersectionObserver === "function"
        ? new view.IntersectionObserver(evaluate, {
            root: scroll,
            threshold: 1,
          })
        : null;
    intersection?.observe(end);
    const resize =
      typeof view.ResizeObserver === "function"
        ? new view.ResizeObserver(evaluate)
        : null;
    resize?.observe(scroll);
    resize?.observe(end);
    if (end.parentElement) resize?.observe(end.parentElement);
    const mutation = new view.MutationObserver(evaluate);
    mutation.observe(doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "role",
        "aria-modal",
        "hidden",
        "style",
        "class",
        "data-state",
      ],
    });
    evaluate();
    return () => {
      active = false;
      cancel();
      if (check.current === evaluate) check.current = null;
      scroll.removeEventListener("scroll", evaluate);
      scroll.removeEventListener("wheel", retryAfterInteraction);
      scroll.removeEventListener("pointerdown", retryAfterInteraction);
      scroll.removeEventListener("keydown", retryAfterInteraction);
      view.removeEventListener("focus", retryAfterInteraction);
      view.removeEventListener("blur", blur);
      view.removeEventListener("resize", evaluate);
      doc.removeEventListener("visibilitychange", retryAfterInteraction);
      intersection?.disconnect();
      resize?.disconnect();
      mutation.disconnect();
    };
  }, [agentId, enabled, scrollRef, endRef]);

  useEffect(() => {
    check.current?.();
  }, [options.throughSeq, options.reviewedSeq, options.unreadCount]);

  return {
    isReading: readingAgent === agentId && readingAgent !== null && enabled,
    error: failure?.agentId === agentId ? failure.message : null,
  };
}
