import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, ExternalLink, RefreshCw } from "lucide-react";
import { api, errorText } from "./api";
import { reviewConclusions, reviewPassed, reviewReasons } from "./review-outcome";
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

const empty: Page = { reviews: [], hasMore: false, nextBefore: null };
const active = (r: ReviewRow) =>
  r.status === "preparing" || r.status === "running";
const conclusions = reviewConclusions;
/** The run's own state; a conclusion is shown only for a completed model run. */
export function reviewState(r: ReviewRow) {
  if (r.status === "preparing") return "Preparing";
  if (r.status === "running") return "Reviewing";
  if (r.status === "completed")
    return conclusions[r.conclusion || ""] || "Conclusion unknown";
  if (r.status === "failed") return "Failed";
  if (r.status === "cancelled") return "Cancelled";
  return "Outcome unknown";
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
export function requester(r: ReviewRow) {
  if (!r.requestedBy) return "Requester unknown (older record)";
  if (r.requestedBy.kind === "user") return "Requested by you";
  return `Requested by ${r.requestedBy.name || "an Agent"}`;
}
const stamp = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");
const short = (sha: string | null) => sha?.slice(0, 8) || "Not resolved";
/** The confirmed reviewer, or the requested one, labelled as such. */
export function reviewer(r: ReviewRow) {
  return harness(r.actualHarness) && r.actualModel
    ? `${harness(r.actualHarness)} · ${r.actualModel}`
    : `${harness(r.requestedHarness) || r.requestedHarness || "Reviewer"} · ${r.requestedModel || "default model"} (requested)`;
}
/** Time from request to end, or so far while it runs. */
export function took(r: ReviewRow, now = Date.now()) {
  const end = r.finishedAt ? Date.parse(r.finishedAt) : active(r) ? now : NaN;
  const seconds = Math.round((end - Date.parse(r.createdAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const text =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return active(r) ? `${text} so far` : text;
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
        throw new Error("Reviews in Jobs require an updated Core.");
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
        value.reviews[0] ? "" : "This review is not part of that task.",
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
    <section className="jobs-source review-jobs" aria-label="PR reviews">
      <JobsSourceHeading
        id="jobs-reviews-title"
        title="Reviews"
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh reviews"
            title="Refresh reviews"
            onClick={() => {
              setError("");
              void load();
            }}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        PR reviews started from a task. They run in Core and do not use this
        machine's job budget. Start a review from the task's PR.
        {scope.agentId &&
          ` Showing reviews ${agentName || "this Agent"} requested itself; reviews you requested are under Workspace.`}
      </JobsSourceHeading>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="jobs-browser">
        <StateGroups
          label="Reviews"
          items={rows}
          place={placeReview}
          selected={selected}
          empty={
            page ? (
              <p className="jobs-empty">
                {scope.agentId
                  ? `No reviews requested by ${agentName || "this Agent"}.`
                  : scope.taskId
                    ? "No reviews for this task yet."
                    : "No PR reviews yet. Start one from a task's linked PR."}
              </p>
            ) : (
              !error && <p className="jobs-empty">Loading reviews…</p>
            )
          }
          row={(r) => (
            <JobRow
              status={tone(r)}
              state={`${reviewState(r)}${r.outdated === true ? " · Outdated" : ""}`}
              name={`${r.repository}#${r.number} · Round ${r.round ?? 1}`}
              meta={[`${r.taskRef}${r.taskTitle ? ` · ${r.taskTitle}` : ""}`]}
              note={`${reviewer(r)}${r.headSha ? ` · head ${r.headSha.slice(0, 7)}` : ""} · ${requester(r)}`}
              time={took(r)}
              timeTitle={`Requested ${stamp(r.createdAt)}`}
              moments={moments([
                ["Queued", r.createdAt],
                ["Finished", r.finishedAt],
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
              Earlier reviews
            </button>
          )}
        </StateGroups>
        <div className="job-detail">
          {onLink && !listed && linkError && (
            <p className="inline-error" role="alert">
              {linkError}
            </p>
          )}
          {chosen ? (
            <ReviewSummary review={chosen} onOpenReport={onOpenReport} />
          ) : (
            !(onLink && linkError) && (
              <p className="jobs-empty">
                {onLink
                  ? "Reading review…"
                  : "Select a review to see its state and open the full report."}
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
}: {
  review: ReviewRow;
  onOpenReport: (review: ReviewRow) => void;
}) {
  const confirmed =
    harness(r.actualHarness) && r.actualModel
      ? `${harness(r.actualHarness)} · ${r.actualModel}`
      : "Model not confirmed";
  return (
    <>
      <JobDetailHeading
        status={tone(r)}
        state={`${reviewState(r)}${active(r) && r.phase ? ` · ${r.phase}` : ""}`}
        title={`${r.repository}#${r.number} · Round ${r.round ?? 1}`}
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
            Open PR on GitHub
          </a>
        )}
      </JobDetailHeading>
      {r.outdated === true && (
        <p className="review-outdated">
          Outdated · the PR's base or head changed after this review.
        </p>
      )}
      {r.outdated === null && !active(r) && (
        <p className="job-footnote">
          Whether the PR changed since is unverified.
        </p>
      )}
      {r.status === "unknown" && (
        <p className="job-footnote">
          Core could not confirm how this review ended. Unknown is not a
          passing review.
        </p>
      )}
      {r.error && <p className="inline-error">{r.error}</p>}
      {reviewReasons(r).length > 0 && (
        <ul className="job-footnote" aria-label="Review reasons">
          {reviewReasons(r).map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <JobCard title="Summary">
        <dl>
          <dt>Task</dt>
          <dd>
            {r.taskRef}
            {r.taskTitle ? ` · ${r.taskTitle}` : ""}
          </dd>
          <dt>Requested</dt>
          <dd>
            {requester(r)} · {stamp(r.createdAt)}
          </dd>
          <dt>Reviewer</dt>
          <dd>
            {confirmed}
            {r.requestedModel &&
              r.requestedModel !== r.actualModel &&
              ` (requested ${harness(r.requestedHarness) || r.requestedHarness} · ${r.requestedModel})`}
          </dd>
          <dt>Reviewed</dt>
          <dd>
            head {short(r.headSha)} · base {short(r.baseSha)}
          </dd>
          <dt>Ended</dt>
          <dd>
            {active(r) ? "Still running" : stamp(r.finishedAt)}
            {took(r) ? ` · ${took(r)}` : ""}
          </dd>
          {r.status === "completed" && (
            <>
              <dt>Findings</dt>
              <dd>{r.findingsCount}</dd>
            </>
          )}
          <dt>Review ID</dt>
          <dd>{r.id}</dd>
        </dl>
      </JobCard>
      <div className="job-detail-actions review-report-action">
        <button className="primary-button" onClick={() => onOpenReport(r)}>
          <ArrowUpRight size={14} aria-hidden="true" />
          Open full report in {r.taskRef}
        </button>
      </div>
      <p className="job-footnote">
        Findings are the model's assessment. A review does not merge the PR,
        pass CI or complete its task.
      </p>
    </>
  );
}
