import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import { reviewConclusions, reviewPassed, reviewReasons } from "./review-outcome";
import { langTag, strings, useLanguage } from "./i18n";
import {
  JobCard,
  JobDetailHeading,
  JobRow,
  JobsSourceHeading,
  moments,
  StateGroups,
  type Placement,
} from "./JobParts";

export type ReviewRow = {
  id: string;
  taskId: string;
  taskRef: string;
  taskTitle: string | null;
  linkId: string;
  repository: string;
  number: number;
  url: string | null;
  round: number | null;
  status: string;
  phase: string | null;
  conclusion: string | null;
  policyVersion?: number | null;
  reasonCodes?: string[] | null;
  requestedHarness: string | null;
  requestedModel: string | null;
  actualHarness: string | null;
  actualModel: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  requestedBy: { kind: string; id: string; name: string } | null;
  findingsCount: number;
  outdated: boolean | null;
  cursor: number;
};
type Page = {
  reviews: ReviewRow[];
  hasMore: boolean;
  nextBefore: number | null;
};
export type ReviewScope = { agentId?: string; taskId?: string };
export type ReviewOpen = { reviewId?: string; taskId?: string };
/** Opens the review in its task, where the report, findings and evidence are. */
export const openTaskReview = (detail: { taskId: string; reviewId: string }) =>
  window.dispatchEvent(new CustomEvent("yuzuno:open-task-review", { detail }));

// The Reviews source in the interface language (T-189). Repositories, task
// titles, model and harness names, SHAs, phases and Core's errors are shown
// as they came. The review reasons come from review-outcome.ts, as in the
// task's review panel.
const reviewText = strings({
  preparing: "Preparing",
  reviewing: "Reviewing",
  conclusions: { ...reviewConclusions } as Record<string, string>,
  conclusionUnknown: "Conclusion unknown",
  failed: "Failed",
  cancelled: "Cancelled",
  outcomeUnknown: "Outcome unknown",
  requesterUnknown: "Requester unknown (older record)",
  byYou: "Requested by you",
  by: (name: string) => `Requested by ${name || "an Agent"}`,
  notResolved: "Not resolved",
  reviewerName: "Reviewer",
  defaultModel: "default model",
  requestedReviewer: (harness: string, model: string) => `${harness} · ${model} (requested)`,
  soFar: (text: string) => `${text} so far`,
  updatedCore: "Reviews in Jobs require an updated Core.",
  notInTask: "This review is not part of that task.",
  region: "PR reviews",
  title: "Reviews",
  refresh: "Refresh reviews",
  intro: "PR reviews started from a task. They run in Core and do not use this machine's job budget. Start a review from the task's PR.",
  agentOnly: (name: string) => ` Showing reviews ${name || "this Agent"} requested itself; reviews you requested are under Workspace.`,
  noneBy: (name: string) => `No reviews requested by ${name || "this Agent"}.`,
  noneForTask: "No reviews for this task yet.",
  none: "No PR reviews yet. Start one from a task's linked PR.",
  loading: "Loading reviews…",
  outdated: " · Outdated",
  round: (repository: string, number: number, round: number) => `${repository}#${number} · Round ${round}`,
  head: (sha: string) => ` · head ${sha}`,
  requested: (when: string) => `Requested ${when}`,
  queuedAt: "Queued",
  finishedAt: "Finished",
  earlier: "Earlier reviews",
  reading: "Reading review…",
  select: "Select a review to see its state and open the full report.",
  notConfirmed: "Model not confirmed",
  openPr: "Open PR on GitHub",
  outdatedNote: "Outdated · the PR's base or head changed after this review.",
  unverified: "Whether the PR changed since is unverified.",
  unknownNote: "Core could not confirm how this review ended. Unknown is not a passing review.",
  reasons: "Review reasons",
  summary: "Summary",
  task: "Task",
  requestedLabel: "Requested",
  reviewer: "Reviewer",
  requestedAs: (harness: string, model: string) => ` (requested ${harness} · ${model})`,
  reviewed: "Reviewed",
  headBase: (head: string, base: string) => `head ${head} · base ${base}`,
  ended: "Ended",
  stillRunning: "Still running",
  findings: "Findings",
  reviewId: "Review ID",
  openReport: (task: string) => `Open full report in ${task}`,
  footnote: "Findings are the model's assessment. A review does not merge the PR, pass CI or complete its task.",
}, {
  preparing: "正在准备",
  reviewing: "正在审查",
  conclusions: {
    no_findings: "没有可操作的发现",
    approved_with_notes: "已通过 · 有非阻塞建议",
    changes_requested: "要求修改",
    unknown: "结论未知",
  },
  conclusionUnknown: "结论未知",
  failed: "失败",
  cancelled: "已取消",
  outcomeUnknown: "结果未知",
  requesterUnknown: "请求者未知（较早的记录）",
  byYou: "由你请求",
  by: (name) => `由 ${name || "某个 Agent"} 请求`,
  notResolved: "未解析",
  reviewerName: "审查者",
  defaultModel: "默认模型",
  requestedReviewer: (harness, model) => `${harness} · ${model}（请求的）`,
  soFar: (text) => `目前 ${text}`,
  updatedCore: "Job 中的审查需要更新的 Core。",
  notInTask: "此审查不属于该任务。",
  region: "PR 审查",
  title: "审查",
  refresh: "刷新审查",
  intro: "从任务发起的 PR 审查。它们在 Core 中运行，不使用此机器的 Job 预算。请从任务的 PR 发起审查。",
  agentOnly: (name) => ` 正在显示 ${name || "此 Agent"} 自己请求的审查；你请求的审查在 Workspace 下。`,
  noneBy: (name) => `没有由 ${name || "此 Agent"} 请求的审查。`,
  noneForTask: "此任务还没有审查。",
  none: "还没有 PR 审查。请从任务链接的 PR 发起一次。",
  loading: "正在加载审查…",
  outdated: " · 已过时",
  round: (repository, number, round) => `${repository}#${number} · 第 ${round} 轮`,
  head: (sha) => ` · head ${sha}`,
  requested: (when) => `请求于 ${when}`,
  queuedAt: "排队",
  finishedAt: "完成",
  earlier: "更早的审查",
  reading: "正在读取审查…",
  select: "选择一个审查，查看它的状态并打开完整报告。",
  notConfirmed: "模型未确认",
  openPr: "在 GitHub 上打开 PR",
  outdatedNote: "已过时 · 此审查之后，PR 的 base 或 head 已改变。",
  unverified: "此后 PR 是否改变尚未核实。",
  unknownNote: "Core 无法确认此审查是如何结束的。未知不代表通过审查。",
  reasons: "审查原因",
  summary: "摘要",
  task: "任务",
  requestedLabel: "请求",
  reviewer: "审查者",
  requestedAs: (harness, model) => `（请求的是 ${harness} · ${model}）`,
  reviewed: "审查范围",
  headBase: (head, base) => `head ${head} · base ${base}`,
  ended: "结束",
  stillRunning: "仍在运行",
  findings: "发现",
  reviewId: "审查 ID",
  openReport: (task) => `在 ${task} 中打开完整报告`,
  footnote: "发现是模型的评估。审查不会合并 PR、让 CI 通过或完成其任务。",
});
type ReviewText = ReturnType<typeof reviewText>;
const reviewEn = reviewText("en");
const empty: Page = { reviews: [], hasMore: false, nextBefore: null };
const active = (r: ReviewRow) =>
  r.status === "preparing" || r.status === "running";
/** The run's own state; a conclusion is shown only for a completed model run. */
export function reviewState(r: ReviewRow, t: ReviewText = reviewEn) {
  if (r.status === "preparing") return t.preparing;
  if (r.status === "running") return t.reviewing;
  if (r.status === "completed")
    return t.conclusions[r.conclusion || ""] || t.conclusionUnknown;
  if (r.status === "failed") return t.failed;
  if (r.status === "cancelled") return t.cancelled;
  return t.outcomeUnknown;
}
const tone = (r: ReviewRow) =>
  active(r)
    ? "running"
    : reviewPassed(r)
      ? "passed"
      : r.status === "cancelled"
        ? "cancelled"
        : "failed";
/** Still running, or ended however it ended. */
const placeReview = (r: ReviewRow): Placement => (active(r) ? "active" : "done");
const harness = (h: string | null) =>
  h === "claude" ? "Claude Code" : h === "codex" ? "Codex" : null;
export function requester(r: ReviewRow, t: ReviewText = reviewEn) {
  if (!r.requestedBy) return t.requesterUnknown;
  if (r.requestedBy.kind === "user") return t.byYou;
  return t.by(r.requestedBy.name);
}
const stamp = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");
const short = (sha: string | null, t: ReviewText) => sha?.slice(0, 8) || t.notResolved;
/** The confirmed reviewer, or the requested one, labelled as such. */
export function reviewer(r: ReviewRow, t: ReviewText = reviewEn) {
  return harness(r.actualHarness) && r.actualModel
    ? `${harness(r.actualHarness)} · ${r.actualModel}`
    : t.requestedReviewer(harness(r.requestedHarness) || r.requestedHarness || t.reviewerName, r.requestedModel || t.defaultModel);
}
/** Time from request to end, or so far while it runs. */
export function took(r: ReviewRow, now = Date.now(), t: ReviewText = reviewEn) {
  const end = r.finishedAt ? Date.parse(r.finishedAt) : active(r) ? now : NaN;
  const seconds = Math.round((end - Date.parse(r.createdAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const text =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return active(r) ? t.soFar(text) : text;
}
const safePull = (url: string | null) =>
  url &&
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(
    url,
  )
    ? url
    : undefined;
const newestFirst = (rows: ReviewRow[]) =>
  [...new Map(rows.map((r) => [r.id, r])).values()].sort(
    (a, b) => b.cursor - a.cursor,
  );
/** A refresh re-reads at most this many pages: the ones already loaded. */
const REFRESH_PAGES = 10;

/**
 * Every PR review in the Workspace, read-only. Reviews start from a task's
 * PR; this list never starts, retries or cancels one. Rows are summaries;
 * the report and findings open in the task.
 */
export function ReviewJobs({
  scope,
  agentName,
  revision,
  initial,
  onOpenReport,
}: {
  scope: ReviewScope;
  agentName?: string;
  revision: string;
  initial: ReviewOpen;
  onOpenReport: (review: ReviewRow) => void;
}) {
  const language = useLanguage();
  const t = reviewText(language);
  // This window's own errors are kept in English and said in the language
  // shown; Core's are shown as they came.
  const said = (text: string) => (text === reviewEn.updatedCore ? t.updatedCore : text === reviewEn.notInTask ? t.notInTask : text);
  // A link names one review of one task. It belongs to that task's scope
  // only, and is read directly however old, never found by paging.
  const link =
    initial.reviewId && initial.taskId && scope.taskId === initial.taskId
      ? { taskId: initial.taskId, reviewId: initial.reviewId }
      : null;
  const [page, setPage] = useState<Page | null>(null);
  const [linked, setLinked] = useState<ReviewRow | null>(null);
  const [selected, setSelected] = useState(link?.reviewId || "");
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const controllers = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const missed = useRef(false);
  const refreshes = useRef(0);
  const shown = useRef(page);
  shown.current = page;
  const selection = useRef(selected);
  selection.current = selected;
  const query = new URLSearchParams(scope).toString();
  const read = useCallback(async (path: string) => {
    const g = generation.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const value = await api<Page>(path, { signal: controller.signal });
      if (!Array.isArray(value?.reviews))
        throw new Error(reviewEn.updatedCore);
      return g === generation.current ? value : null;
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
  const linkTask = link?.taskId;
  const linkReview = link?.reviewId;
  const readLinked = useCallback(async () => {
    if (!linkTask || !linkReview || selection.current !== linkReview) return;
    const g = generation.current;
    try {
      const value = await read(
        `/reviews?${new URLSearchParams({ taskId: linkTask, reviewId: linkReview })}`,
      );
      if (!value || g !== generation.current) return;
      setLinked(value.reviews[0] || null);
      setLinkError(
        value.reviews[0] ? "" : reviewEn.notInTask,
      );
    } catch (e) {
      if (g === generation.current && !(e instanceof DOMException))
        setLinkError(errorText(e));
    }
  }, [linkTask, linkReview, read]);
  const load = useCallback(
    async (before?: number) => {
      if (!before && document.visibilityState === "hidden") {
        missed.current = true;
        return;
      }
      const g = generation.current;
      const path = (cursor?: number) =>
        `/reviews?${query}${cursor ? `${query ? "&" : ""}before=${cursor}` : ""}`;
      try {
        if (before) {
          const next = await read(path(before));
          if (!next) return;
          setPage((old) => ({
            reviews: newestFirst([...(old?.reviews || []), ...next.reviews]),
            hasMore: next.hasMore,
            nextBefore: next.nextBefore,
          }));
          setError("");
          return;
        }
        // A refresh re-reads every page already loaded, so no older row keeps
        // stale facts such as Outdated, and also the linked review.
        void readLinked();
        const ticket = ++refreshes.current;
        const loaded = shown.current?.reviews;
        const oldest = loaded?.length ? loaded[loaded.length - 1].cursor : null;
        const rows: ReviewRow[] = [];
        let last: Page | null = null;
        let reached = oldest == null;
        for (let n = 0; n < REFRESH_PAGES; n++) {
          const next = await read(path(last?.nextBefore ?? undefined));
          if (!next || ticket !== refreshes.current) return;
          rows.push(...next.reviews);
          last = next;
          reached ||=
            !next.hasMore ||
            next.nextBefore == null ||
            (oldest != null && next.nextBefore <= oldest);
          if (reached) break;
        }
        if (!last) return;
        const fresh: Page = {
          reviews: newestFirst(rows),
          hasMore: last.hasMore,
          nextBefore: last.nextBefore,
        };
        setPage((current) => {
          // Older pages loaded while this ran are already current; keep them.
          // Past the page bound, older rows are dropped rather than kept stale.
          const edge = fresh.hasMore ? fresh.nextBefore : null;
          const later =
            reached && edge != null
              ? (current?.reviews || []).filter((r) => r.cursor < edge)
              : [];
          return later.length && current
            ? {
                reviews: newestFirst([...fresh.reviews, ...later]),
                hasMore: current.hasMore,
                nextBefore: current.nextBefore,
              }
            : fresh;
        });
        setError("");
      } catch (e) {
        if (g === generation.current && !(e instanceof DOMException))
          setError(errorText(e));
      }
    },
    [query, read, readLinked],
  );
  useEffect(() => {
    generation.current++;
    setPage(null);
    return () => {
      // A new scope or closing Jobs drops every request still on its way.
      generation.current++;
      for (const c of controllers.current) c.abort();
      controllers.current.clear();
    };
  }, [query]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "hidden" && missed.current) {
        missed.current = false;
        void load();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [load]);
  const listed = page?.reviews.find((r) => r.id === selected);
  const onLink = !!link && selected === link.reviewId;
  const chosen =
    listed || (onLink && linked?.id === selected ? linked : undefined);
  const rows = page?.reviews || empty.reviews;
  return (
    <section className="jobs-source review-jobs" aria-label={t.region} lang={langTag(language)}>
      <JobsSourceHeading
        id="jobs-reviews-title"
        title={t.title}
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label={t.refresh}
            title={t.refresh}
            onClick={() => {
              setError("");
              void load();
            }}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        {t.intro}
        {scope.agentId && t.agentOnly(agentName || "")}
      </JobsSourceHeading>
      {error && (
        <p className="inline-error" role="alert">
          {said(error)}
        </p>
      )}
      <div className="jobs-browser">
        <StateGroups
          label={t.title}
          items={rows}
          place={placeReview}
          selected={selected}
          empty={
            page ? (
              <p className="jobs-empty">
                {scope.agentId
                  ? t.noneBy(agentName || "")
                  : scope.taskId
                    ? t.noneForTask
                    : t.none}
              </p>
            ) : (
              !error && <p className="jobs-empty">{t.loading}</p>
            )
          }
          row={(r) => (
            <JobRow
              status={tone(r)}
              state={`${reviewState(r, t)}${r.outdated === true ? t.outdated : ""}`}
              name={t.round(r.repository, r.number, r.round ?? 1)}
              meta={[`${r.taskRef}${r.taskTitle ? ` · ${r.taskTitle}` : ""}`]}
              note={`${reviewer(r, t)}${r.headSha ? t.head(r.headSha.slice(0, 7)) : ""} · ${requester(r, t)}`}
              time={took(r, Date.now(), t)}
              timeTitle={t.requested(stamp(r.createdAt))}
              moments={moments([
                [t.queuedAt, r.createdAt],
                [t.finishedAt, r.finishedAt],
              ])}
              selected={selected === r.id}
              onSelect={() => setSelected(r.id)}
            />
          )}
        >
          {page?.hasMore && page.nextBefore != null && (
            <button
              type="button"
              className="quiet-button"
              onClick={() => void load(page.nextBefore!)}
            >
              {t.earlier}
            </button>
          )}
        </StateGroups>
        <div className="job-detail">
          {onLink && !listed && linkError && (
            <p className="inline-error" role="alert">
              {said(linkError)}
            </p>
          )}
          {chosen ? (
            <ReviewSummary review={chosen} onOpenReport={onOpenReport} t={t} />
          ) : (
            !(onLink && linkError) && (
              <p className="jobs-empty">
                {onLink ? t.reading : t.select}
              </p>
            )
          )}
        </div>
      </div>
    </section>
  );
}

function ReviewSummary({
  review: r,
  onOpenReport,
  t,
}: {
  review: ReviewRow;
  onOpenReport: (review: ReviewRow) => void;
  t: ReviewText;
}) {
  const language = useLanguage();
  const confirmed =
    harness(r.actualHarness) && r.actualModel
      ? `${harness(r.actualHarness)} · ${r.actualModel}`
      : t.notConfirmed;
  return (
    <>
      <JobDetailHeading
        status={tone(r)}
        state={`${reviewState(r, t)}${active(r) && r.phase ? ` · ${r.phase}` : ""}`}
        title={t.round(r.repository, r.number, r.round ?? 1)}
        role={active(r) ? "status" : undefined}
      >
        {safePull(r.url) && (
          <a
            className="secondary-button"
            href={safePull(r.url)}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            {t.openPr}
          </a>
        )}
      </JobDetailHeading>
      {r.outdated === true && (
        <p className="review-outdated">{t.outdatedNote}</p>
      )}
      {r.outdated === null && !active(r) && <p className="job-footnote">{t.unverified}</p>}
      {r.status === "unknown" && <p className="job-footnote">{t.unknownNote}</p>}
      {r.error && <p className="inline-error">{r.error}</p>}
      {reviewReasons(r).length > 0 && (
        <ul className="job-footnote" aria-label={t.reasons}>
          {reviewReasons(r, language).map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <JobCard title={t.summary}>
        <dl>
          <dt>{t.task}</dt>
          <dd>
            {r.taskRef}
            {r.taskTitle ? ` · ${r.taskTitle}` : ""}
          </dd>
          <dt>{t.requestedLabel}</dt>
          <dd>
            {requester(r, t)} · {stamp(r.createdAt)}
          </dd>
          <dt>{t.reviewer}</dt>
          <dd>
            {confirmed}
            {r.requestedModel &&
              r.requestedModel !== r.actualModel &&
              t.requestedAs(`${harness(r.requestedHarness) || r.requestedHarness}`, r.requestedModel)}
          </dd>
          <dt>{t.reviewed}</dt>
          <dd>{t.headBase(short(r.headSha, t), short(r.baseSha, t))}</dd>
          <dt>{t.ended}</dt>
          <dd>
            {active(r) ? t.stillRunning : stamp(r.finishedAt)}
            {took(r, Date.now(), t) ? ` · ${took(r, Date.now(), t)}` : ""}
          </dd>
          {r.status === "completed" && (
            <>
              <dt>{t.findings}</dt>
              <dd>{r.findingsCount}</dd>
            </>
          )}
          <dt>{t.reviewId}</dt>
          <dd>{r.id}</dd>
        </dl>
      </JobCard>
      <div className="job-detail-actions review-report-action">
        <button className="primary-button" onClick={() => onOpenReport(r)}>
          <ArrowUpRight size={14} aria-hidden="true" />
          {t.openReport(r.taskRef)}
        </button>
      </div>
      <p className="job-footnote">{t.footnote}</p>
    </>
  );
}
