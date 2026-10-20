/**
 * A review's scope as Core recorded it (pr_review/source/scope.rs, coverage
 * policy 3): every changed path with both sides' frozen blob and mode, every
 * fact found for it, and the first fact's state. Only Core's own records set
 * them; the model's claims never do. A path that isn't covered keeps the
 * review incomplete whatever its reason, excluded by policy included.
 * Reviews stored before coverage policy 3 have no scope and show none.
 */
type Side = { blobSha?: string | null; mode?: string | null };
type Fact = {
  kind: string;
  reason?: string | null;
  side?: string | null;
  rule?: string | null;
  totalDiffBytes?: number | null;
  remainingByteRanges?: [number, number][] | null;
  requests?: { receipt: number }[] | null;
};
export type ScopePath = {
  path: string;
  status?: string;
  head?: Side;
  mergeBase?: Side;
  state: string;
  reason?: string | null;
  facts?: Fact[];
};
export type ScopePolicy = {
  state: "absent" | "valid" | "invalid";
  path?: string;
  revision?: string | null;
  rules?: { path: string; reason: string }[];
  error?: string | null;
  changedByThisPr?: boolean;
};
export type ReviewScope = {
  version: number;
  paths: ScopePath[];
  counts: Record<string, number>;
  policy?: ScopePolicy | null;
};
/** Evidence an Agent or the user registered for a path, kept apart from the review. */
export type ScopeEvidence = {
  id: string;
  path: string;
  kind: string;
  reference: { reviewId?: string; jobId?: string; ciRunKey?: string; url?: string };
  artifactSha256?: string | null;
  artifactMatchesHeadContent?: boolean | null;
  note?: string | null;
  registeredBy?: { name?: string } | null;
  candidate?: { headSha?: string | null };
  binding: "this_candidate" | "other_candidate";
};

const states: Record<string, string> = {
  covered: "covered",
  excluded: "excluded by policy",
  unsupported: "can't be reviewed as text",
  budget_exhausted: "over budget",
  read_failed: "read failed",
  not_read: "not read",
};
const reasons: Record<string, string> = {
  binary: "binary file",
  not_utf8: "not UTF-8 text",
  symlink: "symbolic link, never followed",
  submodule: "submodule, never followed",
  special_file: "not a regular file",
  diff_exceeds_context: "its complete diff is larger than any review can read",
  context_exhausted: "the review's budget ran out first",
};
const kinds: Record<string, string> = {
  source_review: "Source review",
  build_provenance: "Build provenance",
  artifact_hash: "Artifact hash",
  signature: "Signature",
  behaviour_test: "Behaviour test",
};
const short = (sha?: string | null) => (sha && /^[a-f0-9]{40}$/i.test(sha) ? sha.slice(0, 8) : null);
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** "3 of 8 changed paths covered · 1 can't be reviewed as text · 4 not read". */
export function scopeSummary(scope: ReviewScope) {
  const parts = Object.keys(states)
    .filter((state) => state !== "covered" && (scope.counts[state] ?? 0) > 0)
    .map((state) => `${scope.counts[state]} ${states[state]}`);
  return [`${scope.counts.covered ?? 0} of ${scope.paths.length} changed paths covered`, ...parts].join(" · ");
}

/** One path that isn't covered: what it is and why, from its first fact. */
export function describeScopePath(p: ScopePath) {
  const fact = p.facts?.find((f) => f.kind === p.state);
  const state = states[p.state] ?? `state ${p.state}`;
  const reason = p.reason ? reasons[p.reason] ?? p.reason : null;
  const unsupported = p.facts?.find((f) => f.kind === "unsupported");
  const detail =
    p.state === "excluded"
      ? [fact?.rule ? `rule ${fact.rule}` : null, unsupported?.reason ? `also ${reasons[unsupported.reason] ?? unsupported.reason}` : null]
          .filter(Boolean)
          .join("; ") || null
      : p.state === "budget_exhausted" && p.reason === "diff_exceeds_context" && typeof fact?.totalDiffBytes === "number"
        ? `${reason}, ${mb(fact.totalDiffBytes)}`
        : p.state === "read_failed" && fact?.requests?.length
          ? `context read ${fact.requests.map((r) => r.receipt).join(", ")}`
          : p.state === "not_read" && fact?.remainingByteRanges?.length
            ? "partly read"
            : reason;
  const blob = short(p.head?.blobSha) ?? short(p.mergeBase?.blobSha);
  return `${p.path} · ${state}${detail ? ` (${detail})` : ""}${blob ? ` · blob ${blob}` : ""}`;
}

/** Where the review's scope came from: the base's policy file, or none. */
export function describePolicy(policy?: ScopePolicy | null) {
  if (!policy || policy.state === "absent") return "No scope policy at the base: every changed path is in scope.";
  const at = short(policy.revision) ? ` at base ${short(policy.revision)}` : "";
  const changed = policy.changedByThisPr ? " This PR changes the policy file; its change applies to later reviews only." : "";
  if (policy.state === "invalid")
    return `Scope policy ${policy.path ?? ""}${at} can't be used (${policy.error ?? "invalid"}): every changed path stays in scope.${changed}`;
  const n = policy.rules?.length ?? 0;
  return `Scope policy ${policy.path ?? ""}${at}: ${n} exclusion rule${n === 1 ? "" : "s"}. Excluded paths stay unreviewed and the review doesn't pass.${changed}`;
}

/** True when some path can never be covered at this head, whatever round runs. */
export const scopeFixedGaps = (scope: ReviewScope) =>
  scope.paths.some(
    (p) => p.state === "unsupported" || p.state === "excluded" || (p.state === "budget_exhausted" && p.reason === "diff_exceeds_context"),
  );

/** One evidence record: what it is, where it points, and whether it is bound to this review's candidate. */
export function describeEvidence(e: ScopeEvidence) {
  const ref = e.reference.reviewId
    ? `review ${e.reference.reviewId.slice(0, 8)}`
    : e.reference.jobId
      ? `Job ${e.reference.jobId.slice(0, 8)}`
      : e.reference.ciRunKey
        ? `CI run ${e.reference.ciRunKey.split(":")[2] ?? e.reference.ciRunKey}`
        : e.reference.url ?? "";
  const hash = e.artifactSha256
    ? ` · registered SHA-256 ${e.artifactSha256.slice(0, 12)}${e.artifactMatchesHeadContent === true ? " equals the reviewed head content's" : e.artifactMatchesHeadContent === false ? " differs from the reviewed head content's" : ""}`
    : "";
  const binding =
    e.binding === "this_candidate"
      ? "bound to this candidate (identity match)"
      : `from another candidate${short(e.candidate?.headSha) ? ` (head ${short(e.candidate?.headSha)})` : ""}; doesn't apply here`;
  const by = e.registeredBy?.name ? `registered by ${e.registeredBy.name}` : "registered by its author";
  return `${e.path} · ${kinds[e.kind] ?? e.kind} · ${ref}${hash} · ${binding} · ${by}; Core didn't fetch or verify the reference`;
}
