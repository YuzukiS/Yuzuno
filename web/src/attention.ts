import type { NeedsYouItem } from "./home/types";
import type { Agent } from "./types";

/**
 * Who needs the user, and in what order (T-42). Pure: what this device has
 * seen of each Agent's last Turn end is kept by turn-seen.ts. Core says how
 * and where each Agent's last Turn ended (`lastTurnEnd`); an end the device
 * has not shown yet, and that the conversation has not been read past
 * (`reviewedSeq`), on an Agent at rest, is "finished · unseen" or
 * "failed · unseen".
 */

/** The journal seq of the last Turn end this device showed, by Agent. */
export type TurnSeen = Readonly<Record<string, number>>;

/** How the Agent's last Turn ended, when this device has not seen that end
 * and the Agent is at rest (ready, or ended in error): `finished` or
 * `failed`. A closed Agent, or one working or waiting again, has none. An
 * end the conversation was read past, here or on another device
 * (`reviewedSeq`, the Workspace's), is seen too: a new device, browser
 * profile or cleared storage does not bring back Turns read long ago
 * (review 9392d7c2). */
export function unseenEnd(agent: Agent, seen: TurnSeen): "finished" | "failed" | null {
  const end = agent.lastTurnEnd;
  if (!end || agent.closedAt) return null;
  if (!["idle", "error", "uncertain"].includes(agent.status)) return null;
  return Math.max(seen[agent.id] ?? 0, agent.reviewedSeq ?? 0) >= end.seq ? null : end.outcome;
}

/** The attention ranks, in order: what waits on the user (requests, open
 * questions), a Turn end not seen here, working, at rest, offline. */
export const attentionRanks = ["needsYou", "unseen", "working", "idle", "offline"] as const;
export type AttentionRank = (typeof attentionRanks)[number];

export function attentionRank(agent: Agent, seen: TurnSeen): AttentionRank {
  if (agent.pendingCount > 0) return "needsYou";
  if (unseenEnd(agent, seen)) return "unseen";
  if (agent.status === "working" || agent.status === "waiting") return "working";
  if (agent.status === "offline" || agent.disconnectedAt) return "offline";
  return "idle";
}

export type AttentionContext = {
  seen: TurnSeen;
  /** When each Agent's oldest wait began (ms), from Home's Needs you: what
   * waits longest goes first. An Agent without one keeps its place. */
  since?: ReadonlyMap<string, number>;
  /** Agents whose gate asks wait on Home (askingAgents, T-43 S4): they wait on the user too. */
  asking?: ReadonlySet<string>;
};

/**
 * The Agents in attention order (T-42). Within the list given (a Project's
 * group, or all of them), `leads` first, then by rank (attentionRanks):
 * waiting on the user, oldest wait first; a Turn end unseen, failed before
 * finished; working; at rest; offline. Ties keep the order given. Grouping
 * by Project, and which Agents a list holds (scope, search, closed or
 * archived), stay the caller's: T-36 groups by Project and passes each
 * Project's leads.
 */
export function orderByAttention(
  agents: readonly Agent[],
  context: AttentionContext,
  options: { leads?: ReadonlySet<string> } = {},
): Agent[] {
  const keyed = agents.map((agent, index) => {
    const rank = context.asking?.has(agent.id) ? "needsYou" : attentionRank(agent, context.seen);
    const within =
      rank === "needsYou"
        ? (context.since?.get(agent.id) ?? Number.POSITIVE_INFINITY)
        : rank === "unseen"
          ? unseenEnd(agent, context.seen) === "failed" ? 0 : 1
          : 0;
    return { agent, index, lead: options.leads?.has(agent.id) ? 0 : 1, rank: attentionRanks.indexOf(rank), within };
  });
  keyed.sort((a, b) => a.lead - b.lead || a.rank - b.rank || a.within - b.within || a.index - b.index);
  return keyed.map((k) => k.agent);
}

/** When each Agent's oldest Needs you item has waited since (ms). An ask
 * counts only as an executor's gate (T-43 S4): its executor waits for it. */
export function waitingSince(items: readonly NeedsYouItem[] | null): Map<string, number> {
  const since = new Map<string, number>();
  for (const item of items || []) {
    if (item.kind === "ask" && !item.gate) continue;
    const at = Date.parse(item.since);
    if (!Number.isFinite(at)) continue;
    since.set(item.agentId, Math.min(at, since.get(item.agentId) ?? at));
  }
  return since;
}

/** The Agents whose gate asks wait in Needs you (T-43 S4): an executor
 * that asked you on Home to approve a step, and waits for the answer. */
export function askingAgents(items: readonly NeedsYouItem[] | null): Set<string> {
  return new Set((items || []).filter((item) => item.kind === "ask" && item.gate).map((item) => item.agentId));
}

/** Where "next needs you" goes. */
export type NeedsTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "ask"; projectId: string | null; sectionKey: string };

const same = (a: NeedsTarget, b: NeedsTarget) =>
  a.kind === "agent" && b.kind === "agent"
    ? a.agentId === b.agentId
    : a.kind === "ask" && b.kind === "ask" && a.projectId === b.projectId && a.sectionKey === b.sectionKey;

/**
 * Every place "next needs you" goes, in order (T-42): Home's Needs you as
 * Core orders it (Project Priority, then wait, across Projects), an Agent
 * once however many of its requests and questions wait, an executor the
 * user dispatched as its Agent (T-36 S3); then an Agent
 * waiting that the last read of Home does not have yet. Only what waits for
 * the user's decision (YN-3): a Turn that ended, finished or failed, and
 * that this device has not shown is the Agent list's to mark (unseenEnd).
 */
export function needsYouTargets(items: readonly NeedsYouItem[] | null, agents: readonly Agent[]): NeedsTarget[] {
  const targets: NeedsTarget[] = [];
  const add = (target: NeedsTarget) => {
    if (!targets.some((t) => same(t, target))) targets.push(target);
  };
  const open = agents.filter((agent) => !agent.closedAt);
  for (const item of items || []) {
    if (item.kind === "ask") {
      if (item.sectionKey) add({ kind: "ask", projectId: item.projectId, sectionKey: item.sectionKey });
    } else if (item.kind === "executor") {
      // Its result and Release are in its conversation, a failed one's too (T-36 S3).
      if (agents.some((agent) => agent.id === item.agentId)) add({ kind: "agent", agentId: item.agentId });
    } else if (open.some((agent) => agent.id === item.agentId && agent.pendingCount > 0)) {
      add({ kind: "agent", agentId: item.agentId });
    }
  }
  for (const agent of open) if (agent.pendingCount > 0) add({ kind: "agent", agentId: agent.id });
  return targets;
}

/** A jump "next needs you" made: where to, and its place in the list then. */
export type NeedsJump = { target: NeedsTarget; index: number };

/**
 * The jump after `current` (the place shown now): the target after it, or
 * the first. When `current` is the place of the last jump and has left the
 * list since (its Turn end is seen once shown, its request answered), the
 * target now in its place comes next, so a round goes on rather than
 * starting over.
 */
export function nextTarget(targets: readonly NeedsTarget[], current: NeedsTarget | null, last: NeedsJump | null = null): NeedsJump | null {
  if (!targets.length) return null;
  const at = current ? targets.findIndex((t) => same(t, current)) : -1;
  const index =
    at >= 0 ? (at + 1) % targets.length
    : current && last && same(current, last.target) ? last.index % targets.length
    : 0;
  return { target: targets[index], index };
}
