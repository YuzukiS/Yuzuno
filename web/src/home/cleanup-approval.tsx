/**
 * A cleanup plan's approval on Home (YN-74 ①b, design 2.4). A gate Ask whose
 * form has a multi-choice field `groups` approves its task's cleanup plan
 * when that task has one. The plan's groups are then shown as Core
 * summarized them (GET /api/tasks/{task}/cleanup-plan): kinds, bytes,
 * worktrees, commits found on no remote branch, changes, snapshots,
 * refusals, warnings and the largest paths. The executor's own label and
 * reason are a smaller note beneath. While Core's summary can't be read, no
 * plan waits, the Ask does not name the plan's ID and sha256, or its options
 * are not the plan's groups, the form can't be sent: the user approves only
 * what Core showed. Core checks all of it again when the plan is applied
 * (cleanup_apply), so this is what the user sees, not the safeguard.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "../api";
import { strings, useLanguage, type Language } from "../i18n";
import { clarificationSchema } from "../intelligent-ui/clarification";
import { sizeText } from "../storage-overview";
import type { Section } from "./types";
import "./cleanup-approval.css";

export type CleanupGroupSummary = {
  group: string;
  decision: string;
  executed: boolean;
  items: number;
  pending: number;
  kinds: { entry: number; cacheDir: Record<string, number>; worktree: number };
  bytes: number;
  bytesComplete: boolean;
  worktrees: number;
  uniqueCommits: { worktrees: number; commits: number };
  trackedChanges: number;
  untrackedFiles: number;
  snapshots: { items: number; bytes: number };
  snapshotTooLarge: number;
  refused: { items: number; reasons: { code: string; items: number; example: string }[] };
  categories: Record<string, number>;
  warnings: { code: string; text: string }[];
  largest?: { item: string; path: string; kind: string; bytes: number | null; category: string; rule?: string | null; flags: string[] }[];
};

export type CleanupPlanView = {
  planId: string;
  taskId: string;
  title: string;
  state: string;
  sha256: string;
  expiresAt: string;
  machine: string | null;
  items: number;
  refused: number;
  groups: { id: string; decision: string; authorLabel: string; authorReason: string; summary: CleanupGroupSummary | null }[];
};

export type CleanupPlanRead = { plan: CleanupPlanView | null; planned?: boolean };

export function readCleanupPlan(taskId: string, signal?: AbortSignal) {
  return api<CleanupPlanRead>(`/tasks/${encodeURIComponent(taskId)}/cleanup-plan`, { signal });
}

const text = strings({
  loading: "Reading Core's summary of the cleanup plan…",
  unreadable: (error: string) => `Core's summary of the cleanup plan couldn't be read (${error}): it can't be approved until it is shown.`,
  noPlan: "No cleanup plan of this task waits for approval now: it expired, was replaced by a newer one or was applied. Ask the executor to register it again.",
  mismatch: "This ask does not name the plan waiting now (its ID and sha256): it may be about an older plan. Ask the executor to ask again.",
  options: "The ask's choices are not this plan's groups. Ask the executor to ask again.",
  noSummary: (group: string) => `Core has no summary of group ${group}: it can't be approved until Core shows what it holds.`,
  heading: (id: string, sha: string, until: string) => `Core's summary of plan ${id} (sha256 ${sha}…), valid until ${until}. Each group below is what Core's own checks found; the executor's words are only a note.`,
  remote: (machine: string) => `Inventoried on ${machine}: Core can't remove anything there yet.`,
  decision: { delete: "Delete", rebuildable: "Rebuildable", keep: "Keep (never run)", ask: "Ask (never run)" } as Record<string, string>,
  items: (n: number) => `${n} item${n === 1 ? "" : "s"}`,
  about: (size: string, complete: boolean) => (complete ? size : `at least ${size}`),
  kinds: (entry: number, cache: string, worktree: number) =>
    [entry ? `${entry} scratch entr${entry === 1 ? "y" : "ies"}` : "", cache ? `cache folders: ${cache}` : "", worktree ? `${worktree} worktree${worktree === 1 ? "" : "s"}` : ""]
      .filter(Boolean).join(" · "),
  snapshots: (n: number, size: string) => `${n} kept in a snapshot first (${size})`,
  refused: (n: number, why: string) => `${n} refused by Core's checks${why ? `, e.g. ${why}` : ""}`,
  notRebuildable: (worktrees: number, entries: number, unknown: number) =>
    `Marked rebuildable, but Core finds ${worktrees} worktree(s), ${entries} entr(ies) and ${unknown} folder(s) no rule recognizes in it`,
  uniqueCommits: (worktrees: number, commits: number) => `${worktrees} worktree(s) hold ${commits} commit(s) found on no remote branch`,
  uncommitted: (tracked: number, untracked: number) => `Worktrees with changes Git tracks: ${tracked}; with untracked files: ${untracked}`,
  largest: "Largest:",
  author: "Executor's note: ",
}, {
  loading: "正在读取 Core 对清理计划的摘要…",
  unreadable: (error) => `读不到 Core 对清理计划的摘要（${error}）：显示出来之前不能批准。`,
  noPlan: "这个任务现在没有等待批准的清理计划：已过期、被新计划取代或已执行。请让执行者重新登记。",
  mismatch: "这个提问没有写明现在等待批准的计划（它的 ID 和 sha256），可能是在问旧计划。请让执行者重新提问。",
  options: "提问的选项不是这个计划的组。请让执行者重新提问。",
  noSummary: (group) => `Core 没有组 ${group} 的摘要：在 Core 显示出它里面有什么之前不能批准。`,
  heading: (id, sha, until) => `Core 对计划 ${id}（sha256 ${sha}…）的摘要，${until} 前有效。下面每一组都是 Core 自己检查的结果；执行者写的只是说明。`,
  remote: (machine) => `在 ${machine} 上盘点：Core 现在还不能删那里的东西。`,
  decision: { delete: "删除", rebuildable: "可重建", keep: "保留（不会执行）", ask: "问用户（不会执行）" },
  items: (n) => `${n} 项`,
  about: (size, complete) => (complete ? size : `至少 ${size}`),
  kinds: (entry, cache, worktree) =>
    [entry ? `scratch 条目 ${entry} 个` : "", cache ? `缓存目录：${cache}` : "", worktree ? `worktree ${worktree} 个` : ""].filter(Boolean).join(" · "),
  snapshots: (n, size) => `${n} 项先存快照（${size}）`,
  refused: (n, why) => `Core 检查拦下 ${n} 项${why ? `，例如：${why}` : ""}`,
  notRebuildable: (worktrees, entries, unknown) => `标为可重建，但 Core 在里面找到 worktree ${worktrees} 个、条目 ${entries} 个、规则认不出的目录 ${unknown} 个`,
  uniqueCommits: (worktrees, commits) => `${worktrees} 个 worktree 里有 ${commits} 个提交不在任何远端分支上`,
  uncommitted: (tracked, untracked) => `有跟踪改动的 worktree：${tracked} 个；有未跟踪文件的：${untracked} 个`,
  largest: "最大的：",
  author: "执行者的说明：",
});

/** The Ask's multi-choice field `groups`, as its form declares it. */
function groupsField(section: Section) {
  const parsed = clarificationSchema.safeParse(section.ask?.reply.form);
  if (!parsed.success) return null;
  const field = parsed.data.fields.find((f) => f.id === "groups" && f.type === "multi");
  return field && field.type !== "text" ? field : null;
}

/** The task a gate Ask with a `groups` multi-choice field asks about, or null. */
export function cleanupCandidate(section: Section): string | null {
  const gate = section.ask?.gate;
  return gate?.taskId && groupsField(section) ? gate.taskId : null;
}

export type CleanupApproval =
  | { state: "none" }
  | { state: "blocked"; reason: string }
  | { state: "ready"; plan: CleanupPlanView };

/**
 * What this Ask is, from Core's read of its task's plan: no cleanup approval
 * (its task never had a plan), one that can't be sent and why, or one whose
 * options Core summarized.
 */
export function judge(section: Section, read: CleanupPlanRead, language: Language): CleanupApproval {
  const t = text(language);
  const plan = read.plan;
  if (!plan) return read.planned ? { state: "blocked", reason: t.noPlan } : { state: "none" };
  const said = `${section.ask?.question ?? ""} ${JSON.stringify(section.body ?? null)}`;
  if (!said.includes(plan.planId) || !said.includes(plan.sha256)) return { state: "blocked", reason: t.mismatch };
  const offered = (groupsField(section)?.options ?? []).map((o) => o.id).sort();
  const groups = plan.groups.map((g) => g.id).sort();
  if (offered.length !== groups.length || offered.some((id, i) => id !== groups[i])) return { state: "blocked", reason: t.options };
  // Every group as Core summarized it, or none: never the executor's words alone (review ac3c3d8f).
  const bare = plan.groups.find((g) => !g.summary);
  if (bare) return { state: "blocked", reason: t.noSummary(bare.id) };
  return { state: "ready", plan };
}

/** This Ask as a cleanup approval, read again when the Ask changes. */
export function useCleanupApproval(section: Section): CleanupApproval | { state: "loading"; reason: string } {
  const language = useLanguage();
  const task = cleanupCandidate(section);
  const [read, setRead] = useState<{ key: string; value: CleanupPlanRead | null; error: string | null } | null>(null);
  const key = `${task}@${section.version}`;
  useEffect(() => {
    if (!task) return;
    const controller = new AbortController();
    readCleanupPlan(task, controller.signal)
      .then((value) => setRead({ key, value, error: null }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setRead({ key, value: null, error: errorText(e) });
      });
    return () => controller.abort();
  }, [task, key]);
  if (!task) return { state: "none" };
  const t = text(language);
  if (!read || read.key !== key) return { state: "loading", reason: t.loading };
  if (read.error !== null || !read.value) return { state: "blocked", reason: t.unreadable(read.error ?? "") };
  return judge(section, read.value, language);
}

const size = (bytes: number | null | undefined) => (typeof bytes === "number" ? sizeText(bytes) : "?");

/** What Core says of the plan as a whole, above the form. */
export function CleanupApprovalNote({ approval }: { approval: ReturnType<typeof useCleanupApproval> }) {
  const t = text(useLanguage());
  if (approval.state === "none") return null;
  if (approval.state !== "ready") {
    return (
      <p className={`cleanup-approval-note${approval.state === "blocked" ? " is-blocked" : ""}`} role={approval.state === "blocked" ? "alert" : "status"}>
        {approval.reason}
      </p>
    );
  }
  const plan = approval.plan;
  return (
    <div className="cleanup-approval-note" role="note">
      <p>{t.heading(plan.planId.slice(0, 8), plan.sha256.slice(0, 12), new Date(plan.expiresAt).toLocaleString())}</p>
      {plan.machine && <p className="is-blocked">{t.remote(plan.machine)}</p>}
    </div>
  );
}

/** One `groups` option as Core summarized its group, the executor's words beneath. */
export function cleanupOptionView(approval: ReturnType<typeof useCleanupApproval>, language: Language) {
  const t = text(language);
  return (fieldId: string, option: { id: string; label: string; description?: string }): ReactNode | null => {
    if (approval.state !== "ready" || fieldId !== "groups") return null;
    const group = approval.plan.groups.find((g) => g.id === option.id);
    const s = group?.summary;
    if (!group || !s) return null;
    const cache = Object.entries(s.kinds.cacheDir).map(([rule, n]) => `${rule} ${n}`).join(", ");
    const warnings = s.warnings.map((w) => {
      switch (w.code) {
        case "notRebuildable":
          return t.notRebuildable(s.worktrees, s.kinds.entry, s.kinds.cacheDir.unrecognized ?? 0);
        case "uniqueCommits":
          return t.uniqueCommits(s.uniqueCommits.worktrees, s.uniqueCommits.commits);
        case "uncommitted":
          return t.uncommitted(s.trackedChanges, s.untrackedFiles);
        default:
          return w.text;
      }
    });
    const largest = (s.largest ?? []).slice(0, 3);
    const reason = group.authorReason?.trim();
    return (
      <span className="cleanup-group" data-decision={group.decision}>
        <strong>
          {t.decision[group.decision] ?? group.decision} · {t.items(s.pending)} · {t.about(size(s.bytes), s.bytesComplete)}
        </strong>
        <span className="cleanup-group-facts">{t.kinds(s.kinds.entry, cache, s.kinds.worktree)}</span>
        {s.snapshots.items > 0 && <span className="cleanup-group-facts">{t.snapshots(s.snapshots.items, size(s.snapshots.bytes))}</span>}
        {s.refused.items > 0 && <span className="cleanup-group-facts">{t.refused(s.refused.items, s.refused.reasons[0]?.example ?? "")}</span>}
        {warnings.map((warning) => (
          <span key={warning} className="cleanup-group-warning">⚠ {warning}</span>
        ))}
        {largest.length > 0 && (
          <span className="cleanup-group-paths">
            {t.largest}{" "}
            {largest.map((p) => `${p.path} (${size(p.bytes)}${p.flags.length ? `, ${p.flags.join(", ")}` : ""})`).join(" · ")}
          </span>
        )}
        <small className="cleanup-group-author">
          {t.author}{option.label}
          {reason ? ` — ${reason}` : ""}
        </small>
      </span>
    );
  };
}
