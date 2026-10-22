import { useCallback, useEffect, useRef, useState } from "react";
import { DetailSync } from "./detail-sync.ts";
import { HttpError } from "./api";
import { watchBrowserNetwork } from "./browser-offline";
import { readSnapshot } from "./snapshot-request";
import type { AgentDetail } from "./types";

/** The shown Agent's detail, read once and then kept current from the event
 * stream (see DetailSync). `sync` takes streamed changes and refetches. */
export function useAgentDetail(agentId: string | null) {
  const windowQuery = useRef<Record<string, string>>({});
  const windowGeneration = useRef(0);
  const [windowLoading, setWindowLoading] = useState(false);
  // The window query whose Turn or Item Core no longer has (rewind, another
  // native session): reading it again would only fall back to the tail again.
  const missingQuery = useRef<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
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
            missingQuery.current = JSON.stringify(query);
            setMissing(missingQuery.current);
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
    missingQuery.current = null;
    setMissing(null);
    sync.select(agentId);
  }, [sync, agentId]);
  useEffect(() => () => sync.dispose(), [sync]);
  // Back online, a read that failed while away is tried again at once,
  // rather than after the retry delay (T-170).
  useEffect(() => watchBrowserNetwork({ online: () => sync.online() }), [sync]);
  const navigate = useCallback(async (query: Record<string, string> = {}, retry = false) => {
    const key = JSON.stringify(query);
    if (!retry && (key === JSON.stringify(windowQuery.current) || key === missingQuery.current)) return;
    if (missingQuery.current) {
      missingQuery.current = null;
      setMissing(null);
    }
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
  return { detail, error, clearError: () => setError(null), sync, navigate, pinWindow, windowLoading, missing };
}
