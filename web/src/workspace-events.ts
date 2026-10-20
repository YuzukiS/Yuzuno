import type {
  Agent,
  Artifact,
  ClaudeRuntime,
  ContextUsage,
  NativeItem,
} from "./types";

/**
 * Messages on Core's `/api/events` stream (see core/src/events.rs).
 *
 * Every message has an SSE id `<epoch>-<n>`. A reconnect with
 * `Last-Event-ID` either resumes (first `resumed`, then everything after that
 * id, in order) or starts with `reset`. `rev` is the Agent record's revision
 * once the change is applied: a detail whose `agent.rev >= rev` already
 * contains it. Several messages may share one `rev`.
 */
export interface AgentDeltaEvent {
  type: "agent.delta";
  agentId: string;
  rev: number;
  turnId: string;
  itemId: string;
  op: "append";
  /** A string field, or with `index`, an array of strings. */
  field: string;
  index?: number;
  text: string;
}
/** The Item as it is now: inserted, or replacing the one with its id. */
export interface AgentItemEvent {
  type: "agent.item";
  agentId: string;
  rev: number;
  turnId: string;
  item: NativeItem;
  /** The whole artifact list, when this Item may have added one. */
  artifacts?: Artifact[];
}
/** Top-level detail fields, each replaced whole when present. */
export interface AgentContextEvent {
  type: "agent.context";
  agentId: string;
  rev: number;
  contextUsage?: ContextUsage | null;
  claudeRuntime?: ClaudeRuntime | null;
}
/** Streamed changes a shown detail applies in place. */
export type DetailEvent = AgentDeltaEvent | AgentItemEvent | AgentContextEvent;
/** Anything else about one Agent; what is shown of it is refetched. */
export interface AgentChangedEvent {
  type: "agent.changed";
  agentId: string;
  rev?: number | null;
  lastSeq?: number | null;
}
/** Streamed progress was applied (and sent above); `agent` is its rail entry
 * now, without `projectId`. */
export interface AgentProgressEvent {
  type: "agent.progress";
  agentId: string;
  rev?: number | null;
  lastSeq?: number | null;
  agent?: Agent;
}
export interface WorkspaceChangedEvent {
  type: "workspace.changed";
  scope: "collaboration" | "projects" | "machines" | "runtime" | string;
}
/** Refetch everything shown: Core said so, live updates may have been
 * missed, or the stream is not open (polling). */
export interface ResetEvent {
  type: "reset";
  reason: string;
}
export interface ResumedEvent {
  type: "resumed";
}
/** Liveness only (sent as a named SSE event every 15 s). */
export interface HeartbeatEvent {
  type: "heartbeat";
}
export type WorkspaceEvent =
  | { type: "agent.codexUsage"; agentId: string; usage: import("./CodexPlanUsage").CodexUsage }
  | DetailEvent
  | AgentChangedEvent
  | AgentProgressEvent
  | WorkspaceChangedEvent
  | ResetEvent
  | ResumedEvent
  | HeartbeatEvent;

const isText = (value: unknown): value is string => typeof value === "string";
const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** One stream message as an event. Older Core notices (`{agentId}`,
 * `{refresh}`, `{collaboration}`, …) map onto the same kinds; anything
 * unreadable asks for a full refetch rather than being ignored. */
export function parseWorkspaceEvent(data: unknown): WorkspaceEvent {
  let value: Record<string, any>;
  try {
    value = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return { type: "reset", reason: "unreadable" };
  }
  if (!value || typeof value !== "object")
    return { type: "reset", reason: "unreadable" };
  const agentId = isText(value.agentId) ? value.agentId : null;
  // A streamed change that does not parse is still a change to that Agent.
  const changed = (): WorkspaceEvent =>
    agentId
      ? { type: "agent.changed", agentId, lastSeq: null }
      : { type: "reset", reason: "unreadable" };
  switch (value.type) {
    case "agent.codexUsage":
      return agentId && value.usage && isSeq(value.usage.revision)
        ? value as Extract<WorkspaceEvent, { type: "agent.codexUsage" }>
        : { type: "heartbeat" };
    case "agent.delta":
      return agentId &&
        isSeq(value.rev) &&
        isText(value.turnId) &&
        isText(value.itemId) &&
        value.op === "append" &&
        isText(value.field) &&
        isText(value.text) &&
        (value.index === undefined ||
          (Number.isSafeInteger(value.index) && value.index >= 0))
        ? (value as AgentDeltaEvent)
        : changed();
    case "agent.item":
      return agentId &&
        isSeq(value.rev) &&
        isText(value.turnId) &&
        value.item &&
        isText(value.item.id) &&
        (value.artifacts === undefined || Array.isArray(value.artifacts))
        ? (value as AgentItemEvent)
        : changed();
    case "agent.context":
      return agentId && isSeq(value.rev) && ("contextUsage" in value || "claudeRuntime" in value)
        ? (value as AgentContextEvent)
        : changed();
    case "agent.changed":
      return agentId
        ? {
            type: "agent.changed",
            agentId,
            rev: isSeq(value.rev) ? value.rev : null,
            lastSeq: isSeq(value.lastSeq) ? value.lastSeq : null,
          }
        : { type: "reset", reason: "unreadable" };
    case "agent.progress":
      return agentId
        ? {
            type: "agent.progress",
            agentId,
            rev: isSeq(value.rev) ? value.rev : null,
            lastSeq: isSeq(value.lastSeq) ? value.lastSeq : null,
            agent:
              value.agent && value.agent.id === agentId ? value.agent : undefined,
          }
        : { type: "reset", reason: "unreadable" };
    case "workspace.changed":
      return {
        type: "workspace.changed",
        scope: isText(value.scope) ? value.scope : "workspace",
      };
    case "reset":
      return { type: "reset", reason: isText(value.reason) ? value.reason : "reset" };
    case "resumed":
      return { type: "resumed" };
    case "heartbeat":
      return { type: "heartbeat" };
  }
  if (value.type !== undefined) return { type: "reset", reason: "unknown" };
  // Older Core notices, without a type.
  if (agentId) return { type: "agent.changed", agentId, lastSeq: null };
  if (value.refresh) return { type: "reset", reason: "refresh" };
  for (const scope of ["collaboration", "projects", "machines", "runtime"])
    if (value[scope]) return { type: "workspace.changed", scope };
  return { type: "reset", reason: "unknown" };
}
