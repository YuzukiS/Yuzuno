/** A task status change an Agent proposed in a result, as Core shows it (T-39). */
import type { z } from "zod";
import type { componentProps } from "./contract";
import { strings, type Language } from "../i18n";

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

// The proposal's own words in the interface language (T-189). Task IDs,
// titles, the blocker, the Agent's and the person's reasons, names and
// Core's error are shown as they are.
const statusText = strings({
  labels: {
    todo: "To do",
    doing: "Doing",
    blocked: "Blocked",
    review: "In review",
    done: "Done",
    cancelled: "Cancelled",
  } as Record<string, string>,
  goes: (id: string, from: string, to: string) => `${id} goes from ${from} to ${to}.`,
  blockerReason: "Its blocker becomes your reason.",
  blockerStays: (blocker: string) => `Its blocker stays: “${blocker}”.`,
  closes: (id: string, done: boolean) => `This closes ${id}. Only confirm it if the work is really ${done ? "finished" : "dropped"}.`,
  theTask: "The task",
  changed: (id: string, now: string) => `${id} changed while you were deciding${now}. Nothing was changed. Check it above and confirm again.`,
  now: (version: number, status: string) => ` (now version ${version}, ${status})`,
  nothing: (reason: string) => `Nothing was changed: ${reason}`,
  noReason: "Core gave no reason",
}, {
  labels: {
    todo: "待办",
    doing: "进行中",
    blocked: "受阻",
    review: "待审阅",
    done: "已完成",
    cancelled: "已取消",
  },
  goes: (id, from, to) => `${id} 从“${from}”变为“${to}”。`,
  blockerReason: "它的受阻原因会变成你填写的理由。",
  blockerStays: (blocker) => `它的受阻原因保持不变：“${blocker}”。`,
  closes: (id, done) => `这会关闭 ${id}。只有在工作确实${done ? "已经完成" : "已经放弃"}时才确认。`,
  theTask: "任务",
  changed: (id, now) => `你在决定时 ${id} 发生了变化${now}。没有做任何更改。请查看上面的情况后再确认。`,
  now: (version, status) => `（现在是版本 ${version}，${status}）`,
  nothing: (reason) => `没有做任何更改：${reason}`,
  noReason: "Core 没有给出原因",
});
export const STATUS_LABELS: Record<string, string> = statusText("en").labels;
export const statusLabel = (status: string | null | undefined, language: Language = "en") =>
  (status && statusText(language).labels[status]) || status || "—";

/** The applied or declined decision: after it, the proposal changes nothing more. */
export const finalAttempt = (view: ProposalView | null) =>
  view?.attempts.find((a) => a.state === "applied" || a.state === "declined");

/** What confirming would do, in the user's words. */
export function impact(task: TaskFacts, status: string, reason: string, language: Language = "en"): string[] {
  const t = statusText(language);
  const lines = [t.goes(task.id, statusLabel(task.status, language), statusLabel(status, language))];
  if (status === "blocked" && reason.trim()) lines.push(t.blockerReason);
  else if (task.blocker && task.status === "blocked") lines.push(t.blockerStays(task.blocker));
  if (status === "done" || status === "cancelled") lines.push(t.closes(task.id, status === "done"));
  return lines;
}

/** Why the last attempt of this window failed, said plainly. */
export function failureText(attempt: ProposalAttempt, task: TaskFacts | null, language: Language = "en"): string {
  const t = statusText(language);
  const error = attempt.error || "";
  if (error.startsWith("version_conflict"))
    return t.changed(task?.id || t.theTask, task ? t.now(task.version, statusLabel(task.status, language)) : "");
  return t.nothing(error.replace(/^[a-z_]+: /, "") || t.noReason);
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
