import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * What each Agent left running besides its Jobs and CI, for its ring's wait
 * (YN-51): the review rounds under way whose result is mailed to it, and the
 * background shells and Claude sub-agents its live connection reports, from
 * Core's /api/waits/live (one local read for every row, never GitHub or a
 * harness). Read again when Core says an Agent or the board changed; a Core
 * without it answers nothing, and no row then says these.
 */
export type AgentWaits = {
  /** Under way: how many, and the newest's PR and round. */
  reviews?: { running: number; pr: number | null; round: number | null };
  shells?: number;
  subAgents?: number;
};
type Snapshot = Record<string, AgentWaits>;
let snapshot: Snapshot = {};
let workspace = "";
let sequence = 0;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : 0);
const number = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);

/** One Agent's entry as Core sent it, only its parts that say something. */
function parse(value: unknown): AgentWaits | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: AgentWaits = {};
  const r = v.reviews as Record<string, unknown> | undefined;
  if (r && typeof r === "object" && count(r.running)) out.reviews = { running: count(r.running), pr: number(r.pr), round: number(r.round) };
  if (count(v.shells)) out.shells = count(v.shells);
  if (count(v.subAgents)) out.subAgents = count(v.subAgents);
  return Object.keys(out).length ? out : null;
}
const same = (a: AgentWaits | undefined, b: AgentWaits) => !!a && JSON.stringify(a) === JSON.stringify(b);

export function clearLiveWaits() {
  controller?.abort();
  controller = null;
  ++sequence;
  workspace = "";
  if (Object.keys(snapshot).length) {
    snapshot = {};
    emit();
  }
}

/** One workspace-wide local read. A newer read, or another workspace,
 * supersedes one on its way; a failed read keeps nothing it can't vouch for
 * (a wait shown is a wait Core said is running). */
export function refreshLiveWaits(workspaceId: string) {
  if (workspace !== workspaceId) {
    clearLiveWaits();
    workspace = workspaceId;
  }
  controller?.abort();
  const mine = ++sequence;
  const current = new AbortController();
  controller = current;
  const timeout = setTimeout(() => current.abort(), 10_000);
  void api<{ agents?: Record<string, unknown> }>("/waits/live", { signal: current.signal })
    .then((value) => {
      if (mine !== sequence || workspace !== workspaceId) return;
      const next: Snapshot = {};
      for (const [id, raw] of Object.entries(value?.agents && typeof value.agents === "object" ? value.agents : {})) {
        const parsed = parse(raw);
        if (parsed) next[id] = same(snapshot[id], parsed) ? snapshot[id] : parsed;
      }
      snapshot = next;
      emit();
    })
    .catch(() => {
      if (mine !== sequence || workspace !== workspaceId || !Object.keys(snapshot).length) return;
      snapshot = {};
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
export function useAgentWaits(agentId: string): AgentWaits | undefined {
  return useSyncExternalStore(subscribe, () => snapshot[agentId]);
}
