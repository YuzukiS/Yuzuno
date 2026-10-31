import type { ProjectService } from "../ProjectServices";
import { endedServiceStatuses } from "./service-observation";

/** Core's recorded user intent. It is never an observed process state. */
export type ServiceIntent = {
  revision: number;
  desiredState: "unspecified" | "stopped" | "running";
  recoveryMode: "manual";
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
};
export type ServiceControlDraft = {
  serviceId: string;
  serviceName: string;
  action: "stop" | "start";
  expectedJobId: string;
  expectedIntentRevision: number;
  sourceJobId?: string;
};
export type ServiceControlRequest = {
  requestId: string;
  expectedJobId: string;
  expectedIntentRevision: number;
  sourceJobId?: string;
  timeoutSeconds?: number;
};
export type ServiceControlReceipt = {
  serviceId: string;
  requestId: string;
  action: "stop" | "start";
  intent: ServiceIntent;
  jobId: string;
  status: string;
};

export function lifecycleKnown(service: ProjectService): boolean {
  return !!service.lifecycle && Number.isSafeInteger(service.lifecycle.intent?.revision) && service.lifecycle.intent.revision >= 0;
}

export function canStartService(service: ProjectService): boolean {
  const { job, lifecycle } = service;
  return !!job && lifecycleKnown(service) && lifecycle?.canStart === true &&
    lifecycle.sourceJobId === job.jobId && job.reserved === false && endedServiceStatuses.has(job.status);
}

/** Called on opening a confirmation. Polling must never replace these
 * identities with a newer run while the user is reading or choosing. */
export function serviceControlDraft(service: ProjectService, action: "stop" | "start"): ServiceControlDraft | null {
  if (!service.job || !lifecycleKnown(service)) return null;
  if (action === "start" ? !canStartService(service) : !service.job.canStop) return null;
  return {
    serviceId: service.id,
    serviceName: service.name,
    action,
    expectedJobId: service.job.jobId,
    expectedIntentRevision: service.lifecycle!.intent.revision,
    ...(action === "start" ? { sourceJobId: service.lifecycle!.sourceJobId! } : {}),
  };
}

export function serviceControlCurrent(service: ProjectService, draft: ServiceControlDraft): boolean {
  return service.id === draft.serviceId && service.job?.jobId === draft.expectedJobId &&
    lifecycleKnown(service) && service.lifecycle!.intent.revision === draft.expectedIntentRevision &&
    (draft.action !== "start" || service.lifecycle!.sourceJobId === draft.sourceJobId);
}

export function validServiceDuration(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 604800;
}

export function controlRequest(draft: ServiceControlDraft, requestId: string, timeoutSeconds?: number): ServiceControlRequest {
  if (draft.action === "start" && !validServiceDuration(timeoutSeconds)) throw new Error("Invalid service time limit");
  return {
    requestId,
    expectedJobId: draft.expectedJobId,
    expectedIntentRevision: draft.expectedIntentRevision,
    ...(draft.action === "start" ? { sourceJobId: draft.sourceJobId, timeoutSeconds } : {}),
  };
}

export function controlReceiptMatches(value: unknown, draft: ServiceControlDraft, request: ServiceControlRequest): value is ServiceControlReceipt {
  const receipt = value as Partial<ServiceControlReceipt> | null;
  return !!receipt && receipt.serviceId === draft.serviceId && receipt.requestId === request.requestId &&
    receipt.action === draft.action && typeof receipt.jobId === "string" && typeof receipt.status === "string" &&
    receipt.intent?.revision === draft.expectedIntentRevision + 1 && receipt.intent.appliesToJobId === receipt.jobId &&
    receipt.intent.requestId === request.requestId && receipt.intent.recoveryMode === "manual" &&
    receipt.intent.desiredState === (draft.action === "stop" ? "stopped" : "running") &&
    (draft.action === "start" ? receipt.intent.sourceJobId === draft.sourceJobId : receipt.jobId === draft.expectedJobId);
}

export function userStoppedService(service: ProjectService): boolean {
  const intent = service.lifecycle?.intent;
  return !!service.job && intent?.desiredState === "stopped" && intent.requestedBy?.kind === "user" &&
    intent.appliesToJobId === service.job.jobId;
}

/** Why a managed service has no page to show now, or null while its run is
 * running with no stop recorded for it. Only the Job's recorded status and
 * reason decide; a passed time limit alone is never an exit. */
export type ServiceIdle = "stopped" | "expired" | "ended" | "stopping" | "queued" | "unknown";
export function serviceIdle(service: ProjectService): ServiceIdle | null {
  const job = service.job;
  if (!job || !lifecycleKnown(service)) return null;
  const intent = service.lifecycle!.intent;
  if (job.status === "unknown") return "unknown";
  if (endedServiceStatuses.has(job.status)) {
    if (job.status === "cancelled" && userStoppedService(service)) return "stopped";
    return job.resultReason === "timeout" || job.reason === "timeout" ? "expired" : "ended";
  }
  if (job.status === "cancelling" || (intent.desiredState === "stopped" && intent.appliesToJobId === job.jobId)) return "stopping";
  return job.status === "running" ? null : "queued";
}
