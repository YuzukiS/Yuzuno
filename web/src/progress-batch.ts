import { useCallback, useEffect, useRef } from "react";

/**
 * How often streamed progress reaches the Agent list at most (YN-199). Core
 * sends each streaming Agent's rail entry at most every 250 ms
 * (`agent.progress`, core/src/events.rs), so a row's progress line shows up
 * at most this much later than it did, plus one frame.
 */
export const PROGRESS_MS = 250;

/**
 * Collect entries, the newest per id, and hand them over together: at most
 * once per `PROGRESS_MS`, on a drawn frame. Applying each `agent.progress`
 * at once re-rendered the whole app for every streaming Agent, several times
 * a second each. While the page is hidden no frame is drawn, so nothing is
 * handed over until it shows again; at most one entry per id waits.
 */
export function useProgressBatch<T extends { id: string }>(apply: (entries: T[]) => void) {
  const waiting = useRef(new Map<string, T>());
  const pending = useRef<{ timeout?: ReturnType<typeof setTimeout>; frame?: number } | null>(null);
  const applyNow = useRef(apply);
  applyNow.current = apply;
  const push = useCallback((entry: T) => {
    waiting.current.set(entry.id, entry);
    if (pending.current) return;
    const due: { timeout?: ReturnType<typeof setTimeout>; frame?: number } = {};
    pending.current = due;
    due.timeout = setTimeout(() => {
      due.frame = requestAnimationFrame(() => {
        pending.current = null;
        const entries = [...waiting.current.values()];
        waiting.current.clear();
        if (entries.length) applyNow.current(entries);
      });
    }, PROGRESS_MS);
  }, []);
  useEffect(
    () => () => {
      const due = pending.current;
      if (due) {
        clearTimeout(due.timeout);
        if (due.frame !== undefined) cancelAnimationFrame(due.frame);
      }
      pending.current = null;
      waiting.current.clear();
    },
    [],
  );
  return push;
}
