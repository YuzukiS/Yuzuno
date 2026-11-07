// The merge queue as Core keeps it (T-65): its entries, each repository's
// switch and pause, the three actions a person takes on them, and the words
// for its states and stop reasons, as docs/merge-queue.md names them. The
// panel reads and writes only Core's /api/merge-queue routes.
import { api, HttpError } from "./api";
import { strings, type Language } from "./i18n";

export const mergeStates = [
  "queued",
  "waiting",
  "ready",
  "merging",
  "merged",
  "done",
  "stopped",
  "cancelled",
] as const;
export type MergeState = (typeof mergeStates)[number];

/** Why an entry stopped: the `reason` of a stopped entry. */
export const stopReasons = [
  "head_moved",
  "pr_not_open",
  "base_changed",
  "review_not_passing",
  "main_red",
  "ci_red",
  "conflict",
  "nothing_to_merge",
  "merge_blocked",
  "batch_changed",
  "checkout_mismatch",
  "checkout_unproven",
  "merge_refused",
  "merge_unknown",
  "post_check_failed",
  "post_check_unverified",
  "gh_too_old",
  "wait_timeout",
  "github_unreachable",
  "dry_run_ended",
] as const;
export type StopReason = (typeof stopReasons)[number];
/** Reasons of the dry-run queue (T-37 S1) that entries stopped then still carry. */
export const dryRunReasons = ["needs_batch"] as const;

/** Who did something, as Core records it. */
export interface MergeActor {
  kind?: string;
  id?: string;
  name?: string;
}
export interface MergeRun {
  workflow?: string;
  run?: number;
  attempt?: number;
  conclusion?: string | null;
}
export interface MergeGate {
  kind?: "slot" | "batch";
  tree?: string;
  mergeRef?: string;
  batch?: { branch?: string; commit?: string; pr?: number | null; main?: string };
  runs?: MergeRun[];
}
export interface MergeBatch {
  branch?: string;
  main?: string;
  commit?: string | null;
  tree?: string | null;
  pr?: number | null;
  closed?: boolean;
  deleted?: boolean;
  cleanup?: string | null;
  cleanupError?: string | null;
}
/** One merge request per merge (#636): `attempts` is 1 once it is journaled
 * and may have reached GitHub, 0 while it certainly has not. */
export interface MergeRecord {
  expectedMain?: string | null;
  tree?: string | null;
  gate?: "slot" | "batch" | null;
  head?: string | null;
  attempts?: number;
  /** Each send; `notSent` or `limited` says why one certainly merged nothing. */
  puts?: { n?: number; at?: string; notSent?: string | null; limited?: string | null }[];
  /** Sends in a row that could not leave Core; five stop the entry. */
  notSent?: number;
  startedAt?: string | null;
  sha?: string | null;
  mergedAt?: string | null;
  post?: {
    ok?: boolean;
    commit?: { sha?: string; parents?: string[]; tree?: string } | string | null;
    detail?: string | null;
    at?: string;
  } | null;
  mainCi?: {
    run?: number;
    attempt?: number;
    conclusion?: string | null;
    url?: string;
    detail?: string;
  } | null;
}
export interface MergeHistoryItem {
  at: string;
  state: MergeState | string;
  reason?: string | null;
  detail?: string | null;
}
export interface MergeEntry {
  id: string;
  taskId: string;
  taskReference?: string | null;
  repositoryId: number;
  repository: string;
  number: number;
  url?: string;
  headSha: string;
  baseBranch?: string;
  mainAtRelease?: string | null;
  mainAnchoredAt?: string | null;
  release?: { by?: MergeActor; at?: string; reviewId?: string | null };
  state: MergeState | string;
  reason?: string | null;
  detail?: string | null;
  batch?: MergeBatch | null;
  merge?: MergeRecord | null;
  evidence?: { gate?: MergeGate | null; main?: { before?: string } | null } | null;
  history?: MergeHistoryItem[];
  queueVersion?: number;
  createdAt?: string;
  updatedAt?: string;
}
export interface MergePause {
  reason: string;
  at?: string;
  entryId?: string;
  number?: number;
  main?: string;
  /** The red main CI run behind a main_red pause. */
  run?: number | null;
  base?: string;
  detail?: string;
  clearedAt?: string;
  clearedBy?: { by?: string; actor?: MergeActor; reason?: string | null; main?: string } | null;
  reanchoredAt?: string;
  acceptedRun?: { id?: number; headSha?: string } | null;
}
export interface MergeRepository {
  repositoryId: number;
  enabled: boolean;
  /** How a merge lands: "core-merge" (Core merges) from T-37 S2b, or a later Core's "github-auto-merge" or "github-merge-queue"; absent before. */
  landing?: string;
  paused: MergePause | null;
  pauses?: MergePause[];
  switches?: { at?: string; enabled?: boolean; by?: string; detail?: string }[];
  updatedAt?: string;
}

/** An entry's state among the eight, or null for one this build does not know. */
export const knownState = (state: string): MergeState | null =>
  (mergeStates as readonly string[]).includes(state) ? (state as MergeState) : null;
/** Still holds its PR: what a cancel can end. */
export const cancellable = (e: MergeEntry) => ["queued", "waiting", "ready"].includes(e.state);
/** A stopped entry can be retried, except one released before Core merged for real. */
export const retryable = (e: MergeEntry) => e.state === "stopped" && e.reason !== "dry_run_ended";
/** Still going: everything before done, stopped and cancelled. */
export const ongoing = (e: MergeEntry) => !["done", "stopped", "cancelled"].includes(e.state);

/** The dock's status marks for an entry. */
export function entryStatus(e: MergeEntry) {
  if (e.state === "done")
    return e.merge?.mainCi?.conclusion === "success" ? "succeeded" : "failed";
  return (
    {
      queued: "queued",
      waiting: "pending",
      ready: "pending",
      merging: "running",
      merged: "running",
      stopped: "failed",
      cancelled: "cancelled",
    }[e.state] ?? "unknown"
  );
}

/** The newest entries, newest first; at most 50 (Core's page), of one task if given. */
export const readEntries = (taskId?: string, signal?: AbortSignal) =>
  api<{ entries: MergeEntry[] }>(
    `/merge-queue${taskId ? `?${new URLSearchParams({ taskId })}` : ""}`,
    { signal },
  );
/** One entry with its history and evidence. */
export const readEntry = (id: string, signal?: AbortSignal) =>
  api<MergeEntry>(`/merge-queue/${encodeURIComponent(id)}`, { signal });
/** A repository's switch and pause, and their journals. */
export const readRepository = (id: number, signal?: AbortSignal) =>
  api<MergeRepository>(`/merge-queue/repositories/${id}`, { signal });

export type MergeAction = "unpause" | "retry" | "cancel";
/** The route of an action; each takes a requestId and an optional reason. */
export const actionPath = (action: MergeAction, target: string | number) =>
  action === "unpause"
    ? `/merge-queue/repositories/${target}/unpause`
    : `/merge-queue/${encodeURIComponent(String(target))}/${action}`;

/**
 * One requestId per action, target and reason until Core answers it, so a
 * click again after a lost answer is the same request, not a second one.
 * Core answers a refusal with a 4xx and keeps only the answers it accepted,
 * so a refusal clears the key. A 5xx comes from between (Core answers every
 * error with 400), and the request may have reached Core: like a lost answer,
 * it keeps the key (T-65 R1).
 */
export function mergeActions() {
  const pending = new Map<string, string>();
  return async function act<T>(action: MergeAction, target: string | number, reason: string) {
    const trimmed = reason.trim();
    const key = JSON.stringify([action, target, trimmed]);
    const requestId = pending.get(key) || crypto.randomUUID();
    pending.set(key, requestId);
    try {
      const answer = await api<T>(actionPath(action, target), {
        method: "POST",
        body: JSON.stringify({ requestId, ...(trimmed ? { reason: trimmed } : {}) }),
      });
      pending.delete(key);
      return answer;
    } catch (error) {
      if (refused(error)) pending.delete(key);
      throw error;
    }
  };
}

/** Core's own answer against an action: a 4xx. A 5xx or no answer may have reached Core. */
export const refused = (error: unknown): error is HttpError =>
  error instanceof HttpError && error.status >= 400 && error.status < 500;

/** A refusal's code, the word before its colon, as Core writes it. */
export function refusalCode(message: string) {
  const match = /^([a-z_]+):/.exec(message);
  return match ? match[1] : null;
}

export const mergeWords = strings(
  {
    states: {
      queued: "Queued",
      waiting: "Waiting",
      ready: "Ready",
      merging: "Merging",
      merged: "Merged",
      done: "Done",
      stopped: "Stopped",
      cancelled: "Cancelled",
    } as Record<MergeState, string>,
    stateMeaning: {
      queued: "Released, not yet checked.",
      waiting: "A check could not decide yet.",
      ready:
        "Every check held, but it cannot merge yet: the switch is off, or another merge of the repository is in flight or has not had its post-check yet.",
      merging: "The merge request is journaled or sent.",
      merged: "GitHub merged it; Core follows main’s push CI.",
      done: "Main’s push CI on the merge commit finished.",
      stopped: "A check decided against.",
      cancelled: "Cancelled by the Agent that released it, or by the user.",
    } as Record<MergeState, string>,
    reasons: {
      head_moved: "Head moved",
      pr_not_open: "PR not open",
      base_changed: "Base changed",
      review_not_passing: "Review not passing",
      main_red: "Main CI red",
      ci_red: "CI red",
      conflict: "Conflict",
      nothing_to_merge: "Nothing to merge",
      merge_blocked: "Merge blocked",
      batch_changed: "Batch changed",
      checkout_mismatch: "Checkout mismatch",
      checkout_unproven: "Checkout unproven",
      merge_refused: "Merge refused",
      merge_unknown: "Merge outcome unknown",
      post_check_failed: "Post-check failed",
      post_check_unverified: "Post-check unverified",
      gh_too_old: "gh too old",
      wait_timeout: "Waited too long",
      github_unreachable: "GitHub unreachable",
      dry_run_ended: "Dry run ended",
    } as Record<StopReason, string>,
    unknownState: (state: string) => `Unknown state (${state})`,
    dryRunReasons: { needs_batch: "Needs a batch (dry run)" } as Record<string, string>,
    unknownReason: (reason: string) => `Other reason (${reason})`,
  },
  {
    states: {
      queued: "已排队",
      waiting: "等待中",
      ready: "就绪",
      merging: "合并中",
      merged: "已合并",
      done: "已完成",
      stopped: "已停止",
      cancelled: "已取消",
    },
    stateMeaning: {
      queued: "已放行合并，尚未检查。",
      waiting: "有项检查暂时无法判定。",
      ready: "各项检查均已通过，但还不能合并：开关已关闭，或该仓库的另一项合并仍在进行或尚未完成合并后检查。",
      merging: "合并请求已记入日志或已发送。",
      merged: "GitHub 已合并；Core 正在跟踪主分支的推送 CI。",
      done: "主分支上合并提交的推送 CI 已结束。",
      stopped: "某项检查判定不通过。",
      cancelled: "已由放行合并的 Agent 或用户取消。",
    },
    reasons: {
      head_moved: "头提交已变",
      pr_not_open: "PR 未打开",
      base_changed: "基础分支已变",
      review_not_passing: "审查未通过",
      main_red: "主分支 CI 失败",
      ci_red: "CI 失败",
      conflict: "有冲突",
      nothing_to_merge: "没有可合并的内容",
      merge_blocked: "合并受阻",
      batch_changed: "批次已变",
      checkout_mismatch: "检出不一致",
      checkout_unproven: "检出未证实",
      merge_refused: "合并被拒绝",
      merge_unknown: "合并结果未知",
      post_check_failed: "合并后检查失败",
      post_check_unverified: "合并后检查未能完成",
      gh_too_old: "gh 版本过旧",
      wait_timeout: "等待超时",
      github_unreachable: "无法连接 GitHub",
      dry_run_ended: "试运行已结束",
    },
    unknownState: (state) => `未知状态（${state}）`,
    dryRunReasons: { needs_batch: "需要批次（试运行）" },
    unknownReason: (reason) => `其他原因（${reason}）`,
  },
);

/**
 * Core's refusals, said in Chinese; Core's own text follows as it came. In
 * English the panel shows Core's text alone.
 */
export const refusalsZh: Record<string, string> = {
  merge_unpause_not_allowed: "只有关联此仓库的项目的负责人或用户，才能恢复它的合并队列。",
  merge_not_paused: "此仓库的合并队列没有暂停。",
  merge_release_not_allowed: "只有放行此合并的 Agent 或用户，才能更改它。",
  merge_not_active: "此条目已不再占用它的 PR，无法取消。",
  merge_not_stopped: "只有已停止的条目才能重试。",
  merge_dry_run_ended: "此条目是在 Core 真正合并之前放行合并的；请重新将该 PR 放行合并。",
  merge_cleanup_pending: "Core 仍在移除此条目的批次；完成后再试。",
  merge_already_queued: "另一条目已占用此 PR。",
  idempotency_conflict: "此请求已以另一个原因发送过。",
};

/** An entry state's word, or the state as Core named it. */
export function stateWord(state: string, language: Language) {
  const words = mergeWords(language);
  const known = knownState(state);
  // A word this build lacks says so with the code, never "undefined" (wce4 t65m7).
  return (known && words.states[known]) || words.unknownState(state);
}
/** A stop reason's word, or the reason as Core named it. */
export function reasonWord(reason: string, language: Language) {
  const words = mergeWords(language);
  if ((stopReasons as readonly string[]).includes(reason))
    return words.reasons[reason as StopReason] ?? words.unknownReason(reason);
  return words.dryRunReasons[reason] ?? words.unknownReason(reason);
}
