import { useSyncExternalStore } from "react";
import { api } from "./api";
import { strings, type Language } from "./i18n";

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

// The Agent list's words for an Agent's jobs (T-189). Each label keeps its
// " · " and "/" parts, which the row's layout reads.
const words = strings({
  waiting: "Waiting · Job",
  check: "Check job",
  unknown: (count: number) => `${count} job${count === 1 ? "" : "s"} with an unknown outcome still ${count === 1 ? "holds its" : "hold their"} reservation. `,
  running: (count: number, unknown: string) => `${count} job${count === 1 ? "" : "s"} queued or running. ${unknown}See Jobs.`,
  checkIn: (unknown: string) => `${unknown}Check in Jobs.`,
}, {
  waiting: "等待中 · Job",
  check: "核对 Job",
  unknown: (count) => `${count} 个结果未知的 Job 仍占用其预留资源。`,
  running: (count, unknown) => `${count} 个 Job 正在排队或运行。${unknown}请在 Job 中查看。`,
  checkIn: (unknown) => `${unknown}请在 Job 中核对。`,
});
/** What the Agent list shows for an idle Agent with unfinished jobs, in
 * `language`: waiting on them, or only ones to check. */
export function waitingLabel(counts: AgentJobs | undefined, language: Language = "en") {
  if (!counts?.active) return null;
  const w = words(language);
  const running = counts.active - counts.unknown;
  const unknown = counts.unknown ? w.unknown(counts.unknown) : "";
  return running > 0
    ? { kind: "waiting" as const, label: w.waiting, detail: w.running(running, unknown) }
    : { kind: "check" as const, label: w.check, detail: w.checkIn(unknown) };
}
