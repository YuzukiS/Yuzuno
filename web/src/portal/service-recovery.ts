import type { ProjectService } from "../ProjectServices";
import { timeFormatter, type TimeDisplay } from "../time-preferences";
import { validServiceTime } from "./service-observation";

// T-14 bounded recovery, as Core reports it (service.lifecycle.recovery,
// design v3.4 §3). The panel only reads it: no clock or poll here retries,
// starts or stops anything.

const states = ["off", "armed", "waiting", "retry", "exhausted", "ended", "halted"] as const;
export type RecoveryState = (typeof states)[number];
export type RecoveryLaunch = "queued" | "starting" | "running" | "unknown" | "stopping";
export type RecoveryHalt = "user_stop" | "opted_out" | "inputs_changed" | "core_restart" | "host_restart" | "lifetime_reached"
  | "insufficient_time" | "oom" | "unknown_outcome" | "cancelled" | "launch_refused" | "superseded";
export type RecoveryFailure = { kind: "exit" | "signal" | "core_dump"; code?: number; signal?: string; jobId: string; endedAt: string };
/** One Job of the window, root first (retry 0). outcome is null until it ends. */
export type RecoveryAttempt = { retry: number; jobId: string; startedAt: string | null; endedAt: string | null; outcome: string | null };
export type ServiceRecovery = {
  mode: "manual" | "bounded";
  state: RecoveryState;
  /** The current Job's launch stage; null once it has ended. */
  launch: RecoveryLaunch | null;
  /** The current retry Job's own waiting reason in Jobs, as Jobs words it. */
  queueReason: string | null;
  retry: { scheduled: number; started: number; max: number };
  /** Delays in seconds before retry 1, 2, 3. */
  schedule: number[];
  /** Fixed once, at the root run's first recorded start; retries share it. */
  deadlineAt: string | null;
  retryJobId: string | null;
  /** The earliest time a retry may be tried, never a promised start. */
  notBefore: string | null;
  lastFailure: RecoveryFailure | null;
  haltedReason: RecoveryHalt | null;
  haltedAt: string | null;
  attempts: RecoveryAttempt[];
  /** Core's time when it read this, for a coarse "in about N minutes". */
  observedAt: string;
};

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Core's recovery block when this page can read it; none from an older Core
 * or a malformed one, which then shows the manual panel it always had. */
export function recoveryOf(service: ProjectService): ServiceRecovery | null {
  const value = service.lifecycle?.recovery as Partial<ServiceRecovery> | null | undefined;
  if (!value || typeof value !== "object") return null;
  if ((value.mode !== "manual" && value.mode !== "bounded") || !states.includes(value.state as RecoveryState)) return null;
  const retry = value.retry;
  if (!retry || !count(retry.scheduled) || !count(retry.started) || !count(retry.max)) return null;
  if (!Array.isArray(value.schedule) || !value.schedule.every((delay) => count(delay) && delay > 0)) return null;
  if (!Array.isArray(value.attempts)) return null;
  return value as ServiceRecovery;
}

/** Whether later retries can still follow: the only time opt-out is offered. */
export const recoveryActive = (recovery: ServiceRecovery | null): boolean =>
  recovery?.mode === "bounded" && (recovery.state === "armed" || recovery.state === "waiting" || recovery.state === "retry");

/** Whether this run's window was armed at all, so its state or end is worth
 * saying. A manual start's block is off with no reason. */
export const recoveryWindow = (recovery: ServiceRecovery | null): recovery is ServiceRecovery =>
  !!recovery && (recovery.state !== "off" || recovery.haltedReason === "opted_out");

/** The delays the Start dialog offers, from Core's plan; none from an older Core. */
export function recoveryOffer(service: ProjectService): number[] | null {
  const recovery = recoveryOf(service);
  return recovery && recovery.schedule.length > 0 ? recovery.schedule : null;
}

/** Whether the current Job's outcome is unconfirmed, a cancel asked of one
 * included. An older Core says only the Job's status. */
export function outcomeUnknown(service: ProjectService): boolean {
  if (!service.job) return false;
  const reported = service.lifecycle?.outcomeUnknown;
  return typeof reported === "boolean" ? reported : service.job.status === "unknown";
}

/** The window's Jobs as this reading has them: a stop or opt-out from it may
 * be answered for any of them (the lineage rule, design v3.4 §6). */
export function recoveryLineage(recovery: ServiceRecovery | null): string[] {
  if (!recovery) return [];
  return [...new Set([...recovery.attempts.map((attempt) => attempt.jobId), ...(recovery.retryJobId ? [recovery.retryJobId] : [])])]
    .filter((id) => typeof id === "string" && id.length > 0);
}

/** The current Job's place in the window when it is an automatic retry. */
export function currentRetry(service: ProjectService, recovery: ServiceRecovery | null): RecoveryAttempt | null {
  const jobId = service.job?.jobId;
  return recovery?.attempts.find((attempt) => attempt.jobId === jobId && attempt.retry > 0) ?? null;
}

/** An attempt's recorded end, in Core's closed set. Anything else is shown
 * as written. */
export type RecoveryOutcome = { kind: "exit"; code: number } | { kind: "signal"; signal: string }
  | { kind: "core_dump" | "lifetime" | "cancelled" | "rejected" | "unknown" | "succeeded" | "oom" | "interrupted" | "failed" }
  | { kind: "other"; text: string };
export function recoveryOutcome(outcome: string | null): RecoveryOutcome | null {
  if (outcome === null) return null;
  const exit = /^exit:(-?\d+)$/.exec(outcome);
  if (exit) return { kind: "exit", code: Number(exit[1]) };
  const signal = /^signal:([A-Z0-9+]+)$/.exec(outcome);
  if (signal) return { kind: "signal", signal: signal[1] };
  if (["core_dump", "lifetime", "cancelled", "rejected", "unknown", "succeeded", "oom", "interrupted", "failed"].includes(outcome)) return { kind: outcome } as RecoveryOutcome;
  return { kind: "other", text: outcome };
}

const clock = timeFormatter({ hour: "2-digit", minute: "2-digit" });
/** "15:04": a retry's time is minutes away, so the clock time alone. */
export function clockTime(iso: string | null | undefined, time: TimeDisplay): string {
  return validServiceTime(iso) ? clock(time).format(new Date(iso)) : "";
}

/** Whole minutes from Core's reading to notBefore, or null once it has passed
 * (or either time is missing). Coarse, and never negative. */
export function minutesUntil(notBefore: string | null, observedAt: string | null): number | null {
  if (!validServiceTime(notBefore) || !validServiceTime(observedAt)) return null;
  const seconds = (Date.parse(notBefore) - Date.parse(observedAt)) / 1000;
  return seconds > 0 ? Math.round(seconds / 60) : null;
}
