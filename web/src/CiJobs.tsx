import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, Github, RefreshCw } from "lucide-react";
import { api, errorText, post } from "./api";
import type { Agent } from "./types";
import { langTag, strings, useLanguage } from "./i18n";
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
// The GitHub Actions source in the interface language (T-189). Repository,
// workflow, job and step names, SHAs, URLs, GitHub's own status words and
// errors are shown as they came. The conversation's dock stays English with
// the conversation.
const ciText = strings({
  labels: {
    passed: "Passed",
    failed: "Failed",
    cancelled: "Cancelled",
    skipped: "Skipped / neutral",
    running: "Running",
    pending: "Waiting",
    unknown: "Outcome unknown",
  } as Record<string, string>,
  closure: {
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
  } as Record<string, string>,
  commitVerified: "Commit verification completed",
  stopped: "Stopped",
  stoppedExpired: "Stopped / expired",
  notObserved: "Not observed yet",
  pr: (number: number) => `PR #${number}`,
  commit: (sha: string, branch: string | null | undefined, event: string | null | undefined) => `Commit ${sha} · ${branch} · ${event}`,
  run: (number: number) => `Run #${number}`,
  lastSeen: (running: boolean) => `Last seen ${running ? "running" : "waiting"}`,
  queuedAt: "Queued",
  finishedAt: "Finished",
  checking: "Checking with GitHub…",
  checked: (at: string) => `Checked with GitHub at ${at}.`,
  recent: (at: string) => `Checked with GitHub moments ago, at ${at}; not asked again.`,
  interval: (at: string, next: string | null) => `GitHub asks to be checked less often; showing its answer from ${at}${next ? `. Next check after ${next}` : ""}.`,
  cooldown: (until: string | null) => `GitHub is limiting reads${until ? ` until ${until}` : ""}. Showing the last successful observation.`,
  checkError: (error: string) => `Couldn't check GitHub: ${error || "unknown error"}. Showing the last successful observation.`,
  nothing: "Nothing here is being watched, so there was nothing to check.",
  notWatched: "This run is not being watched. This check does not restart monitoring.",
  stillPaused: "Its monitor remains paused after repeated failures.",
  paused: (count: number) => `${count} watch${count > 1 ? "es" : ""} paused after repeated failures ${count > 1 ? "were" : "was"} not checked; subscribe again to resume.`,
  more: (count: number) => `${count} more watched target${count > 1 ? "s" : ""} follow${count > 1 ? "" : "s"} on schedule.`,
  join: " ",
  updatedCore: "CI monitoring requires an updated Core.",
  region: "GitHub Actions jobs",
  checkNow: "Check CI with GitHub now",
  back: "Back to runs",
  watch: "Watch CI",
  intro: "Runs Core watches on GitHub for a PR or run commit. Remote runs do not use this machine's job budget.",
  whatToWatch: "What to watch",
  notify: "Notify Agent",
  existingTask: "Existing task",
  url: "GitHub PR, Actions run or commit URL",
  branch: "Branch of its runs",
  event: "Event of its runs",
  commitToWatch: "Commit to watch",
  fullSha: "Full 40-character SHA",
  watchNote:
    "Core watches this commit for seven days, including new attempts, and sends normal mailbox results. You can close this window or end the Agent's Turn. A newer PR commit needs a new subscription. A commit URL can be watched before any run exists: only that commit's runs on that branch for that event count.",
  saving: "Saving…",
  subscribe: "Subscribe to CI",
  activeSubscriptions: (count: number) => `${count} active subscription(s)`,
  waitingFor: "Waiting for a run of",
  watching: "Watching",
  watched: "Watched",
  until: (when: string) => `until ${when}`,
  lastObserved: (when: string) => `Last observed ${when}`,
  olderCommit: (head: string, sha: string) => `Older commit: current PR head is ${head}. These results apply only to ${sha}.`,
  lastAttempt: (when: string) => ` · Last attempt ${when}`,
  needsAttention: " · Paused after repeated failures; subscribe again to resume.",
  truncated: "More than 1,000 runs match this commit; use GitHub for the complete history.",
  stopWatching: "Stop watching",
  latest200: "Showing the latest 200 subscriptions. Narrow to an Agent or task.",
  runs: "Actions runs",
  history: "History",
  noRuns: "No Actions runs observed yet. Subscribe to a PR or run to begin.",
  attempt: (attempt: string) => `attempt ${attempt}`,
  earlier: "Earlier CI runs",
  openTitle: "Open run, logs and artifacts on GitHub",
  openOnGitHub: "Open on GitHub",
  notBeingWatched: "Not being watched — showing the last observation. Use refresh to check this attempt once without restarting monitoring.",
  olderPrCommit: "Older PR commit. This result does not describe the current PR head.",
  summary: "Summary",
  source: "Source",
  runAttempt: "Run / attempt",
  actualCommit: "Actual commit",
  started: "Started",
  lastObservedLabel: "Last observed",
  jobsSteps: "Jobs and steps",
  stepsObserved: (when: string) => `Jobs/steps last observed: ${when}.`,
  predates: " This snapshot predates the latest run observation.",
  jobLogs: "Job logs",
  remainingSteps: "Remaining steps are available on GitHub.",
  furtherJobs: "Further jobs are available on GitHub.",
  moreJobs: "More jobs",
  ciNote: "CI completion does not merge a PR, approve review, or complete its task.",
  selectRun: "Select a run to inspect jobs and steps.",
}, {
  labels: {
    passed: "已通过",
    failed: "失败",
    cancelled: "已取消",
    skipped: "已跳过 / 中性",
    running: "运行中",
    pending: "等待中",
    unknown: "结果未知",
  },
  closure: {
    task_completed: "任务已完成",
    completed: "任务已完成",
    task_cancelled: "任务已取消",
    cancelled: "任务已取消",
    task_archived: "任务已归档",
    archived: "任务已归档",
    pr_merged: "PR 已合并",
    merged: "PR 已合并",
    verification_completed: "运行验证已完成",
    explicit_stop: "已明确停止",
    stopped: "投递已停止",
    expired: "订阅已过期",
  },
  commitVerified: "提交验证已完成",
  stopped: "已停止",
  stoppedExpired: "已停止 / 已过期",
  notObserved: "尚未观察到",
  commit: (sha, branch, event) => `提交 ${sha} · ${branch} · ${event}`,
  run: (number) => `运行 #${number}`,
  lastSeen: (running) => `最后一次看到时${running ? "正在运行" : "正在等待"}`,
  queuedAt: "排队",
  finishedAt: "完成",
  checking: "正在向 GitHub 检查…",
  checked: (at) => `已于 ${at} 向 GitHub 检查。`,
  recent: (at) => `刚刚已向 GitHub 检查（${at}），未再次询问。`,
  interval: (at, next) => `GitHub 要求降低检查频率；正在显示它在 ${at} 的回答${next ? `。下次检查在 ${next} 之后` : ""}。`,
  cooldown: (until) => `GitHub 正在限制读取${until ? `，直到 ${until}` : ""}。正在显示上次成功的观察结果。`,
  checkError: (error) => `无法向 GitHub 检查：${error || "未知错误"}。正在显示上次成功的观察结果。`,
  nothing: "这里没有被监视的内容，因此没有可检查的。",
  notWatched: "此运行未被监视。这次检查不会重新开始监视。",
  stillPaused: "它的监视在多次失败后仍处于暂停状态。",
  paused: (count) => `${count} 个在多次失败后暂停的监视未被检查；重新订阅即可恢复。`,
  more: (count) => `另有 ${count} 个被监视的目标按计划跟进。`,
  join: "",
  updatedCore: "CI 监视需要更新的 Core。",
  region: "GitHub Actions Job",
  checkNow: "立即向 GitHub 检查 CI",
  back: "返回运行列表",
  watch: "监视 CI",
  intro: "Core 在 GitHub 上为某个 PR 或运行的提交所监视的运行。远程运行不使用此机器的 Job 预算。",
  whatToWatch: "监视什么",
  notify: "通知的 Agent",
  existingTask: "已有任务",
  url: "GitHub PR、Actions 运行或提交的 URL",
  branch: "其运行所在的分支",
  event: "其运行的事件",
  commitToWatch: "要监视的提交",
  fullSha: "完整的 40 位 SHA",
  watchNote: "Core 会监视此提交七天，包括新的尝试，并以普通邮件发送结果。你可以关闭此窗口或结束 Agent 的 Turn。较新的 PR 提交需要新的订阅。可以在任何运行出现之前就监视一个提交 URL：只计算该提交在该分支上、该事件的运行。",
  saving: "正在保存…",
  subscribe: "订阅 CI",
  activeSubscriptions: (count) => `${count} 个活跃订阅`,
  waitingFor: "等待运行的提交",
  watching: "正在监视",
  watched: "曾监视",
  until: (when) => `直到 ${when}`,
  lastObserved: (when) => `上次观察于 ${when}`,
  olderCommit: (head, sha) => `较旧的提交：当前 PR head 是 ${head}。这些结果只适用于 ${sha}。`,
  lastAttempt: (when) => ` · 上次尝试于 ${when}`,
  needsAttention: " · 多次失败后已暂停；重新订阅即可恢复。",
  truncated: "与此提交匹配的运行超过 1,000 个；完整历史请在 GitHub 上查看。",
  stopWatching: "停止监视",
  latest200: "正在显示最新的 200 个订阅。请缩小到某个 Agent 或任务。",
  runs: "Actions 运行",
  history: "历史",
  noRuns: "尚未观察到 Actions 运行。订阅一个 PR 或运行即可开始。",
  attempt: (attempt) => `第 ${attempt} 次尝试`,
  earlier: "更早的 CI 运行",
  openTitle: "在 GitHub 上打开运行、日志和产物",
  openOnGitHub: "在 GitHub 上打开",
  notBeingWatched: "未被监视 — 正在显示上次的观察结果。使用刷新可检查此尝试一次，而不会重新开始监视。",
  olderPrCommit: "较旧的 PR 提交。此结果不描述当前的 PR head。",
  summary: "摘要",
  source: "来源",
  runAttempt: "运行 / 尝试",
  actualCommit: "实际提交",
  started: "开始于",
  lastObservedLabel: "上次观察",
  jobsSteps: "Job 与步骤",
  stepsObserved: (when) => `Job/步骤上次观察于：${when}。`,
  predates: "此快照早于最新的运行观察。",
  jobLogs: "Job 日志",
  remainingSteps: "其余步骤可在 GitHub 上查看。",
  furtherJobs: "更多 Job 可在 GitHub 上查看。",
  moreJobs: "更多 Job",
  ciNote: "CI 完成并不会合并 PR、批准审查或完成其任务。",
  selectRun: "选择一个运行，查看它的 Job 和步骤。",
});
type CiText = ReturnType<typeof ciText>;
const ciEn = ciText("en");
/** What a change worth new steps looks like: a running run's every new
 * observation, a finished one's transition only. */
const stateOf = (r: Run) =>
  JSON.stringify([
    r.rawStatus,
    r.conclusion,
    r.rawStatus === "completed" ? null : r.observedAt,
  ]);
/** What a check found, in words; the last observation is always kept. */
function checkText(c: Check, t: CiText) {
  const at = c.checkedAt ? clock(c.checkedAt) : "";
  const text =
    c.status === "busy"
      ? t.checking
      : c.status === "checked"
        ? t.checked(at)
        : c.status === "recent"
          ? t.recent(at)
          : c.status === "github_interval"
            ? t.interval(at, c.retryAt ? clock(c.retryAt) : null)
            : c.status === "cooldown"
              ? t.cooldown(c.retryAt ? clock(c.retryAt) : null)
              : c.status === "error"
                ? t.checkError(c.error || "")
                : t.nothing;
  const notes = [
    c.runWatched === false && t.notWatched,
    !!c.paused && (c.runWatched === false ? t.stillPaused : t.paused(c.paused)),
    !!c.more && t.more(c.more),
  ].filter(Boolean);
  return [text, ...notes].join(t.join);
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
const stamp = (v: string | null | undefined, t: CiText = ciEn) =>
  v ? new Date(v).toLocaleString() : t.notObserved;
const closedLabel = (s: Subscription, t: CiText) =>
  s.closure
    ? s.closure.reason === "verification_completed" && s.watch.kind === "commit"
      ? t.commitVerified
      : t.closure[s.closure.reason] || t.stopped
    : t.stoppedExpired;
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
const watchLabel = (w: Watch, t: CiText) =>
  w.kind === "pull"
    ? t.pr(w.number)
    : w.kind === "commit"
      ? t.commit(w.expectedSha.slice(0, 8), w.branch, w.event)
      : t.run(w.number);
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
const runLabel = (run: Run, t: CiText = ciEn) =>
  run.runWatched === false && runUnfinished(run)
    ? t.lastSeen(run.status === "running")
    : t.labels[run.status] || run.status;
const runMark = (run: Run) =>
  run.runWatched === false && runUnfinished(run) ? "unconfirmed" : run.status;
/** Still going, or ended however it ended. */
const placeRun = (run: Run): Placement => (runActive(run) ? "active" : "done");
/** When it was queued and, once it has, when it finished. */
const runMoments = (run: Run, t: CiText) =>
  moments([
    [t.queuedAt, run.createdAt],
    [t.finishedAt, runUnfinished(run) ? null : run.updatedAt],
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
  const language = useLanguage();
  const t = ciText(language);
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
          throw new Error(ciEn.updatedCore);
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
    <section className="jobs-source ci-jobs" aria-label={t.region} lang={langTag(language)}>
      <JobsSourceHeading
        id="jobs-ci-title"
        title="GitHub Actions"
        actions={
          <>
            {!creating && (
              <button
                type="button"
                className="icon-button"
                aria-label={t.checkNow}
                title={t.checkNow}
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
              {creating ? t.back : t.watch}
            </button>
          </>
        }
      >
        {t.intro}
      </JobsSourceHeading>
      {check ? (
        <p
          className={`ci-check${check.status === "error" || check.status === "cooldown" ? " inline-error" : ""}`}
          role="status"
        >
          {checkText(check, t)}
        </p>
      ) : (
        page.cooldownUntil && (
          <p className="ci-check" role="status">
            {t.cooldown(clock(page.cooldownUntil))}
          </p>
        )
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error === ciEn.updatedCore ? t.updatedCore : error}
        </p>
      )}
      {creating ? (
        <form className="job-form" onSubmit={subscribe}>
          <fieldset className="job-form-group">
            <legend>{t.whatToWatch}</legend>
            <label>
              {t.notify}
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
              {t.existingTask}
              <input
                required
                value={draft.taskId}
                onChange={(e) => setDraft({ ...draft, taskId: e.target.value })}
                placeholder="T-49"
              />
            </label>
            <label className="job-wide">
              {t.url}
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
                  {t.branch}
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
                  {t.event}
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
              {t.commitToWatch}
              <input
                required
                pattern="[a-fA-F0-9]{40}"
                value={draft.expectedSha}
                onChange={(e) =>
                  setDraft({ ...draft, expectedSha: e.target.value })
                }
                placeholder={t.fullSha}
              />
            </label>
          </fieldset>
          <div className="job-form-footer">
            <small>{t.watchNote}</small>
            <button className="primary-button" disabled={busy}>
              {busy ? t.saving : t.subscribe}
            </button>
          </div>
        </form>
      ) : (
        <>
          {!!page.subscriptions.length && (
            <details className="ci-subscriptions" open={!page.runs.length}>
              <summary>{t.activeSubscriptions(page.subscriptions.filter((s) => s.active).length)}</summary>
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
                      {watchLabel(s.watch, t)}
                    </a>
                    <span>
                      {s.active
                        ? s.watch.state === "waiting_for_run"
                          ? t.waitingFor
                          : t.watching
                        : t.watched}{" "}
                      {s.watch.expectedSha.slice(0, 8)} ·{" "}
                      {s.active
                        ? t.until(stamp(s.expiresAt, t))
                        : `${closedLabel(s, t)}${s.closure?.at ? ` · ${stamp(s.closure.at, t)}` : ""}`}
                    </span>
                    <small>{t.lastObserved(stamp(s.watch.observedAt, t))}</small>
                    {s.watch.currentHeadSha !== s.watch.expectedSha && (
                      <p>{t.olderCommit(s.watch.currentHeadSha.slice(0, 8), s.watch.expectedSha.slice(0, 8))}</p>
                    )}
                    {s.watch.error && (
                      <p className="inline-error">
                        {s.watch.error}
                        {t.lastAttempt(stamp(s.watch.lastAttemptAt, t))}
                        {s.watch.state === "needs_attention" && t.needsAttention}
                      </p>
                    )}
                    {s.watch.truncated && <p>{t.truncated}</p>}
                  </div>
                  {s.active && (
                    <button
                      className="quiet-button"
                      disabled={busy}
                      onClick={() => void stop(s)}
                    >
                      {t.stopWatching}
                    </button>
                  )}
                </div>
              ))}
              {page.subscriptionsTruncated && (
                <p>{t.latest200}</p>
              )}
            </details>
          )}
          <div className="jobs-browser">
            <StateGroups
              label={t.runs}
              historyLabel={t.history}
              items={page.runs}
              place={placeRun}
              selected={selected}
              empty={
                <p className="jobs-empty">{t.noRuns}</p>
              }
              row={(r) => (
                <JobRow
                  status={runMark(r)}
                  state={runLabel(r, t)}
                  name={r.name}
                  meta={[
                    `#${r.runId}`,
                    r.attempt !== "1" && t.attempt(r.attempt),
                  ]}
                  note={`${r.repository} · ${r.headSha.slice(0, 8)}`}
                  time={ranFor(r)}
                  timeTitle={t.lastObserved(stamp(r.observedAt, t))}
                  moments={runMoments(r, t)}
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
                  {t.earlier}
                </button>
              )}
            </StateGroups>
            <div className="job-detail">
              {chosen ? (
                <>
                  <JobDetailHeading
                    status={runMark(chosen)}
                    state={`${runLabel(chosen, t)} · ${chosen.conclusion || chosen.rawStatus}`}
                    title={chosen.name}
                    role={runActive(chosen) ? "status" : undefined}
                  >
                    {safeLink(chosen.url) && (
                      <a
                        className="secondary-button"
                        href={safeLink(chosen.url)}
                        target="_blank"
                        rel="noreferrer"
                        title={t.openTitle}
                      >
                        <ExternalLink size={13} aria-hidden="true" />
                        {t.openOnGitHub}
                      </a>
                    )}
                  </JobDetailHeading>
                  {chosen.runWatched === false && (
                    <p className="ci-jobs-observed">{t.notBeingWatched}</p>
                  )}
                  {page.subscriptions
                    .filter((s) => s.watch.expectedSha === chosen.headSha)
                    .some((s) => s.watch.currentHeadSha !== chosen.headSha) && (
                    <p>{t.olderPrCommit}</p>
                  )}
                  <JobCard title={t.summary}>
                    <dl>
                      <dt>{t.source}</dt>
                      <dd>GitHub Actions · {chosen.repository}</dd>
                      <dt>{t.runAttempt}</dt>
                      <dd>
                        {chosen.runId} / {chosen.attempt}
                      </dd>
                      <dt>{t.actualCommit}</dt>
                      <dd>{chosen.headSha}</dd>
                      <dt>{t.started}</dt>
                      <dd>{stamp(chosen.startedAt, t)}</dd>
                      <dt>{t.lastObservedLabel}</dt>
                      <dd>{stamp(chosen.observedAt, t)}</dd>
                    </dl>
                  </JobCard>
                  {report?.run.id === selected && report.details && (
                    <JobCard
                      title={t.jobsSteps}
                      aside={
                        <small className="ci-jobs-observed">
                          {t.stepsObserved(stamp(report.details.observedAt, t))}
                          {Math.floor(
                            Date.parse(report.details.observedAt) / 1000,
                          ) <
                            Math.floor(Date.parse(chosen.observedAt) / 1000) &&
                            t.predates}
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
                              {t.labels[j.status]}
                            </span>
                          </summary>
                          <a
                            className="ci-job-logs"
                            href={safeLink(j.url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t.jobLogs}
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
                            <p>{t.remainingSteps}</p>
                          )}
                        </details>
                      ))}
                      {report.details.hasMore &&
                        (report.details.pageLimitReached ? (
                          <p>{t.furtherJobs}</p>
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
                            {t.moreJobs}
                          </button>
                        ))}
                    </JobCard>
                  )}
                  <p className="job-footnote">{t.ciNote}</p>
                </>
              ) : (
                <p className="jobs-empty">{t.selectRun}</p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
