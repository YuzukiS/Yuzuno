import { isSubAgentCall } from "./claude-subagents.ts";
import type { NativeItem } from "./types";

/**
 * What the capsules in a Turn's Tool activity say (T-9). Only the fields the
 * harness itself reported are read here, and a call that returned is not
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

/** Worth saying first, when one group holds calls in several states. */
const notable: readonly CallState[] = ["failed", "unconfirmed", "running", "returned"];

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

/** One group of calls as its capsule shows it. `part`: how many of the
 * group's calls are in `state`, so a mixed group can name the number. */
export type ToolCapsule = {
  key: string;
  label: string;
  count: number;
  state: CallState | null;
  part: number;
};

/** `groups`: `toolActivityCounts`, which owns how a tool is named and
 * counted; the state below is all this adds. */
export function toolCapsules(
  groups: readonly { key: string; label: string; count: number; items: readonly NativeItem[] }[],
  executionUnconfirmed: boolean,
): ToolCapsule[] {
  return groups.map(({ key, label, count, items }) => {
    const states = items.map((item) => callState(item, executionUnconfirmed));
    const state = notable.find((candidate) => states.includes(candidate)) ?? null;
    return {
      key,
      label,
      count,
      state,
      part: state ? states.filter((held) => held === state).length : 0,
    };
  });
}
