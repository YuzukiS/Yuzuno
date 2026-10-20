import type { NativeItem, NativeTurn } from "./types";

/**
 * Claude's native sub-agents, as Core records them (core/src/claude.rs). A
 * sub-agent is the Agent call that started it: that `claudeToolUse` Item
 * carries `subAgent`, kept current from Claude's task events. The calls a
 * sub-agent makes are Items of the same Turn whose `parentToolUseId` names
 * the Agent call, so nested sub-agents form a tree. Identity is Claude's own
 * tool call id; nothing is inferred from text or order.
 */
export type ClaudeSubAgentRecord = {
  taskId?: string;
  /** Claude's run of the task; a resumed task gets a newer one. */
  runId?: string;
  /** The sub-agent type, for example `general-purpose` or `Explore`. */
  type?: string;
  description?: string;
  /** The goal Claude gave it, shortened by Core past 4000 characters. */
  prompt?: string;
  promptTruncated?: boolean;
  background?: boolean;
  remote?: boolean;
  depth?: number;
  parentTaskId?: string;
  /** "unknown": its runtime ended while it ran; never assumed finished. */
  status?: "pending" | "running" | "paused" | "completed" | "failed" | "stopped" | "unknown";
  startedAt?: string;
  endedAt?: string;
  /** What it is doing now, as Claude's progress says. */
  activity?: string;
  lastToolName?: string;
  progress?: string;
  /** Its final summary, shortened by Core past 16000 characters. */
  result?: string;
  resultTruncated?: boolean;
  usage?: { tokens?: number | null; toolUses?: number | null; durationMs?: number | null };
  error?: string;
  /** Why it ended unusually: `worker_restart`, `runtime_ended`. */
  reason?: string;
};

/** WorkDock's status keys (a stopped or killed sub-agent is cancelled). */
export type ClaudeSubAgentStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";

/** One sub-agent, shaped for the sub-agent dock and its detail. */
export type ClaudeSubAgentEntry = {
  /** The Agent call's tool use id: Claude's identity for the sub-agent. */
  key: string;
  turnId: string;
  /** The Agent call, which is also the anchor in its Turn. */
  itemId: string;
  /** The sub-agent that started this one, if it is nested. */
  parentKey: string | null;
  label: string;
  status: ClaudeSubAgentStatus;
  /** One line of status text. */
  state: string;
  /** A hint line: type, foreground or background, calls so far. */
  sub: string;
  /** Not confirmed: its outcome is unknown, or it ran when Claude was last connected. */
  waiting: boolean;
  /** The Agent call as Core sent it (large fields may be previews). */
  item: NativeItem;
  record: ClaudeSubAgentRecord | null;
  /** Its own tool calls in this Turn, in order. */
  calls: NativeItem[];
};

export function isSubAgentCall(item: NativeItem): boolean {
  return item.type === "claudeToolUse" && (isRecord(item.subAgent) || item.name === "Agent" || item.name === "Task");
}

/**
 * An Agent call too large for the conversation window, sent as a
 * `historyPreview` that keeps its sub-agent's facts (core/src/
 * conversation_window.rs `bounded_item`): its goal and result are in the
 * saved original.
 */
export function isSubAgentPreview(item: NativeItem): boolean {
  return item.type === "historyPreview" && isRecord(item.subAgent);
}

function isRecord(value: unknown): value is ClaudeSubAgentRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The calls of sub-agents whose Agent call is among `items`, by the Agent
 * call: they belong under it, not in the Turn's own tool activity. A call
 * whose Agent call is not here (not loaded, or never seen by Core) stays in
 * the Turn's own activity. `previews`: Agent calls sent as window previews
 * count too (the sub-agent dock); the Turn shows those as previews, so their
 * calls stay in its own activity there.
 */
export function subAgentCalls(items: readonly NativeItem[], previews = false): Map<string, NativeItem[]> {
  const calls = new Map<string, NativeItem[]>();
  if (!items.some((item) => typeof item.parentToolUseId === "string")) return calls;
  for (const item of items) if (isSubAgentCall(item) || (previews && isSubAgentPreview(item))) calls.set(item.id, []);
  for (const item of items) {
    const parent = item.parentToolUseId;
    if (typeof parent === "string" && parent !== item.id) calls.get(parent)?.push(item);
  }
  return calls;
}

/**
 * The call of `ancestor`'s own sub-agent on the way to `target`, which may
 * be nested deeper (a call of a sub-agent that sub-agent started): what to
 * open to reach it. Undefined when `target` is not under `ancestor`.
 */
export function callToward(items: ReadonlyMap<string, NativeItem>, target: string | undefined, ancestor: string): string | undefined {
  let id = target;
  for (let hops = 0; id && id !== ancestor && hops <= items.size; hops++) {
    const parent = items.get(id)?.parentToolUseId;
    if (parent === ancestor) return id;
    id = typeof parent === "string" ? parent : undefined;
  }
  return undefined;
}

const running = new Set(["pending", "running", "paused"]);

/** A sub-agent's status. `live`: Claude's runtime is connected now. */
function statusOf(item: NativeItem, record: ClaudeSubAgentRecord | null, live: boolean) {
  // Without task events, the Agent call itself: a foreground call returns
  // when its sub-agent ended.
  const status = record?.status ?? (
    item.status === "inProgress" ? "running"
      : item.status === "completed" ? "completed"
        : item.status === "failed" ? "failed" : "unknown");
  if (running.has(status) && !live)
    return { status: "unknown" as const, state: "Not confirmed · was running when Claude was last connected", waiting: true };
  if (running.has(status))
    return {
      status: "running" as const,
      state: status === "pending" ? "Starting" : status === "paused" ? "Paused"
        : record?.background ? "Running in the background" : "Running",
      waiting: false,
    };
  if (status === "completed") return { status: "succeeded" as const, state: "Completed", waiting: false };
  if (status === "failed") return { status: "failed" as const, state: record?.error ? `Failed · ${record.error}` : "Failed", waiting: false };
  if (status === "stopped")
    return { status: "cancelled" as const, state: record?.reason === "worker_restart" ? "Stopped · Claude restarted" : "Stopped", waiting: false };
  return {
    status: "unknown" as const,
    state: record?.reason === "runtime_ended" ? "Status unknown · Claude's connection ended first" : "Status unknown",
    waiting: true,
  };
}

/** The sub-agents a Turn started (nested ones included), in call order;
 *  one whose Agent call came as a window preview too. */
export function turnSubAgents(turn: NativeTurn, live: boolean): ClaudeSubAgentEntry[] {
  const calls = subAgentCalls(turn.items, true);
  return turn.items.filter((item) => isSubAgentCall(item) || isSubAgentPreview(item)).map((item) => {
    const record = isRecord(item.subAgent) ? item.subAgent : null;
    const input = isRecord(item.input) ? (item.input as Record<string, unknown>) : {};
    const description = record?.description || (typeof input.description === "string" ? input.description : "");
    const type = record?.type || (typeof input.subagent_type === "string" ? input.subagent_type : "");
    const own = calls.get(item.id) ?? [];
    const count = record?.usage?.toolUses ?? own.length;
    return {
      key: item.id,
      turnId: turn.id,
      itemId: item.id,
      parentKey: typeof item.parentToolUseId === "string" ? item.parentToolUseId : null,
      label: description || type || "Sub-agent",
      ...statusOf(item, record, live),
      sub: [type, record?.remote ? "Remote" : record?.background ? "Background" : "",
        count ? `${count} tool ${count === 1 ? "call" : "calls"}` : ""].filter(Boolean).join(" · "),
      item,
      record,
      calls: own,
    };
  });
}

/** Every loaded Turn's sub-agents. */
export function claudeSubAgents(turns: readonly NativeTurn[], live: boolean): ClaudeSubAgentEntry[] {
  return turns.flatMap((turn) => turnSubAgents(turn, live));
}

export function formatUsage(usage: ClaudeSubAgentRecord["usage"]): string {
  if (!usage) return "";
  const tokens = typeof usage.tokens === "number" ? `${usage.tokens.toLocaleString()} tokens` : "";
  const calls = typeof usage.toolUses === "number" ? `${usage.toolUses} tool ${usage.toolUses === 1 ? "call" : "calls"}` : "";
  const seconds = typeof usage.durationMs === "number" ? `${Math.max(1, Math.round(usage.durationMs / 1000))}s` : "";
  return [tokens, calls, seconds].filter(Boolean).join(" · ");
}
