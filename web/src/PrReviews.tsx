import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import type { GitHubLink } from "./GitHubLinks";
import { describeRead, type ContextRead } from "./review-reads";
import { reviewConclusions, reviewReasons } from "./review-outcome";
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
const conclusion = reviewConclusions;
const short = (sha: string | null) => sha?.slice(0, 8) || "Pending";
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
      if (value)
        setReports((old) => ({
          ...old,
          [id]: value.rawReport || "No original report was returned.",
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
    <section className="pr-reviews" aria-label="PR reviews">
      <h4>PR reviews</h4>
      {controls && (
        <>
      <p className="github-hint">
        Review the full PR with{" "}
        {page?.settings?.harness === "claude" ? "Claude Code" : "Codex"} (
        {page?.settings?.model || "gpt-6.1-sol"}). Source is read only; tests
        are not run. Findings are the model’s assessment.
      </p>
      <label className="pr-review-recipient">
        Notify when finished
        <select
          aria-label="Review result recipient"
          value={notifyAgentId}
          onChange={(e) => setNotifyAgentId(e.target.value)}
          disabled={busy || disabled}
        >
          <option value="">Show in this task only</option>
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
              Review PR
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
                {r.repository}#{r.number} · Round {r.round ?? 1}
                {r.kind === "continuation" &&
                  ` · continues round ${r.continuation?.parentRound ?? "?"}`}
                {r.kind === "incremental" &&
                  ` · new head after round ${r.incremental?.previousRound ?? "?"}`}
              </strong>
              <span>{r.status}</span>
            </header>
            <small>
              {new Date(r.createdAt).toLocaleString()} ·{" "}
              {r.actualHarness === "claude"
                ? "Claude Code"
                : r.actualHarness === "codex"
                  ? "Codex"
                  : "Not started"}{" "}
              · {r.actualModel || r.requestedModel}
            </small>
            <p role={active(r) ? "status" : undefined}>
              {active(r)
                ? r.phase
                : conclusion[r.conclusion] || "Conclusion unknown"}
            </p>
            {outdated === true && (
              <p className="github-stale">
                Outdated report · PR base or head has changed
              </p>
            )}
            {(link?.stale || outdated === null) && (
              <p className="github-hint">
                Latest PR revision is unverified. Refresh GitHub to compare
                versions.
              </p>
            )}
            <details>
              <summary>
                Reviewed head {short(r.headSha)} · base {short(r.baseSha)}
              </summary>
              <dl>
                <dt>Requested reviewer</dt>
                <dd>
                  {r.requestedHarness} · {r.requestedModel}
                </dd>
                <dt>Base SHA</dt>
                <dd>{r.baseSha || "Pending"}</dd>
                <dt>Head SHA</dt>
                <dd>{r.headSha || "Pending"}</dd>
                <dt>Actual comparison</dt>
                <dd>
                  {r.mergeBaseSha
                    ? `${r.mergeBaseSha}..${r.headSha}`
                    : "Pending"}
                </dd>
              </dl>
              {r.fileCount != null && (
                <p>
                  {r.fileCount} changed files · {r.commitCount} PR commits
                </p>
              )}
              {(r.coverage?.version ?? 0) >= 2 && r.coverage && (
                <p>
                  {r.coverage.coveredFileCount} of {r.coverage.fileCount} files covered
                  {" · "}{r.coverage.deliveredCompleteDiffs} by complete diff
                  {" · "}{r.coverage.fullAddedSourceCount} by complete added-file source
                  {r.kind === "continuation" && (
                    <>{" · "}{r.coverage.inheritedCoveredCount ?? 0} read by round {r.continuation?.parentRound ?? "?"}</>
                  )}
                  {r.kind === "incremental" && (
                    <>{" · "}{r.coverage.inheritedCoveredCount ?? 0} unchanged since round {r.incremental?.previousRound ?? "?"}</>
                  )}
                </p>
              )}
              {r.kind === "continuation" && (
                <p className="pr-review-continuation">
                  Continues round {r.continuation?.parentRound ?? "?"} for the{" "}
                  {r.continuation?.targets?.length ?? 0}{" "}
                  {r.continuation?.targets?.length === 1 ? "path" : "paths"} it left unread: a new
                  reviewer run with its own cost, within what that round left of its
                  budget. Coverage and conclusion are over both rounds; that round's
                  findings are kept as it recorded them.
                </p>
              )}
              {r.kind === "incremental" && (
                <p className="pr-review-incremental">
                  Reviews a new head after round {r.incremental?.previousRound ?? "?"}:
                  it reads the {r.incremental?.targets?.length ?? 0}{" "}
                  {r.incremental?.targets?.length === 1
                    ? "path that changed or wasn't read before"
                    : "paths that changed or weren't read before"}
                  , and keeps that round's proofs only for paths identical on both
                  sides. A new round with its own budget and cost. That round's
                  findings stay unless this one shows them fixed by its own
                  reads ({r.settledFindings?.length ?? 0} settled).
                </p>
              )}
              <p className="github-hint">
                Includes full patches and changed-file source, with
                fixed-version context reads as needed.
              </p>
            </details>
            {r.scope?.paths?.length ? (
              <details className="pr-review-scope">
                <summary>Review scope · {scopeSummary(r.scope)}</summary>
                <p className="github-hint">{describePolicy(r.scope.policy)}</p>
                {scopeFixedGaps(r.scope) && (
                  <p className="github-hint">
                    Some paths can't be reviewed as text at this head or are excluded, so no round of it can be complete.
                  </p>
                )}
                {r.scopeConclusion && (
                  <p>
                    Within the policy's scope: {conclusion[r.scopeConclusion] ?? r.scopeConclusion}. Shown for
                    information; the review's own conclusion stands.
                  </p>
                )}
                <ul aria-label="Paths outside the review">
                  {r.scope.paths
                    .filter((p) => p.state !== "covered")
                    .map((p) => (
                      <li key={p.path}>{describeScopePath(p)}</li>
                    ))}
                </ul>
                {!!r.evidence?.length && (
                  <>
                    <p>Evidence registered for these paths, kept apart from the review:</p>
                    <ul aria-label="Registered evidence">
                      {r.evidence.map((e) => (
                        <li key={e.id} className={e.binding === "this_candidate" ? undefined : "github-hint"}>
                          {describeEvidence(e)}
                          {e.note ? ` · Author's note: ${e.note}` : ""}
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
                  {r.contextReads.length} context reads
                  {(() => {
                    const failed = r.contextReads.filter((read) => describeRead(read).error).length;
                    return failed ? ` · ${failed} failed` : "";
                  })()}
                </summary>
                {r.contextReads.map((read, i) => {
                  const view = describeRead(read);
                  return (
                    <p key={i} className={view.error ? "github-error" : undefined}>
                      {view.label}
                      {view.version ? ` · ${view.version}` : ""}
                      {view.error ? ` · Failed: ${view.error}` : ""}
                    </p>
                  );
                })}
              </details>
            )}
            <small>Review ID: {r.id}</small>
            {r.explanation && <p>{r.explanation}</p>}
            {r.error && <p className="github-error">{r.error}</p>}
            {reviewReasons(r).length > 0 && (
              <ul className="github-hint" aria-label="Review reasons">
                {reviewReasons(r).map((reason) => <li key={reason}>{reason}</li>)}
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
                Cancel review
              </button>
            ) : (
              <details
                open={r.id === focusReviewId && !!focused ? true : undefined}
                onToggle={(event) => {
                  if (event.currentTarget.open && reports[r.id] === undefined)
                    void original(r.id);
                }}
              >
                <summary>Original report</summary>
                <pre>{reports[r.id] ?? "Loading…"}</pre>
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
          Older reviews
        </button>
      )}
    </section>
  );
}
