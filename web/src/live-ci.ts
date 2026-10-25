import { useSyncExternalStore } from "react";
import { api } from "./api";
import { strings, type Language } from "./i18n";
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
// The Agent list's words for an Agent's CI (T-189). A label keeps its " · "
// and "/" parts, which the row's layout reads.
const words = strings({
  job: "Job",
  checkJob: "job",
  waiting: (parts: string) => `Waiting · ${parts}`,
  check: (parts: string) => `Check ${parts}`,
  running: (count: number) => `${count} GitHub Actions run${count === 1 ? "" : "s"} queued or running.`,
  discovering: (count: number) => `${count} CI target${count === 1 ? "" : "s"} waiting for run discovery (up to 10 minutes).`,
  waitingForRun: (count: number, checked: string | null) =>
    `${count} commit${count === 1 ? "" : "s"} waiting for ${count === 1 ? "its" : "their"} first run, still monitored${checked ? ` (last checked ${checked})` : ""}.`,
  needsCheck: (count: number) => `${count} CI target${count === 1 ? " needs" : "s need"} checking: monitoring is unavailable, stale, incomplete, or no run was found.`,
  seeJobs: "See CI in Jobs.",
  join: " ",
}, {
  checkJob: "Job",
  waiting: (parts) => `等待中 · ${parts}`,
  check: (parts) => `核对 ${parts}`,
  running: (count) => `${count} 个 GitHub Actions 运行正在排队或运行。`,
  discovering: (count) => `${count} 个 CI 目标正在等待发现运行（最长 10 分钟）。`,
  waitingForRun: (count, checked) => `${count} 个提交正在等待首次运行，仍在监控${checked ? `（上次检查于 ${checked}）` : ""}。`,
  needsCheck: (count) => `${count} 个 CI 目标需要核对：监控不可用、已过时、不完整，或未找到运行。`,
  seeJobs: "请在 Job 中查看 CI。",
  join: "",
});
export function waitingSummary(
  jobs: AgentJobs | undefined,
  ci: AgentCI | undefined,
  language: Language = "en",
) {
  const job = waitingLabel(jobs, language);
  if (!ci) return job;
  const w = words(language);
  const waitingForRun = ci.waitingForRun ?? 0;
  const ciWaiting = ci.running + ci.discovering + waitingForRun > 0;
  const waiting = [
    job?.kind === "waiting" ? w.job : "",
    ciWaiting ? "CI" : "",
  ].filter(Boolean);
  const checking = [
    job?.kind === "check" ? w.checkJob : "",
    ci.check ? "CI" : "",
  ].filter(Boolean);
  const label = [
    waiting.length ? w.waiting(waiting.join(" / ")) : "",
    checking.length ? w.check(checking.join(" / ")) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!label) return job;
  const detail = [
    job?.detail,
    ci.running ? w.running(ci.running) : "",
    ci.discovering ? w.discovering(ci.discovering) : "",
    waitingForRun ? w.waitingForRun(waitingForRun, ci.waitingCheckedAt ? new Date(ci.waitingCheckedAt).toLocaleTimeString() : null) : "",
    ci.check ? w.needsCheck(ci.check) : "",
    w.seeJobs,
  ]
    .filter(Boolean)
    .join(w.join);
  return { label, detail };
}
