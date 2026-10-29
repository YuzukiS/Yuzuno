import { isSubAgentCall } from "./claude-subagents.ts";
import type { NativeItem } from "./types";

/**
 * The state a tool call's capsule says (T-9, tool-call.ts). Only the fields
 * the harness itself reported are read here, and a call that returned is not
 * work that succeeded: `returned` is the neutral state and no capsule claims
 * success.
 *  - `running`: last reported as running, with this turn still followed.
 *  - `unconfirmed`: reported as running with the turn no longer followed, or
 *    reported as unknown. Both are what a tool row shows as Unconfirmed.
 *  - `failed`: the harness said failed, or a command exited non-zero.
 *  - `returned`: it ended and reported a result.
 * An Item that carries no state of its own — a reasoning summary, a proposed
 * plan — has none, and its capsule says nothing about one. Neither does a
 * Claude sub-agent's call: what Claude records for it (running in the
 * background, paused, stopped) is told by its own row, not from `status`.
 */
export type CallState = "failed" | "unconfirmed" | "running" | "returned";

/** `executionUnconfirmed`: this turn's execution is no longer being followed,
 * so a call still reported as running has no confirmed state (see Turn). */
export function callState(item: NativeItem, executionUnconfirmed: boolean): CallState | null {
  if (isSubAgentCall(item)) return null;
  const status = typeof item.status === "string" ? item.status : "";
  if (/inProgress|running/.test(status)) return executionUnconfirmed ? "unconfirmed" : "running";
  if (status === "failed") return "failed";
  if (status === "unknown") return "unconfirmed";
  // A non-zero exit is the command's own report, not a verdict on the work.
  if (typeof item.exitCode === "number") return item.exitCode === 0 ? "returned" : "failed";
  return status ? "returned" : null;
}
