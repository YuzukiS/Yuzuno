import { useCallback, useEffect, useRef, useState } from "react";
import { readHome } from "./home-api";
import type { NeedsYouItem } from "./types";

/** Home's own reads cover a deferred Ask coming back; away from Home this does. */
const AWAY_SAFETY_NET_MS = 60_000;

/**
 * The open Asks and executors the user dispatched (T-36 S3) in Needs you,
 * for the Home tab's count, so that it counts what Needs you lists (YN-3).
 * Approvals and questions are counted from the Agent list, which is live;
 * the rest are read from Home's data: Home
 * reports each of its reads, and while Home is closed this reads it again
 * when a Brief changes (revision) and once a minute. The items read are
 * returned too, for system notifications (T-188).
 */
export function useOpenAsks(workspaceId: string, away: boolean, revision: number) {
  const [read, setRead] = useState<{ workspaceId: string; items: NeedsYouItem[] } | null>(null);
  const [tick, setTick] = useState(0);
  const report = useCallback(
    (items: NeedsYouItem[]) =>
      setRead({ workspaceId, items }),
    [workspaceId],
  );
  // One read at a time, as Home's (YN-221): a change while one is on its way
  // asks for one more after it; only coming back to Home, or another
  // Workspace, drops it.
  const reading = useRef<{ controller: AbortController | null; again: boolean }>({ controller: null, again: false });
  useEffect(() => {
    if (!away || !workspaceId) return;
    const state = reading.current;
    if (state.controller) {
      state.again = true;
      return;
    }
    const read = () => {
      const controller = new AbortController();
      state.controller = controller;
      state.again = false;
      readHome(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted && Array.isArray(value?.needsYou)) report(value.needsYou);
        })
        // The last count stays; Home itself says when it cannot be read.
        .catch(() => {})
        .finally(() => {
          if (state.controller !== controller) return;
          state.controller = null;
          if (state.again) read();
        });
    };
    read();
  }, [away, workspaceId, revision, tick, report]);
  useEffect(() => () => {
    const state = reading.current;
    state.controller?.abort();
    state.controller = null;
    state.again = false;
  }, [away, workspaceId]);
  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") setTick((n) => n + 1);
    }, AWAY_SAFETY_NET_MS);
    return () => clearInterval(timer);
  }, [away]);
  const items = read?.workspaceId === workspaceId ? read.items : null;
  // Neither is in an Agent's pendingCount, so neither is counted twice.
  return [items ? items.filter((item) => item.kind === "ask" || item.kind === "executor").length : 0, report, items] as const;
}
