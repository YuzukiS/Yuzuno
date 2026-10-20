import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, Github, RefreshCw } from "lucide-react";
import { api, errorText, post } from "./api";
import type { Agent } from "./types";
import {
  StatusMark,
  WorkDockGroup,
  WorkDockItem,
  WorkDockMore,
} from "./WorkDock";
import {
  JobCard,
  JobDetailHeading,
  JobRow,
  JobsSourceHeading,
  moments,
  StateGroups,
  type Placement,
} from "./JobParts";

export type Run = {
  id: string;
  name: string;
  repository: string;
  runId: string;
  attempt: string;
  headSha: string;
  status: string;
  rawStatus: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  observedAt: string;
  cursor: number;
  /** Current monitoring, independent of GitHub's last observed status. */
  runWatched?: boolean;
};
type Watch = {
  id: string;
  kind: string;
  number: number;
  /** A commit watch's target: GitHub's exact head branch and event. */
  branch?: string | null;
  event?: string | null;
  url: string;
  expectedSha: string;
  currentHeadSha: string;
  state: string;
  error: string | null;
  observedAt: string | null;
  lastAttemptAt: string | null;
  truncated?: boolean;
};
type Subscription = {
  id: string;
  agentId: string;
  agent: { name: string };
  taskRef: string;
  active: boolean;
  expiresAt: string;
  closure?: { reason: string; at: string } | null;
  watchId: string;
  watch: Watch;
};
export type Page = {
  runs: Run[];
  subscriptions: Subscription[];
  hasMore: boolean;
  nextBefore: number | null;
  subscriptionsTruncated?: boolean;
  cooldownUntil?: string | null;
};
type Step = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
};
type ChildJob = {
  id: number;
  name: string;
  status: string;
  rawStatus: string;
  conclusion: string | null;
  url: string;
  steps: Step[];
  stepsTruncated: boolean;
};
type Report = {
  run: Run;
  details: {
    jobs: ChildJob[];
    page: number;
    nextPage: number | null;
    hasMore: boolean;
    pageLimitReached: boolean;
    observedAt: string;
  } | null;
  error: string | null;
};
/** A manual check with GitHub (`POST /ci/refresh`). */
type Check = {
  status:
    | "busy"
    | "checked"
    | "recent"
    | "github_interval"
    | "cooldown"
    | "error"
    | "nothing";
  checkedAt?: string | null;
  retryAt?: string | null;
  error?: string | null;
  paused?: number;
  more?: number;
  runWatched?: boolean | null;
  run?: Run | null;
  details?: NonNullable<Report["details"]>[] | null;
};
const clock = (v: string) => new Date(v).toLocaleTimeString();
/** What a change worth new steps looks like: a running run's every new
 * observation, a finished one's transition only. */
const stateOf = (r: Run) =>
  JSON.stringify([
    r.rawStatus,
    r.conclusion,
    r.rawStatus === "completed" ? null : r.observedAt,
  ]);
/** What a check found, in words; the last observation is always kept. */
function checkText(c: Check) {
  const at = c.checkedAt ? clock(c.checkedAt) : "";
  const text =
    c.status === "busy"
      ? "Checking with GitHub…"
      : c.status === "checked"
        ? `Checked with GitHub at ${at}.`
        : c.status === "recent"
          ? `Checked with GitHub moments ago, at ${at}; not asked again.`
          : c.status === "github_interval"
            ? `GitHub asks to be checked less often; showing its answer from ${at}${c.retryAt ? `. Next check after ${clock(c.retryAt)}` : ""}.`
            : c.status === "cooldown"
              ? `GitHub is limiting reads${c.retryAt ? ` until ${clock(c.retryAt)}` : ""}. Showing the last successful observation.`
              : c.status === "error"
                ? `Couldn't check GitHub: ${c.error || "unknown error"}. Showing the last successful observation.`
                : "Nothing here is being watched, so there was nothing to check.";
  const notes = [
    c.runWatched === false &&
      "This run is not being watched. This check does not restart monitoring.",
    !!c.paused &&
      (c.runWatched === false
        ? "Its monitor remains paused after repeated failures."
        : `${c.paused} watch${c.paused > 1 ? "es" : ""} paused after repeated failures ${c.paused > 1 ? "were" : "was"} not checked; subscribe again to resume.`),
    !!c.more &&
      `${c.more} more watched target${c.more > 1 ? "s" : ""} follow${c.more > 1 ? "" : "s"} on schedule.`,
  ].filter(Boolean);
  return [text, ...notes].join(" ");
}
function mergeDetails(
  old: Report["details"] | undefined,
  next: Report["details"],
) {
  if (!old || !next) return next;
  return {
    ...next,
    jobs: [
      ...new Map([...old.jobs, ...next.jobs].map((j) => [j.id, j])).values(),
    ],
    // A multi-page view is only as fresh as its oldest retained page.
    observedAt:
      Date.parse(old.observedAt) < Date.parse(next.observedAt)
        ? old.observedAt
        : next.observedAt,
  };
}
export type CiScope = { agentId?: string; taskId?: string };
export type CiOpen = CiScope & {
  source?: "local" | "github_actions";
  runKey?: string;
  url?: string;
  expectedSha?: string;
};
const empty: Page = {
  runs: [],
  subscriptions: [],
  hasMore: false,
  nextBefore: null,
};
const labels: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped / neutral",
  running: "Running",
  pending: "Waiting",
  unknown: "Outcome unknown",
};
const stamp = (v?: string | null) =>
  v ? new Date(v).toLocaleString() : "Not observed yet";
const closureLabels: Record<string, string> = {
  task_completed: "Task completed",
  completed: "Task completed",
  task_cancelled: "Task cancelled",
  cancelled: "Task cancelled",
  task_archived: "Task archived",
  archived: "Task archived",
  pr_merged: "PR merged",
  merged: "PR merged",
  verification_completed: "Run verification completed",
  explicit_stop: "Stopped explicitly",
  stopped: "Delivery stopped",
  expired: "Subscription expired",
};
const closedLabel = (s: Subscription) =>
  s.closure
    ? s.closure.reason === "verification_completed" && s.watch.kind === "commit"
      ? "Commit verification completed"
      : closureLabels[s.closure.reason] || "Stopped"
    : "Stopped / expired";
const safeLink = (url: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:(?:actions\/runs\/|pull\/)[0-9]+(?:\/(?:attempts|job)\/[0-9]+)?|commit\/[0-9a-fA-F]{40})$/.test(
    url,
  )
    ? url
    : undefined;
/** A commit URL: Core watches that commit's runs on one branch for one event. */
const commitUrl = (url: string) =>
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[0-9a-fA-F]{40}$/.test(
    url.trim(),
  );
const watchLabel = (w: Watch) =>
  w.kind === "pull"
    ? `PR #${w.number}`
    : w.kind === "commit"
      ? `Commit ${w.expectedSha.slice(0, 8)} · ${w.branch} · ${w.event}`
      : `Run #${w.number}`;
const open = (detail: CiOpen) =>
  window.dispatchEvent(
    new CustomEvent("yuzuno:open-job", {
      detail: { ...detail, source: "github_actions" },
    }),
  );
/** The conversation's CI runs and subscriptions, for its jobs dock. */
// The last answer for each Agent. A refresh, or coming back to a
// conversation, keeps showing it until the next one arrives: an empty dock
// in between would take back its room and make the conversation jump.
const lastCi = new Map<string, Page>();
export function useConversationCi(
  agentId: string,
  revision: string,
  disabled: boolean,
) {
  const [page, setPage] = useState<Page>(() => lastCi.get(agentId) ?? empty);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    void api<Page>(`/ci?agentId=${encodeURIComponent(agentId)}`, {
      signal: controller.signal,
    })
      .then((p) => {
        if (controller.signal.aborted || !Array.isArray(p.runs)) return;
        lastCi.set(agentId, p);
        setPage(p);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [agentId, revision, disabled]);
  return page;
}
const runUnfinished = (run: Run) =>
  run.status === "running" || run.status === "pending";
export const runActive = (run: Run) =>
  run.runWatched !== false && runUnfinished(run);
const runLabel = (run: Run) =>
  run.runWatched === false && runUnfinished(run)
    ? `Last seen ${run.status === "running" ? "running" : "waiting"}`
    : labels[run.status] || run.status;
const runMark = (run: Run) =>
  run.runWatched === false && runUnfinished(run) ? "unconfirmed" : run.status;
/** Still going, or ended however it ended. */
const placeRun = (run: Run): Placement => (runActive(run) ? "active" : "done");
/** When it was queued and, once it has, when it finished. */
const runMoments = (run: Run) =>
  moments([
    ["Queued", run.createdAt],
    ["Finished", runUnfinished(run) ? null : run.updatedAt],
  ]);
/** Its latest moment, for the dock: finished, else started, else queued. */
const runLatest = (run: Run) =>
  !runUnfinished(run)
    ? moments([["Finished", run.updatedAt]])
    : run.startedAt
      ? moments([["Started", run.startedAt]])
      : moments([["Queued", run.createdAt]]);
/** How long a run took, or had taken when Core last looked. */
function ranFor(run: Run) {
  const end = Date.parse(runUnfinished(run) ? run.observedAt : run.updatedAt);
  const seconds = Math.round((end - Date.parse(run.startedAt || "")) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
/** A step's mark, from GitHub's own status and conclusion. */
function stepStatus(step: Step) {
  if (step.status !== "completed")
    return step.status === "in_progress" ? "running" : "pending";
  return (
    {
      success: "passed",
      failure: "failed",
      timed_out: "failed",
      cancelled: "cancelled",
      skipped: "skipped",
      neutral: "skipped",
    }[step.conclusion || ""] || "unknown"
  );
}

/** The runs the jobs dock picked; `more` were left out for room. */
export function ConversationCi({
  agentId,
  page,
  runs,
  more,
}: {
  agentId: string;
  page: Page;
  runs: Run[];
  more: number;
}) {
  if (!page.runs.length && !page.subscriptions.length) return null;
  const active = page.subscriptions.filter((s) => s.active).length;
  return (
    <WorkDockGroup
      label="GitHub Actions"
      icon={<Github size={14} />}
      onOpen={() => open({ agentId })}
    >
      {runs.map((r) => (
        <WorkDockItem
          key={r.id}
          className="conversation-job"
          status={runMark(r)}
          state={runLabel(r)}
          name={r.name}
          sub={`${runLabel(r)} · ${r.repository.split("/").pop()}`}
          detail={`${r.repository} · ${r.headSha.slice(0, 8)} · attempt ${r.attempt}`}
          when={runLatest(r)}
          onOpen={() => open({ agentId, runKey: r.id })}
        />
      ))}
      {!page.runs.length && (
        <WorkDockItem
          className="conversation-job"
          status={active ? "pending" : "unknown"}
          state={
            active
              ? `Watching ${active} CI subscription(s)`
              : "CI monitoring closed"
          }
          name="GitHub Actions"
          detail={
            active
              ? "No Actions runs observed yet"
              : "Retained subscription history"
          }
          onOpen={() => open({ agentId })}
        />
      )}
      {more > 0 && (
        <WorkDockMore
          label="GitHub Actions"
          count={more}
          onOpen={() => open({ agentId })}
        />
      )}
    </WorkDockGroup>
  );
}

export function CiJobs({
  scope,
  owners,
  defaultAgent,
  revision,
  initial,
}: {
  scope: CiScope;
  owners: Agent[];
  defaultAgent?: string;
  revision: string;
  initial: CiOpen;
}) {
  const [page, setPage] = useState<Page>(empty);
  const [selected, setSelected] = useState(initial.runKey || "");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const checking = useRef(false);
  const mounted = useRef(true);
  // Set again on every setup: StrictMode runs setup, cleanup, setup.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [creating, setCreating] = useState(!!initial.url);
  const [draft, setDraft] = useState({
    agentId: scope.agentId || defaultAgent || owners[0]?.id || "",
    taskId: scope.taskId || "",
    url: initial.url || "",
    expectedSha: initial.expectedSha || "",
    branch: "",
    event: "",
  });
  const request = useRef<{ payload: string; id: string } | null>(null);
  const generation = useRef(0);
  const reportRequest = useRef(0);
  const reportSnapshot = useRef(report);
  reportSnapshot.current = report;
  const visible = useRef<{ id: string; state: string | null }>({
    id: "",
    state: null,
  });
  const selection = useRef(selected);
  selection.current = selected;
  const query = new URLSearchParams(scope).toString();
  const load = useCallback(
    async (before?: number) => {
      const g = generation.current;
      try {
        const p = await api<Page>(
          `/ci?${query}${before ? `&before=${before}` : ""}`,
        );
        if (!Array.isArray(p.runs) || !Array.isArray(p.subscriptions))
          throw new Error("CI monitoring requires an updated Core.");
        if (generation.current !== g) return;
        setPage((old) =>
          before
            ? {
                ...p,
                runs: [
                  ...new Map(
                    [...old.runs, ...p.runs].map((r) => [r.id, r]),
                  ).values(),
                ],
              }
            : p,
        );
        setError("");
      } catch (e) {
        if (generation.current === g) setError(errorText(e));
      }
    },
    [query],
  );
  useEffect(() => {
    generation.current++;
    void load();
    return () => {
      generation.current++;
    };
  }, [load, revision]);
  const readReport = useCallback(
    async (runKey: string, number = 1, through = number) => {
      const request = ++reportRequest.current;
      const current = () =>
        request === reportRequest.current && selection.current === runKey;
      try {
        let r: Report | null = null;
        let details: Report["details"] = null;
        // Refresh only the pages already visible, with the same ten-page bound.
        // Commit them together so a later-page error retains the previous snapshot.
        for (let n = number; n <= Math.min(10, through); n++) {
          const next = await api<Report>(
            `/ci/${encodeURIComponent(runKey)}?page=${n}`,
          );
          if (!current()) return;
          if (next.error) {
            setError(next.error);
            setReport((old) => ({
              ...next,
              details: old?.run.id === next.run.id ? old.details : null,
            }));
            return;
          }
          details = mergeDetails(details, next.details);
          r = { ...next, details };
          if (!next.details?.hasMore) break;
        }
        if (!r) return;
        const complete = r;
        setError("");
        setReport((old) =>
          number > 1 && old?.run.id === complete.run.id
            ? {
                ...complete,
                details: mergeDetails(old.details, complete.details),
              }
            : complete,
        );
      } catch (e) {
        if (current()) setError(errorText(e));
      }
    },
    [],
  );
  const observedRun = page.runs.find((r) => r.id === selected);
  const observedState = observedRun ? stateOf(observedRun) : null;
  // A hidden window reads no steps; it catches up once when shown again.
  const behind = useRef(false);
  // The observation whose steps a refresh has already shown.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    const previous = visible.current;
    visible.current = { id: selected, state: observedState };
    if (previous.id !== selected) {
      behind.current = false;
      reportRequest.current++;
      setReport(null);
      if (selected) void readReport(selected);
    } else if (
      observedState &&
      previous.state &&
      observedState !== previous.state &&
      observedState !== shown.current
    ) {
      if (document.hidden) behind.current = true;
      else
        void readReport(
          selected,
          1,
          reportSnapshot.current?.details?.page || 1,
        );
    }
  }, [selected, observedState, readReport]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden || !behind.current || !selection.current) return;
      behind.current = false;
      void readReport(
        selection.current,
        1,
        reportSnapshot.current?.details?.page || 1,
      );
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [readReport]);
  /** Asks GitHub now about this view and the run on screen. */
  async function refresh() {
    // A click while one runs joins it; Core also merges other windows'.
    if (checking.current) return;
    checking.current = true;
    const runKey = selection.current || undefined;
    const pages =
      runKey && reportSnapshot.current?.run.id === runKey
        ? reportSnapshot.current.details?.page || 1
        : 1;
    setCheck({ status: "busy" });
    try {
      const c = await post<Check>("/ci/refresh", { ...scope, runKey, pages });
      if (!mounted.current) return;
      setCheck(selection.current === (runKey || "") ? c : null);
      const run = c.run;
      if (run)
        setPage((old) => ({
          ...old,
          runs: old.runs.map((r) => (r.id === run.id ? { ...r, ...run } : r)),
        }));
      if (run && c.details?.length && selection.current === run.id) {
        // Newer than any read still on its way.
        reportRequest.current++;
        behind.current = false;
        shown.current = stateOf(run);
        setError("");
        setReport({
          run,
          error: null,
          details: c.details.reduce<Report["details"]>(
            (all, next) => mergeDetails(all, next),
            null,
          ),
        });
      }
      await load();
    } catch (e) {
      if (mounted.current)
        setCheck(
          selection.current === (runKey || "")
            ? { status: "error", error: errorText(e) }
            : null,
        );
    } finally {
      checking.current = false;
    }
  }
  async function subscribe(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    // Branch and event name a commit watch's target; Core refuses them for
    // a PR or run URL.
    const { branch, event: runEvent, ...rest } = draft;
    const payload = JSON.stringify({
      ...rest,
      url: draft.url.trim(),
      expectedSha: draft.expectedSha.trim(),
      taskId: draft.taskId.trim(),
      ...(commitUrl(draft.url)
        ? { branch: branch.trim(), event: runEvent.trim() }
        : {}),
    });
    if (request.current?.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    try {
      await post("/ci", {
        ...JSON.parse(payload),
        requestId: request.current.id,
      });
      request.current = null;
      setCreating(false);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function stop(s: Subscription) {
    setBusy(true);
    setError("");
    try {
      await post(`/ci/subscriptions/${s.id}/stop`);
      await load();
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const chosen =
    observedRun || (report?.run.id === selected ? report.run : undefined);
  return (
    <section className="jobs-source ci-jobs" aria-label="GitHub Actions jobs">
      <JobsSourceHeading
        id="jobs-ci-title"
        title="GitHub Actions"
        actions={
          <>
            {!creating && (
              <button
                type="button"
                className="icon-button"
                aria-label="Check CI with GitHub now"
                title="Check CI with GitHub now"
                aria-busy={check?.status === "busy"}
                disabled={check?.status === "busy"}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  size={15}
                  className={check?.status === "busy" ? "spin" : undefined}
                />
              </button>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={!owners.length}
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? (
                <ArrowLeft size={14} aria-hidden="true" />
              ) : (
                <Eye size={14} aria-hidden="true" />
              )}
              {creating ? "Back to runs" : "Watch CI"}
            </button>
          </>
        }
      >
        Runs Core watches on GitHub for a PR or run commit. Remote runs do not
        use this machine's job budget.
      </JobsSourceHeading>
      {check ? (
        <p
          className={`ci-check${check.status === "error" || check.status === "cooldown" ? " inline-error" : ""}`}
          role="status"
        >
          {checkText(check)}
        </p>
      ) : (
        page.cooldownUntil && (
          <p className="ci-check" role="status">
            GitHub is limiting reads until {clock(page.cooldownUntil)}. Showing
            the last successful observation.
          </p>
        )
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {creating ? (
        <form className="job-form" onSubmit={subscribe}>
          <fieldset className="job-form-group">
            <legend>What to watch</legend>
            <label>
              Notify Agent
              <select
                required
                value={draft.agentId}
                onChange={(e) =>
                  setDraft({ ...draft, agentId: e.target.value })
                }
              >
                {owners.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Existing task
              <input
                required
                value={draft.taskId}
                onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}
                placeholder="T-49"
              />
            </label>
            <label className="job-wide">
              GitHub PR, Actions run or commit URL
              <input
                required
                type="url"
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://github.com/owner/repo/pull/123"
              />
            </label>
            {commitUrl(draft.url) && (
              <>
                <label>
                  Branch of its runs
                  <input
                    required
                    value={draft.branch}
                    onChange={(e) =>
                      setDraft({ ...draft, branch: e.target.value })
                    }
                    placeholder="main"
                  />
                </label>
                <label>
                  Event of its runs
                  <input
                    required
                    value={draft.event}
                    onChange={(e) =>
                      setDraft({ ...draft, event: e.target.value })
                    }
                    placeholder="push"
                  />
                </label>
              </>
            )}
            <label className="job-wide">
              Commit to watch
              <input
                required
                pattern="[a-fA-F0-9]{40}"
                value={draft.expectedSha}
                onChange={(e) =>
                  setDraft({ ...draft, expectedSha: e.target.value })
                }
                placeholder="Full 40-character SHA"
              />
            </label>
          </fieldset>
          <div className="job-form-footer">
            <small>
              Core watches this commit for seven days, including new attempts,
              and sends normal mailbox results. You can close this window or end
              the Agent's Turn. A newer PR commit needs a new subscription. A
              commit URL can be watched before any run exists: only that
              commit's runs on that branch for that event count.
            </small>
            <button className="primary-button" disabled={busy}>
              {busy ? "Saving…" : "Subscribe to CI"}
            </button>
          </div>
        </form>
      ) : (
        <>
          {!!page.subscriptions.length && (
            <details className="ci-subscriptions" open={!page.runs.length}>
              <summary>
                {page.subscriptions.filter((s) => s.active).length} active
                subscription(s)
              </summary>
              {page.subscriptions.map((s) => (
                <div className="ci-subscription" key={s.id}>
                  <div>
                    <strong>
                      {s.taskRef} · {s.agent.name}
                    </strong>
                    <a
                      href={safeLink(s.watch.url)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {watchLabel(s.watch)}
                    </a>
                    <span>
                      {s.active
                        ? s.watch.state === "waiting_for_run"
                          ? "Waiting for a run of"
                          : "Watching"
                        : "Watched"}{" "}
                      {s.watch.expectedSha.slice(0, 8)} ·{" "}
                      {s.active
                        ? `until ${stamp(s.expiresAt)}`
                        : `${closedLabel(s)}${s.closure?.at ? ` · ${stamp(s.closure.at)}` : ""}`}
                    </span>
                    <small>Last observed {stamp(s.watch.observedAt)}</small>
                    {s.watch.currentHeadSha !== s.watch.expectedSha && (
                      <p>
                        Older commit: current PR head is{" "}
                        {s.watch.currentHeadSha.slice(0, 8)}. These results
                        apply only to {s.watch.expectedSha.slice(0, 8)}.
                      </p>
                    )}
                    {s.watch.error && (
                      <p className="inline-error">
                        {s.watch.error} · Last attempt{" "}
                        {stamp(s.watch.lastAttemptAt)}
                        {s.watch.state === "needs_attention" &&
                          " · Paused after repeated failures; subscribe again to resume."}
                      </p>
                    )}
                    {s.watch.truncated && (
                      <p>
                        More than 1,000 runs match this commit; use GitHub for
                        the complete history.
                      </p>
                    )}
                  </div>
                  {s.active && (
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => void stop(s)}
                    >
                      Stop watching
                    </button>
                  )}
                </div>
              ))}
              {page.subscriptionsTruncated && (
                <p>
                  Showing the latest 200 subscriptions. Narrow to an Agent or
                  task.
                </p>
              )}
            </details>
          )}
          <div className="jobs-browser">
            <StateGroups
              label="Actions runs"
              historyLabel="History"
              items={page.runs}
              place={placeRun}
              selected={selected}
              empty={
                <p className="jobs-empty">
                  No Actions runs observed yet. Subscribe to a PR or run to
                  begin.
                </p>
              }
              row={(r) => (
                <JobRow
                  status={runMark(r)}
                  state={runLabel(r)}
                  name={r.name}
                  meta={[
                    `#${r.runId}`,
                    r.attempt !== "1" && `attempt ${r.attempt}`,
                  ]}
                  note={`${r.repository} · ${r.headSha.slice(0, 8)}`}
                  time={ranFor(r)}
                  timeTitle={`Last observed ${stamp(r.observedAt)}`}
                  moments={runMoments(r)}
                  selected={selected === r.id}
                  onSelect={() => setSelected(r.id)}
                />
              )}
            >
              {page.hasMore && (
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => void load(page.nextBefore!)}
                >
                  Earlier CI runs
                </button>
              )}
            </StateGroups>
            <div className="job-detail">
              {chosen ? (
                <>
                  <JobDetailHeading
                    status={runMark(chosen)}
                    state={`${runLabel(chosen)} · ${chosen.conclusion || chosen.rawStatus}`}
                    title={chosen.name}
                    role={runActive(chosen) ? "status" : undefined}
                  >
                    {safeLink(chosen.url) && (
                      <a
                        className="secondary-button"
                        href={safeLink(chosen.url)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open run, logs and artifacts on GitHub"
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        Open on GitHub
                      </a>
                    )}
                  </JobDetailHeading>
                  {chosen.runWatched === false && (
                    <p className="ci-jobs-observed">
                      Not being watched — showing the last observation. Use
                      refresh to check this attempt once without restarting
                      monitoring.
                    </p>
                  )}
                  {page.subscriptions
                    .filter((s) => s.watch.expectedSha === chosen.headSha)
                    .some((s) => s.watch.currentHeadSha !== chosen.headSha) && (
                    <p>
                      Older PR commit. This result does not describe the current
                      PR head.
                    </p>
                  )}
                  <JobCard title="Summary">
                    <dl>
                      <dt>Source</dt>
                      <dd>GitHub Actions · {chosen.repository}</dd>
                      <dt>Run / attempt</dt>
                      <dd>
                        {chosen.runId} / {chosen.attempt}
                      </dd>
                      <dt>Actual commit</dt>
                      <dd>{chosen.headSha}</dd>
                      <dt>Started</dt>
                      <dd>{stamp(chosen.startedAt)}</dd>
                      <dt>Last observed</dt>
                      <dd>{stamp(chosen.observedAt)}</dd>
                    </dl>
                  </JobCard>
                  {report?.run.id === selected && report.details && (
                    <JobCard
                      title="Jobs and steps"
                      aside={
                        <small className="ci-jobs-observed">
                          Jobs/steps last observed:{" "}
                          {stamp(report.details.observedAt)}.
                          {Math.floor(
                            Date.parse(report.details.observedAt) / 1000,
                          ) <
                            Math.floor(Date.parse(chosen.observedAt) / 1000) &&
                            " This snapshot predates the latest run observation."}
                        </small>
                      }
                    >
                      {report.details.jobs.map((j) => (
                        <details
                          className="ci-child-job"
                          key={j.id}
                          open={j.status === "failed" || undefined}
                        >
                          <summary>
                            <StatusMark status={j.status} />
                            {j.name}
                            <span className={`job-state state-${j.status}`}>
                              {labels[j.status]}
                            </span>
                          </summary>
                          <a
                            className="ci-job-logs"
                            href={safeLink(j.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Job logs
                          </a>
                          <ol>
                            {j.steps.map((s) => (
                              <li key={s.number}>
                                <StatusMark status={stepStatus(s)} />
                                {s.name}
                                <span className="ci-step-state">
                                  {s.conclusion || s.status}
                                </span>
                              </li>
                            ))}
                          </ol>
                          {j.stepsTruncated && (
                            <p>Remaining steps are available on GitHub.</p>
                          )}
                        </details>
                      ))}
                      {report.details.hasMore &&
                        (report.details.pageLimitReached ? (
                          <p>Further jobs are available on GitHub.</p>
                        ) : (
                          <button
                            type="button"
                            className="quiet-button"
                            onClick={() =>
                              void readReport(
                                selected,
                                report.details?.nextPage || 1,
                              )
                            }
                          >
                            More jobs
                          </button>
                        ))}
                    </JobCard>
                  )}
                  <p className="job-footnote">
                    CI completion does not merge a PR, approve review, or
                    complete its task.
                  </p>
                </>
              ) : (
                <p className="jobs-empty">
                  Select a run to inspect jobs and steps.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
