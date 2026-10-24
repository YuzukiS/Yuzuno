import { useCallback, useEffect, useState } from "react";
import { readHome } from "./home-api";
import type { NeedsYouItem } from "./types";

/** Home's own reads cover a deferred Ask coming back; away from Home this does. */
const AWAY_SAFETY_NET_MS = 60_000;

/**
 * The open Asks in Needs you, for the Home tab's count. Approvals are counted
 * from the Agent list, which is live; Asks are read from Home's data: Home
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
  const items = read?.workspaceId === workspaceId ? read.items : null;
  return [items ? items.filter((item) => item.kind === "ask").length : 0, report, items] as const;
}
