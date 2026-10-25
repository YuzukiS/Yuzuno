import { strings, type Language } from "./i18n";

/** Display stored verdicts. Never reinterpret older findings as approval. */
export type ReviewOutcome = {
  status: string;
  conclusion: string | null;
  policyVersion?: number | null;
  reasonCodes?: string[] | null;
};

// The verdicts and reasons in the interface language (T-189); a reason this
// version doesn't know keeps its code as Core sent it.
const outcomeText = strings({
  conclusions: {
    no_findings: "No actionable findings",
    approved_with_notes: "Passed · non-blocking suggestions",
    changes_requested: "Changes requested",
    unknown: "Conclusion unknown",
  } as Record<string, string>,
  reasons: {
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
  } as Record<string, string>,
  unrecognized: (code: string) => `Unrecognized review reason: ${code}`,
}, {
  conclusions: {
    no_findings: "没有可操作的发现",
    approved_with_notes: "已通过 · 有非阻塞建议",
    changes_requested: "要求修改",
    unknown: "结论未知",
  },
  reasons: {
    coverage_incomplete: "审查覆盖不完整",
    unsupported_source: "部分源文件无法由此审查者检查",
    diff_too_large: "某个变更文件的完整 diff 超过任何审查能读取的大小",
    scope_excluded: "部分变更路径被基准的范围策略排除，仍未审查",
    scope_policy_invalid: "基准的范围策略文件无法使用；所有变更路径仍在范围内",
    model_unknown: "审查者未能得出结论",
    verdict_conflict: "正确性判断与阻塞性发现相互矛盾",
    invalid_report: "审查者返回了无效的报告",
    execution_failed: "审查未能成功执行",
    execution_unconfirmed: "无法确认审查已完成",
    execution_cancelled: "审查已取消",
  },
  unrecognized: (code) => `无法识别的审查原因：${code}`,
});

/** The verdicts' words in English. */
export const reviewConclusions: Record<string, string> = outcomeText("en").conclusions;
/** The verdicts' words in `language`. */
export const reviewConclusionsIn = (language: Language) => outcomeText(language).conclusions;

export const reviewReasons = (r: ReviewOutcome, language: Language = "en") => {
  const t = outcomeText(language);
  return (r.reasonCodes || []).map((code) => t.reasons[code] || t.unrecognized(code));
};

export const reviewPassed = (r: ReviewOutcome) =>
  r.status === "completed" &&
  (r.conclusion === "no_findings" ||
    (r.conclusion === "approved_with_notes" && (r.policyVersion === 2 || r.policyVersion === 3)));
