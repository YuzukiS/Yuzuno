import type { ProjectService } from "../ProjectServices";
import { endedServiceStatuses } from "./service-observation";
import { currentRetry, outcomeUnknown, recoveryActive, recoveryLineage, recoveryOf, type ServiceRecovery } from "./service-recovery";

/** Core's recorded user intent. It is never an observed process state. */
export type ServiceIntent = {
  revision: number;
  desiredState: "unspecified" | "stopped" | "running";
  recoveryMode: "manual" | "bounded";
  requestedAt: string | null;
  requestedBy: { kind: "user" } | null;
  appliesToJobId: string | null;
  sourceJobId: string | null;
  requestId: string | null;
};
export type ServiceLifecycleInfo = {
  intent: ServiceIntent;
  canStart: boolean;
  startBlockedCode: string | null;
  startBlockedReason: string | null;
  sourceJobId: string | null;
  /** Whether the current Job's outcome is unconfirmed (T-14 recovery Cores). */
  outcomeUnknown?: boolean;
  /** Bounded recovery; absent on older Cores (see service-recovery.ts). */
  recovery?: ServiceRecovery | null;
};
/** stop and start name the run and revision the confirmation opened with;
 * recovery is the opt-out of later automatic retries, sent from the panel. */
export type ServiceControlAction = "stop" | "start" | "recovery";
export type ServiceControlDraft = {
  serviceId: string;
  serviceName: string;
  action: ServiceControlAction;
  expectedJobId: string;
  expectedIntentRevision: number;
  sourceJobId?: string;
  /** The recovery window's Jobs as read: Core may answer a stop or opt-out
   * from this reading for the window's current Job (design v3.4 §6). */
  lineage?: string[];
};
export type ServiceControlRequest = {
  requestId: string;
  expectedJobId: string;
  expectedIntentRevision: number;
  sourceJobId?: string;
  timeoutSeconds?: number;
  recovery?: { mode: "bounded" };
  mode?: "manual";
};
export type ServiceControlReceipt = {
  serviceId: string;
  requestId: string;
  action: ServiceControlAction;
  intent: ServiceIntent;
  jobId: string;
  status: string;
  cancelledRetryJobId?: string | null;
};

export function lifecycleKnown(service: ProjectService): boolean {
  return !!service.lifecycle && Number.isSafeInteger(service.lifecycle.intent?.revision) && service.lifecycle.intent.revision >= 0;
}

export function canStartService(service: ProjectService): boolean {
  const { job, lifecycle } = service;
  return !!job && lifecycleKnown(service) && lifecycle?.canStart === true &&
    lifecycle.sourceJobId === job.jobId && job.reserved === false && endedServiceStatuses.has(job.status);
}

/** Opting out closes later automatic retries; it is offered only while some
 * can still follow. */
export function canOptOut(service: ProjectService): boolean {
  return !!service.job && lifecycleKnown(service) && recoveryActive(recoveryOf(service));
}

/** Called on opening a confirmation. Polling must never replace these
 * identities with a newer run while the user is reading or choosing. */
export function serviceControlDraft(service: ProjectService, action: ServiceControlAction): ServiceControlDraft | null {
  if (!service.job || !lifecycleKnown(service)) return null;
  if (action === "start" ? !canStartService(service) : action === "stop" ? !service.job.canStop : !canOptOut(service)) return null;
  const lineage = recoveryLineage(recoveryOf(service));
  return {
    serviceId: service.id,
    serviceName: service.name,
    action,
    expectedJobId: service.job.jobId,
    expectedIntentRevision: service.lifecycle!.intent.revision,
    ...(action === "start" ? { sourceJobId: service.lifecycle!.sourceJobId! }
      : { lineage: lineage.includes(service.job.jobId) ? lineage : [service.job.jobId] }),
  };
}

/** Whether a confirmation still matches what Core reports. An automatic
 * retry never changes the revision, so a stop or opt-out from before it
 * still holds while both Jobs are of the same window; a user's choice or
 * another run taking over does not. */
export function serviceControlCurrent(service: ProjectService, draft: ServiceControlDraft): boolean {
  if (service.id !== draft.serviceId || !service.job || !lifecycleKnown(service) ||
    service.lifecycle!.intent.revision !== draft.expectedIntentRevision) return false;
  if (draft.action === "start") return service.job.jobId === draft.expectedJobId && service.lifecycle!.sourceJobId === draft.sourceJobId;
  if (service.job.jobId === draft.expectedJobId) return true;
  const lineage = recoveryLineage(recoveryOf(service));
  return lineage.includes(draft.expectedJobId) && lineage.includes(service.job.jobId);
}

export function validServiceDuration(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 604800;
}

/** At sending: the window's Jobs Core may answer for are those the
 * confirmation opened with and those read since, while that reading is of
 * the same window. A Job queued after the last read leaves the reply
 * unconfirmed until a read shows this request recorded. */
export function lineageAtSend(service: ProjectService, draft: ServiceControlDraft): ServiceControlDraft {
  if (draft.action === "start") return draft;
  const now = recoveryLineage(recoveryOf(service));
  if (!now.includes(draft.expectedJobId)) return draft;
  return { ...draft, lineage: [...new Set([...(draft.lineage ?? [draft.expectedJobId]), ...now])] };
}

/** A start asks for bounded recovery only when the user ticked it, on this
 * start; an opt-out always asks for manual. */
export function controlRequest(draft: ServiceControlDraft, requestId: string, timeoutSeconds?: number, recovery = false): ServiceControlRequest {
  if (draft.action === "start" && !validServiceDuration(timeoutSeconds)) throw new Error("Invalid service time limit");
  return {
    requestId,
    expectedJobId: draft.expectedJobId,
    expectedIntentRevision: draft.expectedIntentRevision,
    ...(draft.action === "start" ? { sourceJobId: draft.sourceJobId, timeoutSeconds, ...(recovery ? { recovery: { mode: "bounded" as const } } : {}) }
      : draft.action === "recovery" ? { mode: "manual" as const } : {}),
  };
}

export function controlReceiptMatches(value: unknown, draft: ServiceControlDraft, request: ServiceControlRequest): value is ServiceControlReceipt {
  const receipt = value as Partial<ServiceControlReceipt> | null;
  if (!receipt || receipt.serviceId !== draft.serviceId || receipt.requestId !== request.requestId || receipt.action !== draft.action ||
    typeof receipt.jobId !== "string" || typeof receipt.status !== "string" || !receipt.intent ||
    receipt.intent.revision !== draft.expectedIntentRevision + 1 || receipt.intent.requestId !== request.requestId) return false;
  const { intent, jobId } = receipt;
  if (draft.action === "start") {
    return intent.appliesToJobId === jobId && intent.desiredState === "running" && intent.sourceJobId === draft.sourceJobId &&
      intent.recoveryMode === (request.recovery ? "bounded" : "manual");
  }
  // From an older reading Core answers for the window's current Job.
  const lineage = draft.lineage ?? [draft.expectedJobId];
  if (!lineage.includes(jobId)) return false;
  if (draft.action === "stop") {
    return intent.appliesToJobId === jobId && intent.desiredState === "stopped" && (intent.recoveryMode === "manual" || intent.recoveryMode === "bounded");
  }
  return intent.recoveryMode === "manual" && (receipt.cancelledRetryJobId === null || typeof receipt.cancelledRetryJobId === "string");
}

export function userStoppedService(service: ProjectService): boolean {
  const intent = service.lifecycle?.intent;
  return !!service.job && intent?.desiredState === "stopped" && intent.requestedBy?.kind === "user" &&
    intent.appliesToJobId === service.job.jobId;
}

/** Why a managed service has no page to show now, or null while its run is
 * running with no stop recorded for it. Only the Job's recorded status and
 * reason decide; a passed time limit alone is never an exit. */
export type ServiceIdle = "stopped" | "expired" | "ended" | "stopping" | "queued" | "unknown" | "retryWaiting" | "retryStarting";
export function serviceIdle(service: ProjectService): ServiceIdle | null {
  const job = service.job;
  if (!job || !lifecycleKnown(service)) return null;
  const intent = service.lifecycle!.intent;
  if (outcomeUnknown(service)) return "unknown";
  if (endedServiceStatuses.has(job.status)) {
    if (job.status === "cancelled" && userStoppedService(service)) return "stopped";
    return job.resultReason === "timeout" || job.reason === "timeout" ? "expired" : "ended";
  }
  if (job.status === "cancelling" || (intent.desiredState === "stopped" && intent.appliesToJobId === job.jobId)) return "stopping";
  if (job.status === "running") return null;
  // An automatic retry that hasn't run yet: waiting for its time or a slot,
  // or in launch preparation.
  const recovery = recoveryOf(service);
  if (!currentRetry(service, recovery)) return "queued";
  return recovery!.launch === "starting" ? "retryStarting" : recoveryActive(recovery) ? "retryWaiting" : "queued";
}
