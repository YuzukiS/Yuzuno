import type { NativeItem } from "./types";

/**
 * Codex sub-agents a parent Turn started, from that Turn's own
 * `subAgentActivity` Items (kind started, interacted, interrupted or
 * completed; Codex 0.162.1). The child is Codex's `agentThreadId`; nothing is
 * inferred from text.
 */
export type SubAgentState = "started" | "ended" | "interrupted" | "unknown";

export type SubAgentRow = {
  threadId: string;
  /** Codex's agent path, for example `/root/alpha`. */
  path: string;
  /** The last part of the path, for the row label. */
  label: string;
  state: SubAgentState;
  model: string | null;
};

/** GET /api/agents/{id}/subagents/{threadId} (core/src/subagents.rs). */
export type SubAgentDetail = {
  threadId: string;
  parentThreadId: string;
  nickname: string | null;
  role: string | null;
  path: string | null;
  depth: number | null;
  model: string | null;
  /** Codex's thread status when read: active, idle, … */
  status: string | null;
  turn: { id: string; status: string; error: string | null } | null;
  result: { text: string; truncated: boolean } | null;
  readFrom: "live" | "history";
  readAt: string;
};

/** A child's state from its last known fact and whether the Turn that
 * reported it is still running (see conversationSubAgents). */
function stateOf(last: string | undefined, running: boolean): SubAgentState {
  return last === "completed"
    ? "ended"
    : last === "interrupted"
      ? "interrupted"
      : last === "started" && running
        ? "started"
        : "unknown";
}

export const stateLabels: Record<SubAgentState, string> = {
  started: "Started · status to confirm",
  ended: "Ended",
  interrupted: "Interrupted",
  unknown: "Status unknown",
};

/** A child Turn's own status, as Codex reports it in the details. */
export function turnStatusLabel(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    case "inProgress":
      return "In progress";
    default:
      return status || "Unknown";
  }
}

/** Codex's thread status as read (not a result): loaded and working, idle, … */
export function threadStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "Working";
    case "idle":
      return "Idle";
    case "notLoaded":
      return "Not loaded";
    case "systemError":
      return "System error";
    default:
      return status || "Unknown";
  }
}

/** A sub-agent with where it was started: its Turn and first Item. */
export type ConversationSubAgent = SubAgentRow & {
  turnId: string;
  itemId: string;
};

/**
 * Every sub-agent the loaded Turns started, once each, in the order Codex
 * started them. A child a later Turn works with again keeps the Turn and
 * Item where it first appeared, and takes its state from its last known
 * fact across them all, judged by whether the Turn that reported that fact
 * is still running. The facts are the activity kinds: an Item's own start
 * and completion events are not the child finishing. `interacted` is input
 * to the child, not a state.
 * - **started:** the child has started; whether it is still working is
 *   confirmed only in its details.
 * - **completed:** the child's Turn has ended; how it ended (completed,
 *   failed, interrupted) is in its details.
 * - **interrupted:** Codex interrupted it.
 * - **unknown:** started, but the Turn that reported it ended without either.
 */
export function conversationSubAgents(
  turns: readonly { id: string; status?: string; items?: readonly NativeItem[] }[],
): ConversationSubAgent[] {
  const children = new Map<
    string,
    { child: ConversationSubAgent; last?: string; running: boolean }
  >();
  for (const turn of turns) {
    const running = turn.status === "inProgress";
    const seen = new Set<string>();
    for (const item of turn.items || []) {
      if (item.type !== "subAgentActivity" || seen.has(item.id)) continue;
      seen.add(item.id);
      const threadId = item.agentThreadId;
      if (typeof threadId !== "string" || !threadId) continue;
      const path = typeof item.agentPath === "string" ? item.agentPath : "";
      let entry = children.get(threadId);
      if (!entry) {
        entry = {
          child: {
            threadId,
            path,
            label: path.split("/").filter(Boolean).at(-1) || "Sub-agent",
            state: "unknown",
            model: null,
            turnId: turn.id,
            itemId: item.id,
          },
          running,
        };
        children.set(threadId, entry);
      }
      if (!entry.child.path && path) {
        entry.child.path = path;
        entry.child.label = path.split("/").filter(Boolean).at(-1) || "Sub-agent";
      }
      if (!entry.child.model && typeof item.model === "string") entry.child.model = item.model;
      if (item.kind === "started" || item.kind === "completed" || item.kind === "interrupted") {
        entry.last = item.kind as string;
        entry.running = running;
      }
    }
  }
  return [...children.values()].map(({ child, last, running }) => ({
    ...child,
    state: stateOf(last, running),
  }));
}
