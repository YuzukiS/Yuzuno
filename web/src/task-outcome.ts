/** Result IDs identify submissions. Task versions or Job success never grant acceptance. */
export type OutcomePerson = { kind: string; id: string; name: string };
export type ArtifactReference = {
  jobId: string;
  attempt: string;
  path: string;
  sha256: string;
};
export type ReportedCriterion = {
  id: string;
  label: string;
  report: string;
  reportedStatus: "met" | "not_met" | "unknown";
  artifacts?: ArtifactReference[];
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
export type OutcomePage = {
  taskId: string;
  taskVersion: number;
  currentResultId: string | null;
  result: OutcomeResult | null;
  history: OutcomeHistory[];
  hasMore: boolean;
  nextBefore: number | null;
  artifacts: OutcomeArtifact[];
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
    })),
    ...(report.remaining == null ? {} : { remaining: report.remaining }),
    ...(report.nextAgentId == null ? {} : { nextAgentId: report.nextAgentId }),
    ...(report.nextStep == null ? {} : { nextStep: report.nextStep }),
  };
}
