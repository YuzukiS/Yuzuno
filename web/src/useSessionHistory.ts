import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { AgentDetail, NativeTurn, SessionHistory } from "./types";

interface HistoryPage extends SessionHistory {
  turns: NativeTurn[];
}

function turnTime(turn: NativeTurn): number | null {
  const completedAt = (turn as NativeTurn & { completedAt?: number | null })
    .completedAt;
  if (typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt))
    return turn.startedAt;
  if (typeof completedAt === "number" && Number.isFinite(completedAt))
    return completedAt;
  if (
    typeof turn._yuzunoStartedAt === "number" &&
    Number.isFinite(turn._yuzunoStartedAt)
  )
    return turn._yuzunoStartedAt / 1000;
  return null;
}

/** Each input is in native ascending order; later inputs own fresher contents.
 * Recovery can leave disjoint old/recent windows in the cache. A fetched page
 * belongs between those windows, not necessarily before every cached Turn.
 * Preserve each native sequence (including equal/missing timestamps), and use
 * native time to order independent runs. IDs are only identity, never sort keys.
 */
function mergeTurns(...groups: NativeTurn[][]): NativeTurn[] {
  const values = new Map(groups.flat().map((turn) => [turn.id, turn]));
  const order = new Map([...values.keys()].map((id, index) => [id, index]));
  const successors = new Map<string, Set<string>>();
  const incoming = new Map([...values.keys()].map((id) => [id, 0]));
  for (const group of groups) {
    const ids = [...new Set(group.map((turn) => turn.id))];
    for (let i = 1; i < ids.length; i++) {
      const previous = ids[i - 1],
        next = ids[i];
      const after = successors.get(previous) || new Set<string>();
      if (!after.has(next)) {
        after.add(next);
        successors.set(previous, after);
        incoming.set(next, incoming.get(next)! + 1);
      }
    }
  }
  const ready = [...values.keys()].filter((id) => incoming.get(id) === 0);
  const result: NativeTurn[] = [];
  while (ready.length) {
    // Native order resolves ties and missing-time records. Independent runs
    // with native timestamps are inserted at their actual chronological place.
    let nextIndex = 0;
    for (let i = 1; i < ready.length; i++) {
      const candidate = turnTime(values.get(ready[i])!);
      const chosen = turnTime(values.get(ready[nextIndex])!);
      if (
        candidate !== null && chosen !== null && candidate !== chosen
          ? candidate < chosen
          : order.get(ready[i])! < order.get(ready[nextIndex])!
      )
        nextIndex = i;
    }
    const [id] = ready.splice(nextIndex, 1);
    result.push(values.get(id)!);
    for (const after of successors.get(id) || []) {
      incoming.set(after, incoming.get(after)! - 1);
      if (incoming.get(after) === 0) ready.push(after);
    }
  }
  // Conflicting snapshots must never make a Turn disappear from the UI.
  if (result.length !== values.size) {
    const emitted = new Set(result.map((turn) => turn.id));
    result.push(
      ...[...values.values()].filter((turn) => !emitted.has(turn.id)),
    );
  }
  return result;
}

/** Keep expanded pages for the selected conversation only, outside durable state. */
export function useSessionHistory(
  detail: AgentDetail | null,
  selected: string,
) {
  const [pages, setPages] = useState<
    (HistoryPage & { agentId: string; baseCursor: string | null }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // How many Turns the last page added that were not already shown (T-161).
  const [added, setAdded] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setPages(null);
    setLoading(false);
    setError("");
    setAdded(null);
    return () => request.current?.abort();
  }, [selected]);
  const current = detail?.agent.id === selected ? detail : null;
  const earlier =
    pages?.agentId === selected &&
    pages.baseCursor === current?.history?.nextCursor
      ? pages
      : null;
  useEffect(() => {
    if (pages && !earlier) setPages(null);
  }, [pages, earlier]);
  const history = earlier || current?.history;
  const nativeTurns = useMemo(() => {
    const saved = new Set((current?.conversation?.index || current?.turns || []).map(turn => turn.id));
    return (earlier?.turns || []).filter(turn => !saved.has(turn.id));
  }, [current?.conversation?.index, current?.turns, earlier]);
  const navigationTurns = useMemo(() => mergeTurns(earlier?.turns || [],
    current?.conversation?.index || current?.turns || []), [earlier, current?.conversation?.index, current?.turns]);
  const mergedDetail = useMemo(() => {
    if (!current || !earlier) return current;
    // Only native-only pages are retained. Saved-body page changes must not
    // accumulate old Core windows in this separate compatibility cache.
    const bodies = new Map([...nativeTurns, ...current.turns].map(turn => [turn.id, turn]));
    const turns = current.conversation
      ? navigationTurns.flatMap(turn => bodies.has(turn.id) ? [bodies.get(turn.id)!] : [])
      : mergeTurns(earlier.turns, current.turns);
    return {
      ...current,
      turns,
      history: {
        nextCursor: earlier.nextCursor,
        hasMore: earlier.hasMore,
        loadedCount: turns.length,
        totalCount: current.history?.totalCount ?? earlier.totalCount,
      },
    };
  }, [current, earlier, nativeTurns, navigationTurns]);

  async function loadEarlier(beforeApply?: () => void) {
    if (!current || !history?.hasMore || !history.nextCursor || request.current)
      return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setAdded(null);
    try {
      const page = await api<HistoryPage>(
        `/agents/${encodeURIComponent(selected)}/history?${new URLSearchParams({ cursor: history.nextCursor })}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || selectedRef.current !== selected) return;
      beforeApply?.();
      const known = new Set([...(current.conversation?.index || current.turns), ...(earlier?.turns || [])].map(turn => turn.id));
      setAdded(page.turns.filter(turn => !known.has(turn.id)).length);
      setPages({
        ...page,
        agentId: selected,
        baseCursor: current.history?.nextCursor || null,
        turns: mergeTurns(page.turns, earlier?.turns || []),
      });
    } catch (error) {
      if (!controller.signal.aborted && selectedRef.current === selected)
        setError(errorText(error));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }
  return {
    detail: mergedDetail,
    nativeTurns,
    navigationTurns,
    loading,
    error,
    added,
    loadEarlier,
  };
}
