import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleDot,
  GitPullRequest,
  Github,
  Link2,
  LoaderCircle,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { api, errorText } from "./api";
import "./github-links.css";
import { PrReviews } from "./PrReviews";
import { PrOperations } from "./PrOperations";
import { openJobs } from "./Jobs";

export type GitHubLink = {
  id: string;
  repositoryId: number;
  repository: string;
  kind: "pull" | "issue";
  number: number;
  url: string;
  syncedAt: string | null;
  lastAttemptAt: string | null;
  stale: boolean;
  error: string | null;
  snapshot: {
    title: string;
    state: string;
    headSha?: string;
    baseSha?: string;
    headBranch?: string;
    baseBranch?: string;
    ci?: {
      state: string;
      headSha: string;
      observedAt: string;
      complete: boolean;
      checks: { name: string; state: string }[];
    };
  };
};
type Repository = {
  id: number;
  fullName: string;
  url: string;
  syncedAt: string;
  error: string | null;
};
type Page = {
  links: GitHubLink[];
  repositories: Repository[];
  refreshing: boolean;
};
const labels: Record<string, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  draft: "Draft",
  success: "Checks passed",
  failure: "Checks failed",
  pending: "Checks waiting / running",
  cancelled: "Checks cancelled",
  none: "No checks",
  unknown: "Checks unknown",
  neutral: "Checks skipped / neutral",
};
const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never synced";
const safeUrl = (value: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:pull|issues)\/[1-9]\d*)?$/.test(
    value,
  )
    ? value
    : undefined;
function ciState(link: GitHubLink) {
  const ci = link.snapshot.ci;
  return ci && ci.headSha === link.snapshot.headSha && ci.complete
    ? ci.state
    : "unknown";
}

const inFlight = (link: GitHubLink) =>
  link.snapshot.state === "open" || link.snapshot.state === "draft";

/** Compact, inert summary inside a task-card button; links live in the
 * detail. With `openOnly`, finished PRs and Issues are only counted. */
export function GitHubSummary({
  links = [],
  openOnly = false,
}: {
  links?: GitHubLink[];
  openOnly?: boolean;
}) {
  const shown = openOnly ? links.filter(inFlight) : links;
  const merged = openOnly ? links.filter((l) => l.snapshot.state === "merged").length : 0;
  const closed = openOnly ? links.length - shown.length - merged : 0;
  if (!shown.length && !merged && !closed) return null;
  return (
    <div className="github-summary" aria-label="Linked GitHub work">
      {shown.slice(0, 2).map((link) => (
        <span
          key={link.id}
          title={`${link.repository}#${link.number} · ${time(link.syncedAt)}`}
        >
          {link.kind === "pull" ? (
            <GitPullRequest size={12} />
          ) : (
            <CircleDot size={12} />
          )}
          {openOnly ? link.repository.split("/").pop() : link.repository}#{link.number}
          <span>{labels[link.snapshot.state] || link.snapshot.state}</span>
          {link.kind === "pull" && (
            <span
              className={`github-ci ${link.stale ? "stale" : ciState(link)}`}
            >
              {link.stale ? "Last known: " : ""}
              {labels[ciState(link)]}
            </span>
          )}
        </span>
      ))}
      {shown.length > 2 && <span>+{shown.length - 2} more</span>}
      {(merged > 0 || closed > 0) && (
        <span className="github-finished">
          {[merged && `${merged} merged`, closed && `${closed} closed`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

export function GitHubLinks({
  projectId,
  taskId,
  disabled = false,
  reviewId,
  manage = true,
  onManage,
}: {
  projectId?: string;
  taskId?: string;
  disabled?: boolean;
  /** A review to open in this task's PR reviews. */
  reviewId?: string;
  /** For a task: linking, PR operations and starting reviews. What is
   * linked, its checks and review runs always show. */
  manage?: boolean;
  /** Asks the task to show its management controls. */
  onManage?: () => void;
}) {
  const repoMode = !!projectId;
  const managing = repoMode || manage;
  const scopeKey = projectId || taskId || "";
  const operation = repoMode ? "github_repositories" : "github_links";
  const [page, setPage] = useState<Page | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const request = useCallback(
    async (op: string, extra: object = {}) => {
      const stamp = ++generation.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const value = await api<Page>(`/collaboration/${op}`, {
          method: "POST",
          body: JSON.stringify({
            ...(repoMode ? { projectId: scopeKey } : { taskId: scopeKey }),
            ...extra,
          }),
          signal: controller.signal,
        });
        if (!Array.isArray(value.links) || !Array.isArray(value.repositories))
          throw new Error("GitHub links are unavailable from this Core.");
        if (mounted.current && stamp === generation.current) {
          setPage(value);
          setError("");
        }
        return value;
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
    [scopeKey, repoMode],
  );
  useEffect(() => {
    mounted.current = true;
    setPage(null);
    setInput("");
    setNotice("");
    setError("");
    void request(operation).then((value) => {
      if (value && mounted.current) void request("github_refresh");
    });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void request("github_refresh");
    }, 120_000);
    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(timer);
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, [request, operation]);
  useEffect(() => {
    if (!page?.refreshing) return;
    const timer = window.setTimeout(() => void request(operation), 1500);
    return () => window.clearTimeout(timer);
  }, [page, request, operation]);
  const mutate = async (extra: object, clear = false) => {
    setBusy(true);
    setNotice("");
    const submitted = input;
    const result = await request(operation, extra);
    if (result) {
      if (clear) setInput((current) => (current === submitted ? "" : current));
      setNotice(
        clear
          ? "Linked. GitHub and task status stay independent."
          : "Association removed. The GitHub object is unchanged.",
      );
    }
    if (mounted.current) setBusy(false);
  };
  // A task with nothing linked says so in one line until it is managed.
  const quiet = !managing && !!page && !page.links.length && !error;
  return (
    <section
      className="github-panel"
      aria-label={repoMode ? "GitHub repositories" : "GitHub delivery"}
    >
      {!quiet && (
      <header>
        <h4>
          <Github size={16} />
          {repoMode ? "Repositories" : "Pull requests and issues"}
        </h4>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh GitHub"
          title="Refresh GitHub (requests are combined within 30 seconds)"
          disabled={busy || !!page?.refreshing}
          onClick={() => void request("github_refresh")}
        >
          <RefreshCw size={14} className={page?.refreshing ? "spin" : ""} />
        </button>
      </header>
      )}
      {repoMode && (
        <p className="github-hint">
          Link the repositories this project uses. A repository can belong to
          several projects.
        </p>
      )}
      {!page && !error && (
        <p className="github-sync">
          <LoaderCircle size={13} className="spin" />
          Loading links…
        </p>
      )}
      {error && (
        <p role="alert" className="github-error">
          {error}
          {page && " · Showing the last loaded links."}
        </p>
      )}
      <div className="github-list">
        {repoMode
          ? (page?.repositories || []).map((repo) => (
              <article key={repo.id} className="github-entry">
                <div className="github-entry-top">
                  <a href={safeUrl(repo.url)} target="_blank" rel="noreferrer">
                    <Github size={14} />
                    {repo.fullName}
                    <ArrowUpRight size={12} />
                  </a>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Unlink ${repo.fullName}`}
                    title="Remove from this project; task links stay"
                    onClick={() =>
                      void mutate({ action: "unlink", repositoryId: repo.id })
                    }
                  >
                    <Unlink size={13} />
                  </button>
                </div>
                <small>Synced {time(repo.syncedAt)}</small>
                {repo.error && (
                  <p className="github-error">
                    {repo.error} · Last known repository.
                  </p>
                )}
              </article>
            ))
          : (page?.links || []).map((link) => (
              <article
                key={link.id}
                className={`github-entry ${link.stale ? "is-stale" : ""}`}
              >
                <div className="github-entry-top">
                  <a href={safeUrl(link.url)} target="_blank" rel="noreferrer">
                    {link.kind === "pull" ? (
                      <GitPullRequest size={14} />
                    ) : (
                      <CircleDot size={14} />
                    )}
                    <span>
                      {link.repository}#{link.number}
                    </span>
                    <ArrowUpRight size={12} />
                  </a>
                  {managing && (
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      aria-label={`Unlink ${link.repository}#${link.number}`}
                      title="Remove association only"
                      onClick={() =>
                        void mutate({ action: "unlink", linkId: link.id })
                      }
                    >
                      <Unlink size={13} />
                    </button>
                  )}
                </div>
                <div className="github-title">{link.snapshot.title}</div>
                <div className="github-facts">
                  <span className={`github-state ${link.snapshot.state}`}>
                    {labels[link.snapshot.state]}
                  </span>
                  {link.kind === "pull" && (
                    <span
                      className={`github-ci ${link.stale ? "stale" : ciState(link)}`}
                    >
                      {link.stale ? "Last known: " : ""}
                      {labels[ciState(link)]}
                    </span>
                  )}
                  {link.stale && (
                    <span className="github-stale">Out of date</span>
                  )}
                </div>
                {link.snapshot.headSha && (
                  <div className="github-commit" title={link.snapshot.headSha}>
                    <span>
                      {link.snapshot.headBranch} → {link.snapshot.baseBranch}
                    </span>
                    <code>{link.snapshot.headSha.slice(0, 8)}</code>
                  </div>
                )}
                {taskId && link.kind === "pull" && link.snapshot.headSha && <button className="quiet-button" disabled={disabled} onClick={() => openJobs({ taskId, source: "github_actions", url: link.url, expectedSha: link.snapshot.headSha })}>Watch Actions at {link.snapshot.headSha.slice(0, 8)}…</button>}
                {link.snapshot.ci?.checks?.length ? (
                  <details className="github-checks">
                    <summary>
                      {link.snapshot.ci.checks.length} checks at{" "}
                      {link.snapshot.headSha?.slice(0, 8)}
                    </summary>
                    {link.snapshot.ci.checks.map((check, index) => (
                      <div key={index}>
                        <span>{check.name}</span>
                        <span>{labels[check.state] || check.state}</span>
                      </div>
                    ))}
                  </details>
                ) : null}
                <small>
                  Synced {time(link.syncedAt)}
                  {link.snapshot.ci &&
                    ` · Checks observed ${time(link.snapshot.ci.observedAt)}`}
                </small>
                {link.error && (
                  <p className="github-error">
                    {link.error} · Last successful snapshot kept.
                  </p>
                )}
              </article>
            ))}
      </div>
      {page && !(repoMode ? page.repositories : page.links).length && (
        <p className="github-empty">
          {repoMode
            ? "No repositories linked yet."
            : "No Issue or PR linked yet. An Issue is optional."}
          {!managing && onManage && (
            <button type="button" className="secondary-button" onClick={onManage}>
              <Link2 size={14} />
              Link a PR or Issue
            </button>
          )}
        </p>
      )}
      {managing && (
        <>
      <form
        className="github-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim())
            void mutate({ action: "link", input: input.trim() }, true);
        }}
      >
        <label htmlFor={`github-${scopeKey}`}>
          {repoMode ? "Repository" : "Issue or pull request URL"}
        </label>
        <div>
          <input
            id={`github-${scopeKey}`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              repoMode
                ? "owner/repository"
                : "https://github.com/owner/repo/pull/42"
            }
            maxLength={300}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="secondary-button"
            disabled={disabled || busy || !input.trim()}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Link2 size={14} />
            )}
            Link
          </button>
        </div>
      </form>
      {notice && (
        <p className="github-notice" role="status">
          {notice}
        </p>
      )}
      <p className="github-source">
        Read via gh on the Core host · GitHub.com
        {page?.refreshing ? " · Refreshing…" : ""}
      </p>
        </>
      )}
      {/* Kept mounted while folded away, so a half-written PR stays. */}
      {!repoMode && page && <div hidden={!managing}><PrOperations key={`operations-${scopeKey}`} taskId={scopeKey} disabled={disabled} onLinked={() => void request(operation)} /></div>}
      {!repoMode && page && <PrReviews key={scopeKey} taskId={scopeKey} links={page.links} disabled={disabled} focusReviewId={reviewId} controls={managing} />}
    </section>
  );
}
