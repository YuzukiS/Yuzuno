import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { GitHubLink } from "./GitHubLinks";
import { describeRead, type ContextRead } from "./review-reads";
import { reviewConclusionsIn, reviewReasons } from "./review-outcome";
import { strings, useLanguage } from "./i18n";
import {
  describeEvidence,
  describePolicy,
  describeScopePath,
  scopeFixedGaps,
  scopeSummary,
  type ReviewScope,
  type ScopeEvidence,
} from "./review-scope";
import "./pr-reviews.css";

type Finding = {
  title: string;
  body: string;
  path: string;
  startLine: number;
  endLine: number;
  revision: string;
  priority: number;
};
type Review = {
  id: string;
  requestId?: string;
  requestedHarness: string;
  requestedModel: string;
  actualHarness: string | null;
  linkId: string;
  repository: string;
  number: number;
  status: string;
  phase: string;
  actualModel: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  conclusion: string;
  policyVersion?: number | null;
  reasonCodes?: string[] | null;
  explanation?: string;
  error: string | null;
  createdAt: string;
  outdated: boolean | null;
  findings: Finding[];
  rawReport?: string | null;
  fileCount?: number;
  commitCount?: number;
  cursor: number;
  round?: number;
  contextReads?: ContextRead[];
  coverage?: {
    version?: number;
    fileCount: number;
    coveredFileCount?: number;
    deliveredCompleteDiffs: number;
    fullAddedSourceCount?: number;
    inheritedCoveredCount?: number;
  };
  kind?: string;
  continuation?: { parentRound?: number; targets?: { path: string }[] } | null;
  incremental?: {
    previousRound?: number;
    targets?: { path: string }[];
    leftThePr?: string[];
  } | null;
  settledFindings?: Finding[] | null;
  scope?: ReviewScope | null;
  scopeConclusion?: string | null;
  evidence?: ScopeEvidence[] | null;
};
type Page = {
  settings?: { harness: string; model: string };
  reviews: Review[];
  hasMore: boolean;
  nextBefore: number | null;
};
const active = (r: Review) =>
  r.status === "preparing" || r.status === "running";
const short = (sha: string | null, pending: string) => sha?.slice(0, 8) || pending;
const harnessName = (harness: string | null | undefined) =>
  harness === "claude" ? "Claude Code" : harness === "codex" ? "Codex" : null;

// A task's PR reviews in the interface language (T-189). Repositories, SHAs,
// harness and model names, Core's phase and status, the reviewer's
// explanation, findings and original report, paths and errors are shown as
// they are.
const reviewsText = strings({
  title: "PR reviews",
  intro: (harness: string, model: string) =>
    `Review the full PR with ${harness} (${model}). Source is read only; tests are not run. Findings are the model’s assessment.`,
  notify: "Notify when finished",
  recipient: "Review result recipient",
  taskOnly: "Show in this task only",
  start: "Review PR",
  round: (round: number) => ` · Round ${round}`,
  continues: (round: number | string) => ` · continues round ${round}`,
  newHead: (round: number | string) => ` · new head after round ${round}`,
  notStarted: "Not started",
  conclusionUnknown: "Conclusion unknown",
  outdated: "Outdated report · PR base or head has changed",
  unverified: "Latest PR revision is unverified. Refresh GitHub to compare versions.",
  reviewed: (head: string, base: string) => `Reviewed head ${head} · base ${base}`,
  pending: "Pending",
  requestedReviewer: "Requested reviewer",
  baseSha: "Base SHA",
  headSha: "Head SHA",
  comparison: "Actual comparison",
  counts: (files: number, commits: number | undefined) => `${files} changed files · ${commits} PR commits`,
  coverage: (covered: number | undefined, files: number, diffs: number, added: number | undefined) =>
    `${covered} of ${files} files covered · ${diffs} by complete diff · ${added} by complete added-file source`,
  readBy: (count: number, round: number | string) => ` · ${count} read by round ${round}`,
  unchangedSince: (count: number, round: number | string) => ` · ${count} unchanged since round ${round}`,
  continuation: (round: number | string, paths: number) =>
    `Continues round ${round} for the ${paths} ${paths === 1 ? "path" : "paths"} it left unread: a new reviewer run with its own cost, within what that round left of its budget. Coverage and conclusion are over both rounds; that round's findings are kept as it recorded them.`,
  incremental: (round: number | string, paths: number, settled: number) =>
    `Reviews a new head after round ${round}: it reads the ${paths} ${paths === 1 ? "path that changed or wasn't read before" : "paths that changed or weren't read before"}, and keeps that round's proofs only for paths identical on both sides. A new round with its own budget and cost. That round's findings stay unless this one shows them fixed by its own reads (${settled} settled).`,
  includes: "Includes full patches and changed-file source, with fixed-version context reads as needed.",
  scope: (summary: string) => `Review scope · ${summary}`,
  fixedGaps: "Some paths can't be reviewed as text at this head or are excluded, so no round of it can be complete.",
  withinPolicy: (conclusion: string) =>
    `Within the policy's scope: ${conclusion}. Shown for information; the review's own conclusion stands.`,
  outside: "Paths outside the review",
  evidenceIntro: "Evidence registered for these paths, kept apart from the review:",
  evidence: "Registered evidence",
  note: (note: string) => ` · Author's note: ${note}`,
  reads: (count: number) => `${count} context reads`,
  readsFailed: (count: number) => ` · ${count} failed`,
  readFailed: (error: string) => ` · Failed: ${error}`,
  reviewId: (id: string) => `Review ID: ${id}`,
  reasons: "Review reasons",
  cancel: "Cancel review",
  original: "Original report",
  loading: "Loading…",
  noReport: "No original report was returned.",
  older: "Older reviews",
}, {
  title: "PR 审查",
  intro: (harness, model) => `用 ${harness}（${model}）审查整个 PR。只读取源码，不运行测试。发现是模型的评估。`,
  notify: "完成后通知",
  recipient: "审查结果的接收方",
  taskOnly: "只在此任务中显示",
  start: "审查 PR",
  round: (round) => ` · 第 ${round} 轮`,
  continues: (round) => ` · 继续第 ${round} 轮`,
  newHead: (round) => ` · 第 ${round} 轮之后的新 head`,
  notStarted: "未开始",
  conclusionUnknown: "结论未知",
  outdated: "报告已过时 · PR 的 base 或 head 已变化",
  unverified: "PR 的最新修订尚未核实。刷新 GitHub 即可比较版本。",
  reviewed: (head, base) => `审查的 head ${head} · base ${base}`,
  pending: "待定",
  requestedReviewer: "请求的审查者",
  comparison: "实际比较范围",
  counts: (files, commits) => `${files} 个变更文件 · ${commits} 个 PR 提交`,
  coverage: (covered, files, diffs, added) =>
    `${files} 个文件中已覆盖 ${covered} 个 · ${diffs} 个通过完整 diff · ${added} 个通过新增文件的完整源码`,
  readBy: (count, round) => ` · ${count} 个由第 ${round} 轮读取`,
  unchangedSince: (count, round) => ` · ${count} 个自第 ${round} 轮以来未变`,
  continuation: (round, paths) =>
    `继续第 ${round} 轮，读取它未读的 ${paths} 个路径：这是一次新的审查者运行，有自己的费用，用的是那一轮剩下的预算。覆盖与结论按两轮合计；那一轮的发现按它记录的样子保留。`,
  incremental: (round, paths, settled) =>
    `审查第 ${round} 轮之后的新 head：读取 ${paths} 个变更过或之前未读的路径，只对两侧完全相同的路径沿用那一轮的证明。这是新的一轮，有自己的预算和费用。那一轮的发现会保留，除非这一轮用自己的读取表明它们已修复（已处理 ${settled} 个）。`,
  includes: "包括完整补丁和变更文件的源码，并按需读取固定版本的上下文。",
  scope: (summary) => `审查范围 · ${summary}`,
  fixedGaps: "部分路径在此 head 无法作为文本审查，或已被排除，因此它的任何一轮都不可能完整。",
  withinPolicy: (conclusion) => `在策略范围内：${conclusion}。仅供参考；以审查自身的结论为准。`,
  outside: "审查范围之外的路径",
  evidenceIntro: "为这些路径登记的证据，与审查分开保存：",
  evidence: "登记的证据",
  note: (note) => ` · 作者备注：${note}`,
  reads: (count) => `${count} 次上下文读取`,
  readsFailed: (count) => ` · ${count} 次失败`,
  readFailed: (error) => ` · 失败：${error}`,
  reviewId: (id) => `审查 ID：${id}`,
  reasons: "审查原因",
  cancel: "取消审查",
  original: "原始报告",
  loading: "正在加载…",
  noReport: "没有返回原始报告。",
  older: "更早的审查",
});
function sourceUrl(r: Review, f: Finding) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository) ||
    !/^[a-f0-9]{40}$/i.test(f.revision)
  )
    return undefined;
  return `https://github.com/${r.repository}/blob/${f.revision}/${f.path.split("/").map(encodeURIComponent).join("/")}#L${f.startLine}-L${f.endLine}`;
}

export function PrReviews({
  taskId,
  links,
  disabled,
  focusReviewId,
  controls = true,
}: {
  taskId: string;
  links: GitHubLink[];
  disabled: boolean;
  /** Opened from a link: shown with its original report, however old. */
  focusReviewId?: string;
  /** Starting a review and choosing who hears of it; the runs always show. */
  controls?: boolean;
}) {
  const language = useLanguage();
  const t = reviewsText(language);
  const conclusion = reviewConclusionsIn(language);
  const [recipients, setRecipients] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [notifyAgentId, setNotifyAgentId] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reports, setReports] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<Review | null>(null);
  const focusedElement = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const pendingStarts = useRef(new Map<string, string>());
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const revisionKey = links
    .map(
      (l) =>
        `${l.id}:${l.syncedAt}:${l.snapshot.baseSha}:${l.snapshot.headSha}`,
    )
    .join("|");
  const request = useCallback(
    async <T,>(path: string, options?: RequestInit): Promise<T | null> => {
      const stamp = generation.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const value = await api<T>(path, {
          ...options,
          signal: controller.signal,
        });
        return mounted.current && stamp === generation.current ? value : null;
      } catch (e) {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          stamp === generation.current
        )
          setError(errorText(e));
        return null;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );
  const load = useCallback(
    async (before?: number | null) => {
      const value = await request<Page>(
        `/pr-reviews?taskId=${encodeURIComponent(taskId)}${before ? `&before=${before}` : ""}`,
      );
      if (!value || !Array.isArray(value.reviews)) return;
      for (const r of value.reviews) {
        if (r.requestId)
          for (const [key, requestId] of pendingStarts.current) {
            if (requestId === r.requestId) pendingStarts.current.delete(key);
          }
      }
      setPage((old) => {
        if (!old) return value;
        const reviews = new Map(old.reviews.map((r) => [r.id, r]));
        for (const r of value.reviews) reviews.set(r.id, r);
        // Refresh the newest records without unmounting loaded history.
        // Pagination belongs to the oldest loaded boundary, even when
        // an earlier page request finishes after a later one.
        const extendsHistory =
          old.nextBefore == null ||
          (before != null && before <= old.nextBefore) ||
          (value.nextBefore != null && value.nextBefore <= old.nextBefore);
        return {
          ...value,
          reviews: [...reviews.values()].sort((a, b) => b.cursor - a.cursor),
          hasMore: extendsHistory ? value.hasMore : old.hasMore,
          nextBefore: extendsHistory
            ? (value.nextBefore ?? old.nextBefore)
            : old.nextBefore,
        };
      });
    },
    [taskId, request],
  );
  useEffect(() => {
    mounted.current = true;
    setPage(null);
    setReports({});
    setError("");
    setBusy(false);
    setNotifyAgentId("");
    void request<{ peers: { id: string; name: string }[] }>(
      "/collaboration/peers_list",
      { method: "POST", body: "{}" },
    ).then((value) => {
      if (value?.peers) setRecipients(value.peers);
    });
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
      for (const c of controllers.current) c.abort();
      controllers.current.clear();
    };
  }, [load]);
  useEffect(() => {
    if (mounted.current) void load();
  }, [revisionKey, load]);
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") void load();
      },
      page?.reviews.some(active) ? 1500 : 5000,
    );
    return () => window.clearInterval(timer);
  }, [page, load]);
  const mutate = async (path: string, body: object) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const stamp = generation.current;
    const result = await request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!mounted.current || stamp !== generation.current) return;
    await load();
    setBusy(false);
    return result;
  };
  const startReview = async (link: GitHubLink) => {
    const payload = {
      taskId,
      linkId: link.id,
      baseSha: link.snapshot.baseSha,
      headSha: link.snapshot.headSha,
      notifyAgentId: notifyAgentId || null,
    };
    const key = JSON.stringify(payload);
    const requestId = pendingStarts.current.get(key) || crypto.randomUUID();
    pendingStarts.current.set(key, requestId);
    const result = await mutate("/pr-reviews", { ...payload, requestId });
    if (result) pendingStarts.current.delete(key);
  };
  const original = useCallback(
    async (id: string) => {
      const value = await request<Review>(
        `/pr-reviews/${id}?taskId=${encodeURIComponent(taskId)}`,
      );
      // Empty when none came back: said in the language shown at the time.
      if (value)
        setReports((old) => ({
          ...old,
          [id]: value.rawReport || "",
        }));
      return value;
    },
    [taskId, request],
  );
  useEffect(() => {
    setFocused(null);
    if (!focusReviewId) return;
    // The one review a link names is read directly, never found by paging.
    void original(focusReviewId).then((value) => {
      if (value && value.id === focusReviewId) setFocused(value);
    });
  }, [focusReviewId, original]);
  const shown = page
    ? focused && !page.reviews.some((r) => r.id === focused.id)
      ? [...page.reviews, focused].sort((a, b) => b.cursor - a.cursor)
      : page.reviews
    : [];
  const loaded = page !== null;
  useEffect(() => {
    focusedElement.current?.scrollIntoView?.({ block: "start" });
  }, [focused, loaded]);
  if (!controls && !shown.length && !error) return null;
  return (
    <section className="pr-reviews" aria-label={t.title}>
      <h4>{t.title}</h4>
      {controls && (
        <>
      <p className="github-hint">
        {t.intro(
          page?.settings?.harness === "claude" ? "Claude Code" : "Codex",
          page?.settings?.model || "gpt-6.1-sol",
        )}
      </p>
      <label className="pr-review-recipient">
        {t.notify}
        <select
          aria-label={t.recipient}
          value={notifyAgentId}
          onChange={(e) => setNotifyAgentId(e.target.value)}
          disabled={busy || disabled}
        >
          <option value="">{t.taskOnly}</option>
          {recipients.map((peer) => (
            <option key={peer.id} value={peer.id}>
              {peer.name}
            </option>
          ))}
        </select>
      </label>
      {links
        .filter((l) => l.kind === "pull")
        .map((link) => (
          <div className="pr-review-start" key={link.id}>
            <span>
              {link.repository}#{link.number}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={
                disabled ||
                busy ||
                !page ||
                page.reviews.some((r) => r.linkId === link.id && active(r))
              }
              onClick={() => void startReview(link)}
            >
              {t.start}
            </button>
          </div>
        ))}
        </>
      )}
      {error && (
        <p role="alert" className="github-error">
          {error}
        </p>
      )}
      {shown.map((r) => {
        const link = links.find((l) => l.id === r.linkId);
        // Match Core's null semantics using the current linked snapshot,
        // including rows retained from older pages.
        const outdated =
          r.baseSha != null &&
          r.headSha != null &&
          link?.snapshot.baseSha != null &&
          link.snapshot.headSha != null
            ? r.baseSha !== link.snapshot.baseSha ||
              r.headSha !== link.snapshot.headSha
            : null;
        return (
          <article
            className={`pr-review-run${r.id === focusReviewId ? " focused" : ""}`}
            key={r.id}
            ref={
              r.id === focusReviewId && focused
                ? (node) => {
                    focusedElement.current = node;
                  }
                : undefined
            }
          >
            <header>
              <strong>
                {r.repository}#{r.number}
                {t.round(r.round ?? 1)}
                {r.kind === "continuation" &&
                  t.continues(r.continuation?.parentRound ?? "?")}
                {r.kind === "incremental" &&
                  t.newHead(r.incremental?.previousRound ?? "?")}
              </strong>
              <span>{r.status}</span>
            </header>
            <small>
              {new Date(r.createdAt).toLocaleString()} ·{" "}
              {harnessName(r.actualHarness) ?? t.notStarted}{" "}
              · {r.actualModel || r.requestedModel}
            </small>
            <p role={active(r) ? "status" : undefined}>
              {active(r)
                ? r.phase
                : conclusion[r.conclusion] || t.conclusionUnknown}
            </p>
            {outdated === true && (
              <p className="github-stale">{t.outdated}</p>
            )}
            {(link?.stale || outdated === null) && (
              <p className="github-hint">{t.unverified}</p>
            )}
            <details>
              <summary>
                {t.reviewed(short(r.headSha, t.pending), short(r.baseSha, t.pending))}
              </summary>
              <dl>
                <dt>{t.requestedReviewer}</dt>
                <dd>
                  {r.requestedHarness} · {r.requestedModel}
                </dd>
                <dt>{t.baseSha}</dt>
                <dd>{r.baseSha || t.pending}</dd>
                <dt>{t.headSha}</dt>
                <dd>{r.headSha || t.pending}</dd>
                <dt>{t.comparison}</dt>
                <dd>
                  {r.mergeBaseSha
                    ? `${r.mergeBaseSha}..${r.headSha}`
                    : t.pending}
                </dd>
              </dl>
              {r.fileCount != null && (
                <p>{t.counts(r.fileCount, r.commitCount)}</p>
              )}
              {(r.coverage?.version ?? 0) >= 2 && r.coverage && (
                <p>
                  {t.coverage(
                    r.coverage.coveredFileCount,
                    r.coverage.fileCount,
                    r.coverage.deliveredCompleteDiffs,
                    r.coverage.fullAddedSourceCount,
                  )}
                  {r.kind === "continuation" &&
                    t.readBy(r.coverage.inheritedCoveredCount ?? 0, r.continuation?.parentRound ?? "?")}
                  {r.kind === "incremental" &&
                    t.unchangedSince(r.coverage.inheritedCoveredCount ?? 0, r.incremental?.previousRound ?? "?")}
                </p>
              )}
              {r.kind === "continuation" && (
                <p className="pr-review-continuation">
                  {t.continuation(r.continuation?.parentRound ?? "?", r.continuation?.targets?.length ?? 0)}
                </p>
              )}
              {r.kind === "incremental" && (
                <p className="pr-review-incremental">
                  {t.incremental(
                    r.incremental?.previousRound ?? "?",
                    r.incremental?.targets?.length ?? 0,
                    r.settledFindings?.length ?? 0,
                  )}
                </p>
              )}
              <p className="github-hint">{t.includes}</p>
            </details>
            {r.scope?.paths?.length ? (
              <details className="pr-review-scope">
                <summary>{t.scope(scopeSummary(r.scope, language))}</summary>
                <p className="github-hint">{describePolicy(r.scope.policy, language)}</p>
                {scopeFixedGaps(r.scope) && (
                  <p className="github-hint">{t.fixedGaps}</p>
                )}
                {r.scopeConclusion && (
                  <p>{t.withinPolicy(conclusion[r.scopeConclusion] ?? r.scopeConclusion)}</p>
                )}
                <ul aria-label={t.outside}>
                  {r.scope.paths
                    .filter((p) => p.state !== "covered")
                    .map((p) => (
                      <li key={p.path}>{describeScopePath(p, language)}</li>
                    ))}
                </ul>
                {!!r.evidence?.length && (
                  <>
                    <p>{t.evidenceIntro}</p>
                    <ul aria-label={t.evidence}>
                      {r.evidence.map((e) => (
                        <li key={e.id} className={e.binding === "this_candidate" ? undefined : "github-hint"}>
                          {describeEvidence(e, language)}
                          {e.note ? t.note(e.note) : ""}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            ) : null}
            {!!r.contextReads?.length && (
              <details>
                <summary>
                  {t.reads(r.contextReads.length)}
                  {(() => {
                    const failed = r.contextReads.filter((read) => describeRead(read).error).length;
                    return failed ? t.readsFailed(failed) : "";
                  })()}
                </summary>
                {r.contextReads.map((read, i) => {
                  const view = describeRead(read, language);
                  return (
                    <p key={i} className={view.error ? "github-error" : undefined}>
                      {view.label}
                      {view.version ? ` · ${view.version}` : ""}
                      {view.error ? t.readFailed(view.error) : ""}
                    </p>
                  );
                })}
              </details>
            )}
            <small>{t.reviewId(r.id)}</small>
            {r.explanation && <p>{r.explanation}</p>}
            {r.error && <p className="github-error">{r.error}</p>}
            {reviewReasons(r).length > 0 && (
              <ul className="github-hint" aria-label={t.reasons}>
                {reviewReasons(r, language).map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
            {r.findings.map((f, index) => (
              <div className="pr-review-finding" key={index}>
                <strong>{f.title}</strong>
                <p>{f.body}</p>
                <a href={sourceUrl(r, f)} target="_blank" rel="noreferrer">
                  {f.path}:{f.startLine}–{f.endLine}
                </a>
              </div>
            ))}
            {active(r) ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void mutate(`/pr-reviews/${r.id}/cancel`, { taskId })
                }
              >
                {t.cancel}
              </button>
            ) : (
              <details
                open={r.id === focusReviewId && !!focused ? true : undefined}
                onToggle={(event) => {
                  if (event.currentTarget.open && reports[r.id] === undefined)
                    void original(r.id);
                }}
              >
                <summary>{t.original}</summary>
                <pre>{reports[r.id] === undefined ? t.loading : reports[r.id] || t.noReport}</pre>
              </details>
            )}
          </article>
        );
      })}
      {page?.hasMore && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => void load(page.nextBefore)}
        >
          {t.older}
        </button>
      )}
    </section>
  );
}
