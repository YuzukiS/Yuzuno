import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { api, errorText } from "./api";
import type { GitHubLink } from "./GitHubLinks";
import "./delivery-flow.css";
import { openTaskReview } from "./ReviewJobs";
import { strings, useStrings } from "./i18n";
import { randomId } from "./random-id";
import { Tip, TipText } from "./Tip";

export type DeliveryCandidate = {
  flowId: string;
  round: number;
  baseSha: string;
  headSha: string;
};
type Settings = { harness: string; model: string };
type Step = {
  id: string | null;
  requestId: string;
  attempts: number;
  error: string | null;
};
type Round = {
  number: number;
  baseSha: string;
  headSha: string;
  settings: Settings;
  resultId: string | null;
  review: Step;
  ci: Step;
};
type ReviewEvidence = {
  id: string;
  status: string;
  conclusion: string;
  actualModel: string | null;
  finishedAt: string | null;
  /** The revision it reviewed; absent from older Cores. */
  baseSha?: string | null;
  headSha?: string | null;
};
type CiEvidence = {
  watch: {
    observedAt: string | null;
    error: string | null;
    /** What the watch saw at its last read; the runs are that commit's. */
    currentHeadSha?: string | null;
    currentPr?: { baseSha?: string | null } | null;
  };
  runs: {
    id: string;
    name: string;
    conclusion: string | null;
    status: string;
    url: string;
  }[];
};
type Flow = {
  id: string;
  enabled: boolean;
  linkId: string;
  url: string;
  maxRounds: number;
  state: string;
  reason: string;
  rounds: Round[];
  candidate: DeliveryCandidate;
  /** The round record's attempt number, from a Core that names it (YN-12 S4). */
  attempt?: number;
  reviewEvidence: ReviewEvidence | null;
  ciEvidence: CiEvidence | null;
};
type Page = { flow: Flow | null; settings: Settings };
// A task's delivery in the interface language (T-189). Core's reason, the
// review's status and conclusion, CI run names and results, harness and
// model names, commits and operation identities are shown as they are.
const deliveryText = strings({
  states: {
    awaiting_result: "Waiting for result",
    waiting_review: "Waiting for review",
    waiting_ci: "Waiting for CI",
    waiting_fix: "Waiting for fixes",
    ci_failed: "CI did not pass",
    ready_to_merge: "Ready for merge decision",
    needs_judgment: "Needs judgment",
    infrastructure_error: "Execution needs attention",
    candidate_changed: "Revision changed",
    stopped: "Delivery stopped",
    completed: "Task completed",
    cancelled: "Task cancelled",
    archived: "Task archived",
    merged: "Merged · deployment untracked",
  } as Record<string, string>,
  aria: "Task delivery",
  title: "Automatic delivery",
  refresh: "Refresh delivery",
  linkedPr: "Linked PR ↗",
  reviewOf: (round: number | undefined, max: number) => `Review ${round ?? ""} / ${max}`,
  noReview: "No completed review",
  reviewer: "Reviewer: ",
  notConfirmed: "Not confirmed",
  evidence: "Original review evidence ↗",
  ciObserved: (at: string) => `CI observed ${at}`,
  // The waiting line at the entry (R-18 #4): which candidate, how it was
  // attempted, what it waits for, when that was last observed, and what a
  // person can do now. Core's reason and state are its own facts.
  roundHead: (round: number, head: string) => `Round ${round} · head ${head}`,
  attempt: (attempt: number) => `attempt ${attempt}`,
  noEvidence: "No review or CI observation yet",
  reviewFinished: (at: string) => `Review finished ${at}`,
  reviewOther: (head: string) => `Review evidence is for another revision (head ${head}); it does not apply to this candidate.`,
  reviewUnrecorded: "This review does not record its revision; whether it applies to this candidate is unconfirmed.",
  ciOther: (head: string) => `CI evidence is for another revision (head ${head}); it does not mark this candidate green.`,
  ciUnrecorded: "This CI evidence does not record its revision; whether it applies to this candidate is unconfirmed.",
  actions: {
    awaiting_result: "A matching result submission starts review.",
    waiting_review: "Read again every few seconds; Refresh reads now.",
    waiting_ci: "Refresh reads CI now; nothing reruns it from here.",
    waiting_fix: "Push a fix, then explicitly continue the delivery.",
    ci_failed: "Inspect the failed runs; CI is never rerun from here.",
    ready_to_merge: "A person checks merge requirements and merges; nothing is deployed.",
    needs_judgment: "Refresh and reconcile before another candidate.",
    infrastructure_error: "Refresh; an inactive or unreadable review or CI needs attention.",
    candidate_changed: "Authorize the next candidate for the new revision.",
    stopped: "Delivery stopped; existing evidence is kept.",
  } as Record<string, string>,
  identities: "Authorization and operation identities",
  round: (round: number) => `Round ${round}`,
  result: (id: string | null) => `Result: ${id || "Not submitted"}`,
  review: (id: string | null) => `Review: ${id || "Not started"}`,
  ci: (id: string | null) => `CI: ${id || "Not subscribed"}`,
  authorizeNext: "Authorize next candidate…",
  stop: "Stop automatic delivery",
  intro: "Connect one fixed PR revision to independent review and CI.",
  setUp: "Set up delivery…",
  pullRequest: "Pull request",
  choose: "Choose a linked PR",
  authorize: (who: ReactNode, revision: ReactNode): ReactNode => (
    <>
      Authorize {who} for {revision}.
    </>
  ),
  maxRounds: "Maximum paid review attempts",
  oneReview: "1 review",
  twoReviews: "Up to 2 reviews · explicit continuation required",
  refreshFirst: "Refresh the PR in GitHub links above before authorizing this version.",
  note: "Starts after a matching result submission. No automatic fixes, merge or deployment. CI covers the observed GitHub Actions workflows; merge requirements still need a person’s judgment.",
  authorizeNextReview: "Authorize next review candidate",
  enable: "Enable this delivery",
  unknown: "Unknown",
}, {
  states: {
    awaiting_result: "等待结果",
    waiting_review: "等待审查",
    waiting_ci: "等待 CI",
    waiting_fix: "等待修复",
    ci_failed: "CI 未通过",
    ready_to_merge: "可以决定是否合并",
    needs_judgment: "需要判断",
    infrastructure_error: "执行需要处理",
    candidate_changed: "修订已变化",
    stopped: "交付已停止",
    completed: "任务已完成",
    cancelled: "任务已取消",
    archived: "任务已归档",
    merged: "已合并 · 未跟踪部署",
  },
  aria: "任务交付",
  title: "自动交付",
  refresh: "刷新交付",
  linkedPr: "已链接的 PR ↗",
  reviewOf: (round, max) => `审查 ${round ?? ""} / ${max}`,
  noReview: "没有已完成的审查",
  reviewer: "审查模型：",
  notConfirmed: "未确认",
  evidence: "原始审查证据 ↗",
  ciObserved: (at) => `CI 观察于 ${at}`,
  roundHead: (round, head) => `第 ${round} 轮 · head ${head}`,
  attempt: (attempt) => `尝试 ${attempt}`,
  noEvidence: "尚无审查或 CI 观察",
  reviewFinished: (at) => `审查完成于 ${at}`,
  reviewOther: (head) => `审查证据属于另一个修订（head ${head}），不适用于当前候选。`,
  reviewUnrecorded: "此审查未记录其修订，是否适用于当前候选未确认。",
  ciOther: (head) => `CI 证据属于另一个修订（head ${head}），不能把当前候选标为通过。`,
  ciUnrecorded: "此 CI 证据未记录其修订，是否适用于当前候选未确认。",
  actions: {
    awaiting_result: "提交匹配的结果后开始审查。",
    waiting_review: "每几秒重读一次；刷新立即读取。",
    waiting_ci: "刷新立即读取 CI；这里不会重跑 CI。",
    waiting_fix: "推送修复后，再明确继续交付。",
    ci_failed: "查看失败的运行；这里不会重跑 CI。",
    ready_to_merge: "由人核对合并要求并合并；不会部署。",
    needs_judgment: "刷新并核对后再决定下一个候选。",
    infrastructure_error: "刷新；未生效或无法读取的审查或 CI 需要处理。",
    candidate_changed: "为新的修订授权下一个候选。",
    stopped: "交付已停止；已有证据保留。",
  },
  identities: "授权与操作标识",
  round: (round) => `第 ${round} 轮`,
  result: (id) => `结果：${id || "未提交"}`,
  review: (id) => `审查：${id || "未开始"}`,
  ci: (id) => `CI：${id || "未订阅"}`,
  authorizeNext: "授权下一个候选…",
  stop: "停止自动交付",
  intro: "把一个固定的 PR 修订交给独立审查和 CI。",
  setUp: "设置交付…",
  pullRequest: "拉取请求",
  choose: "选择一个已链接的 PR",
  authorize: (who, revision) => (
    <>
      为 {revision} 授权 {who}。
    </>
  ),
  maxRounds: "付费审查次数上限",
  oneReview: "1 次审查",
  twoReviews: "最多 2 次审查 · 需要明确继续",
  refreshFirst: "授权此版本前，请先在上方的 GitHub 链接中刷新这个 PR。",
  note: "在提交匹配的结果后开始。不会自动修复、合并或部署。CI 覆盖观察到的 GitHub Actions 工作流；合并要求仍需要人来判断。",
  authorizeNextReview: "授权下一个审查候选",
  enable: "启用此交付",
  unknown: "未知",
});
const call = <T,>(op: string, body: object, signal?: AbortSignal) =>
  api<T>(`/collaboration/${op}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
const short = (s: string | undefined, unknown: string) => s?.slice(0, 8) || unknown;
/** Two revisions are the same commit, whatever the case GitHub wrote it in. */
const sameSha = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
export function DeliveryFlow({
  taskId,
  revision,
  onCandidate,
  manage = true,
}: {
  taskId: string;
  revision: number;
  onCandidate: (candidate: DeliveryCandidate | null) => void;
  /** Offer setting delivery up; a running flow always shows. */
  manage?: boolean;
}) {
  const t = useStrings(deliveryText);
  const [page, setPage] = useState<Page | null>(null);
  const [links, setLinks] = useState<GitHubLink[]>([]);
  const [linkId, setLinkId] = useState("");
  const [maxRounds, setMaxRounds] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const load = useCallback(async () => {
    const stamp = ++generation.current;
    try {
      const [next, github] = await Promise.all([
        call<Page>("delivery_get", { taskId }),
        call<{ links: GitHubLink[] }>("github_links", { taskId }),
      ]);
      if (generation.current !== stamp) return;
      setPage(next);
      setLinks(github.links.filter((l) => l.kind === "pull"));
      setError("");
    } catch (e) {
      if (generation.current === stamp) {
        setError(errorText(e));
        setPage(null);
      }
    }
  }, [taskId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load, revision]);
  useEffect(() => {
    // Read only the existing durable state; never launches or polls a model.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  const flow = page?.flow;
  const round = flow?.rounds.at(-1);
  // Which candidate each fact belongs to (R-18 #4): a green review or CI run
  // for a revision other than the fixed candidate is not this candidate's.
  const review = flow?.reviewEvidence ?? null;
  const reviewMatches = review?.headSha && review.baseSha
    ? sameSha(review.headSha, flow?.candidate.headSha) && sameSha(review.baseSha, flow?.candidate.baseSha)
    : null;
  const reviewRunning = !!review && ["queued", "preparing", "running"].includes(review.status);
  const reviewPasses = !!review && review.status === "completed" &&
    (review.conclusion === "no_findings" || review.conclusion === "approved_with_notes");
  const ciHead = flow?.ciEvidence?.watch.currentHeadSha ?? null;
  const ciMatches = ciHead ? sameSha(ciHead, flow!.candidate.headSha) : null;
  // When the facts were last observed, in the one waiting line.
  const observedAt = flow?.ciEvidence?.watch.observedAt
    ? t.ciObserved(new Date(flow.ciEvidence.watch.observedAt).toLocaleString())
    : review?.finishedAt
      ? t.reviewFinished(new Date(review.finishedAt).toLocaleString())
      : t.noEvidence;
  const action = flow ? t.actions[flow.state] : undefined;
  const candidateKey =
    flow?.state === "awaiting_result" ? JSON.stringify(flow.candidate) : "";
  useEffect(() => {
    onCandidate(candidateKey ? JSON.parse(candidateKey) : null);
  }, [candidateKey, onCandidate]);
  const linked =
    links.find((l) => l.id === (flow?.linkId || linkId)) ||
    (!flow && !linkId ? links[0] : undefined);
  const fresh =
    linked &&
    !linked.stale &&
    !linked.error &&
    linked.snapshot.baseSha &&
    linked.snapshot.headSha;
  const mutate = async (op: string, body: object) => {
    if (busy) return;
    const fingerprint = JSON.stringify([op, body]);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: randomId() };
    setBusy(true);
    setError("");
    try {
      await call(op, { ...body, requestId: request.current.id });
      request.current = null;
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const authorize = () => {
    if (!linked || !page) return;
    void mutate(flow ? "delivery_continue" : "delivery_enable", {
      taskId,
      linkId: linked.id,
      baseSha: linked.snapshot.baseSha,
      headSha: linked.snapshot.headSha,
      settings: page.settings,
      ...(flow
        ? { flowId: flow.id, expectedRound: round!.number }
        : { maxRounds }),
    });
  };
  const canContinue =
    flow &&
    flow.enabled &&
    round &&
    round.number < flow.maxRounds &&
    flow.reviewEvidence &&
    !["queued", "preparing", "running", "unknown"].includes(flow.reviewEvidence.status);
  if (!manage && !flow && !error) return null;
  return (
    <section className="delivery-flow" aria-label={t.aria}>
      <div className="delivery-heading">
        <GitPullRequest size={16} />
        <strong>{t.title}</strong>
        {flow && (
          <span className={`delivery-state is-${flow.state}`} role="status">
            {t.states[flow.state] || flow.state}
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={() => void load()}
          aria-label={t.refresh}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <p className="delivery-error" role="alert">
          {error}
        </p>
      )}
      {flow ? (
        <>
          {/* The normal entry: which candidate, what it waits for, when the
              facts were observed and what a person can do now, in one line. */}
          <p className="delivery-wait">
            <strong>{t.roundHead(flow.candidate.round, short(flow.candidate.headSha, t.unknown))}</strong>
            {flow.attempt && <> · {t.attempt(flow.attempt)}</>}
            {" · "}
            {flow.reason}
            {" · "}
            <span className="delivery-wait-at">{observedAt}</span>
            {action && <> · {action}</>}
          </p>
          <div className="delivery-revision">
            <a href={flow.url} target="_blank" rel="noreferrer">
              {t.linkedPr}
            </a>
            <Tip content={round?.baseSha ? <TipText value={round.baseSha} /> : null} size="wide"><code>{short(round?.baseSha, t.unknown)}</code></Tip>
            <ArrowRight size={12} />
            <Tip content={round?.headSha ? <TipText value={round.headSha} /> : null} size="wide"><code>{short(round?.headSha, t.unknown)}</code></Tip>
            <span>{t.reviewOf(round?.number, flow.maxRounds)}</span>
          </div>
          <div className="delivery-evidence">
            <span>
              {reviewPasses && reviewMatches !== false
                ? <CircleCheck size={13} />
                : reviewRunning
                  ? <CircleDashed size={13} />
                  : <CircleAlert size={13} />}{" "}
              {review
                ? `${review.status} · ${review.conclusion.replaceAll("_", " ")}`
                : t.noReview}
            </span>
            {review && (
              <small>
                {t.reviewer}
                {review.actualModel || t.notConfirmed} ·{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    openTaskReview({
                      taskId,
                      reviewId: review.id,
                    })
                  }
                >
                  {t.evidence}
                </button>
              </small>
            )}
            {review && reviewMatches === false && (
              <small className="delivery-mismatch" role="status">
                {t.reviewOther(short(review.headSha ?? undefined, t.unknown))}
              </small>
            )}
            {review && reviewMatches === null && (
              <small className="delivery-mismatch" role="status">{t.reviewUnrecorded}</small>
            )}
            {ciHead && ciMatches === false && (
              <small className="delivery-mismatch" role="status">
                {t.ciOther(short(ciHead, t.unknown))}
              </small>
            )}
            {flow.ciEvidence && !ciHead && (
              <small className="delivery-mismatch" role="status">{t.ciUnrecorded}</small>
            )}
            {flow.ciEvidence?.runs.map((run) => (
              <a key={run.id} href={run.url} target="_blank" rel="noreferrer">
                {run.name} · {run.conclusion || run.status} ↗
              </a>
            ))}
          </div>
          <details>
            <summary>{t.identities}</summary>
            {flow.rounds.map((r) => (
              <div className="delivery-round" key={r.number}>
                <strong>
                  {t.round(r.number)} · {r.settings.harness} / {r.settings.model}
                </strong>
                <code>{t.result(r.resultId)}</code>
                <code>{t.review(r.review.id)}</code>
                <code>{r.review.requestId}</code>
                <code>{t.ci(r.ci.id)}</code>
                <code>{r.ci.requestId}</code>
                {(r.review.error || r.ci.error) && (
                  <p>{r.review.error || r.ci.error}</p>
                )}
              </div>
            ))}
          </details>
          {canContinue && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setExpanded(!expanded)}
            >
              {t.authorizeNext}
            </button>
          )}
          {flow.enabled && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                void mutate("delivery_stop", { taskId, flowId: flow.id })
              }
            >
              {t.stop}
            </button>
          )}
        </>
      ) : (
        page && (
          <>
            <p>{t.intro}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setExpanded(!expanded)}
            >
              {t.setUp}
            </button>
          </>
        )
      )}
      {page && expanded && (!flow || canContinue) && (
        <div className="delivery-setup">
          {!flow && (
            <label>
              {t.pullRequest}
              <select
                value={linked?.id || ""}
                onChange={(e) => setLinkId(e.target.value)}
              >
                <option value="" disabled>
                  {t.choose}
                </option>
                {links.map((l) => (
                  <option key={l.id} value={l.id}>
                    #{l.number} · {l.snapshot.title || l.repository}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>
            {t.authorize(
              <strong>
                {page.settings.harness} / {page.settings.model}
              </strong>,
              <code>
                {short(linked?.snapshot.baseSha, t.unknown)} →{" "}
                {short(linked?.snapshot.headSha, t.unknown)}
              </code>,
            )}
          </p>
          {!flow && (
            <label>
              {t.maxRounds}
              <select
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
              >
                <option value={1}>{t.oneReview}</option>
                <option value={2}>{t.twoReviews}</option>
              </select>
            </label>
          )}
          {!fresh && (
            <p>{t.refreshFirst}</p>
          )}
          <p className="delivery-note">{t.note}</p>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !fresh}
            onClick={authorize}
          >
            {flow ? t.authorizeNextReview : t.enable}
          </button>
        </div>
      )}
    </section>
  );
}
