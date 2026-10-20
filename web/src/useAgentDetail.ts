import { useCallback, useEffect, useRef, useState } from "react";
import { DetailSync } from "./detail-sync.ts";
import { HttpError } from "./api";
import { readSnapshot } from "./snapshot-request";
import type { AgentDetail } from "./types";

/** The shown Agent's detail, read once and then kept current from the event
 * stream (see DetailSync). `sync` takes streamed changes and refetches. */
export function useAgentDetail(agentId: string | null) {
  const windowQuery = useRef<Record<string, string>>({});
  const windowGeneration = useRef(0);
  const [windowLoading, setWindowLoading] = useState(false);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sync] = useState(
    () =>
      new DetailSync({
        fetch: async (id, signal) => {
          const query = windowQuery.current;
          const path = `/agents/${encodeURIComponent(id)}`;
          const headers = {"X-Yuzuno-Conversation":"window"};
          try {
            return await readSnapshot<AgentDetail>(`${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`, signal, headers);
          } catch (error) {
            // Rewind can remove the pinned body window, including when another
            // client performs it. Discard that stale anchor and read the tail.
            if (signal.aborted || windowQuery.current !== query || !Object.keys(query).length ||
              !(error instanceof HttpError) || error.status !== 404 ||
              !["turn_not_found", "item_not_found"].includes(error.code || "")) throw error;
            windowQuery.current = {};
            return readSnapshot<AgentDetail>(path, signal, headers);
          }
        },
        publish: setDetail,
        error: setError,
      }),
  );
  useEffect(() => {
    windowQuery.current = {};
    windowGeneration.current++;
    setWindowLoading(false);
    sync.select(agentId);
  }, [sync, agentId]);
  useEffect(() => () => sync.dispose(), [sync]);
  const navigate = useCallback(async (query: Record<string, string> = {}, retry = false) => {
    if (!retry && JSON.stringify(query) === JSON.stringify(windowQuery.current)) return;
    windowQuery.current = query;
    const generation = ++windowGeneration.current;
    setWindowLoading(true);
    await sync.reloadWindow();
    if (generation === windowGeneration.current) setWindowLoading(false);
  }, [sync]);
  const pinWindow = useCallback(() => {
    // Reading within the current tail is still history reading. Future
    // refetches must start at these stable IDs rather than evict that body
    // when new messages push the latest window forward.
    const cursor = sync.current?.conversation?.start;
    if (!cursor || Object.keys(windowQuery.current).length) return;
    const [turnId, itemId] = JSON.parse(cursor) as [string, string | null];
    const query = { turnId, ...(itemId ? { itemId } : {}) };
    if (sync.running) void navigate(query);
    else windowQuery.current = query;
  }, [sync, navigate]);
  return { detail, error, clearError: () => setError(null), sync, navigate, pinWindow, windowLoading };
}
