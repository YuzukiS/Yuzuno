import { useEffect, useState, type FormEvent } from "react";
import { Goal, LoaderCircle, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { HttpError, api, errorText, post } from "./api";
import { formatElapsed } from "./activity-time";
import { Modal } from "./components";
import type { Agent } from "./types";
import "./remote.css";
import "./session-import.css";

/** Codex's own `ThreadGoal`. */
export type CodexGoal = {
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
};
type GoalView = { state: "ready" | "unavailable" | "unsupported" | "failed"; reason: string; goal: CodexGoal | null };
type GoalChange = { action: "set"; objective: string; replace: boolean } | { action: "pause" | "resume" | "clear" };

/** Codex's own words for each status (its CLI's). */
const statusLabels: Record<CodexGoal["status"], string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Stalled",
  usageLimited: "Usage limited",
  budgetLimited: "Limited by budget",
  complete: "Complete",
};
const notes: Record<string, string> = {
  not_connected: "Connect this Agent to see its Codex goal.",
  closed: "This Agent is closed.",
  no_thread: "This Agent has no Codex session yet.",
  old_protocol: "This Agent's Codex has no goals.",
  harness: "Goals are Codex's own.",
};
/** Codex's CLI limit on an objective. */
const MAX_OBJECTIVE = 4000;

/**
 * `/goal` (T-29): this Codex Agent's own goal, as Codex's CLI shows it,
 * read when this opens and on Refresh only; opening it or typing an
 * objective starts nothing. A change is the user's click, and says what
 * Codex does with it (0.162.1): an active goal (set or resumed) starts a
 * turn toward it when the conversation is idle, or is taken into the
 * running turn; pausing or clearing only stops new work toward it, never
 * the running turn. Nothing here makes a shared task or assigns work.
 */
export function CodexGoalDialog({ agent, open, initialObjective, onOpenChange, onChanged }: {
  agent: Agent;
  open: boolean;
  /** What followed `/goal`, to set as the objective. */
  initialObjective: string;
  onOpenChange: (open: boolean) => void;
  onChanged: (notice: string) => void;
}) {
  const [view, setView] = useState<GoalView | null>(null);
  const [reading, setReading] = useState(0);
  const [objective, setObjective] = useState(initialObjective);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(null);
    setError("");
    api<GoalView>(`/agents/${encodeURIComponent(agent.id)}/codex/goal`, { signal: controller.signal })
      .then(setView, (e) => { if (!controller.signal.aborted) setView({ state: "failed", reason: errorText(e), goal: null }); });
    return () => controller.abort();
  }, [open, agent.id, reading]);

  const goal = view?.state === "ready" ? view.goal : null;
  const unfinished = !!goal && goal.status !== "complete";
  const text = objective.trim();

  async function change(body: GoalChange, done: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const answer = await post<{ goal: CodexGoal | null }>(`/agents/${encodeURIComponent(agent.id)}/codex/goal`, body);
      setView({ state: "ready", reason: "changed", goal: answer.goal });
      if (body.action === "set") setObjective("");
      onChanged(done);
    } catch (e) {
      // Core's answer says what happened; no answer leaves it unknown.
      setError(e instanceof HttpError ? errorText(e)
        : `No answer came back (${errorText(e)}). Codex may have changed its goal: Refresh to see it before trying again.`);
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text || [...text].length > MAX_OBJECTIVE) return;
    void change({ action: "set", objective: text, replace: unfinished },
      `Codex ${unfinished ? "replaced" : "set"} its goal and works toward it on its own: in a new turn if this conversation was idle, else in the running turn.`);
  }

  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title="Codex goal"
      description={`${agent.name}'s own Codex goal for this conversation. Opening this or typing an objective starts nothing.`}>
      <form className="create-form remote-create" onSubmit={submit}>
        {!view ? (
          <p role="status"><LoaderCircle size={14} className="spin" /> Reading the goal…</p>
        ) : view.state !== "ready" ? (
          <p role="status" className="remote-field-note">{notes[view.reason] ?? `Codex could not read the goal: ${view.reason}`}</p>
        ) : goal ? (
          <section className="session-preview" aria-label="Current goal">
            <div className="session-preview-heading">
              <span><Goal size={14} /> {statusLabels[goal.status] ?? goal.status}</span>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => setReading((n) => n + 1)}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            <p className="session-preview-excerpt">{goal.objective}</p>
            <p className="session-preview-model">
              {formatElapsed(goal.timeUsedSeconds * 1000)} · {goal.tokensUsed.toLocaleString()} tokens
              {goal.tokenBudget != null && ` of ${goal.tokenBudget.toLocaleString()}`}
            </p>
          </section>
        ) : (
          <p role="status" className="remote-field-note">No goal is set.</p>
        )}
        {view?.state === "ready" && (
          <fieldset className="remote-form-fields" disabled={busy}>
            {goal && (
              <div className="modal-actions">
                {goal.status === "active" && (
                  <button type="button" className="secondary-button" onClick={() => change({ action: "pause" }, "Codex paused its goal. A turn already running continues until it ends or you stop it.")}>
                    <Pause size={15} /> Pause
                  </button>
                )}
                {["paused", "blocked", "usageLimited"].includes(goal.status) && (
                  <button type="button" className="secondary-button" onClick={() => change({ action: "resume" }, "Codex resumed its goal and works toward it on its own: in a new turn if this conversation was idle, else in the running turn.")}>
                    <Play size={15} /> Resume and run
                  </button>
                )}
                <button type="button" className="secondary-button" onClick={() => change({ action: "clear" }, "Codex cleared its goal. A turn already running continues until it ends or you stop it.")}>
                  <Trash2 size={15} /> Clear
                </button>
              </div>
            )}
            <label>
              {unfinished ? "New objective (replaces this goal)" : "Objective"}
              <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={3} maxLength={MAX_OBJECTIVE} />
            </label>
            <p className="remote-field-note">
              Set and start makes it Codex's active goal: Codex works toward it on its own, in a new turn if this conversation
              is idle, else in the running turn. Pause and Clear only stop new work toward it; a running turn continues.
            </p>
          </fieldset>
        )}
        {error && <p role="alert" className="remote-field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>Close</button>
          {view?.state === "ready" && (
            <button className="primary-button" disabled={busy || !text}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Goal size={15} />}
              {unfinished ? "Replace and start" : "Set and start"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
