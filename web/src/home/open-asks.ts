import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError } from "../api";
import { readHomeSnapshot, readNeedsSnapshot } from "./home-api";
import type { NeedsYouItem } from "./types";

/** Needs you alone where Core has it (YN-221 S1). A Core without it answers 404 (its page, not JSON), or anything
 * but Needs you, and Home is read for it instead, for that Workspace from then on. */
async function readNeeds(signal: AbortSignal, older: { workspaceId: string; home: boolean }, workspaceId: string) {
  if (older.workspaceId !== workspaceId) Object.assign(older, { workspaceId, home: false });
  if (!older.home) {
    try {
      const needs = await readNeedsSnapshot(signal);
      if (Array.isArray(needs?.needsYou)) return needs.needsYou;
    } catch (error) {
      const unknown = (error instanceof HttpError && error.status === 404) || error instanceof SyntaxError;
      if (!unknown || signal.aborted) throw error;
    }
    older.home = true;
  }
  return (await readHomeSnapshot(signal)).needsYou;
}

/** Home's own reads cover a deferred Ask coming back; away from Home this does. */
const AWAY_SAFETY_NET_MS = 60_000;

/**
 * The open Asks and executors the user dispatched (T-36 S3) in Needs you,
 * for the Home tab's count, so that it counts what Needs you lists (YN-3).
 * Approvals and questions are counted from the Agent list, which is live;
 * the rest are read from Home's data: Home
 * reports each of its reads, and while Home is closed this reads Needs you
 * alone (YN-221 S1) when a Brief changes (revision) and once a minute. The items read are
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
  // Workspace, drops it, and one never answered ends at the snapshot deadline.
  const reading = useRef<{ controller: AbortController | null; again: boolean }>({ controller: null, again: false });
  const older = useRef({ workspaceId: "", home: false });
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
      readNeeds(controller.signal, older.current, workspaceId)
        .then((needsYou) => {
          if (!controller.signal.aborted && Array.isArray(needsYou)) report(needsYou);
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
