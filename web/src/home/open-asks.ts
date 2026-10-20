import { useCallback, useEffect, useState } from "react";
import { readHome } from "./home-api";
import type { NeedsYouItem } from "./types";

/** Home's own reads cover a deferred Ask coming back; away from Home this does. */
const AWAY_SAFETY_NET_MS = 60_000;

/**
 * The open Asks in Needs you, for the Home tab's count. Approvals are counted
 * from the Agent list, which is live; Asks are read from Home's data: Home
 * reports each of its reads, and while Home is closed this reads it again
 * when a Brief changes (revision) and once a minute.
 */
export function useOpenAsks(workspaceId: string, away: boolean, revision: number) {
  const [read, setRead] = useState<{ workspaceId: string; count: number } | null>(null);
  const [tick, setTick] = useState(0);
  const report = useCallback(
    (items: NeedsYouItem[]) =>
      setRead({ workspaceId, count: items.filter((item) => item.kind === "ask").length }),
    [workspaceId],
  );
  useEffect(() => {
    if (!away || !workspaceId) return;
    const controller = new AbortController();
    readHome(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && Array.isArray(value?.needsYou)) report(value.needsYou);
      })
      // The last count stays; Home itself says when it cannot be read.
      .catch(() => {});
    return () => controller.abort();
  }, [away, workspaceId, revision, tick, report]);
  useEffect(() => {
    if (!away) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") setTick((n) => n + 1);
    }, AWAY_SAFETY_NET_MS);
    return () => clearInterval(timer);
  }, [away]);
  return [read?.workspaceId === workspaceId ? read.count : 0, report] as const;
}
