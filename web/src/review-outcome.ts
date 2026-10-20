/** Display stored verdicts. Never reinterpret older findings as approval. */
export type ReviewOutcome = {
  status: string;
  conclusion: string | null;
  policyVersion?: number | null;
  reasonCodes?: string[] | null;
};

export const reviewConclusions: Record<string, string> = {
  no_findings: "No actionable findings",
  approved_with_notes: "Passed · non-blocking suggestions",
  changes_requested: "Changes requested",
  unknown: "Conclusion unknown",
};

const reasons: Record<string, string> = {
  coverage_incomplete: "Review coverage is incomplete",
  unsupported_source: "Some source cannot be inspected by this reviewer",
  diff_too_large: "A changed file's complete diff is larger than any review can read",
  scope_excluded: "Some changed paths are excluded by the base's scope policy and stay unreviewed",
  scope_policy_invalid: "The base's scope policy file can't be used; every changed path stays in scope",
  model_unknown: "The reviewer could not reach a conclusion",
  verdict_conflict: "The correctness verdict conflicts with blocking findings",
  invalid_report: "The reviewer returned an invalid report",
  execution_failed: "The review could not execute successfully",
  execution_unconfirmed: "Review completion could not be confirmed",
  execution_cancelled: "The review was cancelled",
};

export const reviewReasons = (r: ReviewOutcome) =>
  (r.reasonCodes || []).map((code) => reasons[code] || `Unrecognized review reason: ${code}`);

export const reviewPassed = (r: ReviewOutcome) =>
  r.status === "completed" &&
  (r.conclusion === "no_findings" ||
    (r.conclusion === "approved_with_notes" && (r.policyVersion === 2 || r.policyVersion === 3)));
