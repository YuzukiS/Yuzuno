import { REVIEW_ROUNDS, type ExecutorDetail, type ExecutorShown, type ExecutorView, type PRStatus } from "./executor-display";
import { strings, useLanguage, type Language } from "./i18n";
import "./executor-row.css";

// The executor row's words (T-43 S2): one state, then what it is at. The
// reasons and blockers come from Core or the Agent as they are.
export const executorRowText = strings({
  shown: {
    queued: "Queued",
    working: "Working",
    needsYou: "Needs you",
    review: "Review",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
  } as Record<ExecutorShown, string>,
  position: (n: number) => `${n} in line`,
  starting: "Starting",
  awaitingRelease: "Handed in, waiting for the lead",
  blocked: (text: string) => `Task blocked: ${text}`,
  check: "Check its result",
  released: "Archived",
  archiving: "Closing",
  turnFailed: "Its Turn failed",
  closed: "Closed",
  offline: "Offline",
  waited: (time: string) => `waited ${time}`,
  merged: "Merged",
  prClosed: "PR closed",
  changes: "Changes requested",
  ciFailed: "CI failed",
  rounds: (approved: number, of: number) => `Review ${approved}/${of}`,
  reviewing: (approved: number, of: number) => `Reviewing · ${approved}/${of}`,
  // In review already, its rounds alone: "Review · 1/2", not "Review · Review 1/2".
  roundsOnly: (approved: number, of: number, running: boolean) => `${approved}/${of}${running ? " · under way" : ""}`,
  approved: (of: number) => `${of} rounds approved`,
  ciPending: "CI not green yet",
  draft: "Draft",
  pr: (n: number) => `PR #${n}`,
  template: "Template",
  elapsed: (time: string) => `On its task for ${time}`,
  elapsedEnded: (time: string) => `${time} on its task`,
}, {
  shown: {
    queued: "排队",
    working: "在做",
    needsYou: "等你",
    review: "审查",
    done: "完成",
    failed: "失败",
    stopped: "已停止",
  },
  position: (n) => `第 ${n} 位`,
  starting: "启动中",
  awaitingRelease: "已交，等负责人",
  blocked: (text) => `任务受阻：${text}`,
  check: "核对结果",
  released: "已归档",
  archiving: "收尾中",
  turnFailed: "Turn 出错",
  closed: "已关闭",
  offline: "离线",
  waited: (time) => `等了 ${time}`,
  merged: "已合并",
  prClosed: "PR 已关闭",
  changes: "需修改",
  ciFailed: "CI 失败",
  rounds: (approved, of) => `审查 ${approved}/${of}`,
  reviewing: (approved, of) => `审查中 · ${approved}/${of}`,
  roundsOnly: (approved, of, running) => `${approved}/${of}${running ? " · 进行中" : ""}`,
  approved: (of) => `${of} 轮通过`,
  ciPending: "CI 未绿",
  draft: "草稿",
  pr: (n) => `PR #${n}`,
  template: "模板",
  elapsed: (time) => `已用 ${time}`,
  elapsedEnded: (time) => `共用 ${time}`,
});
type Text = ReturnType<typeof executorRowText>;

export function prText(status: PRStatus, t: Text): string {
  switch (status.kind) {
    case "merged": return t.merged;
    case "closed": return t.prClosed;
    case "changes": return t.changes;
    case "ciFailed": return t.ciFailed;
    case "approved": return status.ciPending ? `${t.approved(REVIEW_ROUNDS)} · ${t.ciPending}` : t.approved(REVIEW_ROUNDS);
    case "draft": return t.draft;
    case "rounds": return status.running ? t.reviewing(status.approved, status.of) : t.rounds(status.approved, status.of);
  }
}

export function detailText(detail: ExecutorDetail | null, t: Text, shown?: ExecutorShown): string | null {
  if (!detail) return null;
  switch (detail.kind) {
    case "position": return t.position(detail.position);
    case "starting": return t.starting;
    case "awaitingRelease": return t.awaitingRelease;
    case "pr":
      return shown === "review" && detail.status.kind === "rounds"
        ? t.roundsOnly(detail.status.approved, detail.status.of, detail.status.running)
        : prText(detail.status, t);
    case "blocked": return t.blocked(detail.text);
    case "check": return t.check;
    case "waiting": return detail.label;
    case "released": return t.released;
    case "archiving": return detail.text ? `${t.archiving} · ${detail.text}` : t.archiving;
    case "reason": return detail.text;
    case "turnFailed": return t.turnFailed;
    case "closed": return t.closed;
    case "offline": return t.offline;
  }
}

/** The state and what it is at, as one line of text: the row's accessible
 * description and title say it so. */
export function stateText(view: ExecutorView, language: Language): string {
  const t = executorRowText(language);
  const detail = detailText(view.detail, t, view.shown);
  return detail ? `${t.shown[view.shown]} · ${detail}` : t.shown[view.shown];
}

/** What the chips say, for the island's label: the template, then the PR
 * and its status. Null when there are no chips. */
export function rowFactsLabel(view: ExecutorView, template: string | null | undefined, t: Text): string | null {
  const parts = [template || null, view.pr ? `${t.pr(view.pr.number)} · ${prText(view.pr.status, t)}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * What an executor's island holds beside its state (T-43 S2; inside the
 * island since the user's review of 2026-11-07): the template it was made
 * from when its name doesn't say it, and its PR, as "#688".
 */
export function ExecutorRowFacts({ view, template, title }: { view: ExecutorView; template?: string | null; title?: string }) {
  const language = useLanguage();
  const t = executorRowText(language);
  if (!template && !view.pr) return null;
  const pr = view.pr ? `${t.pr(view.pr.number)} · ${prText(view.pr.status, t)}` : null;
  return (
    <span className="executor-row-facts" data-shown={view.shown} title={title}>
      {template && <span className="executor-template-chip" title={`${t.template}: ${template}`}>{template}</span>}
      {view.pr && (
        <span className="executor-pr-chip" data-tone={view.pr.tone} title={pr ?? undefined}>#{view.pr.number}</span>
      )}
    </span>
  );
}
