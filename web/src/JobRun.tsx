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
  /** One attempt's readable entries; 0 with nothing unreadable: it recorded none. */
  entries?: number;
  /** A run's total (T-17): attempts that reported, recorded none, or an unknown amount. */
  attemptsReporting?: number;
  attemptsNotRecorded?: number;
  attemptsWithUnknown?: number;
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
  analysis?: {
    id: string;
    state: string;
    jobId: string;
    attemptId: string;
    execution: string;
    /** The research record that explains the decision (T-17), as cited. */
    record?: CitedRecord | null;
    recordNow?: LineNow | null;
  } | null;
};
/** A research record of the run's task, as the run or a decision cites it (T-17). */
type CitedRecord = {
  activitySeq: number;
  record?: { type?: string; id?: string; title?: string } | null;
  version?: number | null;
  next?: { action: string; text: string } | null;
};
/** Where a cited record's line stands now, beside the version cited. */
type LineNow = { state: string; revisedBy?: number | null; latestActivitySeq?: number | null };
export type Run = {
  id: string;
  name: string;
  experiment?: string | null;
  status: string;
  costLimitUsd?: number | null;
  cancelRequestedAt?: string | null;
  stages: Stage[];
  cost: Cost;
  /** The method record of the task this run follows (T-17), as cited. */
  method?: { activitySeq: number; id?: string; title?: string; version?: number | null } | null;
  methodNow?: LineNow | null;
  /** A queued run (YN-30): its first stage in the queue, that attempt, Core's
   * reason and what it waits for (gpu, memory, cpu, slot, disk, exclusive,
   * budget or capacity). */
  queue?: { stage: string; jobId: string; waitingFor: string; reason: string } | null;
};
/** What a task's Jobs recorded spending (job_cost, T-17). */
export type TaskSpend = {
  taskId: string;
  attempts: number;
  byStatus: Record<string, number>;
  usd: {
    knownUsd: number;
    attemptsReporting: number;
    attemptsNotRecorded: number;
    attemptsWithUnknown: number;
    attemptsRunning: number;
    complete: boolean;
  };
  compute: {
    cpuSeconds: number;
    workerWallSeconds: number;
    /** Each added over the attempts that measured it; absent from an older Core. */
    attemptsWithCpu?: number;
    attemptsWithoutCpu?: number;
    attemptsWithWall?: number;
    attemptsWithoutWall?: number;
    /** Attempts with both measured, and the rest. */
    attemptsMeasured: number;
    attemptsUnmeasured: number;
  };
  gpu: { attemptsReserving: number; measured: boolean };
  runs: number;
  reusedStages: number;
  /** Which counts stop at the newest `limit` attempts or runs. */
  attemptsTruncated?: boolean;
  runsTruncated?: boolean;
  limit?: number;
  truncated: boolean;
};

// A run's own words (T-189); stage keys, names, Core's reasons and what an
// attempt reported are shown as they came.
const text = strings({
  run: {
    waiting_analysis: "Awaiting analysis",
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    blocked: "Stopped at its cost limit",
    checkpointed: "A stage stopped at checkpoint",
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
    checkpointed: "Stopped at checkpoint",
    rejected: "Inputs rejected",
    interrupted: "Interrupted",
    unknown: "Outcome unknown",
    reused: "Reused",
  } as Record<string, string>,
  /** A queued run, by what its first stage in the queue waits for (YN-30). */
  queuedFor: {
    gpu: "Queued: waiting for a GPU",
    memory: "Queued: waiting for memory",
    cpu: "Queued: waiting for CPU",
    slot: "Queued: waiting for a job slot",
    disk: "Queued: waiting for disk space",
    exclusive: "Queued: waiting for an exclusive job",
    budget: "Queued: waiting for the budget",
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
  costNote: "Cost is what each attempt recorded, failed ones included; an attempt that recorded none is said apart, calls in flight are missing, and unknown is not zero.",
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
  // Research records a run or a decision cites (T-17).
  follows: (title: string, seq: number, version: number | null | undefined) =>
    `Follows the method “${title}”, activity ${seq}${version ? `, version ${version}` : ""}`,
  newer: (seq: number) => `; a newer version is activity ${seq}, and the run keeps the version it followed`,
  latestUnknown: "; a newer version exists, and the run keeps the version it followed",
  missing: "; this record can no longer be read",
  recordType: { method: "method", claim: "claim", observation: "observation", comparison: "comparison" } as Record<string, string>,
  explained: (state: string, type: string, title: string, seq: number, version: number | null | undefined) =>
    `${state === "continued" ? "Continued" : "Cancelled"}, as the ${type} “${title}” (activity ${seq}${version ? `, version ${version}` : ""}) explains`,
  decisionNewer: (seq: number) => `; a newer version is activity ${seq}, and the decision keeps the version it cited`,
  decisionLatestUnknown: "; a newer version exists, and the decision keeps the version it cited",
  proposes: { check: "It proposed a next check", stop: "It proposed to stop" } as Record<string, string>,
  // A task's spend across its Jobs (job_cost, T-17).
  spendTitle: "Recorded spend on this task",
  spendUsd: "Recorded cost",
  notRecorded: (n: number) => `${n} attempt${n === 1 ? "" : "s"} recorded none`,
  unknownAmount: (n: number) => `${n} with an unknown amount`,
  spendRunning: (n: number) => `${n} still running`,
  compute: "Compute",
  cpu: (seconds: string, measured: number) => `${seconds} s of CPU over ${measured} measured attempt${measured === 1 ? "" : "s"}`,
  cpuMissing: (n: number) => `${n} without a CPU measurement`,
  cpuNone: "CPU not measured",
  // An older Core's answer counts only attempts with both CPU and wall time.
  cpuPaired: (seconds: string, n: number) =>
    `${seconds} s of CPU over ${n} attempt${n === 1 ? "" : "s"} that measured both CPU and wall time`,
  cpuPairedNone: "No attempt measured both CPU and wall time",
  cpuPairedUnknown: (n: number) => `whether ${n} attempt${n === 1 ? "" : "s"} measured CPU is not said`,
  attempts: "Attempts",
  attemptsLine: (n: number, runs: number) => `${n} attempt${n === 1 ? "" : "s"}, each counted once, in ${runs} run${runs === 1 ? "" : "s"} and single Jobs`,
  reusedStages: (n: number) => `${n} reused stage${n === 1 ? "" : "s"} ran nothing and ${n === 1 ? "is" : "are"} not counted again`,
  gpuNotMeasured: (n: number) => `GPU use is not measured; ${n} attempt${n === 1 ? "" : "s"} reserved a GPU`,
  partialAttempts: (limit: number) => `partial: only the newest ${limit} attempts are read`,
  partialRuns: (limit: number) => `runs and reused stages partial: only the newest ${limit} runs are read`,
  spendNote: "A soft total, not a bill or a limit: failed and retried attempts count, unknown is never zero, and nothing resets when the method or the run changes.",
  spendUnreadable: "Core's answer was not a spend summary",
  spendFailed: (error: string) => `Could not read the recorded spend: ${error}`,
}, {
  run: {
    waiting_analysis: "等待分析",
    queued: "排队中",
    running: "运行中",
    waiting: "等待中",
    blocked: "已在成本上限处停止",
    checkpointed: "有阶段已于检查点停止",
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
    checkpointed: "已于检查点停止",
    rejected: "输入被拒绝",
    interrupted: "已中断",
    unknown: "结果未知",
    reused: "已复用",
  },
  queuedFor: {
    gpu: "排队：等 GPU",
    memory: "排队：等内存",
    cpu: "排队：等 CPU",
    slot: "排队：等槽位",
    disk: "排队：等磁盘空间",
    exclusive: "排队：等独占 Job",
    budget: "排队：等预算",
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
  costNote: "成本是每次尝试记录的数值，包括失败的尝试；没有记录的尝试单独说明，进行中的调用不在其中，未知并不等于零。",
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
  follows: (title, seq, version) => `遵循方法“${title}”，活动 ${seq}${version ? `，第 ${version} 版` : ""}`,
  newer: (seq) => `；较新的版本是活动 ${seq}，本运行保留它遵循的版本`,
  latestUnknown: "；已有较新的版本，本运行保留它遵循的版本",
  missing: "；这条记录已无法读取",
  recordType: { method: "方法", claim: "主张", observation: "观察", comparison: "比较" },
  explained: (state, type, title, seq, version) =>
    `${state === "continued" ? "已继续" : "已取消"}，理由见${type}“${title}”（活动 ${seq}${version ? `，第 ${version} 版` : ""}）`,
  decisionNewer: (seq) => `；较新的版本是活动 ${seq}，本决定保留它引用的版本`,
  decisionLatestUnknown: "；已有较新的版本，本决定保留它引用的版本",
  proposes: { check: "它提议了下一项检查", stop: "它提议停止" },
  spendTitle: "此任务记录的花费",
  spendUsd: "记录的成本",
  notRecorded: (n) => `${n} 次尝试没有记录`,
  unknownAmount: (n) => `${n} 次金额未知`,
  spendRunning: (n) => `${n} 次仍在运行`,
  compute: "计算",
  cpu: (seconds, measured) => `${measured} 次已测量的尝试共用 CPU ${seconds} 秒`,
  cpuMissing: (n) => `${n} 次没有 CPU 计量`,
  cpuNone: "CPU 未测量",
  cpuPaired: (seconds, n) => `${n} 次同时测得 CPU 和墙钟时间的尝试共用 CPU ${seconds} 秒`,
  cpuPairedNone: "没有同时测得 CPU 和墙钟时间的尝试",
  cpuPairedUnknown: (n) => `${n} 次尝试是否测得 CPU 未说明`,
  attempts: "尝试",
  attemptsLine: (n, runs) => `${n} 次尝试，每次只计一次，分布在 ${runs} 个运行和单独的 Job 中`,
  reusedStages: (n) => `${n} 个复用的阶段没有运行，不再重复计算`,
  gpuNotMeasured: (n) => `GPU 用量未测量；${n} 次尝试预留了 GPU`,
  partialAttempts: (limit) => `不完整：只读取了最新的 ${limit} 次尝试`,
  partialRuns: (limit) => `运行数和复用阶段数不完整：只读取了最新的 ${limit} 个运行`,
  spendNote: "这是软性合计，不是账单也不是上限：失败和重试的尝试都计入，未知从不当作零，更换方法或运行也不会清零。",
  spendUnreadable: "Core 的回答不是花费汇总",
  spendFailed: (error) => `无法读取记录的花费：${error}`,
});
type Text = ReturnType<typeof text>;
const ended = new Set(["failed", "cancelled", "rejected", "interrupted"]);
const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
/** Where a cited record's line stands now, said after the version cited. */
const lineNow = (cited: number, now: LineNow | null | undefined, missing: string, newer: (seq: number) => string, unknown: string) =>
  now?.state === "missing"
    ? missing
    : now && now.latestActivitySeq !== cited
      ? now.latestActivitySeq != null
        ? newer(now.latestActivitySeq)
        : unknown
      : "";

/** Recorded cost as said, never more certain than it is. */
export function costText(cost?: Cost | null, language: Language = "en") {
  const t = text(language);
  if (!cost) return t.noCost;
  const unknown = (cost.unknownEntries || 0) + (cost.invalidLines || 0) + (cost.incompleteLines || 0);
  // As job_cost reads a task (T-17): an attempt's empty usage file, or a run
  // none of whose attempts reported or left an unknown amount, recorded none;
  // an entry of $0 is a known $0. An older Core's run total has no counts.
  const run = typeof cost.attemptsNotRecorded === "number";
  const none = run
    ? cost.attemptsReporting === 0 && !cost.attemptsWithUnknown
    : cost.entries === 0 && unknown === 0 && !cost.truncated;
  return [
    none ? t.noCost : usd(cost.knownUsd || 0),
    unknown > 0 && t.unknownCost(unknown),
    run && !none && (cost.attemptsWithUnknown || 0) > 0 && t.unknownAmount(cost.attemptsWithUnknown || 0),
    run && !none && (cost.attemptsNotRecorded || 0) > 0 && t.notRecorded(cost.attemptsNotRecorded || 0),
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
  // A stage stopped at a checkpoint resumes from it (the user's Resume on
  // its attempt), not from scratch (YN-30).
  const retryable = !run.cancelRequestedAt && latest?.id === jobId && ended.has(latest.status) && mine?.status !== "checkpointed";
  const live = ["queued", "running", "waiting", "blocked", "failed", "checkpointed"].includes(run.status);
  const said = (run.status === "queued" && run.queue && t.queuedFor[run.queue.waitingFor]) || t.run[run.status] || run.status;
  const awaiting = run.stages.some((stage) => stage.analysis?.state === "waiting");
  return (
    <JobCard
      title={t.title}
      className="job-run"
      aside={<small title={run.status === "queued" ? run.queue?.reason || undefined : undefined}>{said}</small>}
    >
      <p className="job-run-name">
        <strong>{run.name}</strong>
        {run.experiment && <span> · {run.experiment}</span>}
      </p>
      {run.method && (
        <p className="job-run-method">
          {t.follows(run.method.title || "", run.method.activitySeq, run.method.version)}
          {lineNow(run.method.activitySeq, run.methodNow, t.missing, t.newer, t.latestUnknown)}
        </p>
      )}
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
              {(last?.status === "waiting" || last?.status === "queued") && last.reason && <small className="job-run-wait">{last.reason}</small>}
              {stage.analysis?.record && stage.analysis.state !== "waiting" && (
                <small className="job-run-explained">
                  {t.explained(
                    stage.analysis.state,
                    t.recordType[stage.analysis.record.record?.type ?? ""] ?? "",
                    stage.analysis.record.record?.title || "",
                    stage.analysis.record.activitySeq,
                    stage.analysis.record.version,
                  )}
                  {lineNow(stage.analysis.record.activitySeq, stage.analysis.recordNow, t.missing, t.decisionNewer, t.decisionLatestUnknown)}
                  {stage.analysis.record.next && ` · ${t.proposes[stage.analysis.record.next.action] ?? ""}: ${stage.analysis.record.next.text}`}
                </small>
              )}
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

/** What a task's Jobs recorded spending (T-17): every attempt once, unknown
 * apart and never zero; a soft total that limits nothing. */
export function TaskSpendCard({ taskId, revision }: { taskId: string; revision: string }) {
  const language = useLanguage();
  const t = text(language);
  const [spend, setSpend] = useState<TaskSpend | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setSpend(null);
    setError("");
    post<TaskSpend>("/collaboration/job_cost", { taskId })
      .then((value) => {
        if (!current) return;
        // Only an answer of the expected shape is added up; anything else
        // says it could not be read, and the panel around it stays.
        if (typeof value?.usd?.knownUsd === "number" && typeof value.compute?.cpuSeconds === "number" && value.gpu)
          setSpend(value);
        else setError(t.spendUnreadable);
      })
      .catch((e) => current && setError(errorText(e)));
    return () => {
      current = false;
    };
  }, [taskId, revision]);
  if (!spend)
    return error ? (
      <JobCard title={t.spendTitle} className="job-task-spend">
        <p className="job-footnote">{t.spendFailed(error)}</p>
      </JobCard>
    ) : null;
  const { usd: cost, compute, gpu } = spend;
  // Each subtotal says when it stops at the newest attempts or runs; an
  // older Core says only that something stopped, read as the attempts.
  const limit = spend.limit ?? 5000;
  const attemptsPartial = (spend.attemptsTruncated ?? spend.truncated) && t.partialAttempts(limit);
  // CPU time is said over the attempts that measured CPU, whatever their
  // wall time. An older Core's answer counts only attempts with both, so it
  // is said as that, and nothing is inferred about the others' CPU.
  const cpu =
    typeof compute.attemptsWithCpu === "number"
      ? [
          compute.attemptsWithCpu > 0 ? t.cpu(compute.cpuSeconds.toFixed(1), compute.attemptsWithCpu) : t.cpuNone,
          (compute.attemptsWithoutCpu ?? 0) > 0 && t.cpuMissing(compute.attemptsWithoutCpu ?? 0),
        ]
      : [
          compute.attemptsMeasured > 0 ? t.cpuPaired(compute.cpuSeconds.toFixed(1), compute.attemptsMeasured) : t.cpuPairedNone,
          compute.attemptsUnmeasured > 0 && t.cpuPairedUnknown(compute.attemptsUnmeasured),
        ];
  const gaps = [
    cost.attemptsWithUnknown > 0 && t.unknownAmount(cost.attemptsWithUnknown),
    cost.attemptsNotRecorded > 0 && t.notRecorded(cost.attemptsNotRecorded),
    cost.attemptsRunning > 0 && t.spendRunning(cost.attemptsRunning),
    attemptsPartial,
  ].filter(Boolean);
  return (
    <JobCard title={t.spendTitle} className="job-task-spend">
      <dl>
        <dt>{t.spendUsd}</dt>
        <dd>{[usd(cost.knownUsd || 0), ...gaps].join(" · ")}</dd>
        <dt>{t.compute}</dt>
        <dd>
          {[
            ...cpu,
            gpu.attemptsReserving > 0 && t.gpuNotMeasured(gpu.attemptsReserving),
            attemptsPartial,
          ]
            .filter(Boolean)
            .join(" · ")}
        </dd>
        <dt>{t.attempts}</dt>
        <dd>
          {[
            t.attemptsLine(spend.attempts, spend.runs),
            spend.reusedStages > 0 && t.reusedStages(spend.reusedStages),
            attemptsPartial,
            spend.runsTruncated && t.partialRuns(limit),
          ]
            .filter(Boolean)
            .join(" · ")}
        </dd>
      </dl>
      <p className="job-footnote">{t.spendNote}</p>
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
