/** A task status change an Agent proposed in a result, as Core shows it (T-39). */
import type { z } from "zod";
import type { componentProps } from "./contract";

export type TaskStatusProps = z.infer<typeof componentProps.TaskStatus>;
export type TaskStatus = TaskStatusProps["status"];

export interface TaskFacts {
  id: string;
  title: string;
  status: string;
  version: number;
  blocker: string;
  assignee: string | null;
  archived: boolean;
}

export interface ProposalAttempt {
  requestId: string;
  action: "confirm" | "decline";
  status: string | null;
  reason: string | null;
  expectedVersion: number | null;
  state: "pending" | "applied" | "failed" | "declined";
  error: string | null;
  taskVersion: number | null;
  by: { name: string };
  at: string;
}

export interface ProposalView {
  resultId: string;
  agentId: string;
  proposal: TaskStatusProps;
  task: TaskFacts | null;
  blocked: string | null;
  attempts: ProposalAttempt[];
}

/** A decision sent to Core; kept until Core answers it, so it can be retried as is. */
export interface Decision {
  requestId: string;
  action: "confirm" | "decline";
  status?: string;
  reason?: string;
  expectedVersion?: number;
}

export const STATUS_LABELS: Record<string, string> = {
  todo: "To do",
  doing: "Doing",
  blocked: "Blocked",
  review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};
export const statusLabel = (status: string | null | undefined) =>
  (status && STATUS_LABELS[status]) || status || "—";

/** The applied or declined decision: after it, the proposal changes nothing more. */
export const finalAttempt = (view: ProposalView | null) =>
  view?.attempts.find((a) => a.state === "applied" || a.state === "declined");

/** What confirming would do, in the user's words. */
export function impact(task: TaskFacts, status: string, reason: string): string[] {
  const lines = [`${task.id} goes from ${statusLabel(task.status)} to ${statusLabel(status)}.`];
  if (status === "blocked" && reason.trim()) lines.push("Its blocker becomes your reason.");
  else if (task.blocker && task.status === "blocked") lines.push(`Its blocker stays: “${task.blocker}”.`);
  if (status === "done" || status === "cancelled")
    lines.push(`This closes ${task.id}. Only confirm it if the work is really ${status === "done" ? "finished" : "dropped"}.`);
  return lines;
}

/** Why the last attempt of this window failed, said plainly. */
export function failureText(attempt: ProposalAttempt, task: TaskFacts | null): string {
  const error = attempt.error || "";
  if (error.startsWith("version_conflict"))
    return `${task?.id || "The task"} changed while you were deciding${task ? ` (now version ${task.version}, ${statusLabel(task.status)})` : ""}. Nothing was changed. Check it above and confirm again.`;
  return `Nothing was changed: ${error.replace(/^[a-z_]+: /, "") || "Core gave no reason"}`;
}

const DRAFT_PREFIX = "yuzuno.taskProposal.";
export function readDecision(storage: Storage, resultId: string): Decision | null {
  try {
    const value = JSON.parse(storage.getItem(DRAFT_PREFIX + resultId) || "null");
    return value && typeof value.requestId === "string" ? value : null;
  } catch {
    return null;
  }
}
export function saveDecision(storage: Storage, resultId: string, decision: Decision | null) {
  try {
    if (decision) storage.setItem(DRAFT_PREFIX + resultId, JSON.stringify(decision));
    else storage.removeItem(DRAFT_PREFIX + resultId);
  } catch {
    /* storage unavailable: a lost reply can still be checked from Core */
  }
}
