/** Result IDs identify submissions. Task versions or Job success never grant acceptance. */
export type OutcomePerson = { kind: string; id: string; name: string };
export type ArtifactReference = {
  jobId: string;
  attempt: string;
  path: string;
  sha256: string;
};
/** One of the task's research records a criterion cites (T-17), fixed as it
 * read when the result was submitted. */
export type OutcomeRecord = {
  activitySeq: number;
  record?: {
    kind?: string;
    type?: string;
    id?: string;
    title?: string;
    status?: string;
    counts?: Record<"included" | "excluded" | "missing" | "not_done", number>;
  } | null;
  version?: number | null;
  producer?: OutcomePerson | null;
  at?: string | null;
};
export type ReportedCriterion = {
  id: string;
  label: string;
  report: string;
  reportedStatus: "met" | "not_met" | "unknown";
  artifacts?: ArtifactReference[];
  records?: OutcomeRecord[];
};
export type OutcomeReport = {
  criteria: ReportedCriterion[];
  remaining?: string | null;
  nextAgentId?: string | null;
  nextAgent?: OutcomePerson | null;
  nextStep?: string | null;
};
export type OutcomeResult = {
  id?: string | null;
  summary: string;
  links: { label: string; url: string }[];
  taskVersion?: number | null;
  status?: string;
  reportedAt?: string;
  reportedBy?: OutcomePerson;
  source?: {
    agentId: string;
    turnId?: string | null;
    sessionId?: string | null;
  } | null;
  outcome?: OutcomeReport | null;
  acceptanceContext?: {
    text: string | null;
    source: "dispatch" | "registration" | "not_recorded";
    dispatchId?: string | null;
    taskVersion?: number | null;
    activitySeq?: number | null;
    capturedAt?: string;
  } | null;
};

/** An intermediate result (YN-4): submitted with status doing, one step of
 * work that goes on, and its task still in progress. It is the newest step,
 * not an earlier result that work has moved past. */
export const isStepResult = (task: { status: string; result?: OutcomeResult | null }) =>
  task.status === "doing" && task.result?.status === "doing";
export type OutcomeHistory = {
  resultId: string | null;
  seq: number;
  taskVersion?: number | null;
  summary: string;
  reportedAt?: string;
  reportedBy?: OutcomePerson;
  status?: string;
};
export type OutcomeArtifact = ArtifactReference & {
  criterionId: string;
  state:
    | "recorded_match"
    | "job_missing"
    | "attempt_mismatch"
    | "artifact_missing"
    | "artifact_mismatch";
  jobStatus?: string | null;
  checkedAt?: string | null;
  finishedAt?: string | null;
  bytes?: number | null;
  index?: number | null;
  downloadable?: boolean;
  machineName?: string | null;
};
/** Where a cited record's line stands now, beside the version the result cites. */
export type OutcomeRecordNow = {
  criterionId: string;
  activitySeq: number;
  state: "readable" | "missing";
  revisedBy?: number | null;
  latestActivitySeq?: number | null;
};
export type OutcomePage = {
  taskId: string;
  taskVersion: number;
  currentResultId: string | null;
  result: OutcomeResult | null;
  history: OutcomeHistory[];
  hasMore: boolean;
  nextBefore: number | null;
  artifacts: OutcomeArtifact[];
  records?: OutcomeRecordNow[];
  note?: string;
};

export function outcomeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** A later task edit does not make an old submission a new outcome version. */
export function resultVersion(
  result: OutcomeResult | OutcomeHistory | null | undefined,
): string | null {
  return result?.taskVersion == null ? null : `v${result.taskVersion}`;
}

export function reportCounts(report?: OutcomeReport | null) {
  const criteria = report?.criteria || [];
  return {
    total: criteria.length,
    reported: criteria.filter((c) => c.reportedStatus === "met").length,
    missing: criteria.filter((c) => c.reportedStatus === "not_met").length,
    unknown: criteria.filter((c) => c.reportedStatus === "unknown").length,
  };
}

/** Only author-entered fields may be resubmitted; derived actor snapshots are Core's. */
export function outcomeInput(report?: OutcomeReport | null) {
  if (!report) return undefined;
  return {
    criteria: report.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      report: c.report,
      reportedStatus: c.reportedStatus,
      artifacts: c.artifacts || [],
      // A cited record is named by its activity; Core fixes the rest.
      ...(c.records?.length
        ? { records: c.records.map((r) => ({ activitySeq: r.activitySeq })) }
        : {}),
    })),
    ...(report.remaining == null ? {} : { remaining: report.remaining }),
    ...(report.nextAgentId == null ? {} : { nextAgentId: report.nextAgentId }),
    ...(report.nextStep == null ? {} : { nextStep: report.nextStep }),
  };
}
