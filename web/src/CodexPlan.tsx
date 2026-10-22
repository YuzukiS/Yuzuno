import { useEffect, useState } from "react";
import { ListChecks, LoaderCircle, RefreshCw } from "lucide-react";
import { HttpError, api, errorText, post } from "./api";
import { Modal } from "./components";
import type { Agent, CodexPlanState } from "./types";
import "./remote.css";
import "./session-import.css";

type Mode = "plan" | "default";
type PlanView = {
  state: "ready" | "unavailable" | "unsupported" | "failed";
  reason: string;
  generation: number | null;
  /** The modes this connection's Codex lists, of the two its CLI switches. */
  modes: Mode[];
  reported: CodexPlanState["reported"];
  switch: CodexPlanState["switch"];
};

const notes: Record<string, string> = {
  not_connected: "Connect this Agent to see its Codex mode.",
  closed: "This Agent is closed.",
  no_thread: "This Agent has no Codex session yet.",
  old_protocol: "This Agent's Codex has no collaboration modes, so no Plan mode.",
  harness: "Plan mode here is Codex's own.",
};
const names: Record<string, string> = { plan: "Plan mode", default: "Default mode" };
const modeName = (mode: string) => names[mode] ?? `the mode “${mode}”`;

/** What Codex last reported, in words; null when it has not. */
function reportedText(reported: PlanView["reported"]) {
  if (!reported) return null;
  const when = reported.source === "resume" ? "when it resumed this conversation" : "after its settings last changed";
  return `Codex reports ${modeName(reported.mode)}, ${when}.`;
}

function switchText(change: NonNullable<PlanView["switch"]>) {
  const to = modeName(change.to);
  if (change.state === "sending") return `Switching to ${to}…`;
  if (change.state === "accepted") return `Codex accepted the switch to ${to} and has not reported its mode since.`;
  return `No answer came back for the switch to ${to}. Codex may have switched: Refresh, or reconnect, to see what it reports. It is not sent again.`;
}

/**
 * `/plan` (T-29): this Codex Agent's own collaboration mode, as Codex's CLI
 * switches it (Plan or Default). It is read when this opens and on Refresh
 * only, on the connection the Agent already has. Opening it starts nothing,
 * and changes nothing. A switch is the user's click, between turns. It
 * changes the mode only: no message, no turn, and the model, effort,
 * permissions, folder and draft stay as they are. The mode shown is what
 * Codex reported; an experimental part of Codex 0.162.1, asked per
 * connection.
 */
export function CodexPlanDialog({ agent, open, turnRunning, onOpenChange, onChanged }: {
  agent: Agent;
  open: boolean;
  /** A turn is running or waiting: Codex's CLI switches only between turns. */
  turnRunning: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (notice: string) => void;
}) {
  const [view, setView] = useState<PlanView | null>(null);
  const [reading, setReading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Read on opening, on Refresh, and after a switch with no answer.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setView(null);
    api<PlanView>(`/agents/${encodeURIComponent(agent.id)}/codex/plan`, { signal: controller.signal })
      .then(setView, (e) => {
        if (!controller.signal.aborted) setView({ state: "failed", reason: errorText(e), generation: null, modes: [], reported: null, switch: null });
      });
    return () => controller.abort();
  }, [open, agent.id, reading]);

  async function change(mode: Mode) {
    if (busy || !view?.generation) return;
    setBusy(true);
    setError("");
    try {
      const answer = await post<PlanView>(`/agents/${encodeURIComponent(agent.id)}/codex/plan`, { mode, generation: view.generation });
      setView(answer);
      const confirmed = answer.reported?.mode === mode && !answer.switch;
      onChanged(mode === "plan"
        ? `Codex ${confirmed ? "switched to" : "accepted"} Plan mode. Your next message starts the planning; Codex's questions show as they always do.`
        : `Codex ${confirmed ? "switched back to" : "accepted"} Default mode. The plan stays in this conversation; nothing was sent to carry it out.`);
    } catch (e) {
      // Core's answer says what happened; no answer leaves it unknown. The
      // mode is read again either way, and nothing is sent again.
      setError(e instanceof HttpError ? errorText(e)
        : `No answer came back (${errorText(e)}). Codex may have switched: shown below as Codex now reports it.`);
      setReading((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const reported = view?.reported?.mode;
  const offered = (mode: Mode) => !!view && view.state === "ready" && view.modes.includes(mode) && reported !== mode;
  return (
    <Modal open={open} onOpenChange={(next) => !busy && onOpenChange(next)} title="Codex mode"
      description={`${agent.name}'s own Codex mode for this conversation. Opening this changes nothing.`}>
      <div className="create-form remote-create">
        {!view ? (
          <p role="status"><LoaderCircle size={14} className="spin" /> Reading the mode…</p>
        ) : view.state !== "ready" ? (
          <p role="status" className="remote-field-note">{notes[view.reason] ?? `Codex could not list its modes: ${view.reason}`}</p>
        ) : (
          <section className="session-preview" aria-label="Current mode">
            <div className="session-preview-heading">
              <span><ListChecks size={14} /> {reported ? modeName(reported) : "Not reported yet"}</span>
              <button type="button" className="quiet-button" disabled={busy} onClick={() => setReading((n) => n + 1)}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
            <p className="session-preview-excerpt">
              {reportedText(view.reported) ?? "Codex has not reported this conversation's mode on this connection yet."}
            </p>
            {view.switch && <p className="session-preview-model" role="status">{switchText(view.switch)}</p>}
            {!view.modes.includes("plan") && <p className="session-preview-model">This Agent's Codex lists no Plan mode.</p>}
          </section>
        )}
        {view?.state === "ready" && (
          <p className="remote-field-note">
            Plan mode is Codex's own, an experimental part of this Codex: Codex plans, and asks you what it needs, before it changes
            files. Switching sends nothing to the model; your next message starts the planning. The model, effort, permissions,
            folder and your draft stay as they are. Leaving Plan mode only switches back: it does not ask Codex to carry out the plan.
            {turnRunning && " Switch once this turn has ended, as Codex's CLI does."}
          </p>
        )}
        {error && <p role="alert" className="remote-field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>Close</button>
          {offered("default") && (
            <button type="button" className="secondary-button" disabled={busy || turnRunning} onClick={() => void change("default")}>
              {reported === "plan" ? "Leave Plan mode" : "Switch to Default mode"}
            </button>
          )}
          {offered("plan") && (
            <button type="button" className="primary-button" disabled={busy || turnRunning} onClick={() => void change("plan")}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <ListChecks size={15} />} Switch to Plan mode
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The composer's sign that Codex reports Plan mode for this conversation,
 * or has accepted a switch to it; it opens `/plan`. Nothing when Codex
 * reports another mode, or nothing at all.
 */
export function CodexPlanChip({ state, onOpen }: { state: CodexPlanState | undefined; onOpen: () => void }) {
  const reported = state?.reported?.mode === "plan";
  const switching = state?.switch?.to === "plan";
  if (!reported && !switching) return null;
  const title = reported
    ? "Codex reports Plan mode: it plans, and asks what it needs, before it changes files · open /plan"
    : "A switch to Plan mode that Codex has not reported yet · open /plan";
  return (
    <button type="button" className="composer-tool composer-mode" data-unconfirmed={reported ? undefined : ""} title={title} onClick={onOpen}>
      <ListChecks size={14} /> {reported ? "Plan mode" : "Plan mode?"}
    </button>
  );
}
