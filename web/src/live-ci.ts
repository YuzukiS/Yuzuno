import { useSyncExternalStore } from "react";
import { api } from "./api";
import { waitingLabel, type AgentJobs } from "./live-jobs";

export type AgentCI = {
  running: number;
  discovering: number;
  check: number;
  /** Commits still monitored that have no run yet (no deadline). */
  waitingForRun?: number;
  /** The oldest last successful read among them. */
  waitingCheckedAt?: string | null;
};
type Snapshot = Record<string, AgentCI>;
let snapshot: Snapshot = {};
let workspace = "";
let sequence = 0;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function clearLiveCI() {
  controller?.abort();
  controller = null;
  ++sequence;
  workspace = "";
  if (Object.keys(snapshot).length) {
    snapshot = {};
    emit();
  }
}

/** One workspace-wide local cache read, never a GitHub refresh. */
export function refreshLiveCI(workspaceId: string) {
  if (workspace !== workspaceId) {
    clearLiveCI();
    workspace = workspaceId;
  }
  controller?.abort();
  const mine = ++sequence;
  const current = new AbortController();
  controller = current;
  const timeout = setTimeout(() => current.abort(), 10_000);
  void api<{ agents: Record<string, AgentCI> }>("/ci/live", {
    signal: current.signal,
  })
    .then((value) => {
      if (mine !== sequence || workspace !== workspaceId) return;
      if (
        !value?.agents ||
        Array.isArray(value.agents) ||
        typeof value.agents !== "object"
      )
        throw new Error("Invalid CI summary");
      const next: Snapshot = {};
      for (const [id, counts] of Object.entries(value.agents)) {
        // An older Core sends no waitingForRun: none.
        const waitingForRun = counts?.waitingForRun ?? 0;
        if (
          !counts ||
          ![counts.running, counts.discovering, counts.check, waitingForRun].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          throw new Error("Invalid CI counts");
        const { running, discovering, check } = counts;
        const waitingCheckedAt =
          typeof counts.waitingCheckedAt === "string"
            ? counts.waitingCheckedAt
            : null;
        if (!running && !discovering && !check && !waitingForRun) continue;
        const old = snapshot[id];
        next[id] =
          old?.running === running &&
          old.discovering === discovering &&
          old.check === check &&
          (old.waitingForRun ?? 0) === waitingForRun &&
          (old.waitingCheckedAt ?? null) === waitingCheckedAt
            ? old
            : waitingForRun
              ? { running, discovering, check, waitingForRun, waitingCheckedAt }
              : { running, discovering, check };
      }
      snapshot = next;
      emit();
    })
    .catch(() => {
      if (mine !== sequence || workspace !== workspaceId) return;
      // A failed local read cannot keep an old Waiting label looking healthy.
      snapshot = Object.fromEntries(
        Object.entries(snapshot).map(([id, c]) => [
          id,
          c.running || c.discovering || c.waitingForRun
            ? {
                running: 0,
                discovering: 0,
                check:
                  c.check + c.running + c.discovering + (c.waitingForRun ?? 0),
              }
            : c,
        ]),
      );
      emit();
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
export function useAgentCI(agentId: string) {
  return useSyncExternalStore(subscribe, () => snapshot[agentId]);
}

/** Idle-only presentation; native runtime and task statuses never change. */
export function waitingSummary(
  jobs: AgentJobs | undefined,
  ci: AgentCI | undefined,
) {
  const job = waitingLabel(jobs);
  if (!ci) return job;
  const waitingForRun = ci.waitingForRun ?? 0;
  const ciWaiting = ci.running + ci.discovering + waitingForRun > 0;
  const waiting = [
    job?.label === "Waiting · Job" ? "Job" : "",
    ciWaiting ? "CI" : "",
  ].filter(Boolean);
  const checking = [
    job?.label === "Check job" ? "job" : "",
    ci.check ? "CI" : "",
  ].filter(Boolean);
  const label = [
    waiting.length ? `Waiting · ${waiting.join(" / ")}` : "",
    checking.length ? `Check ${checking.join(" / ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!label) return job;
  const detail = [
    job?.detail,
    ci.running
      ? `${ci.running} GitHub Actions run${ci.running === 1 ? "" : "s"} queued or running.`
      : "",
    ci.discovering
      ? `${ci.discovering} CI target${ci.discovering === 1 ? "" : "s"} waiting for run discovery (up to 10 minutes).`
      : "",
    waitingForRun
      ? `${waitingForRun} commit${waitingForRun === 1 ? "" : "s"} waiting for ${waitingForRun === 1 ? "its" : "their"} first run, still monitored${ci.waitingCheckedAt ? ` (last checked ${new Date(ci.waitingCheckedAt).toLocaleTimeString()})` : ""}.`
      : "",
    ci.check
      ? `${ci.check} CI target${ci.check === 1 ? " needs" : "s need"} checking: monitoring is unavailable, stale, incomplete, or no run was found.`
      : "",
    "See CI in Jobs.",
  ]
    .filter(Boolean)
    .join(" ");
  return { label, detail };
}
