// A job that is one attempt of a run's stage: the run around it (its stages,
// their attempts and what waits), the artifacts it verified, and the cost and
// progress it reported. Jobs own this lifecycle; whether a result is valid
// for the experiment stays the project's.
import { useEffect, useState } from "react";
import { RotateCcw, Square } from "lucide-react";
import { api, API_BASE, errorText, post } from "./api";
import { JobCard } from "./JobParts";
import { strings, useLanguage, useStrings, type Language } from "./i18n";

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

// A run's own words (T-189); stage keys, names, Core's reasons and what an
// attempt reported are shown as they came.
const text = strings({
  run: {
    waiting_analysis: "Awaiting analysis",
    running: "Running",
    waiting: "Waiting",
    blocked: "Stopped at its cost limit",
    succeeded: "Completed",
    failed: "A stage did not succeed",
    unknown: "A stage's outcome is unknown",
    cancelling: "Cancelling",
    cancelled: "Cancelled",
  } as Record<string, string>,
  stage: {
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
  } as Record<string, string>,
  noCost: "None recorded",
  unknownCost: (count: number) => `plus ${count} of unknown cost`,
  truncated: "usage file too long to read whole",
  stillRunning: "still running",
  title: "Run",
  stages: "Stages",
  earlier: "earlier attempt",
  attempt: (attempt: number, of: number | null) => `attempt ${attempt}${of ? ` of ${of}` : ""}`,
  needs: (keys: string) => `needs ${keys}`,
  reused: "Successful result reused",
  succeeded: "Execution succeeded",
  noResources: " · no resources held. Review its output before continuing.",
  continueAfter: (key: string) => `Continue after ${key}`,
  cancelAt: (key: string) => `Cancel run at ${key}`,
  recordedCost: "Recorded cost",
  softLimit: (limit: string) => ` · soft limit ${limit}`,
  costNote: "Cost is what each attempt recorded, failed ones included; calls in flight or never recorded are missing, and unknown is not zero.",
  retryStage: "Retry stage",
  cancelRun: "Cancel run",
  awaiting: "Awaiting analysis",
  awaitingLabel: "Runs awaiting analysis",
  awaitingNote: "Execution has succeeded. These runs need a decision to continue.",
  latestWaiting: "Latest waiting runs",
  earlierWaiting: "Earlier waiting runs",
  artifacts: "Artifacts",
  checkedOn: (machine: string) => `Checked on ${machine} and kept there; not copied to this host.`,
  notChecked: "Not checked yet",
  verified: "Verified",
  bytes: (count: string) => `${count} bytes`,
  notAccepted: (problem: string) => `Not accepted: ${problem}`,
  on: (machine: string) => `On ${machine}: `,
  unchanged: "Already there before the command ran, unchanged",
  download: "Download this attempt's file",
  progress: "Progress",
  unreadable: (problem: string) => `Unreadable: ${problem}`,
}, {
  run: {
    waiting_analysis: "等待分析",
    running: "运行中",
    waiting: "等待中",
    blocked: "已在成本上限处停止",
    succeeded: "已完成",
    failed: "有阶段未成功",
    unknown: "有阶段的结果未知",
    cancelling: "正在取消",
    cancelled: "已取消",
  },
  stage: {
    waiting_analysis: "等待分析",
    waiting: "等待上游",
    queued: "排队中",
    starting: "正在启动",
    running: "运行中",
    cancelling: "正在取消",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    rejected: "输入被拒绝",
    interrupted: "已中断",
    unknown: "结果未知",
    reused: "已复用",
  },
  noCost: "未记录",
  unknownCost: (count) => `另有 ${count} 项成本未知`,
  truncated: "用量文件过长，无法完整读取",
  stillRunning: "仍在运行",
  title: "运行",
  stages: "阶段",
  earlier: "更早的尝试",
  attempt: (attempt, of) => `第 ${attempt} 次尝试${of ? `，共 ${of} 次` : ""}`,
  needs: (keys) => `需要 ${keys}`,
  reused: "已复用成功的结果",
  succeeded: "执行成功",
  noResources: " · 未占用资源。继续之前请先查看其输出。",
  continueAfter: (key) => `在 ${key} 之后继续`,
  cancelAt: (key) => `在 ${key} 处取消运行`,
  recordedCost: "记录的成本",
  softLimit: (limit) => ` · 软上限 ${limit}`,
  costNote: "成本是每次尝试记录的数值，包括失败的尝试；进行中或从未记录的调用不在其中，未知并不等于零。",
  retryStage: "重试阶段",
  cancelRun: "取消运行",
  awaiting: "等待分析",
  awaitingLabel: "等待分析的运行",
  awaitingNote: "执行已成功。这些运行需要做出决定才能继续。",
  latestWaiting: "最新的等待中运行",
  earlierWaiting: "更早的等待中运行",
  artifacts: "产物",
  checkedOn: (machine) => `已在 ${machine} 上核对并保留在那里；未复制到此主机。`,
  notChecked: "尚未核对",
  verified: "已验证",
  bytes: (count) => `${count} 字节`,
  notAccepted: (problem) => `未被接受：${problem}`,
  on: (machine) => `位于 ${machine}：`,
  unchanged: "命令运行前就已存在，且未更改",
  download: "下载此次尝试的文件",
  progress: "进度",
  unreadable: (problem) => `无法读取：${problem}`,
});
type Text = ReturnType<typeof text>;
const ended = new Set(["failed", "cancelled", "rejected", "interrupted"]);
const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;

/** Recorded cost as said, never more certain than it is. */
export function costText(cost?: Cost | null, language: Language = "en") {
  const t = text(language);
  if (!cost) return t.noCost;
  const unknown = (cost.unknownEntries || 0) + (cost.invalidLines || 0) + (cost.incompleteLines || 0);
  return [
    usd(cost.knownUsd || 0),
    unknown > 0 && t.unknownCost(unknown),
    cost.truncated && t.truncated,
    (cost.attemptsRunning || 0) > 0 && t.stillRunning,
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
  const language = useLanguage();
  const t = text(language);
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
      title={t.title}
      className="job-run"
      aside={<small>{t.run[run.status] || run.status}</small>}
    >
      <p className="job-run-name">
        <strong>{run.name}</strong>
        {run.experiment && <span> · {run.experiment}</span>}
      </p>
      <ol className="job-run-stages" aria-label={t.stages}>
        {run.stages.map((stage) => {
          const last = stage.attempts[stage.attempts.length - 1];
          return (
            <li key={stage.key} className={`job-run-stage state-${stage.status}`}>
              <span className="job-run-stage-key">{stage.key}</span>
              <span className={`job-state state-${stage.status}`}>
                {t.stage[stage.status] || stage.status}
              </span>
              {stage.reusedFrom ? (
                <button type="button" className="quiet-button" onClick={() => onOpen(stage.reusedFrom!.jobId)}>
                  {t.earlier}
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
                    {t.attempt(attempt.run.attempt, stage.retry ? stage.retry.attempts : null)}
                  </button>
                ))
              )}
              {stage.needs.length > 0 && <small>{t.needs(stage.needs.join(", "))}</small>}
              {last?.status === "waiting" && last.reason && <small className="job-run-wait">{last.reason}</small>}
              {stage.analysis?.state === "waiting" && !run.cancelRequestedAt && (
                <div className="job-analysis-decision">
                  <p>{stage.analysis.execution === "reused" ? t.reused : t.succeeded}{t.noResources}</p>
                  {(["continue", "cancel"] as const).map((decision) => (
                    <button key={decision} type="button" className="secondary-button" disabled={busy}
                      onClick={() => void act(`/jobs/runs/${run.id}/decide`, {
                        requestId: `analysis:${stage.analysis!.id}:${decision}`, stage: stage.key,
                        gateId: stage.analysis!.id, attemptId: stage.analysis!.attemptId, decision,
                      })}>
                      {decision === "continue" ? t.continueAfter(stage.key) : t.cancelAt(stage.key)}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <dl>
        <dt>{t.recordedCost}</dt>
        <dd>
          {costText(run.cost, language)}
          {run.costLimitUsd != null && t.softLimit(usd(run.costLimitUsd))}
        </dd>
      </dl>
      <p className="job-footnote">{t.costNote}</p>
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
              {t.retryStage}
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
              {t.cancelRun}
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
  const t = useStrings(text);
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
  return <section className="job-analysis-runs" aria-label={t.awaitingLabel}>
    <h3>{t.awaiting}</h3>
    <p>{t.awaitingNote}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {page.runs.map((run) => <PendingRun key={run.id} run={run} revision={`${revision}:${refresh}`} onOpen={onOpen} />)}
    {before !== undefined && <button type="button" className="quiet-button" onClick={() => setBefore(undefined)}>{t.latestWaiting}</button>}
    {page.hasMore && <button type="button" className="quiet-button" onClick={() => setBefore(page.nextBefore)}>{t.earlierWaiting}</button>}
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
  const t = useStrings(text);
  return (
    <JobCard title={t.artifacts} className="job-artifacts">
      {on && <p className="job-footnote">{t.checkedOn(on.name)}</p>}
      <ul>
        {declared.map(({ path }) => {
          const index = checked?.findIndex((a) => a.path === path) ?? -1;
          const entry = index >= 0 ? checked![index] : undefined;
          return (
            <li key={path} className={entry ? (entry.ok ? "verified" : "unverified") : undefined}>
              <code>{path}</code>
              <span>
                {!entry
                  ? t.notChecked
                  : entry.ok
                    ? [
                        t.verified,
                        entry.bytes != null && t.bytes(entry.bytes.toLocaleString()),
                        entry.sha256 ? `SHA-256 ${entry.sha256.slice(0, 12)}…` : entry.hash,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : t.notAccepted(`${entry.problem}`)}
              </span>
              {on && entry?.absolutePath && (
                <span className="job-artifact-where">
                  {t.on(on.name)}<code>{entry.absolutePath}</code>
                </span>
              )}
              {entry?.preExisting && entry.unchangedSinceStart && (
                <span>{t.unchanged}</span>
              )}
              {/* Served only while the file is still the one this attempt produced. */}
              {entry?.ok && !on && (
                <a href={`${API_BASE}/api/jobs/${jobId}/artifacts/${index}`} download>
                  {t.download}
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
  const language = useLanguage();
  const t = text(language);
  if (!cost && !progress) return null;
  return (
    <>
      {cost && (
        <>
          <dt>{t.recordedCost}</dt>
          <dd>{costText(cost, language)}</dd>
        </>
      )}
      {progress && (
        <>
          <dt>{t.progress}</dt>
          <dd>
            {progress.problem
              ? t.unreadable(progress.problem)
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
