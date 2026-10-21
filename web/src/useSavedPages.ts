import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "./api";
import { readSnapshot } from "./snapshot-request";
import { join, SAVED_WINDOWS } from "./saved-pages.ts";
import type { AgentDetail } from "./types";

interface Earlier {
  agentId: string;
  /** Where the live window started when these were read; they are shown only
   * while it still starts there. */
  liveStart: string;
  /** Oldest first, each ending at the Item the next one starts with. */
  pages: AgentDetail[];
}

/**
 * "Load earlier messages" reads the saved window before the shown one and
 * puts it in front, instead of replacing what is being read (T-161). As
 * Matrix's TimelineWindow and Zulip's message list do, the loaded range
 * grows; a bound is kept by dropping the far end only beyond SAVED_WINDOWS.
 *
 * The live window stays the newest one and keeps receiving changes; earlier
 * windows hold finished history. They apply only while the live window
 * starts where it did when they were read (it is pinned while reading
 * history), and are dropped when it moves: back to latest, a jump, a rewind
 * or another Agent.
 */
export function useSavedPages(detail: AgentDetail | null, selected: string) {
  const [earlier, setEarlier] = useState<Earlier | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const drop = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setEarlier(null);
    setLoading(false);
    setError("");
  }, []);
  useEffect(() => drop, [selected, drop]);
  const live = detail?.agent.id === selected ? detail : null;
  const liveStart = live?.conversation?.start ?? null;
  const shown =
    earlier && earlier.agentId === selected && liveStart !== null && earlier.liveStart === liveStart
      ? earlier
      : null;
  useEffect(() => {
    if (earlier && !shown) setEarlier(null);
  }, [earlier, shown]);
  const merged = useMemo(() => {
    if (!live?.conversation || !shown) return detail;
    const first = shown.pages[0].conversation;
    return {
      ...live,
      turns: join([...shown.pages, live]),
      conversation: { ...live.conversation, start: first?.start ?? null, hasBefore: !!first?.hasBefore },
    };
  }, [detail, live, shown]);
  const pages = shown?.pages.length ?? 0;

  /** Reads the window that ends at `cursor` (the first Item shown) and puts
   * it in front. False when the bound is reached: the caller pages instead. */
  const loadEarlier = useCallback(
    (cursor: string) => {
      if (!live?.conversation || liveStart === null || request.current) return true;
      if (pages + 1 >= SAVED_WINDOWS) return false;
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError("");
      const kept = shown?.pages ?? [];
      void readSnapshot<AgentDetail>(
        `/agents/${encodeURIComponent(selected)}?${new URLSearchParams({ before: cursor })}`,
        controller.signal,
        { "X-Yuzuno-Conversation": "window" },
      )
        .then((page) => {
          if (!controller.signal.aborted) setEarlier({ agentId: selected, liveStart, pages: [page, ...kept] });
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(errorText(e));
        })
        .finally(() => {
          if (request.current === controller) {
            request.current = null;
            setLoading(false);
          }
        });
      return true;
    },
    [live?.conversation, liveStart, pages, selected, shown],
  );
  return { detail: merged, pages, loading, error, loadEarlier, drop };
}
