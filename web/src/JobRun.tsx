// A job that is one attempt of a run's stage: the run around it (its stages,
// their attempts and what waits), the artifacts it verified, and the cost and
// progress it reported. Jobs own this lifecycle; whether a result is valid
// for the experiment stays the project's.
import { useEffect, useState } from "react";
import { RotateCcw, Square } from "lucide-react";
import { api, API_BASE, errorText, post } from "./api";
import { JobCard } from "./JobParts";

export type Artifact = {
  path: string;
  ok: boolean;
  problem?: string;
  bytes?: number;
  sha256?: string | null;
  hash?: string;
  lines?: number;
  /** Where it is on the machine it was checked on. */
  absolutePath?: string;
  /** A file was at its path before the command ran, and is unchanged: noted, not judged. */
  preExisting?: boolean;
  unchangedSinceStart?: boolean;
};
export type Cost = {
  knownUsd: number;
  unknownEntries: number;
  invalidLines?: number;
  incompleteLines?: number;
  truncated?: boolean;
  sources?: string[];
  attemptsRunning?: number;
  complete?: boolean;
};
export type Progress = { value?: unknown; problem?: string; updatedAtUnix?: number };
type Attempt = {
  id: string;
  status: string;
  reason: string | null;
  run: { attempt: number };
  retryOf?: string | null;
  cost?: Cost | null;
  artifacts?: Artifact[] | null;
};
type Stage = {
  key: string;
  status: string;
  needs: string[];
  retry?: { attempts: number } | null;
  reusedFrom?: { jobId: string } | null;
  attempts: Attempt[];
  analysis?: { id: string; state: string; jobId: string; attemptId: string; execution: string } | null;
};
export type Run = {
  id: string;
  name: string;
  experiment?: string | null;
  status: string;
  costLimitUsd?: number | null;
  cancelRequestedAt?: string | null;
  stages: Stage[];
  cost: Cost;
};

const runStatus: Record<string, string> = {
  waiting_analysis: "Awaiting analysis",
  running: "Running",
  waiting: "Waiting",
  blocked: "Stopped at its cost limit",
  succeeded: "Completed",
  failed: "A stage did not succeed",
  unknown: "A stage's outcome is unknown",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};
const stageStatus: Record<string, string> = {
  waiting_analysis: "Awaiting analysis",
  waiting: "Waiting for upstream",
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  cancelling: "Cancelling",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  rejected: "Inputs rejected",
  interrupted: "Interrupted",
  unknown: "Outcome unknown",
  reused: "Reused",
};
const ended = new Set(["failed", "cancelled", "rejected", "interrupted"]);
const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;

/** Recorded cost as said, never more certain than it is. */
export function costText(cost?: Cost | null) {
  if (!cost) return "None recorded";
  const unknown = (cost.unknownEntries || 0) + (cost.invalidLines || 0) + (cost.incompleteLines || 0);
  return [
    usd(cost.knownUsd || 0),
    unknown > 0 && `plus ${unknown} of unknown cost`,
    cost.truncated && "usage file too long to read whole",
    (cost.attemptsRunning || 0) > 0 && "still running",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The run a stage attempt belongs to, and its two actions. */
export function RunCard({
  runId,
  jobId,
  revision,
  onOpen,
}: {
  runId: string;
  jobId: string;
  revision: string;
  onOpen: (jobId: string) => void;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    api<Run>(`/jobs/runs/${runId}`)
      .then((value) => current && setRun(value))
      .catch((e) => current && setError(errorText(e)));
    return () => {
      current = false;
    };
  }, [runId, jobId, revision]);
  async function act(path: string, body?: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setRun(await post<Run>(path, body));
      window.dispatchEvent(new CustomEvent("yuzuno:jobs-refresh"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!run) return error ? <p className="inline-error" role="alert">{error}</p> : null;
  const mine = run.stages.find((s) => s.attempts.some((a) => a.id === jobId));
  const latest = mine?.attempts[mine.attempts.length - 1];
  const retryable = !run.cancelRequestedAt && latest?.id === jobId && ended.has(latest.status);
  const live = run.status === "running" || run.status === "waiting" || run.status === "blocked" || run.status === "failed";
  const awaiting = run.stages.some((stage) => stage.analysis?.state === "waiting");
  return (
    <JobCard
      title="Run"
      className="job-run"
      aside={<small>{runStatus[run.status] || run.status}</small>}
    >
      <p className="job-run-name">
        <strong>{run.name}</strong>
        {run.experiment && <span> · {run.experiment}</span>}
      </p>
      <ol className="job-run-stages" aria-label="Stages">
        {run.stages.map((stage) => {
          const last = stage.attempts[stage.attempts.length - 1];
          return (
            <li key={stage.key} className={`job-run-stage state-${stage.status}`}>
              <span className="job-run-stage-key">{stage.key}</span>
              <span className={`job-state state-${stage.status}`}>
                {stageStatus[stage.status] || stage.status}
              </span>
              {stage.reusedFrom ? (
                <button type="button" className="quiet-button" onClick={() => onOpen(stage.reusedFrom!.jobId)}>
                  earlier attempt
                </button>
              ) : (
                stage.attempts.map((attempt) => (
                  <button
                    key={attempt.id}
                    type="button"
                    className="quiet-button"
                    aria-current={attempt.id === jobId ? "true" : undefined}
                    title={attempt.reason || undefined}
                    onClick={() => onOpen(attempt.id)}
                  >
                    attempt {attempt.run.attempt}
                    {stage.retry ? ` of ${stage.retry.attempts}` : ""}
                  </button>
                ))
              )}
              {stage.needs.length > 0 && <small>needs {stage.needs.join(", ")}</small>}
              {last?.status === "waiting" && last.reason && <small className="job-run-wait">{last.reason}</small>}
              {stage.analysis?.state === "waiting" && !run.cancelRequestedAt && (
                <div className="job-analysis-decision">
                  <p>{stage.analysis.execution === "reused" ? "Successful result reused" : "Execution succeeded"} · no resources held. Review its output before continuing.</p>
                  {(["continue", "cancel"] as const).map((decision) => (
                    <button key={decision} type="button" className="secondary-button" disabled={busy}
                      onClick={() => void act(`/jobs/runs/${run.id}/decide`, {
                        requestId: `analysis:${stage.analysis!.id}:${decision}`, stage: stage.key,
                        gateId: stage.analysis!.id, attemptId: stage.analysis!.attemptId, decision,
                      })}>
                      {decision === "continue" ? `Continue after ${stage.key}` : `Cancel run at ${stage.key}`}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <dl>
        <dt>Recorded cost</dt>
        <dd>
          {costText(run.cost)}
          {run.costLimitUsd != null && ` · soft limit ${usd(run.costLimitUsd)}`}
        </dd>
      </dl>
      <p className="job-footnote">
        Cost is what each attempt recorded, failed ones included; calls in flight or never recorded are missing, and unknown is not zero.
      </p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {(retryable || (live && !run.cancelRequestedAt)) && (
        <div className="job-run-actions">
          {/* One retry per ended attempt: a repeated click or a lost reply is the same request. */}
          {retryable && mine && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(`/jobs/runs/${run.id}/retry`, { requestId: `retry:${latest!.id}`, stage: mine.key })}
            >
              <RotateCcw size={13} aria-hidden="true" />
              Retry stage
            </button>
          )}
          {live && !awaiting && !run.cancelRequestedAt && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void act(`/jobs/runs/${run.id}/cancel`)}
            >
              <Square size={12} aria-hidden="true" />
              Cancel run
            </button>
          )}
        </div>
      )}
    </JobCard>
  );
}

/** Keep a final-stage or all-reused gate reachable even when no Job is live. */
export function PendingAnalysisRuns({ scope, revision, onOpen }: {
  scope: { agentId?: string; taskId?: string }; revision: string; onOpen: (jobId: string) => void;
}) {
  const [page, setPage] = useState<{ runs: { id: string; name: string }[]; hasMore?: boolean; nextBefore?: number }>({ runs: [] });
  const [before, setBefore] = useState<number | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const changed = () => { setBefore(undefined); setRefresh((n) => n + 1); };
    window.addEventListener("yuzuno:jobs-refresh", changed);
    return () => window.removeEventListener("yuzuno:jobs-refresh", changed);
  }, []);
  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ awaitingAnalysis: "true" });
    if (scope.agentId) query.set("agentId", scope.agentId);
    if (scope.taskId) query.set("taskId", scope.taskId);
    if (before !== undefined) query.set("before", String(before));
    api<typeof page>(`/jobs/runs?${query}`).then((value) => {
      if (current) { setPage({ ...value, runs: value.runs || [] }); setError(""); }
    }).catch((e) => current && setError(errorText(e)));
    return () => { current = false; };
  }, [scope.agentId, scope.taskId, revision, before, refresh]);
  if (!page.runs.length && !error && before === undefined) return null;
  return <section className="job-analysis-runs" aria-label="Runs awaiting analysis">
    <h3>Awaiting analysis</h3>
    <p>Execution has succeeded. These runs need a decision to continue.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {page.runs.map((run) => <PendingRun key={run.id} run={run} revision={`${revision}:${refresh}`} onOpen={onOpen} />)}
    {before !== undefined && <button type="button" className="quiet-button" onClick={() => setBefore(undefined)}>Latest waiting runs</button>}
    {page.hasMore && <button type="button" className="quiet-button" onClick={() => setBefore(page.nextBefore)}>Earlier waiting runs</button>}
  </section>;
}

function PendingRun({ run, revision, onOpen }: {
  run: { id: string; name: string }; revision: string; onOpen: (jobId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{run.name}</summary>
    {open && <RunCard runId={run.id} jobId="" revision={revision} onOpen={onOpen} />}
  </details>;
}

/** What a clean exit had to leave behind, as checked after it. `on` is the
 * remote machine a job's artifacts are checked on and stay on: Core does not
 * copy them, so none is offered for download here. */
export function ArtifactsCard({
  jobId,
  declared,
  checked,
  on,
}: {
  jobId: string;
  declared: { path: string }[];
  checked?: Artifact[] | null;
  on?: { name: string } | null;
}) {
  return (
    <JobCard title="Artifacts" className="job-artifacts">
      {on && <p className="job-footnote">Checked on {on.name} and kept there; not copied to this host.</p>}
      <ul>
        {declared.map(({ path }) => {
          const index = checked?.findIndex((a) => a.path === path) ?? -1;
          const entry = index >= 0 ? checked![index] : undefined;
          return (
            <li key={path} className={entry ? (entry.ok ? "verified" : "unverified") : undefined}>
              <code>{path}</code>
              <span>
                {!entry
                  ? "Not checked yet"
                  : entry.ok
                    ? [
                        "Verified",
                        entry.bytes != null && `${entry.bytes.toLocaleString()} bytes`,
                        entry.sha256 ? `SHA-256 ${entry.sha256.slice(0, 12)}…` : entry.hash,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : `Not accepted: ${entry.problem}`}
              </span>
              {on && entry?.absolutePath && (
                <span className="job-artifact-where">
                  On {on.name}: <code>{entry.absolutePath}</code>
                </span>
              )}
              {entry?.preExisting && entry.unchangedSinceStart && (
                <span>Already there before the command ran, unchanged</span>
              )}
              {/* Served only while the file is still the one this attempt produced. */}
              {entry?.ok && !on && (
                <a href={`${API_BASE}/api/jobs/${jobId}/artifacts/${index}`} download>
                  Download this attempt's file
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </JobCard>
  );
}

/** The cost and progress an attempt reported through its own files. */
export function ReportedLines({ cost, progress }: { cost?: Cost | null; progress?: Progress | null }) {
  if (!cost && !progress) return null;
  return (
    <>
      {cost && (
        <>
          <dt>Recorded cost</dt>
          <dd>{costText(cost)}</dd>
        </>
      )}
      {progress && (
        <>
          <dt>Progress</dt>
          <dd>
            {progress.problem
              ? `Unreadable: ${progress.problem}`
              : JSON.stringify(progress.value).slice(0, 200)}
            {progress.updatedAtUnix
              ? ` · ${new Date(progress.updatedAtUnix * 1000).toLocaleTimeString()}`
              : ""}
          </dd>
        </>
      )}
    </>
  );
}
