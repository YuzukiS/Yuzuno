/**
 * A review's scope as Core recorded it (pr_review/source/scope.rs, coverage
 * policy 3): every changed path with both sides' frozen blob and mode, every
 * fact found for it, and the first fact's state. Only Core's own records set
 * them; the model's claims never do. A path that isn't covered keeps the
 * review incomplete whatever its reason, excluded by policy included.
 * Reviews stored before coverage policy 3 have no scope and show none.
 */
import { strings, type Language } from "./i18n";

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

// The scope's own words in the interface language (T-189). Paths, rules,
// blobs, receipts, the policy file and its error, references, names and an
// author's note are shown as they are.
const scopeText = strings({
  states: {
    covered: "covered",
    excluded: "excluded by policy",
    unsupported: "can't be reviewed as text",
    budget_exhausted: "over budget",
    read_failed: "read failed",
    not_read: "not read",
  } as Record<string, string>,
  reasons: {
    binary: "binary file",
    not_utf8: "not UTF-8 text",
    symlink: "symbolic link, never followed",
    submodule: "submodule, never followed",
    special_file: "not a regular file",
    diff_exceeds_context: "its complete diff is larger than any review can read",
    context_exhausted: "the review's budget ran out first",
  } as Record<string, string>,
  kinds: {
    source_review: "Source review",
    build_provenance: "Build provenance",
    artifact_hash: "Artifact hash",
    signature: "Signature",
    behaviour_test: "Behaviour test",
  } as Record<string, string>,
  covered: (covered: number, total: number) => `${covered} of ${total} changed paths covered`,
  count: (count: number, state: string) => `${count} ${state}`,
  state: (state: string) => `state ${state}`,
  rule: (rule: string) => `rule ${rule}`,
  also: (reason: string) => `also ${reason}`,
  and: "; ",
  size: (reason: string, size: string) => `${reason}, ${size}`,
  receipts: (receipts: string) => `context read ${receipts}`,
  partly: "partly read",
  path: (path: string, state: string, detail: string | null, blob: string | null) =>
    `${path} · ${state}${detail ? ` (${detail})` : ""}${blob ? ` · blob ${blob}` : ""}`,
  noPolicy: "No scope policy at the base: every changed path is in scope.",
  atBase: (sha: string) => ` at base ${sha}`,
  policyChanged: " This PR changes the policy file; its change applies to later reviews only.",
  invalid: "invalid",
  unusable: (path: string, at: string, error: string, changed: string) =>
    `Scope policy ${path}${at} can't be used (${error}): every changed path stays in scope.${changed}`,
  rules: (path: string, at: string, n: number, changed: string) =>
    `Scope policy ${path}${at}: ${n} exclusion rule${n === 1 ? "" : "s"}. Excluded paths stay unreviewed and the review doesn't pass.${changed}`,
  review: (id: string) => `review ${id}`,
  job: (id: string) => `Job ${id}`,
  run: (id: string) => `CI run ${id}`,
  hash: (sha: string, matches: boolean | null | undefined) =>
    ` · registered SHA-256 ${sha}${matches === true ? " equals the reviewed head content's" : matches === false ? " differs from the reviewed head content's" : ""}`,
  bound: "bound to this candidate (identity match)",
  other: (head: string | null) => `from another candidate${head ? ` (head ${head})` : ""}; doesn't apply here`,
  by: (name: string) => `registered by ${name}`,
  byAuthor: "registered by its author",
  evidence: (path: string, kind: string, ref: string, hash: string, binding: string, by: string) =>
    `${path} · ${kind} · ${ref}${hash} · ${binding} · ${by}; Core didn't fetch or verify the reference`,
}, {
  states: {
    covered: "已覆盖",
    excluded: "被策略排除",
    unsupported: "无法作为文本审查",
    budget_exhausted: "超出预算",
    read_failed: "读取失败",
    not_read: "未读取",
  },
  reasons: {
    binary: "二进制文件",
    not_utf8: "不是 UTF-8 文本",
    symlink: "符号链接，从不跟随",
    submodule: "子模块，从不跟随",
    special_file: "不是普通文件",
    diff_exceeds_context: "其完整 diff 超过任何审查能读取的大小",
    context_exhausted: "审查预算先用完了",
  },
  kinds: {
    source_review: "源码审查",
    build_provenance: "构建来源",
    artifact_hash: "产物哈希",
    signature: "签名",
    behaviour_test: "行为测试",
  },
  covered: (covered, total) => `${total} 个变更路径中已覆盖 ${covered} 个`,
  count: (count, state) => `${state} ${count} 个`,
  state: (state) => `状态 ${state}`,
  rule: (rule) => `规则 ${rule}`,
  also: (reason) => `另外：${reason}`,
  and: "；",
  size: (reason, size) => `${reason}，${size}`,
  receipts: (receipts) => `上下文读取 ${receipts}`,
  partly: "已部分读取",
  path: (path, state, detail, blob) => `${path} · ${state}${detail ? `（${detail}）` : ""}${blob ? ` · blob ${blob}` : ""}`,
  noPolicy: "基准处没有范围策略：所有变更路径都在范围内。",
  atBase: (sha) => `（基准 ${sha}）`,
  policyChanged: "此 PR 修改了策略文件；修改只对之后的审查生效。",
  invalid: "无效",
  unusable: (path, at, error, changed) => `范围策略 ${path}${at} 无法使用（${error}）：所有变更路径仍在范围内。${changed}`,
  rules: (path, at, n, changed) => `范围策略 ${path}${at}：${n} 条排除规则。被排除的路径仍未审查，审查不会通过。${changed}`,
  review: (id) => `审查 ${id}`,
  run: (id) => `CI 运行 ${id}`,
  hash: (sha, matches) =>
    ` · 登记的 SHA-256 ${sha}${matches === true ? "，与被审查 head 的内容一致" : matches === false ? "，与被审查 head 的内容不同" : ""}`,
  bound: "绑定到此候选（身份匹配）",
  other: (head) => `来自另一个候选${head ? `（head ${head}）` : ""}；不适用于此处`,
  by: (name) => `由 ${name} 登记`,
  byAuthor: "由其作者登记",
  evidence: (path, kind, ref, hash, binding, by) => `${path} · ${kind} · ${ref}${hash} · ${binding} · ${by}；Core 没有获取或验证该引用`,
});
const short = (sha?: string | null) => (sha && /^[a-f0-9]{40}$/i.test(sha) ? sha.slice(0, 8) : null);
const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/** "3 of 8 changed paths covered · 1 can't be reviewed as text · 4 not read". */
export function scopeSummary(scope: ReviewScope, language: Language = "en") {
  const t = scopeText(language);
  const parts = Object.keys(t.states)
    .filter((state) => state !== "covered" && (scope.counts[state] ?? 0) > 0)
    .map((state) => t.count(scope.counts[state], t.states[state]));
  return [t.covered(scope.counts.covered ?? 0, scope.paths.length), ...parts].join(" · ");
}

/** One path that isn't covered: what it is and why, from its first fact. */
export function describeScopePath(p: ScopePath, language: Language = "en") {
  const t = scopeText(language);
  const fact = p.facts?.find((f) => f.kind === p.state);
  const state = t.states[p.state] ?? t.state(p.state);
  const reason = p.reason ? t.reasons[p.reason] ?? p.reason : null;
  const unsupported = p.facts?.find((f) => f.kind === "unsupported");
  const detail =
    p.state === "excluded"
      ? [fact?.rule ? t.rule(fact.rule) : null, unsupported?.reason ? t.also(t.reasons[unsupported.reason] ?? unsupported.reason) : null]
          .filter(Boolean)
          .join(t.and) || null
      : p.state === "budget_exhausted" && p.reason === "diff_exceeds_context" && typeof fact?.totalDiffBytes === "number"
        ? t.size(reason!, mb(fact.totalDiffBytes))
        : p.state === "read_failed" && fact?.requests?.length
          ? t.receipts(fact.requests.map((r) => r.receipt).join(", "))
          : p.state === "not_read" && fact?.remainingByteRanges?.length
            ? t.partly
            : reason;
  const blob = short(p.head?.blobSha) ?? short(p.mergeBase?.blobSha);
  return t.path(p.path, state, detail, blob);
}

/** Where the review's scope came from: the base's policy file, or none. */
export function describePolicy(policy?: ScopePolicy | null, language: Language = "en") {
  const t = scopeText(language);
  if (!policy || policy.state === "absent") return t.noPolicy;
  const at = short(policy.revision) ? t.atBase(short(policy.revision)!) : "";
  const changed = policy.changedByThisPr ? t.policyChanged : "";
  if (policy.state === "invalid") return t.unusable(policy.path ?? "", at, policy.error ?? t.invalid, changed);
  return t.rules(policy.path ?? "", at, policy.rules?.length ?? 0, changed);
}

/** True when some path can never be covered at this head, whatever round runs. */
export const scopeFixedGaps = (scope: ReviewScope) =>
  scope.paths.some(
    (p) => p.state === "unsupported" || p.state === "excluded" || (p.state === "budget_exhausted" && p.reason === "diff_exceeds_context"),
  );

/** One evidence record: what it is, where it points, and whether it is bound to this review's candidate. */
export function describeEvidence(e: ScopeEvidence, language: Language = "en") {
  const t = scopeText(language);
  const ref = e.reference.reviewId
    ? t.review(e.reference.reviewId.slice(0, 8))
    : e.reference.jobId
      ? t.job(e.reference.jobId.slice(0, 8))
      : e.reference.ciRunKey
        ? t.run(e.reference.ciRunKey.split(":")[2] ?? e.reference.ciRunKey)
        : e.reference.url ?? "";
  const hash = e.artifactSha256 ? t.hash(e.artifactSha256.slice(0, 12), e.artifactMatchesHeadContent) : "";
  const binding = e.binding === "this_candidate" ? t.bound : t.other(short(e.candidate?.headSha));
  const by = e.registeredBy?.name ? t.by(e.registeredBy.name) : t.byAuthor;
  return t.evidence(e.path, t.kinds[e.kind] ?? e.kind, ref, hash, binding, by);
}
