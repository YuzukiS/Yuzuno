import { useSyncExternalStore } from "react";
import { errorText, reconnectAgent } from "./api";
import { reconnectOffer } from "./agent-actions";
import { nativeSession } from "./machine-checks";
import type { Agent } from "./types";

/**
 * How many reconnects of a batch run at once (T-184). Each may start an
 * Agent's native runtime; Core reconnects each Agent under its own gate, so
 * nothing else bounds how many start together.
 */
export const BATCH_LIMIT = 3;

/** One Agent's part in a batch: queued, on its way, or what Core answered. */
export type BatchOutcome =
  | { state: "waiting" }
  | { state: "running" }
  /** Core's reply: the Agent as it reports it after the reconnect. */
  | { state: "done"; agent: Agent | null }
  | { state: "failed"; error: string }
  /** Not sent: by its turn the Agent no longer needed it, as said. */
  | { state: "skipped"; reason: string };

export interface BatchState {
  /** Chosen by the user; nothing is chosen for them. */
  selected: ReadonlySet<string>;
  outcomes: ReadonlyMap<string, BatchOutcome>;
}

/**
 * The Agents a batch lists: open ones with a session that offer a reconnect
 * or a check now, and ones Core is already connecting (shown, not chosen).
 * Closed Agents reopen from their own menu, never here.
 */
export function batchCandidates(agents: Agent[]): Agent[] {
  return agents.filter((agent) => reconnectOffer(agent) !== null);
}

/** Whether the user can choose it now: Core is not connecting it already. */
export function choosable(agent: Agent): boolean {
  const offer = reconnectOffer(agent);
  return offer === "reconnect" || offer === "check";
}

// Per Workspace, outside any view: closing the dialog or opening an Agent
// keeps the selection and what each reconnect answered.
const states = new Map<string, BatchState>();
// Each Workspace's Agents as last listed, checked again before each send.
const known = new Map<string, Agent[]>();

export function remember(workspace: string, agents: Agent[]) {
  known.set(workspace, agents);
}

/** The session a reconnect would attach to; a change means another one. */
const sessionOf = (agent: Agent) => `${nativeSession(agent) ?? ""}|${agent.remote?.machine.id ?? ""}`;
const listeners = new Set<() => void>();
const EMPTY: BatchState = { selected: new Set(), outcomes: new Map() };

const read = (workspace: string) => states.get(workspace) ?? EMPTY;
function write(workspace: string, change: (state: BatchState) => BatchState) {
  states.set(workspace, change(read(workspace)));
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBatch(workspace: string): BatchState {
  return useSyncExternalStore(subscribe, () => read(workspace));
}

export function choose(workspace: string, ids: string[], on: boolean) {
  write(workspace, (state) => {
    const selected = new Set(state.selected);
    for (const id of ids) {
      if (on) selected.add(id);
      else selected.delete(id);
    }
    return { ...state, selected };
  });
}

function setOutcome(workspace: string, id: string, outcome: BatchOutcome, keep?: boolean) {
  write(workspace, (state) => {
    const outcomes = new Map(state.outcomes);
    outcomes.set(id, outcome);
    if (keep === undefined) return { ...state, outcomes };
    const selected = new Set(state.selected);
    if (keep) selected.add(id);
    else selected.delete(id);
    return { selected, outcomes };
  });
}

/** Whether any of this Workspace's reconnects is queued or on its way. */
export function busy(state: BatchState): boolean {
  return [...state.outcomes.values()].some((o) => o.state === "waiting" || o.state === "running");
}

/** On opening the dialog: for Agents that no longer need a reconnect
 * (reconnected elsewhere since), an old failure and the choice go. */
export function forgetStale(workspace: string, needed: ReadonlySet<string>) {
  write(workspace, (state) => {
    const selected = new Set([...state.selected].filter((id) => needed.has(id)));
    const outcomes = new Map(state.outcomes);
    for (const [id, outcome] of outcomes) if (outcome.state === "failed" && !needed.has(id)) outcomes.delete(id);
    return { selected, outcomes };
  });
}

/** On closing the dialog: answers already read go; failures and what is
 * still on its way stay, with the selection. */
export function forgetSettled(workspace: string) {
  write(workspace, (state) => {
    const outcomes = new Map(state.outcomes);
    for (const [id, outcome] of outcomes) if (outcome.state === "done" && !state.selected.has(id)) outcomes.delete(id);
    return { ...state, outcomes };
  });
}

interface Job {
  workspace: string;
  id: string;
  /** Its session when chosen. */
  session: string;
  settled: (id: string) => void;
}
// One queue for every batch, so retries and a second batch share the limit.
const queue: Job[] = [];
let active = 0;

/**
 * Reconnects these Agents through the shared `reconnectAgent` (one request
 * per Agent, also with its menu or notice), at most BATCH_LIMIT at once.
 * An Agent already queued or on its way is not queued again. Before its
 * turn each is checked again against the Workspace as last listed: one
 * closed, connected, already connecting or on another session since is
 * skipped, said so, and no longer chosen. A reply that still offers a
 * reconnect, and a failure, keep the Agent chosen for the next try;
 * `settled` runs after each request, to read the Workspace again.
 */
export function reconnectBatch(workspace: string, agents: Agent[], settled: (id: string) => void) {
  const pending = (id: string) => {
    const outcome = read(workspace).outcomes.get(id);
    return outcome?.state === "waiting" || outcome?.state === "running";
  };
  for (const agent of agents) {
    if (pending(agent.id)) continue;
    setOutcome(workspace, agent.id, { state: "waiting" });
    queue.push({ workspace, id: agent.id, session: sessionOf(agent), settled });
  }
  pump();
}

function pump() {
  while (active < BATCH_LIMIT && queue.length) {
    const job = queue.shift()!;
    active++;
    void run(job).finally(() => {
      active--;
      pump();
    });
  }
}

/** Why this Agent is no longer reconnected by its turn, if it isn't. */
function stale(job: Job): string | null {
  const agent = known.get(job.workspace)?.find((a) => a.id === job.id);
  if (!agent) return "no longer in this workspace";
  if (agent.closedAt) return "closed since, and not reopened here";
  if (sessionOf(agent) !== job.session) return "its session changed; choose it again";
  const offer = reconnectOffer(agent);
  if (offer === "connecting") return "Core is already connecting it";
  if (offer === null) return "already connected";
  return null;
}

async function run(job: Job) {
  const { workspace, id, settled } = job;
  const reason = stale(job);
  if (reason) {
    setOutcome(workspace, id, { state: "skipped", reason }, false);
    return;
  }
  setOutcome(workspace, id, { state: "running" });
  try {
    const reply = (await reconnectAgent(id)) as { agent?: Agent } | null;
    const agent = reply?.agent ?? null;
    // Kept for another try while Core still reports it offline or unconfirmed.
    setOutcome(workspace, id, { state: "done", agent }, agent ? choosable(agent) : true);
  } catch (error) {
    setOutcome(workspace, id, { state: "failed", error: errorText(error) }, true);
  }
  settled(id);
}
