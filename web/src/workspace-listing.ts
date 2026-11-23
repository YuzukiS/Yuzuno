import { api } from "./api";
import type { Agent, Workspace } from "./types";

/** How the page asks for the Agent list (YN-221 S3/S4): released executors
 * as slim rows, as `?listing=slim` would; a header, as a conversation's
 * window is asked for (`X-Yuzuno-Conversation`), so the list's address stays
 * `/api/workspace`. An older Core ignores it and sends every row whole,
 * without `listing`, and nothing more is read. */
export const SLIM_LISTING: Readonly<Record<string, string>> = Object.freeze({ "X-Yuzuno-Listing": "slim" });

/** A released executor's slim row (`listing: "slim"`). */
export function isSlim(agent: Agent | null | undefined): boolean {
  return agent?.listing === "slim";
}

/** The full row known for an Agent with the slim row read now: the slim
 * row's fields are newer; the rest are the full row's. */
export function withListing(full: Agent, slim: Agent): Agent {
  const merged: Agent = {
    ...full,
    ...slim,
    executor: slim.executor ? { ...(full.executor ?? {}), ...slim.executor } : full.executor,
    remote: full.remote && slim.remote ? { ...full.remote, machine: { ...full.remote.machine, ...slim.remote.machine } } : slim.remote ?? full.remote,
  };
  delete merged.listing;
  return merged;
}

/** A slim list with the full rows known for its slim rows: read when one was
 * opened (`known`), or the row the last list of the same Workspace had whole
 * (an Agent released while it was open). Another Workspace's rows are never
 * used: a Core restored from a backup may give its Agents the same ids. */
export function mergeListing(next: Workspace, previous: Workspace | null | undefined, known: (id: string) => Agent | undefined): Workspace {
  if (next.listing !== "slim") return next;
  const sameWorkspace = !!previous && !!next.workspace?.id && previous.workspace?.id === next.workspace.id;
  const whole = new Map<string, Agent>();
  if (sameWorkspace) for (const a of previous.agents) if (!isSlim(a)) whole.set(a.id, a);
  let changed = false;
  const agents = next.agents.map((row) => {
    if (!isSlim(row)) return row;
    const full = known(row.id) ?? whole.get(row.id);
    if (!full) return row;
    changed = true;
    return withListing(full, row);
  });
  return changed ? { ...next, agents } : next;
}

/** One Agent's full row (`GET /api/agents/{id}/listing`). */
export const readFullAgent = (id: string, signal?: AbortSignal) =>
  api<Agent>(`/agents/${encodeURIComponent(id)}/listing`, { signal });
