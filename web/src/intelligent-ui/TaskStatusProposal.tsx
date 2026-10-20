import { useCallback, useContext, useEffect, useState } from "react";
import { Check, ClipboardCheck, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, errorText, post } from "../api";
import { ClarificationHost } from "./ClarificationHost";
import { useResult } from "./ResultContext";
import { TASK_STATUSES } from "./contract";
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
    <section className="task-status-card" aria-label={`Proposed status change for ${proposal.taskId}`}>
      <header>
        <ClipboardCheck size={15} />
        <h4>
          Proposed change to {proposal.taskId}
          {task && <span> · {task.title}</span>}
        </h4>
      </header>
      <dl className="task-status-facts">
        <div>
          <dt>Now</dt>
          <dd>
            {loading && !view
              ? "Reading the task from Core…"
              : task
                ? `${statusLabel(task.status)} · version ${task.version}${task.assignee ? ` · ${task.assignee}` : ""}${task.archived ? " · archived" : ""}`
                : view
                  ? `${proposal.taskId} no longer exists`
                  : "Unknown"}
          </dd>
        </div>
        <div>
          <dt>Agent proposes</dt>
          <dd>
            {statusLabel(proposal.status)}: {proposal.reason}
          </dd>
        </div>
      </dl>
      {final ? (
        <p className="task-status-outcome" role="status">
          {final.state === "applied"
            ? `${final.by.name} confirmed it: ${proposal.taskId} is now ${statusLabel(final.status)}${final.taskVersion ? ` (version ${final.taskVersion})` : ""}.${final.reason ? ` Reason: ${final.reason}` : ""}`
            : `${final.by.name} declined it. ${proposal.taskId} was not changed by this proposal.`}
        </p>
      ) : blocked ? (
        <p className="task-status-outcome" role="status">
          {blocked}
        </p>
      ) : (
        <>
          <div className="task-status-edit">
            <label>
              <span>New status</span>
              <select value={status} disabled={disabled} onChange={(e) => setStatus(e.target.value)}>
                {TASK_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(value)}
                    {value === proposal.status ? " (proposed)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Reason</span>
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
              {(same ? [`${task.id} is already ${statusLabel(task.status)}.`] : impact(task, status, reason)).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {edited && <li>You changed the Agent’s proposal.</li>}
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
              Change {proposal.taskId} to {statusLabel(status)}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={disabled}
              onClick={() => onDecide?.({ action: "decline" })}
            >
              {busy === "decline" ? <LoaderCircle size={14} className="spin" /> : <X size={14} />}
              Decline
            </button>
          </div>
        </>
      )}
      {!final && last?.state === "failed" && (
        <p className="task-status-error" role="alert">
          {failureText(last, task)}
        </p>
      )}
      {unanswered && (
        <p className="task-status-error" role="alert">
          Core’s answer to your {unanswered.action === "confirm" ? "confirmation" : "decline"} was lost, so it isn’t known
          whether it was recorded.{" "}
          <button type="button" className="inline-link" disabled={!!busy || !onCheck} onClick={onCheck}>
            {busy === "check" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
            Check again
          </button>{" "}
          sends the same decision once more; Core never applies it twice.
        </p>
      )}
      {error && !unanswered && (
        <p className="task-status-error" role="alert">
          {error}
        </p>
      )}
      <small>Only your confirmation changes the task. Nothing else here does.</small>
    </section>
  );
}

/** The card for a published result: Core's facts, decisions and their receipts. */
export function PublishedTaskStatus({ proposal }: { proposal: TaskStatusProps }) {
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
  const readOnly = !resultId
    ? "Ask the Agent to publish this proposal with result_publish so you can confirm it here."
    : !agent || host?.readOnly
      ? "This proposal is read-only here. Open its original conversation to decide it."
      : undefined;
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
