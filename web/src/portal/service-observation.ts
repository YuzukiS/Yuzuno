/** A proof made by this browser, at the time it actually finished. Core's
 * HTTP probe is a different observation and never fills this timestamp. */
export type ServiceBrowserReach = {
  state: "checking" | "proven" | "unproven" | "notChecked";
  url?: string;
  checkedAt?: string;
  jobId?: string | null;
};

export const endedServiceStatuses = new Set(["succeeded", "failed", "cancelled", "interrupted", "rejected"]);

export function validServiceTime(at: string | null | undefined): at is string {
  return typeof at === "string" && Number.isFinite(Date.parse(at));
}

/** A planned time limit, not proof of an exit. No clock comparison here
 * changes the observed run state. */
export function serviceDeadline(startedAt?: string | null, timeoutSeconds?: number | null): string | null {
  if (!validServiceTime(startedAt) || !Number.isFinite(timeoutSeconds) || !timeoutSeconds || timeoutSeconds <= 0) return null;
  const end = Date.parse(startedAt) + timeoutSeconds * 1000;
  return Number.isFinite(end) && Math.abs(end) <= 8.64e15 ? new Date(end).toISOString() : null;
}

export function currentBrowserReach(reach: ServiceBrowserReach | undefined, jobId: string | undefined, url: string | null): ServiceBrowserReach {
  if (!reach || !url || (reach.url && reach.url !== url)) return { state: "notChecked" };
  if (reach.jobId !== undefined && (reach.jobId ?? undefined) !== jobId) return { state: "notChecked" };
  return reach;
}
