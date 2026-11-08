// The Jobs panel's merge queue (T-65): each linked repository's switch and
// pause, and the PRs released into Core's queue with their checks, evidence
// and history. It reads Core's /api/merge-queue routes and takes only the
// three actions they offer a person: unpause, retry and cancel. The switch
// itself is the user's, in each Project's repositories (T-37 S2b); here it is
// only shown. Repositories, branches, SHAs, names and Core's details and
// refusals are shown as they came.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, ExternalLink, Play, RefreshCw, RotateCcw, X } from "lucide-react";
import { api, errorText, NetworkError } from "./api";
import { langTag, strings, useLanguage, type Language } from "./i18n";
import {
  clock,
  JobCard,
  JobDetailHeading,
  JobRow,
  JobsSourceHeading,
  moments,
  StateGroups,
} from "./JobParts";
import {
  cancellable,
  entryStatus,
  knownState,
  mergeActions,
  mergeWords,
  ongoing,
  readEntries,
  readEntry,
  readRepository,
  reasonWord,
  refusalCode,
  refusalsZh,
  refused,
  retryable,
  stateWord,
  type MergeAction,
  type MergeActor,
  type MergeEntry,
  type MergePause,
  type MergeRecord,
  type MergeRepository,
  type MergeRun,
} from "./merge-queue";
import type { Agent, Project } from "./types";
import "./merge-queue.css";

export type MergeQueueOpen = { entryId?: string };

const queueEn = {
  region: "Merge queue",
  title: "Merge queue",
  intro:
    "Core merges a released PR once CI has tested exactly what the merge lands on main. Each repository’s switches are the user’s, in Settings → Projects → its Project → Repositories.",
  taskOnly: (task: string) => ` Entries of ${task} only.`,
  workspaceWide: " The queue is the whole Workspace’s.",
  refresh: "Refresh",
  updatedCore: "Update Core to read the merge queue.",
  repositories: "Repositories",
  noRepositories: "No repository is linked to a Project yet.",
  linkedReadFailed: (error: string) => `Some Projects’ repositories could not be read: ${error}`,
  repositoryFailed: (error: string) => `This repository’s queue state could not be read: ${error}`,
  switchOn: "On: Core merges released PRs here",
  switchOff: "Off: Core writes nothing to GitHub here",
  switchTitle: "Only the user turns it on or off, in Settings → Projects → its Project → Repositories.",
  landingTitle: "How a released PR lands on main",
  landings: { "core-merge": "Core merges", "github-auto-merge": "GitHub auto-merge", "github-merge-queue": "GitHub merge queue" } as Record<string, string>,
  paused: (reason: string) => `Paused: ${reason}`,
  sinceAt: (at: string) => `since ${at}`,
  causedBy: "Caused by",
  entryFor: (number: number) => `the entry for #${number}`,
  atMain: (sha: string) => `on main ${sha}`,
  redRun: "Red main CI run",
  run: (id: number) => `run ${id}`,
  acceptNote: (sha: string, run: number) =>
    `Unpausing while main is still ${sha} accepts red run ${run}: entries anchored there stop counting it, and each still needs its own green CI.`,
  autoClear: "This pause also ends by itself once CI on a newer main is green.",
  noneMerges: "While paused, entries are still checked but none merges.",
  lastPause: (reason: string, at: string, by: string) => `Last pause: ${reason}, ended ${at} by ${by}`,
  acceptedRun: (run: number) => ` · accepted red run ${run}`,
  autoCleared: "CI on a newer main",
  unpause: "Unpause",
  unpauseWho: (who: string) => `Who can unpause: ${who}, or you.`,
  unpauseHelp:
    "Ends the pause and re-anchors every waiting entry at the main Core reads now, so their main CI counts from there.",
  revert: (pr: number) => `Revert #${pr}`,
  revertWho: (who: string) => `Who can revert: ${who}, or you.`,
  revertHelp:
    "Core writes a revert commit (the main before this merge, on top of it) on its own branch queue/revert-…, opens a PR, and merges it once CI on it is green, or at once if main is still this merge and the main before it had green CI. It needs no review round and is the only entry that passes this pause; green main CI after it ends the pause.",
  reverting: (id: string) => `Revert queued as entry ${id}: Core builds it on its own branch and PR, then merges it.`,
  revertOff: "Reverts are off for this repository. Turn them on in Settings → Projects → its Project → Repositories to revert this merge in one step.",
  revertOf: (pr: number) => `Revert of #${pr}`,
  leadsOf: (project: string, leads: string) => `a lead of ${project} (${leads})`,
  noLead: "none set",
  anyLead: "a lead of a Project this repository is linked to",
  or: " or ",
  unpaused: (count: number, sha: string) =>
    `Unpaused. ${count} waiting ${count === 1 ? "entry" : "entries"} re-anchored at main ${sha}.`,
  accepted: (run: number) => ` Red run ${run} is accepted at that main.`,
  entries: "Entries",
  none: "No PR has been released into the merge queue.",
  noneForTask: "No PR of this task has been released into the merge queue.",
  loading: "Reading the merge queue…",
  select: "Choose an entry to see its checks, evidence and history.",
  reading: "Reading this entry…",
  title2: (repository: string, number: number) => `${repository} #${number}`,
  head: (sha: string) => `head ${sha}`,
  releasedAt: "Released",
  updatedAt: "Updated",
  openPr: "Open PR",
  openTask: (task: string) => `Open ${task}`,
  stateCard: "State",
  releaseCard: "Release",
  batchCard: "Batch",
  gateCard: "Tested merge",
  mergeCard: "Merge",
  historyCard: "History",
  meaning: "Meaning",
  reason: "Reason",
  detail: "Detail",
  releasedBy: "Released by",
  you: "You",
  review: "Review round",
  binaries: "Binary files",
  binariesAcknowledged: (count: number, by: string) =>
    `${count} acknowledged by ${by} by their content; the review round could not read them and stays unknown`,
  bytes: (n: number) => `${n} bytes`,
  frozenHead: "Frozen head",
  base: "Base branch",
  anchor: "Anchor main",
  branch: "Branch",
  builtOn: "Built on main",
  batchPr: "Batch PR",
  batchCi: "CI on the batch",
  removal: "Removal",
  removalStates: {
    pending: "Pending",
    done: "Removed",
    failed: "Failed: remove the branch and PR by hand",
  } as Record<string, string>,
  kept: "Kept while the entry holds its PR",
  gateKind: { slot: "The PR’s merge ref (slot)", batch: "Core’s batch" } as Record<string, string>,
  gate: "Tested as",
  tree: "Tree",
  runs: "CI runs",
  notYet: "Not yet",
  expectedMain: "Main before the merge",
  request: "Merge request",
  requestNotSent: "Not sent yet",
  requestSent: "Sent; waiting for GitHub’s answer",
  requestUncertain: "Sent; GitHub’s answer was uncertain, so it may have merged",
  notSentRun: (count: number) =>
    `${count} ${count === 1 ? "send" : "sends"} in a row could not leave Core; five stop the entry`,
  mergeCommit: "Merge commit",
  mergedAt: "Merged",
  postCheck: "Post-check",
  postOk: "Parents and tree as tested",
  postFailed: (detail: string) => `Failed${detail ? `: ${detail}` : ""}`,
  mainCi: "Main CI",
  unobserved: (detail: string) => `Not observed${detail ? `: ${detail}` : ""}`,
  runLine: (workflow: string, run: number, attempt: number) =>
    `${workflow} · run ${run}${attempt > 1 ? `, attempt ${attempt}` : ""}`,
  conclusions: {
    success: "Passed",
    failure: "Failed",
    cancelled: "Cancelled",
    timed_out: "Timed out",
    skipped: "Skipped",
    neutral: "Neutral",
    startup_failure: "Failed to start",
    action_required: "Action required",
    stale: "Stale",
  } as Record<string, string>,
  running: "Not finished yet",
  noHistory: "No history yet.",
  historyReading: "Reading the history…",
  retry: "Retry",
  cancel: "Cancel entry",
  retryHelp:
    "Checks it again from the start, anchored at the main Core reads now. It never reruns CI: rerun a red job first.",
  cancelHelp: "Takes the PR out of the queue; Core removes its batch, if it has one.",
  changeWho: (who: string) => `Who can: ${who}, or you.`,
  releaser: (name: string) => `the Agent that released it (${name})`,
  youReleased: "You released it, so only you can.",
  dryRunEnded: "Released before Core merged for real: release the PR again instead of retrying.",
  reasonLabel: "Reason (optional, kept in the record)",
  back: "Back",
  sending: "Sending…",
  refused: (text: string) => `Refused: ${text}`,
  unconfirmed: (text: string) =>
    `No certain answer from Core${text ? ` (${text})` : ""}: it may or may not have arrived. Trying again sends the same request.`,
  retried: "Retried: Core checks it again from the start.",
  cancelledNow: "Cancelled.",
  footnote:
    "Core merges only as a merge commit pinned to the released head: never a squash, a rebase or an admin merge. The task keeps each entry’s evidence record.",
};
type QueueText = typeof queueEn;
const queueText = strings<QueueText>(queueEn, {
  region: "合并队列",
  title: "合并队列",
  intro: "CI 测试过合并将落到主分支上的确切内容后，Core 才会合并已放行合并的 PR。每个仓库的开关由用户在“设置 → 项目 → 该项目 → 仓库”中控制。",
  taskOnly: (task) => ` 仅显示 ${task} 的条目。`,
  workspaceWide: " 队列属于整个工作区。",
  refresh: "刷新",
  updatedCore: "请更新 Core 以读取合并队列。",
  repositories: "仓库",
  noRepositories: "还没有仓库关联到项目。",
  linkedReadFailed: (error) => `部分项目的仓库无法读取：${error}`,
  repositoryFailed: (error) => `无法读取此仓库的队列状态：${error}`,
  switchOn: "已开启：Core 合并此仓库中已放行合并的 PR",
  switchOff: "已关闭：Core 不向 GitHub 写入任何内容",
  switchTitle: "只有用户能在“设置 → 项目 → 该项目 → 仓库”中开启或关闭它。",
  landingTitle: "已放行合并的 PR 如何落到主分支",
  landings: { "core-merge": "由 Core 合并", "github-auto-merge": "GitHub 自动合并", "github-merge-queue": "GitHub 合并队列" },
  paused: (reason) => `已暂停：${reason}`,
  sinceAt: (at) => `自 ${at}`,
  causedBy: "起因",
  entryFor: (number) => `#${number} 的条目`,
  atMain: (sha) => `主分支 ${sha}`,
  redRun: "主分支 CI 失败的运行",
  run: (id) => `运行 ${id}`,
  acceptNote: (sha, run) =>
    `若恢复时主分支仍是 ${sha}，恢复会接受失败的运行 ${run}：锚定在该主分支上的条目不再计入它，但每个条目仍需自己的 CI 通过。`,
  autoClear: "主分支更新且其 CI 通过后，此暂停也会自行结束。",
  noneMerges: "暂停期间仍会检查条目，但不会合并任何条目。",
  lastPause: (reason, at, by) => `上次暂停：${reason}，${at} 由${by}结束`,
  acceptedRun: (run) => ` · 已接受失败的运行 ${run}`,
  autoCleared: "更新后主分支上通过的 CI",
  unpause: "恢复",
  unpauseWho: (who) => `可恢复者：${who}，或你。`,
  unpauseHelp: "结束暂停，并把每个等待中的条目重新锚定到 Core 此时读取的主分支上，主分支 CI 从那里开始计算。",
  revert: (pr) => `回退 #${pr}`,
  revertWho: (who) => `可回退者：${who}，或你。`,
  revertHelp:
    "Core 在自己的分支 queue/revert-… 上写一个回退提交（在这个合并之上恢复合并前的主分支），开一个 PR；PR 上的 CI 通过后合并它。如果主分支仍是这个合并、且合并前的主分支 CI 是绿的，则立即合并。它不需要审查轮，是唯一能越过这次暂停的条目；它合并后主分支 CI 变绿即结束暂停。",
  reverting: (id) => `回退已排入条目 ${id}：Core 在自己的分支和 PR 上构建它，然后合并。`,
  revertOff: "这个仓库的回退已关闭。在“设置 → 项目 → 该项目 → 仓库”中打开回退，即可一步回退这个合并。",
  revertOf: (pr) => `#${pr} 的回退`,
  leadsOf: (project, leads) => `${project} 的负责人（${leads}）`,
  noLead: "尚未设置",
  anyLead: "关联此仓库的项目的负责人",
  or: "或",
  unpaused: (count, sha) => `已恢复。${count} 个等待中的条目已重新锚定到主分支 ${sha}。`,
  accepted: (run) => ` 已在该主分支上接受失败的运行 ${run}。`,
  entries: "条目",
  none: "还没有 PR 放行到合并队列。",
  noneForTask: "此任务还没有 PR 放行到合并队列。",
  loading: "正在读取合并队列…",
  select: "选择一个条目，查看其检查、证据和历史。",
  reading: "正在读取此条目…",
  head: (sha) => `头提交 ${sha}`,
  releasedAt: "放行",
  updatedAt: "更新",
  openPr: "打开 PR",
  openTask: (task) => `打开 ${task}`,
  stateCard: "状态",
  releaseCard: "放行",
  batchCard: "批次",
  gateCard: "已测试的合并",
  mergeCard: "合并",
  historyCard: "历史",
  meaning: "含义",
  reason: "原因",
  detail: "详情",
  releasedBy: "放行者",
  you: "你",
  review: "审查轮次",
  binaries: "二进制文件",
  binariesAcknowledged: (count, by) => `${by} 已按内容确认 ${count} 个；审查轮读不了它们，结论仍是未知`,
  bytes: (n) => `${n} 字节`,
  frozenHead: "冻结的头提交",
  base: "基础分支",
  anchor: "锚定主分支",
  branch: "分支",
  builtOn: "基于主分支",
  batchPr: "批次 PR",
  batchCi: "批次上的 CI",
  removal: "移除",
  removalStates: { pending: "待移除", done: "已移除", failed: "失败：请手动移除该分支和 PR" },
  kept: "条目占用 PR 期间保留",
  gateKind: { slot: "PR 的合并引用（槽位）", batch: "Core 的批次" },
  gate: "测试方式",
  tree: "树",
  runs: "CI 运行",
  notYet: "尚无",
  expectedMain: "合并前的主分支",
  request: "合并请求",
  requestNotSent: "尚未发送",
  requestSent: "已发送；正在等待 GitHub 的回答",
  requestUncertain: "已发送；GitHub 的回答不确定，可能已合并",
  notSentRun: (count) => `连续 ${count} 次发送未能离开 Core；连续五次会停止该条目`,
  mergeCommit: "合并提交",
  mergedAt: "合并时间",
  postCheck: "合并后检查",
  postOk: "父提交和树与测试一致",
  postFailed: (detail) => `未通过${detail ? `：${detail}` : ""}`,
  mainCi: "主分支 CI",
  unobserved: (detail) => `未观察到${detail ? `：${detail}` : ""}`,
  runLine: (workflow, run, attempt) => `${workflow} · 运行 ${run}${attempt > 1 ? `，第 ${attempt} 次尝试` : ""}`,
  conclusions: {
    success: "通过",
    failure: "失败",
    cancelled: "已取消",
    timed_out: "超时",
    skipped: "已跳过",
    neutral: "中性",
    startup_failure: "启动失败",
    action_required: "需要操作",
    stale: "已过时",
  },
  running: "尚未结束",
  noHistory: "还没有历史。",
  historyReading: "正在读取历史…",
  retry: "重试",
  cancel: "取消条目",
  retryHelp: "从头再检查一次，锚定在 Core 此时读取的主分支上。不会重新运行 CI：请先重新运行失败的作业。",
  cancelHelp: "将该 PR 移出队列；如有批次，Core 会将其移除。",
  changeWho: (who) => `可操作者：${who}，或你。`,
  releaser: (name) => `放行合并的 Agent（${name}）`,
  youReleased: "由你放行合并，因此只有你可以操作。",
  dryRunEnded: "在 Core 真正合并之前放行合并：请重新将该 PR 放行合并，而不是重试。",
  reasonLabel: "原因（可选，记入记录）",
  back: "返回",
  sending: "正在发送…",
  refused: (text) => `已拒绝：${text}`,
  unconfirmed: (text) => `没有收到 Core 的确定回答${text ? `（${text}）` : ""}：此操作可能已到达，也可能没有。再试一次会发送同一个请求。`,
  retried: "已重试：Core 将从头再检查。",
  cancelledNow: "已取消。",
  footnote: "Core 只以固定在放行合并时的头提交上的合并提交方式合并，绝不压缩、变基或以管理员身份合并。任务保留每个条目的证据记录。",
});

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const github = (repository: string, path: string) =>
  REPO.test(repository) ? `https://github.com/${repository}/${path}` : undefined;
const safeUrl = (url: string | undefined, repository: string) =>
  url && url.startsWith(`https://github.com/${repository}/`) && REPO.test(repository) ? url : undefined;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");
const runLink = (repository: string, run: number | null | undefined) =>
  typeof run === "number" ? github(repository, `actions/runs/${run}`) : undefined;
const commitLink = (repository: string, sha: string | null | undefined) =>
  sha && SHA.test(sha) ? github(repository, `commit/${sha}`) : undefined;

/** A link when Core gave a safe one, else the text alone. */
function Link({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}
function Sha({ sha, repository }: { sha?: string | null; repository: string }) {
  if (!sha) return null;
  return (
    <Link href={commitLink(repository, sha)}>
      <code title={sha}>{short(sha)}</code>
    </Link>
  );
}

type Linked = { id: number; fullName: string; projects: string[] };
type RepoRead = { state?: MergeRepository; error?: string };

/** Which Projects link which repository: each Project's repositories, read from Core. */
async function readLinked(projects: Project[], signal: AbortSignal) {
  const linked = new Map<number, Linked>();
  let failure = "";
  const pages = await Promise.allSettled(
    projects.map((p) =>
      api<{ repositories?: { id: number; fullName: string }[] }>("/collaboration/github_repositories", {
        method: "POST",
        body: JSON.stringify({ projectId: p.id }),
        signal,
      }).then((page) => ({ project: p.id, page })),
    ),
  );
  for (const result of pages) {
    if (result.status === "rejected") {
      if (!(result.reason instanceof DOMException)) failure ||= errorText(result.reason);
      continue;
    }
    for (const r of result.value.page.repositories || []) {
      if (typeof r?.id !== "number") continue;
      const old = linked.get(r.id) || { id: r.id, fullName: r.fullName, projects: [] };
      old.projects.push(result.value.project);
      linked.set(r.id, old);
    }
  }
  return { linked, failure };
}

/** The words for who did something. */
const actorName = (by: MergeActor | undefined, t: QueueText) =>
  !by ? "" : by.kind === "user" ? t.you : by.name || by.id || "";

/**
 * The merge queue: the linked repositories' switches and pauses, then the
 * entries in their groups and the chosen one's record. Read when Core says
 * the queue changed (`revision`), never on a timer.
 */
export function MergeQueue({
  scope,
  agents,
  projects,
  revision,
  initial,
  onOpenTask,
}: {
  scope: { taskId?: string; agentId?: string };
  agents: Agent[];
  projects: Project[];
  revision: string;
  initial: MergeQueueOpen;
  onOpenTask: (taskId: string) => void;
}) {
  const language = useLanguage();
  const t = queueText(language);
  const said = (text: string) => (text === queueEn.updatedCore ? t.updatedCore : text);
  const taskId = scope.taskId;
  const [entries, setEntries] = useState<MergeEntry[] | null>(null);
  const [linked, setLinked] = useState<Map<number, Linked>>(new Map());
  const [repos, setRepos] = useState<Map<number, RepoRead>>(new Map());
  const [linkFailure, setLinkFailure] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(initial.entryId || "");
  const [detail, setDetail] = useState<MergeEntry | null>(null);
  const [detailError, setDetailError] = useState("");
  // A change of ours re-reads at once, without waiting for Core's event.
  const [ownChange, setOwnChange] = useState(0);
  const act = useRef(mergeActions()).current;
  const controllers = useRef(new Set<AbortController>());
  const generation = useRef(0);
  const reads = useRef(0);
  const missed = useRef(false);
  const shownProjects = projects.filter((p) => !p.archivedAt);
  const projectsNow = useRef(shownProjects);
  projectsNow.current = shownProjects;
  const projectKey = shownProjects.map((p) => p.id).join(" ");
  // Which Projects link which repository, read again only when the Projects
  // change or on Refresh, not on every change of the queue (T-65 R3).
  const linkedRead = useRef<{ key: string; linked: Map<number, Linked> } | null>(null);
  const relink = useRef(false);
  const signal = useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  }, []);
  const load = useCallback(async () => {
    if (document.visibilityState === "hidden") {
      missed.current = true;
      return;
    }
    const g = generation.current;
    const ticket = ++reads.current;
    const controller = signal();
    const current = () => g === generation.current && ticket === reads.current;
    const key = projectsNow.current.map((p) => p.id).join(" ");
    const cached = !relink.current && linkedRead.current?.key === key ? linkedRead.current : null;
    relink.current = false;
    try {
      const [list, links] = await Promise.all([
        readEntries(taskId, controller.signal),
        cached ? { linked: cached.linked, failure: "" } : readLinked(projectsNow.current, controller.signal),
      ]);
      if (!Array.isArray(list?.entries)) throw new Error(queueEn.updatedCore);
      // A task's view shows the repositories its entries are in; otherwise
      // every linked repository, and any an entry names.
      const ids = [
        ...new Set([
          ...(taskId ? [] : [...links.linked.keys()]),
          ...list.entries.map((e) => e.repositoryId),
        ]),
      ].filter((id) => typeof id === "number");
      const states = await Promise.all(
        ids.map((id) =>
          readRepository(id, controller.signal).then(
            (state): [number, RepoRead] => [id, { state }],
            (e: unknown): [number, RepoRead] => {
              if (e instanceof DOMException) throw e;
              return [id, { error: errorText(e) }];
            },
          ),
        ),
      );
      if (!current()) return;
      // A failed read is not kept: the next change reads it again.
      if (!cached) linkedRead.current = links.failure ? null : { key, linked: links.linked };
      setEntries(list.entries);
      setLinked(links.linked);
      setLinkFailure(links.failure);
      setRepos(new Map(states));
      setError("");
    } catch (e) {
      if (current() && !(e instanceof DOMException)) setError(errorText(e));
    } finally {
      controllers.current.delete(controller);
    }
  }, [taskId, signal]);
  useEffect(() => {
    generation.current++;
    setEntries(null);
    return () => {
      // A new scope or closing Jobs drops every request still on its way.
      generation.current++;
      for (const c of controllers.current) c.abort();
      controllers.current.clear();
    };
  }, [taskId]);
  useEffect(() => {
    void load();
  }, [load, revision, ownChange, projectKey]);
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
  // The chosen entry is read whole, with its history and evidence.
  useEffect(() => {
    setDetailError("");
    if (!selected) {
      setDetail(null);
      return;
    }
    const g = generation.current;
    const controller = signal();
    readEntry(selected, controller.signal)
      .then((value) => {
        if (g !== generation.current || controller.signal.aborted) return;
        if (value?.id !== selected) throw new Error(queueEn.updatedCore);
        setDetail(value);
      })
      .catch((e: unknown) => {
        if (g === generation.current && !(e instanceof DOMException)) setDetailError(errorText(e));
      })
      .finally(() => controllers.current.delete(controller));
    return () => controller.abort();
  }, [selected, revision, ownChange, signal]);

  const rows = entries || [];
  const listed = rows.find((e) => e.id === selected);
  const chosen = detail?.id === selected ? detail : listed;
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name || id;
  const leadsFor = (repositoryId: number) => {
    const linkedTo = linked.get(repositoryId)?.projects || [];
    if (!linkedTo.length) return t.anyLead;
    return linkedTo
      .map((project) => {
        const names = agents
          .filter((a) => a.kind === "lead" && a.projectId === project && !a.closedAt)
          .map((a) => a.name);
        return t.leadsOf(projectName(project), names.length ? names.join(", ") : t.noLead);
      })
      .join(t.or);
  };
  const repoIds = [...repos.keys()];
  const nameOf = (id: number) =>
    linked.get(id)?.fullName || rows.find((e) => e.repositoryId === id)?.repository || `#${id}`;
  const changed = () => setOwnChange((n) => n + 1);
  return (
    <section className="jobs-source merge-queue" aria-label={t.region} lang={langTag(language)}>
      <JobsSourceHeading
        id="jobs-merge-queue-title"
        title={t.title}
        actions={
          <button
            type="button"
            className="icon-button"
            aria-label={t.refresh}
            title={t.refresh}
            onClick={() => {
              setError("");
              // One read: the change re-reads the list and the chosen entry.
              relink.current = true;
              changed();
            }}
          >
            <RefreshCw size={15} />
          </button>
        }
      >
        {t.intro}
        {taskId ? t.taskOnly(taskId) : scope.agentId ? t.workspaceWide : ""}
      </JobsSourceHeading>
      {error && (
        <p className="inline-error" role="alert">
          {said(error)}
        </p>
      )}
      <section className="merge-repositories" aria-label={t.repositories}>
        {linkFailure && <p className="inline-error">{t.linkedReadFailed(linkFailure)}</p>}
        {entries && !repoIds.length && <p className="job-footnote">{t.noRepositories}</p>}
        {repoIds.map((id) => (
          <RepositoryCard
            key={id}
            id={id}
            name={nameOf(id)}
            read={repos.get(id)!}
            leads={leadsFor(id)}
            entries={rows}
            onSelect={setSelected}
            act={act}
            onChanged={changed}
            t={t}
            language={language}
          />
        ))}
      </section>
      <div className="jobs-browser">
        <StateGroups
          label={t.entries}
          items={rows}
          place={(e) => (ongoing(e) ? "active" : "done")}
          selected={selected}
          empty={
            entries ? (
              <p className="jobs-empty">{taskId ? t.noneForTask : t.none}</p>
            ) : (
              !error && <p className="jobs-empty">{t.loading}</p>
            )
          }
          row={(e) => (
            <JobRow
              status={entryStatus(e)}
              state={`${stateWord(e.state, language)}${e.reason ? ` · ${reasonWord(e.reason, language)}` : ""}`}
              name={e.kind === "revert" && e.revert?.pr != null ? `${t.title2(e.repository, e.number)} · ${t.revertOf(e.revert.pr)}` : t.title2(e.repository, e.number)}
              meta={[e.taskReference || e.taskId, t.head(short(e.headSha))]}
              note={e.detail || undefined}
              moments={moments([
                [t.releasedAt, e.release?.at || e.createdAt],
                [t.updatedAt, e.updatedAt],
              ])}
              selected={selected === e.id}
              onSelect={() => setSelected(e.id)}
            />
          )}
        />
        <div className="job-detail">
          {detailError && (
            <p className="inline-error" role="alert">
              {said(detailError)}
            </p>
          )}
          {chosen ? (
            <EntryDetail
              key={chosen.id}
              entry={chosen}
              whole={detail?.id === chosen.id}
              act={act}
              onChanged={changed}
              onOpenTask={onOpenTask}
              t={t}
              language={language}
            />
          ) : (
            !detailError && <p className="jobs-empty">{selected ? t.reading : t.select}</p>
          )}
        </div>
      </div>
    </section>
  );
}

type Act = ReturnType<typeof mergeActions>;

/** Core's refusal in the language shown, with Core's own text as it came. */
function Refusal({ text, t, language }: { text: string; t: QueueText; language: Language }) {
  const code = refusalCode(text);
  const said = language === "zh-Hans" && code ? refusalsZh[code] : "";
  return (
    <div className="inline-error merge-refusal" role="alert">
      <span>{t.refused(said || text)}</span>
      {said && (
        <small className="merge-core-text" lang="en">
          {text}
        </small>
      )}
    </div>
  );
}

/**
 * One action, with who may take it; a click opens its reason, and Core's
 * answer or refusal shows beneath. The web acts as the user, whom every
 * route allows; Core still decides.
 */
function MergeActionBox({
  action,
  label,
  icon,
  who,
  help,
  run,
  t,
  language,
}: {
  action: MergeAction;
  label: string;
  icon: ReactNode;
  who: string;
  help: string;
  run: (reason: string) => Promise<string>;
  t: QueueText;
  language: Language;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Core refused (its text), or no answer came, so it may have arrived.
  const [refusal, setRefusal] = useState("");
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  const [done, setDone] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setRefusal("");
    setUnconfirmed(null);
    setDone("");
    try {
      const said = await run(reason);
      if (!mounted.current) return;
      setDone(said);
      setOpen(false);
      setReason("");
    } catch (e) {
      if (!mounted.current) return;
      if (refused(e)) setRefusal(errorText(e));
      else setUnconfirmed(e instanceof NetworkError ? "" : errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <div className={`merge-action merge-action-${action}`} data-action={action}>
      <p className="merge-action-who">{who}</p>
      {open ? (
        <form className="merge-action-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>{t.reasonLabel}</span>
            <textarea
              value={reason}
              rows={2}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
            />
          </label>
          <p className="job-footnote">{help}</p>
          <div className="merge-action-buttons">
            <button type="submit" className="primary-button" disabled={busy}>
              {icon}
              {busy ? t.sending : label}
            </button>
            <button type="button" className="quiet-button" disabled={busy} onClick={() => setOpen(false)}>
              {t.back}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setOpen(true);
            setRefusal("");
            setUnconfirmed(null);
            setDone("");
          }}
        >
          {icon}
          {label}
        </button>
      )}
      {refusal && <Refusal text={refusal} t={t} language={language} />}
      {unconfirmed !== null && (
        <p className="inline-error merge-unconfirmed" role="alert">
          {t.unconfirmed(unconfirmed)}
        </p>
      )}
      {done && (
        <p className="merge-action-done" role="status">
          {done}
        </p>
      )}
    </div>
  );
}

function RepositoryCard({
  id,
  name,
  read,
  leads,
  entries,
  onSelect,
  act,
  onChanged,
  t,
  language,
}: {
  id: number;
  name: string;
  read: RepoRead;
  leads: string;
  entries: MergeEntry[];
  onSelect: (entryId: string) => void;
  act: Act;
  onChanged: () => void;
  t: QueueText;
  language: Language;
}) {
  const state = read.state;
  const pause = state?.paused || null;
  const last = state?.pauses?.length ? state.pauses[state.pauses.length - 1] : null;
  // The last unpause's answer: the pause it ends, and the banner that asked,
  // are gone once Core reads back unpaused, so the card says it (T-65 R3).
  const [unpaused, setUnpaused] = useState("");
  const pausedAt = pause?.at;
  useEffect(() => {
    if (pausedAt) setUnpaused("");
  }, [pausedAt]);
  return (
    <article className="merge-repository" aria-label={name}>
      <header className="merge-repository-heading">
        <strong>
          <Link href={github(name, "")?.replace(/\/$/, "")}>{name}</Link>
        </strong>
        <span className="merge-repository-state">
          {state && (
            <span
              className={`merge-switch ${state.enabled ? "is-on" : "is-off"}`}
              title={t.switchTitle}
            >
              {state.enabled ? t.switchOn : t.switchOff}
            </span>
          )}
          {/* How a merge lands (T-37 S2b): shown once Core says it. */}
          {typeof state?.landing === "string" && state.landing && (
            <span className="merge-landing" title={t.landingTitle}>
              {t.landings[state.landing] || state.landing}
            </span>
          )}
        </span>
      </header>
      {read.error && <p className="inline-error">{t.repositoryFailed(read.error)}</p>}
      {pause ? (
        <PauseBanner
          repositoryId={id}
          name={name}
          pause={pause}
          leads={leads}
          entries={entries}
          onSelect={onSelect}
          act={act}
          onChanged={onChanged}
          onUnpaused={setUnpaused}
          reverts={state?.revert === true}
          t={t}
          language={language}
        />
      ) : (
        <>
          {unpaused && (
            <p className="merge-action-done merge-unpaused" role="status">
              {unpaused}
            </p>
          )}
          {last && <LastPause pause={last} t={t} language={language} />}
        </>
      )}
    </article>
  );
}

function PauseBanner({
  repositoryId,
  name,
  pause,
  leads,
  entries,
  onSelect,
  act,
  onChanged,
  onUnpaused,
  reverts,
  t,
  language,
}: {
  repositoryId: number;
  name: string;
  pause: MergePause;
  leads: string;
  entries: MergeEntry[];
  onSelect: (entryId: string) => void;
  act: Act;
  onChanged: () => void;
  /** Core's answer, kept by the card once the pause is gone. */
  onUnpaused: (said: string) => void;
  /** YN-18 S2d-2: the user allows one-step reverts for this repository. */
  reverts: boolean;
  t: QueueText;
  language: Language;
}) {
  const listed = pause.entryId ? entries.find((e) => e.id === pause.entryId) : undefined;
  // The merge that turned main red can be reverted in one step.
  const revertable = pause.reason === "main_red" && listed?.state === "done" && listed.reason === "main_red" && listed.kind !== "revert";
  const red = pause.reason === "main_red" && typeof pause.run === "number" ? pause.run : null;
  return (
    <div className="merge-pause" data-reason={pause.reason}>
      <p className="merge-pause-title">
        <strong>{t.paused(reasonWord(pause.reason, language))}</strong>
        {clock(pause.at) && <span> · {t.sinceAt(clock(pause.at)!)}</span>}
      </p>
      <dl>
        {pause.number != null && (
          <>
            <dt>{t.causedBy}</dt>
            <dd>
              {listed ? (
                <button type="button" className="merge-link-button" onClick={() => onSelect(listed.id)}>
                  {t.entryFor(pause.number)}
                </button>
              ) : (
                t.entryFor(pause.number)
              )}
              {" · "}
              <Link href={github(name, `pull/${pause.number}`)}>PR #{pause.number}</Link>
              {pause.main && (
                <>
                  {" · "}
                  {t.atMain(short(pause.main))}
                </>
              )}
            </dd>
          </>
        )}
        {red != null && (
          <>
            <dt>{t.redRun}</dt>
            <dd>
              <Link href={runLink(name, red)}>{t.run(red)}</Link>
            </dd>
          </>
        )}
        {pause.detail && (
          <>
            <dt>{t.detail}</dt>
            <dd className="merge-core-text">{pause.detail}</dd>
          </>
        )}
      </dl>
      <p className="job-footnote">
        {t.noneMerges}
        {red != null && pause.main ? ` ${t.acceptNote(short(pause.main), red)} ${t.autoClear}` : ""}
      </p>
      <MergeActionBox
        action="unpause"
        label={t.unpause}
        icon={<Play size={13} aria-hidden="true" />}
        who={t.unpauseWho(leads)}
        help={t.unpauseHelp}
        t={t}
        language={language}
        run={async (reason) => {
          const answer = await act<{
            reanchored?: string[];
            main?: string;
            acceptedRun?: { id?: number } | null;
          }>("unpause", repositoryId, reason);
          const accepted = answer?.acceptedRun?.id;
          const said = `${t.unpaused(answer?.reanchored?.length ?? 0, short(answer?.main))}${typeof accepted === "number" ? t.accepted(accepted) : ""}`;
          onUnpaused(said);
          onChanged();
          return said;
        }}
      />
      {revertable && listed && pause.number != null &&
        (reverts ? (
          <MergeActionBox
            action="revert"
            label={t.revert(pause.number)}
            icon={<RotateCcw size={13} aria-hidden="true" />}
            who={t.revertWho(leads)}
            help={t.revertHelp}
            t={t}
            language={language}
            run={async (reason) => {
              const answer = await act<{ id?: string }>("revert", listed.id, reason);
              onChanged();
              return t.reverting(answer?.id ?? "");
            }}
          />
        ) : (
          <p className="job-footnote merge-revert-off">{t.revertOff}</p>
        ))}
    </div>
  );
}

function LastPause({ pause, t, language }: { pause: MergePause; t: QueueText; language: Language }) {
  const by = pause.clearedBy;
  const who = by?.actor ? actorName(by.actor, t) : by?.by || t.autoCleared;
  const accepted = pause.acceptedRun?.id;
  return (
    <p className="job-footnote merge-last-pause">
      {t.lastPause(reasonWord(pause.reason, language), clock(pause.clearedAt) || "", who)}
      {typeof accepted === "number" ? t.acceptedRun(accepted) : ""}
    </p>
  );
}

function conclusionWord(conclusion: string | null | undefined, t: QueueText) {
  if (!conclusion) return t.running;
  return t.conclusions[conclusion] || conclusion;
}

function Runs({ runs, repository, t }: { runs: MergeRun[]; repository: string; t: QueueText }) {
  return (
    <ul className="merge-runs">
      {runs.map((r, index) => (
        <li key={`${r.run}-${index}`}>
          <Link href={runLink(repository, r.run)}>
            {t.runLine(r.workflow || "CI", r.run ?? 0, r.attempt ?? 1)}
          </Link>
          {" · "}
          {conclusionWord(r.conclusion, t)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the one merge request stands before GitHub merged it: not sent (and
 * why the last send certainly merged nothing), sent and waiting, or sent
 * with an uncertain answer, after which the entry stops with merge_unknown.
 */
function MergeRequest({ merge, merging, t }: { merge: MergeRecord; merging: boolean; t: QueueText }) {
  if (merge.attempts === 1) return <>{merging ? t.requestSent : t.requestUncertain}</>;
  const last = merge.puts?.length ? merge.puts[merge.puts.length - 1] : null;
  const why = last?.notSent || last?.limited || "";
  return (
    <>
      {t.requestNotSent}
      {why && <span className="merge-core-text"> · {why}</span>}
      {(merge.notSent ?? 0) > 0 && <> · {t.notSentRun(merge.notSent!)}</>}
    </>
  );
}

function EntryDetail({
  entry: e,
  whole,
  act,
  onChanged,
  onOpenTask,
  t,
  language,
}: {
  entry: MergeEntry;
  /** Read with its history and evidence, not only as the list has it. */
  whole: boolean;
  act: Act;
  onChanged: () => void;
  onOpenTask: (taskId: string) => void;
  t: QueueText;
  language: Language;
}) {
  const words = mergeWords(language);
  const state = knownState(e.state);
  const repo = e.repository;
  const gate = e.evidence?.gate || null;
  const batchRuns = gate?.kind === "batch" ? gate.runs || [] : [];
  const batchCi = batchRuns.find((r) => r.workflow === "CI") || batchRuns[0];
  const by = e.release?.by;
  const releasedByUser = by?.kind === "user";
  const changeWho = releasedByUser ? t.youReleased : t.changeWho(t.releaser(actorName(by, t) || "?"));
  const merge = e.merge;
  const mainCi = merge?.mainCi;
  const history = [...(e.history || [])].reverse();
  const task = e.taskReference || e.taskId;
  return (
    <>
      <JobDetailHeading
        status={entryStatus(e)}
        state={`${stateWord(e.state, language)}${e.reason ? ` · ${reasonWord(e.reason, language)}` : ""}`}
        title={e.kind === "revert" && e.revert?.pr != null ? `${t.title2(repo, e.number)} · ${t.revertOf(e.revert.pr)}` : t.title2(repo, e.number)}
        role={ongoing(e) ? "status" : undefined}
      >
        {safeUrl(e.url, repo) && (
          <a className="secondary-button" href={safeUrl(e.url, repo)} target="_blank" rel="noreferrer">
            <ExternalLink size={13} aria-hidden="true" />
            {t.openPr}
          </a>
        )}
        <button type="button" className="secondary-button" onClick={() => onOpenTask(e.taskId)}>
          <ArrowUpRight size={13} aria-hidden="true" />
          {t.openTask(task)}
        </button>
      </JobDetailHeading>
      <JobCard title={t.stateCard}>
        <dl>
          {state && (
            <>
              <dt>{t.meaning}</dt>
              <dd>{words.stateMeaning[state]}</dd>
            </>
          )}
          {e.reason && (
            <>
              <dt>{t.reason}</dt>
              <dd>
                {reasonWord(e.reason, language)} <code>{e.reason}</code>
              </dd>
            </>
          )}
          {e.detail && (
            <>
              <dt>{t.detail}</dt>
              <dd className="merge-core-text">{e.detail}</dd>
            </>
          )}
        </dl>
      </JobCard>
      {e.state === "stopped" && e.reason === "dry_run_ended" && (
        <p className="job-footnote">{t.dryRunEnded}</p>
      )}
      {(retryable(e) || cancellable(e)) && (
        <div className="merge-entry-actions">
          {retryable(e) && (
            <MergeActionBox
              action="retry"
              label={t.retry}
              icon={<RotateCcw size={13} aria-hidden="true" />}
              who={changeWho}
              help={t.retryHelp}
              t={t}
              language={language}
              run={async (reason) => {
                await act("retry", e.id, reason);
                onChanged();
                return t.retried;
              }}
            />
          )}
          {cancellable(e) && (
            <MergeActionBox
              action="cancel"
              label={t.cancel}
              icon={<X size={13} aria-hidden="true" />}
              who={changeWho}
              help={t.cancelHelp}
              t={t}
              language={language}
              run={async (reason) => {
                await act("cancel", e.id, reason);
                onChanged();
                return t.cancelledNow;
              }}
            />
          )}
        </div>
      )}
      <JobCard title={t.releaseCard}>
        <dl>
          <dt>{t.releasedBy}</dt>
          <dd>
            {actorName(by, t)}
            {clock(e.release?.at) ? ` · ${clock(e.release?.at)}` : ""}
          </dd>
          {e.release?.reviewId && (
            <>
              <dt>{t.review}</dt>
              <dd>
                <code>{e.release.reviewId}</code>
              </dd>
            </>
          )}
          {!!e.binaries?.files?.length && (
            <>
              <dt>{t.binaries}</dt>
              <dd>
                {t.binariesAcknowledged(e.binaries.files.length, actorName(e.binaries.by, t) || "?")}
                <ul className="merge-runs merge-binaries">
                  {e.binaries.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code>
                      {" · "}
                      <code>{f.format || "?"}</code>
                      {f.bytes != null && ` · ${t.bytes(f.bytes)}`}
                      {" · "}
                      <code title={f.sha256}>{f.sha256.slice(0, 12)}</code>
                      {f.note && (
                        <>
                          {" · "}
                          <span className="merge-core-text">{f.note}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>{t.frozenHead}</dt>
          <dd>
            <Sha sha={e.headSha} repository={repo} />
          </dd>
          {e.baseBranch && (
            <>
              <dt>{t.base}</dt>
              <dd>
                <code>{e.baseBranch}</code>
              </dd>
            </>
          )}
          {e.mainAtRelease && (
            <>
              <dt>{t.anchor}</dt>
              <dd>
                <Sha sha={e.mainAtRelease} repository={repo} />
                {clock(e.mainAnchoredAt) ? ` · ${t.sinceAt(clock(e.mainAnchoredAt)!)}` : ""}
              </dd>
            </>
          )}
        </dl>
      </JobCard>
      {e.batch && (
        <JobCard title={t.batchCard}>
          <dl>
            {e.batch.branch && (
              <>
                <dt>{t.branch}</dt>
                <dd>
                  <code>{e.batch.branch}</code>
                </dd>
              </>
            )}
            {e.batch.main && (
              <>
                <dt>{t.builtOn}</dt>
                <dd>
                  <Sha sha={e.batch.main} repository={repo} />
                </dd>
              </>
            )}
            <dt>{t.batchPr}</dt>
            <dd>
              {typeof e.batch.pr === "number" ? (
                <Link href={github(repo, `pull/${e.batch.pr}`)}>PR #{e.batch.pr}</Link>
              ) : (
                t.notYet
              )}
            </dd>
            <dt>{t.batchCi}</dt>
            <dd>
              {batchCi ? (
                <>
                  <Link href={runLink(repo, batchCi.run)}>
                    {t.runLine(batchCi.workflow || "CI", batchCi.run ?? 0, batchCi.attempt ?? 1)}
                  </Link>
                  {" · "}
                  {conclusionWord(batchCi.conclusion, t)}
                </>
              ) : (
                t.notYet
              )}
            </dd>
            <dt>{t.removal}</dt>
            <dd>
              {e.batch.cleanup ? t.removalStates[e.batch.cleanup] || e.batch.cleanup : t.kept}
              {e.batch.cleanupError && <span className="merge-core-text"> · {e.batch.cleanupError}</span>}
            </dd>
          </dl>
        </JobCard>
      )}
      {gate && (
        <JobCard title={t.gateCard}>
          <dl>
            {gate.kind && (
              <>
                <dt>{t.gate}</dt>
                <dd>{t.gateKind[gate.kind] || gate.kind}</dd>
              </>
            )}
            {gate.tree && (
              <>
                <dt>{t.tree}</dt>
                <dd>
                  <code title={gate.tree}>{short(gate.tree)}</code>
                </dd>
              </>
            )}
            <dt>{t.runs}</dt>
            <dd>{gate.runs?.length ? <Runs runs={gate.runs} repository={repo} t={t} /> : t.notYet}</dd>
          </dl>
        </JobCard>
      )}
      {merge && (
        <JobCard title={t.mergeCard}>
          <dl>
            {merge.expectedMain && (
              <>
                <dt>{t.expectedMain}</dt>
                <dd>
                  <Sha sha={merge.expectedMain} repository={repo} />
                </dd>
              </>
            )}
            {!merge.sha && (
              <>
                <dt>{t.request}</dt>
                <dd>
                  <MergeRequest merge={merge} merging={e.state === "merging"} t={t} />
                </dd>
              </>
            )}
            <dt>{t.mergeCommit}</dt>
            <dd>{merge.sha ? <Sha sha={merge.sha} repository={repo} /> : t.notYet}</dd>
            {clock(merge.mergedAt) && (
              <>
                <dt>{t.mergedAt}</dt>
                <dd>{clock(merge.mergedAt)}</dd>
              </>
            )}
            <dt>{t.postCheck}</dt>
            <dd>
              {!merge.post ? (
                t.notYet
              ) : merge.post.ok ? (
                t.postOk
              ) : (
                <span className="merge-core-text">{t.postFailed(merge.post.detail || "")}</span>
              )}
            </dd>
            <dt>{t.mainCi}</dt>
            <dd>
              {!mainCi ? (
                t.notYet
              ) : mainCi.conclusion === "unobserved" ? (
                <span className="merge-core-text">{t.unobserved(mainCi.detail || "")}</span>
              ) : (
                <>
                  <Link href={safeUrl(mainCi.url, repo) || runLink(repo, mainCi.run)}>
                    {t.runLine("CI", mainCi.run ?? 0, mainCi.attempt ?? 1)}
                  </Link>
                  {" · "}
                  {conclusionWord(mainCi.conclusion, t)}
                </>
              )}
            </dd>
          </dl>
        </JobCard>
      )}
      <JobCard title={t.historyCard}>
        {!whole ? (
          <p className="job-footnote">{t.historyReading}</p>
        ) : history.length ? (
          <ol className="merge-history">
            {history.map((h, index) => (
              <li key={`${h.at}-${index}`}>
                <span className="merge-history-at">{clock(h.at)}</span>
                <span>
                  <strong>{stateWord(h.state, language)}</strong>
                  {h.reason ? ` · ${reasonWord(h.reason, language)}` : ""}
                  {h.detail && <span className="merge-core-text"> · {h.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="job-footnote">{t.noHistory}</p>
        )}
      </JobCard>
      <p className="job-footnote">{t.footnote}</p>
    </>
  );
}
