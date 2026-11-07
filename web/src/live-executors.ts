import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { ExecutorPR } from "./executor-display";

/**
 * Each open executor's PR for its sidebar row (T-43 S2): GET
 * /api/executors/live, one local read for every row, never a GitHub request.
 * App reads it again on collaboration changes (a link, a GitHub refresh, a
 * review's end), as it reads live-ci.ts. A failed read shows no PR rather
 * than an old one as if it were current.
 */
type Snapshot = Record<string, ExecutorPR>;
let snapshot: Snapshot = {};
let workspace = "";
let sequence = 0;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function clearLiveExecutors() {
  controller?.abort();
  controller = null;
  ++sequence;
  workspace = "";
  if (Object.keys(snapshot).length) {
    snapshot = {};
    emit();
  }
}

const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** One executor's PR as this client takes it, or null when it doesn't read as Core's. */
export function readPR(value: unknown): ExecutorPR | null {
  const pr = (value as { pr?: Record<string, unknown> } | null)?.pr;
  if (!pr || typeof pr !== "object" || !count(pr.number) || !pr.number) return null;
  const reviews = pr.reviews as Record<string, unknown> | null | undefined;
  return {
    number: pr.number as number,
    url: text(pr.url),
    state: text(pr.state),
    ci: text(pr.ci),
    reviews: reviews && count(reviews.approved)
      ? { approved: reviews.approved as number, changesRequested: reviews.changesRequested === true, running: reviews.running === true }
      : null,
  };
}

export function refreshLiveExecutors(workspaceId: string) {
  if (workspace !== workspaceId) {
    clearLiveExecutors();
    workspace = workspaceId;
  }
  controller?.abort();
  const mine = ++sequence;
  const current = new AbortController();
  controller = current;
  const timeout = setTimeout(() => current.abort(), 10_000);
  void api<{ executors: Record<string, unknown> }>("/executors/live", { signal: current.signal })
    .then((value) => {
      if (mine !== sequence || workspace !== workspaceId) return;
      if (!value?.executors || Array.isArray(value.executors) || typeof value.executors !== "object")
        throw new Error("Invalid executor summary");
      const next: Snapshot = {};
      for (const [id, entry] of Object.entries(value.executors)) {
        const pr = readPR(entry);
        if (!pr) continue;
        const old = snapshot[id];
        next[id] = old && JSON.stringify(old) === JSON.stringify(pr) ? old : pr;
      }
      snapshot = next;
      emit();
    })
    .catch(() => {
      if (mine !== sequence || workspace !== workspaceId) return;
      if (Object.keys(snapshot).length) {
        snapshot = {};
        emit();
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      if (controller === current) controller = null;
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useExecutorPR(agentId: string): ExecutorPR | undefined {
  return useSyncExternalStore(subscribe, () => snapshot[agentId]);
}

/** Now, to the minute, for the times an executor's row shows: one timer
 * while any row reads it, none otherwise. */
let minute = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
const subscribeClock = (listener: () => void) => {
  clockListeners.add(listener);
  if (!timer) {
    minute = Date.now();
    timer = setInterval(() => {
      minute = Date.now();
      clockListeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
export function useMinute(): number {
  return useSyncExternalStore(subscribeClock, () => minute);
}
