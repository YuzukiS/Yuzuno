import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CircleCheck,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { api, errorText } from "./api";
import type { GitHubLink } from "./GitHubLinks";
import "./delivery-flow.css";
import { openTaskReview } from "./ReviewJobs";
import { strings, useStrings } from "./i18n";

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
  reviewEvidence: {
    id: string;
    status: string;
    conclusion: string;
    actualModel: string | null;
    finishedAt: string | null;
  } | null;
  ciEvidence: {
    watch: { observedAt: string | null; error: string | null };
    runs: {
      id: string;
      name: string;
      conclusion: string | null;
      status: string;
      url: string;
    }[];
  } | null;
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
      request.current = { fingerprint, id: crypto.randomUUID() };
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
    !["preparing", "running", "unknown"].includes(flow.reviewEvidence.status);
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
          <p>{flow.reason}</p>
          <div className="delivery-revision">
            <a href={flow.url} target="_blank" rel="noreferrer">
              {t.linkedPr}
            </a>
            <code title={round?.baseSha}>{short(round?.baseSha, t.unknown)}</code>
            <ArrowRight size={12} />
            <code title={round?.headSha}>{short(round?.headSha, t.unknown)}</code>
            <span>{t.reviewOf(round?.number, flow.maxRounds)}</span>
          </div>
          <div className="delivery-evidence">
            <span>
              <CircleCheck size={13} />{" "}
              {flow.reviewEvidence
                ? `${flow.reviewEvidence.status} · ${flow.reviewEvidence.conclusion.replaceAll("_", " ")}`
                : t.noReview}
            </span>
            {flow.reviewEvidence && (
              <small>
                {t.reviewer}
                {flow.reviewEvidence.actualModel || t.notConfirmed} ·{" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    openTaskReview({
                      taskId,
                      reviewId: flow.reviewEvidence!.id,
                    })
                  }
                >
                  {t.evidence}
                </button>
              </small>
            )}
            {flow.ciEvidence?.runs.map((run) => (
              <a key={run.id} href={run.url} target="_blank" rel="noreferrer">
                {run.name} · {run.conclusion || run.status} ↗
              </a>
            ))}
            {flow.ciEvidence?.watch.observedAt && (
              <small>
                {t.ciObserved(new Date(flow.ciEvidence.watch.observedAt).toLocaleString())}
              </small>
            )}
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
