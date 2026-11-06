import { REVIEW_ROUNDS, elapsedText, type ExecutorDetail, type ExecutorShown, type ExecutorView, type PRStatus } from "./executor-display";
import { strings, useLanguage, type Language } from "./i18n";
import { useMinute } from "./live-executors";
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
  awaitingRelease: "Awaiting release",
  blocked: (text: string) => `Task blocked: ${text}`,
  check: "Check its result",
  released: "Released",
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
  awaitingRelease: "等待放行",
  blocked: (text) => `任务受阻：${text}`,
  check: "核对结果",
  released: "已放行",
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
  approved: (of) => `${of} 轮通过`,
  ciPending: "CI 未绿",
  draft: "草稿",
  pr: (n) => `PR #${n}`,
  template: "模板",
  elapsed: (time) => `已用 ${time}`,
  elapsedEnded: (time) => `共用 ${time}`,
});
type Text = ReturnType<typeof executorRowText>;

/** Each state's dot, in the status colours every palette sets: at work
 * pulses, waiting for you is the waiting colour, a failure the error one;
 * the rest are quiet and their word says which. */
const DOT: Record<ExecutorShown, string> = {
  queued: "idle", working: "working", needsYou: "waiting", review: "idle", done: "idle", failed: "error", stopped: "offline",
};

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

export function detailText(detail: ExecutorDetail | null, t: Text): string | null {
  if (!detail) return null;
  switch (detail.kind) {
    case "position": return t.position(detail.position);
    case "starting": return t.starting;
    case "awaitingRelease": return t.awaitingRelease;
    case "pr": return prText(detail.status, t);
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
  const detail = detailText(view.detail, t);
  return detail ? `${t.shown[view.shown]} · ${detail}` : t.shown[view.shown];
}

/**
 * The second line of an executor's row (T-43 S2): its one state, what it is
 * at and how long it has waited for you; the template it was made from when
 * its name doesn't say it; its PR; its time on the task, frozen once it is
 * over. A compact list (Settings → Appearance) keeps the state, the wait and
 * the time.
 */
export function ExecutorRowState({ view, template, title }: { view: ExecutorView; template?: string | null; title?: string }) {
  const language = useLanguage();
  const t = executorRowText(language);
  const now = useMinute();
  const detail = detailText(view.detail, t);
  const waited = view.waitingSince != null ? elapsedText(now - view.waitingSince, language) : null;
  const elapsed = view.started != null ? elapsedText((view.ended ?? now) - view.started, language) : null;
  const pr = view.pr ? `${t.pr(view.pr.number)} · ${prText(view.pr.status, t)}` : null;
  return (
    <span className="executor-row-state" data-shown={view.shown} title={title}>
      <span className="executor-state">
        <span className={`status-dot ${DOT[view.shown]}`} aria-hidden="true" />
        <span className="executor-state-word">{t.shown[view.shown]}</span>
        {detail && <span className="executor-state-detail" title={detail}>{detail}</span>}
        {waited && <span className="executor-state-waited">{t.waited(waited)}</span>}
      </span>
      {(template || view.pr || elapsed) && (
        <span className="executor-row-facts">
          {template && <span className="executor-template-chip" title={`${t.template}: ${template}`}>{template}</span>}
          {view.pr && (
            <span className="executor-pr-chip" data-tone={view.pr.tone} title={pr ?? undefined}>{t.pr(view.pr.number)}</span>
          )}
          {elapsed && (
            <span className="executor-elapsed" title={view.ended != null ? t.elapsedEnded(elapsed) : t.elapsed(elapsed)}>{elapsed}</span>
          )}
        </span>
      )}
    </span>
  );
}
