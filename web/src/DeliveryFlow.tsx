import { useCallback, useEffect, useRef, useState } from "react";
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
const labels: Record<string, string> = {
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
};
const call = <T,>(op: string, body: object, signal?: AbortSignal) =>
  api<T>(`/collaboration/${op}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
const short = (s?: string) => s?.slice(0, 8) || "Unknown";
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
    <section className="delivery-flow" aria-label="Task delivery">
      <div className="delivery-heading">
        <GitPullRequest size={16} />
        <strong>Automatic delivery</strong>
        {flow && (
          <span className={`delivery-state is-${flow.state}`} role="status">
            {labels[flow.state] || flow.state}
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          onClick={() => void load()}
          aria-label="Refresh delivery"
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
              Linked PR ↗
            </a>
            <code title={round?.baseSha}>{short(round?.baseSha)}</code>
            <ArrowRight size={12} />
            <code title={round?.headSha}>{short(round?.headSha)}</code>
            <span>
              Review {round?.number} / {flow.maxRounds}
            </span>
          </div>
          <div className="delivery-evidence">
            <span>
              <CircleCheck size={13} />{" "}
              {flow.reviewEvidence
                ? `${flow.reviewEvidence.status} · ${flow.reviewEvidence.conclusion.replaceAll("_", " ")}`
                : "No completed review"}
            </span>
            {flow.reviewEvidence && (
              <small>
                Reviewer: {flow.reviewEvidence.actualModel || "Not confirmed"} ·{" "}
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
                  Original review evidence ↗
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
                CI observed{" "}
                {new Date(flow.ciEvidence.watch.observedAt).toLocaleString()}
              </small>
            )}
          </div>
          <details>
            <summary>Authorization and operation identities</summary>
            {flow.rounds.map((r) => (
              <div className="delivery-round" key={r.number}>
                <strong>
                  Round {r.number} · {r.settings.harness} / {r.settings.model}
                </strong>
                <code>Result: {r.resultId || "Not submitted"}</code>
                <code>Review: {r.review.id || "Not started"}</code>
                <code>{r.review.requestId}</code>
                <code>CI: {r.ci.id || "Not subscribed"}</code>
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
              Authorize next candidate…
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
              Stop automatic delivery
            </button>
          )}
        </>
      ) : (
        page && (
          <>
            <p>Connect one fixed PR revision to independent review and CI.</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setExpanded(!expanded)}
            >
              Set up delivery…
            </button>
          </>
        )
      )}
      {page && expanded && (!flow || canContinue) && (
        <div className="delivery-setup">
          {!flow && (
            <label>
              Pull request
              <select
                value={linked?.id || ""}
                onChange={(e) => setLinkId(e.target.value)}
              >
                <option value="" disabled>
                  Choose a linked PR
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
            Authorize{" "}
            <strong>
              {page.settings.harness} / {page.settings.model}
            </strong>{" "}
            for{" "}
            <code>
              {short(linked?.snapshot.baseSha)} →{" "}
              {short(linked?.snapshot.headSha)}
            </code>
            .
          </p>
          {!flow && (
            <label>
              Maximum paid review attempts
              <select
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
              >
                <option value={1}>1 review</option>
                <option value={2}>
                  Up to 2 reviews · explicit continuation required
                </option>
              </select>
            </label>
          )}
          {!fresh && (
            <p>
              Refresh the PR in GitHub links above before authorizing this
              version.
            </p>
          )}
          <p className="delivery-note">
            Starts after a matching result submission. No automatic fixes, merge
            or deployment. CI covers the observed GitHub Actions workflows;
            merge requirements still need a person’s judgment.
          </p>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !fresh}
            onClick={authorize}
          >
            {flow ? "Authorize next review candidate" : "Enable this delivery"}
          </button>
        </div>
      )}
    </section>
  );
}
