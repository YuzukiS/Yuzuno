import { useSyncExternalStore } from "react";
import { api } from "./api";

/** One Agent's unfinished local jobs: queued or still holding a reservation.
 * `unknown` of them have an outcome Core could not confirm. */
export type AgentJobs = { active: number; unknown: number };
type Snapshot = Record<string, AgentJobs>;

// Workspace-wide and outside React state: a job change re-renders only the
// Agent rows whose counts changed, never the conversation.
let snapshot: Snapshot = {};
let workspace = "";
let sequence = 0;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Read every Agent's unfinished jobs. A newer read, or another workspace,
 * supersedes one still on its way; a failed read keeps the last snapshot
 * until the next job change or reconnect reads again. */
export function refreshLiveJobs(workspaceId: string) {
  if (workspaceId !== workspace) {
    workspace = workspaceId;
    if (Object.keys(snapshot).length) {
      snapshot = {};
      emit();
    }
  }
  controller?.abort();
  const mine = ++sequence;
  const current = new AbortController();
  controller = current;
  void api<{ agents?: Record<string, Partial<AgentJobs>> }>("/jobs/live", {
    signal: current.signal,
  })
    .then((value) => {
      if (mine !== sequence || workspaceId !== workspace) return;
      if (!value?.agents || typeof value.agents !== "object") return;
      const next: Snapshot = {};
      for (const [id, counts] of Object.entries(value.agents)) {
        const active = Math.max(0, Number(counts?.active) || 0);
        const unknown = Math.min(active, Math.max(0, Number(counts?.unknown) || 0));
        if (!active) continue;
        const old = snapshot[id];
        next[id] =
          old?.active === active && old.unknown === unknown
            ? old
            : { active, unknown };
      }
      snapshot = next;
      emit();
    })
    .catch(() => {})
    .finally(() => {
      if (controller === current) controller = null;
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useAgentJobs(agentId: string): AgentJobs | undefined {
  return useSyncExternalStore(subscribe, () => snapshot[agentId]);
}

const jobs = (n: number) => `${n} job${n === 1 ? "" : "s"}`;
/** What the Agent list shows for an idle Agent with unfinished jobs. */
export function waitingLabel(counts: AgentJobs | undefined) {
  if (!counts?.active) return null;
  const running = counts.active - counts.unknown;
  const unknown = counts.unknown
    ? `${jobs(counts.unknown)} with an unknown outcome still ${counts.unknown === 1 ? "holds its" : "hold their"} reservation. `
    : "";
  return running > 0
    ? {
        label: "Waiting · Job",
        detail: `${jobs(running)} queued or running. ${unknown}See Jobs.`,
      }
    : { label: "Check job", detail: `${unknown}Check in Jobs.` };
}
