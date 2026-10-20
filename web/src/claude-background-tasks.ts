import type { NativeItem, NativeTurn } from "./types";

/**
 * A task Claude runs in the background other than a sub-agent (a shell
 * started with run_in_background, a monitor, a workflow, an MCP task), as
 * Core records it on the call that started it (core/src/claude.rs
 * `backgroundTask`), from Claude's own task events. Sub-agents keep their
 * `subAgent` record and their own dock group; a task is never both.
 */
export type ClaudeBackgroundTaskRecord = {
  taskId?: string;
  runId?: string;
  /** Claude's task type: `local_bash` (a shell), `monitor`, `local_workflow`, `mcp_task`, … */
  type?: string;
  workflowName?: string;
  /** What it runs: a shell's command, shortened by Core past 1000 characters. */
  description?: string;
  /** "unknown": its runtime ended while it ran; never assumed finished. */
  status?: "pending" | "running" | "paused" | "completed" | "failed" | "stopped" | "unknown";
  background?: boolean;
  /** Housekeeping, not activity (Claude's own flag). */
  ambient?: boolean;
  startedAt?: string;
  endedAt?: string;
  activity?: string;
  lastToolName?: string;
  progress?: string;
  /** Claude's summary when it ended, shortened by Core past 16000 characters. */
  result?: string;
  resultTruncated?: boolean;
  /** Where Claude wrote its output, on the Core host. */
  outputFile?: string;
  error?: string;
  /** Why it ended unusually: `worker_restart`, `runtime_ended`. */
  reason?: string;
  /** When a stop was sent; only the task's own end says it stopped. */
  stopRequestedAt?: string;
  /** Why the last stop was not sent or Claude refused it. */
  stopError?: string;
};

/** WorkDock's status keys, as for sub-agents. */
export type ClaudeBackgroundTaskStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export type ClaudeBackgroundTaskEntry = {
  /** The call that started it: Claude's tool use id. */
  key: string;
  turnId: string;
  itemId: string;
  label: string;
  /** What its call runs, when the call says (a shell's command): Claude's
   *  description may be its own words for it. */
  command: string;
  /** Shell, Monitor, Workflow, … */
  kind: string;
  status: ClaudeBackgroundTaskStatus;
  state: string;
  /** Not known to have ended: still running, or its end unconfirmed. */
  waiting: boolean;
  item: NativeItem;
  record: ClaudeBackgroundTaskRecord;
};

/** How long a stop Claude acknowledged waits for the task's own end
 *  (core/src/claude.rs TASK_STOP_WAIT_SECS). */
export const STOP_WAIT_MS = 15_000;

const kinds: Record<string, string> = {
  local_bash: "Shell",
  monitor: "Monitor",
  local_workflow: "Workflow",
  mcp_task: "MCP task",
  remote_agent: "Remote agent",
};

export function taskKind(record: ClaudeBackgroundTaskRecord): string {
  const kind = record.type ? kinds[record.type] ?? record.type : "Task";
  return record.type === "local_workflow" && record.workflowName ? `${kind} · ${record.workflowName}` : kind;
}

function isRecord(value: unknown): value is ClaudeBackgroundTaskRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function backgroundTaskOf(item: NativeItem): ClaudeBackgroundTaskRecord | null {
  return isRecord(item.backgroundTask) ? item.backgroundTask : null;
}

const runningStatuses = new Set(["pending", "running", "paused"]);

/** Whether Claude last reported it running: pending, running or paused. */
export function taskRunning(record: ClaudeBackgroundTaskRecord): boolean {
  return runningStatuses.has(record.status ?? "running");
}

/** A stop sent and still within its wait for the task's end, at `now`. */
export function stopPending(record: ClaudeBackgroundTaskRecord, now = Date.now()): boolean {
  if (!record.stopRequestedAt || record.stopError || !taskRunning(record)) return false;
  const at = Date.parse(record.stopRequestedAt);
  return Number.isFinite(at) && now - at < STOP_WAIT_MS;
}

/** Its status. `live`: Claude's runtime is connected now. */
function statusOf(record: ClaudeBackgroundTaskRecord, live: boolean, now: number): { status: ClaudeBackgroundTaskStatus; state: string; waiting: boolean } {
  const status = record.status ?? "running";
  if (runningStatuses.has(status) && !live)
    return { status: "unknown", state: "Not confirmed · was running when Claude was last connected", waiting: true };
  if (runningStatuses.has(status)) {
    const state = stopPending(record, now) ? "Stopping…"
      : record.stopRequestedAt && !record.stopError ? "Still running · no end reported since the stop"
        : status === "pending" ? "Starting" : status === "paused" ? "Paused" : "Running in the background";
    return { status: "running", state, waiting: true };
  }
  if (status === "completed") return { status: "succeeded", state: "Completed", waiting: false };
  if (status === "failed") return { status: "failed", state: record.error ? `Failed · ${record.error}` : "Failed", waiting: false };
  if (status === "stopped")
    return { status: "cancelled", state: record.reason === "worker_restart" ? "Stopped · Claude restarted" : "Stopped", waiting: false };
  return {
    status: "unknown",
    state: record.reason === "runtime_ended" ? "Status unknown · Claude's connection ended first" : "Status unknown",
    waiting: true,
  };
}

/** The background tasks of the loaded Turns, in call order; a call sent as
 *  a window preview keeps its record too. Housekeeping ones are never
 *  waiting: they are not activity. */
export function claudeBackgroundTasks(turns: readonly NativeTurn[], live: boolean, now = Date.now()): ClaudeBackgroundTaskEntry[] {
  const out: ClaudeBackgroundTaskEntry[] = [];
  for (const turn of turns) {
    for (const item of turn.items) {
      const record = backgroundTaskOf(item);
      if (!record) continue;
      const input = (item.input && typeof item.input === "object" ? item.input : {}) as Record<string, unknown>;
      const command = typeof input.command === "string" ? input.command : "";
      const label = record.description
        || (typeof input.description === "string" ? input.description : "")
        || command
        || taskKind(record);
      const status = statusOf(record, live, now);
      out.push({
        key: item.id,
        turnId: turn.id,
        itemId: item.id,
        label: label.split("\n", 1)[0],
        command,
        kind: taskKind(record),
        ...status,
        waiting: status.waiting && !record.ambient,
        item,
        record,
      });
    }
  }
  return out;
}

/** Why it cannot be stopped on its own now, or null when it can. */
export function stopUnavailable(record: ClaudeBackgroundTaskRecord, live: boolean): string | null {
  if (!taskRunning(record)) return "It has ended.";
  if (!live) return "Claude isn't connected, so nothing can be stopped now.";
  if (!record.taskId) return "Claude didn't report a task id for it, so it can't be stopped on its own.";
  return null;
}
