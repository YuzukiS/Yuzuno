import { useCallback, useContext, useEffect, useState } from "react";
import { Check, ClipboardCheck, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, errorText, post } from "../api";
import { ClarificationHost } from "./ClarificationHost";
import { useResult } from "./ResultContext";
import { TASK_STATUSES } from "./contract";
import { strings, useLanguage } from "../i18n";
import {
  failureText,
  finalAttempt,
  impact,
  readDecision,
  saveDecision,
  statusLabel,
  type Decision,
  type ProposalView,
  type TaskStatusProps,
} from "./task-status";
// Its styles are in intelligent-ui.css, which the main bundle loads.

// The card's own words in the interface language (T-189); see task-status.ts.
const cardText = strings({
  aria: (id: string) => `Proposed status change for ${id}`,
  title: (id: string) => `Proposed change to ${id}`,
  now: "Now",
  reading: "Reading the task from Core…",
  task: (status: string, version: number, assignee: string | null | undefined, archived: boolean) =>
    `${status} · version ${version}${assignee ? ` · ${assignee}` : ""}${archived ? " · archived" : ""}`,
  gone: (id: string) => `${id} no longer exists`,
  unknown: "Unknown",
  proposes: "Agent proposes",
  proposal: (status: string, reason: string) => `${status}: ${reason}`,
  applied: (by: string, id: string, status: string, version: number | null | undefined, reason: string | null | undefined) =>
    `${by} confirmed it: ${id} is now ${status}${version ? ` (version ${version})` : ""}.${reason ? ` Reason: ${reason}` : ""}`,
  declined: (by: string, id: string) => `${by} declined it. ${id} was not changed by this proposal.`,
  newStatus: "New status",
  proposed: " (proposed)",
  reason: "Reason",
  already: (id: string, status: string) => `${id} is already ${status}.`,
  edited: "You changed the Agent’s proposal.",
  change: (id: string, status: string) => `Change ${id} to ${status}`,
  decline: "Decline",
  lost: (confirm: boolean) => `Core’s answer to your ${confirm ? "confirmation" : "decline"} was lost, so it isn’t known whether it was recorded.`,
  checkAgain: "Check again",
  lostAfter: "sends the same decision once more; Core never applies it twice.",
  only: "Only your confirmation changes the task. Nothing else here does.",
  publish: "Ask the Agent to publish this proposal with result_publish so you can confirm it here.",
  readOnly: "This proposal is read-only here. Open its original conversation to decide it.",
}, {
  aria: (id) => `${id} 的状态变更提议`,
  title: (id) => `对 ${id} 的变更提议`,
  now: "当前",
  reading: "正在从 Core 读取任务…",
  task: (status, version, assignee, archived) => `${status} · 版本 ${version}${assignee ? ` · ${assignee}` : ""}${archived ? " · 已归档" : ""}`,
  gone: (id) => `${id} 已不存在`,
  unknown: "未知",
  proposes: "Agent 提议",
  proposal: (status, reason) => `${status}：${reason}`,
  applied: (by, id, status, version, reason) =>
    `${by} 已确认：${id} 现在是“${status}”${version ? `（版本 ${version}）` : ""}。${reason ? `理由：${reason}` : ""}`,
  declined: (by, id) => `${by} 拒绝了它。${id} 没有因这个提议而改变。`,
  newStatus: "新状态",
  proposed: "（提议）",
  reason: "理由",
  already: (id, status) => `${id} 已经是“${status}”。`,
  edited: "你修改了 Agent 的提议。",
  change: (id, status) => `把 ${id} 改为“${status}”`,
  decline: "拒绝",
  lost: (confirm) => `Core 对你的${confirm ? "确认" : "拒绝"}的回答丢失了，所以不知道它是否已被记录。`,
  checkAgain: "再次检查",
  lostAfter: "会再发送一次同样的决定；Core 不会重复执行。",
  only: "只有你的确认会改变任务。这里的其他操作都不会。",
  publish: "请让 Agent 用 result_publish 发布这个提议，你就能在这里确认。",
  readOnly: "这个提议在这里是只读的。请打开它的原始会话来决定。",
});

type CardProps = {
  proposal: TaskStatusProps;
  view: ProposalView | null;
  /** Why this card cannot decide anything, when it cannot. */
  readOnly?: string;
  loading?: boolean;
  error?: string;
  /** A decision Core has not answered (the reply was lost). */
  unanswered?: Decision | null;
  /** This window's last decision, to show its outcome. */
  mine?: string | null;
  busy?: "confirm" | "decline" | "check" | "";
  onDecide?: (decision: Omit<Decision, "requestId">) => void;
  onCheck?: () => void;
};

/** The proposal, the task as Core reads it, and the user's decision. */
export function TaskStatusCard({
  proposal,
  view,
  readOnly,
  loading,
  error,
  unanswered,
  mine,
  busy = "",
  onDecide,
  onCheck,
}: CardProps) {
  const language = useLanguage();
  const t = cardText(language);
  const label = (value: string | null | undefined) => statusLabel(value, language);
  const [status, setStatus] = useState<string>(proposal.status);
  const [reason, setReason] = useState(proposal.reason);
  const task = view?.task || null;
  const final = finalAttempt(view);
  const last = mine ? view?.attempts.find((a) => a.requestId === mine) : undefined;
  const blocked = readOnly || view?.blocked || undefined;
  const edited = status !== proposal.status || reason.trim() !== proposal.reason.trim();
  const same = !!task && task.status === status;
  const disabled = !!busy || !!blocked || !task || !onDecide || !!unanswered;
  return (
    <section className="task-status-card" aria-label={t.aria(proposal.taskId)}>
      <header>
        <ClipboardCheck size={15} />
        <h4>
          {t.title(proposal.taskId)}
          {task && <span> · {task.title}</span>}
        </h4>
      </header>
      <dl className="task-status-facts">
        <div>
          <dt>{t.now}</dt>
          <dd>
            {loading && !view
              ? t.reading
              : task
                ? t.task(label(task.status), task.version, task.assignee, !!task.archived)
                : view
                  ? t.gone(proposal.taskId)
                  : t.unknown}
          </dd>
        </div>
        <div>
          <dt>{t.proposes}</dt>
          <dd>{t.proposal(label(proposal.status), proposal.reason)}</dd>
        </div>
      </dl>
      {final ? (
        <p className="task-status-outcome" role="status">
          {final.state === "applied"
            ? t.applied(final.by.name, proposal.taskId, label(final.status), final.taskVersion, final.reason)
            : t.declined(final.by.name, proposal.taskId)}
        </p>
      ) : blocked ? (
        <p className="task-status-outcome" role="status">
          {blocked}
        </p>
      ) : (
        <>
          <div className="task-status-edit">
            <label>
              <span>{t.newStatus}</span>
              <select value={status} disabled={disabled} onChange={(e) => setStatus(e.target.value)}>
                {TASK_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                    {value === proposal.status ? t.proposed : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.reason}</span>
              <textarea
                rows={2}
                maxLength={1000}
                value={reason}
                disabled={disabled}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </div>
          {task && (
            <ul className="task-status-impact">
              {(same ? [t.already(task.id, label(task.status))] : impact(task, status, reason, language)).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {edited && <li>{t.edited}</li>}
            </ul>
          )}
          <div className="task-status-actions">
            <button
              type="button"
              className="result-primary"
              disabled={disabled || same}
              onClick={() =>
                task && onDecide?.({ action: "confirm", status, reason, expectedVersion: task.version })
              }
            >
              {busy === "confirm" ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              {t.change(proposal.taskId, label(status))}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => onDecide?.({ action: "decline" })}
            >
              {busy === "decline" ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}
              {t.decline}
            </button>
          </div>
        </>
      )}
      {!final && last?.state === "failed" && (
        <p className="task-status-error" role="alert">
          {failureText(last, task, language)}
        </p>
      )}
      {unanswered && (
        <p className="task-status-error" role="alert">
          {t.lost(unanswered.action === "confirm")}{" "}
          <button type="button" className="inline-link" disabled={!!busy || !onCheck} onClick={onCheck}>
            {busy === "check" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
            {t.checkAgain}
          </button>{" "}
          {t.lostAfter}
        </p>
      )}
      {error && !unanswered && (
        <p className="task-status-error" role="alert">
          {error}
        </p>
      )}
      <small>{t.only}</small>
    </section>
  );
}

/** The card for a published result: Core's facts, decisions and their receipts. */
export function PublishedTaskStatus({ proposal }: { proposal: TaskStatusProps }) {
  const t = cardText(useLanguage());
  const host = useContext(ClarificationHost);
  const { resultId } = useResult();
  const agent = host?.detail?.agent;
  const [view, setView] = useState<ProposalView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"confirm" | "decline" | "check" | "">("");
  const [unanswered, setUnanswered] = useState<Decision | null>(() =>
    resultId ? readDecision(localStorage, resultId) : null,
  );
  const [mine, setMine] = useState<string | null>(unanswered?.requestId || null);
  const path = resultId ? `/results/${encodeURIComponent(resultId)}/task-status` : "";
  const load = useCallback(async () => {
    if (!path || !resultId) return;
    setLoading(true);
    try {
      const next = await api<ProposalView>(path);
      setView(next);
      setError("");
      // Core already has the unanswered decision, or the proposal was decided
      // elsewhere: nothing is left to check.
      const kept = readDecision(localStorage, resultId);
      if (kept && (next.attempts.some((a) => a.requestId === kept.requestId) || finalAttempt(next))) {
        saveDecision(localStorage, resultId, null);
        setUnanswered(null);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path, resultId]);
  // Read again when the card opens and when the Agent's status changes; a
  // running Turn changes its record constantly.
  useEffect(() => {
    void load();
  }, [load, agent?.status]);
  async function send(decision: Decision, kind: "confirm" | "decline" | "check") {
    if (!resultId) return;
    setBusy(kind);
    setError("");
    setMine(decision.requestId);
    // Kept until Core answers, so a lost reply can be checked with the same requestId.
    saveDecision(localStorage, resultId, decision);
    setUnanswered(null);
    try {
      setView(await post<ProposalView>(path, decision));
      saveDecision(localStorage, resultId, null);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status < 500) {
        // Core answered: refused, nothing recorded for it.
        saveDecision(localStorage, resultId, null);
        setError(errorText(e));
        void load();
      } else {
        setUnanswered(decision);
      }
    } finally {
      setBusy("");
    }
  }
  const readOnly = !resultId ? t.publish : !agent || host?.readOnly ? t.readOnly : undefined;
  return (
    <TaskStatusCard
      proposal={proposal}
      view={view}
      readOnly={readOnly}
      loading={loading}
      error={error}
      unanswered={unanswered}
      mine={mine}
      busy={busy}
      onDecide={(decision) => void send({ ...decision, requestId: crypto.randomUUID() }, decision.action)}
      onCheck={() => unanswered && void send(unanswered, "check")}
    />
  );
}
