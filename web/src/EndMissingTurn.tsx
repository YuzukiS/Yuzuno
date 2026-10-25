import { useEffect, useRef, useState } from "react";
import { CircleStop, LoaderCircle } from "lucide-react";
import { Modal } from "./components";
import { endMissingTurns, errorText } from "./api";
import type { AgentDetail } from "./types";
import "./recovery.css";

/**
 * Ending the Turns a check found missing from Codex's own history (T-198).
 * Codex never saved them, after a power cut for one, so no reconnect can
 * say what they did. Ending them is the user's decision: each becomes
 * interrupted with its result unknown, in the same session. Nothing is sent
 * again, and nothing the Turn may have done is undone or called not done.
 * Nothing changes until the user confirms here.
 */
export function EndMissingTurnDialog({
  detail,
  open,
  onOpenChange,
  onEnded,
}: {
  detail: AgentDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentId = detail.agent.id;
  // A result for another Agent must not land on this one.
  const current = useRef(agentId);
  useEffect(() => {
    current.current = agentId;
    setBusy(false);
    setError("");
  }, [agentId, open]);
  const missing = detail.codexHandoff?.missingTurns;
  if (!missing) return null;
  const count = missing.turnIds.length;
  const running = missing.nativeStatus === "active";
  const checked = new Date(missing.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  async function end() {
    if (busy || !missing) return;
    const target = agentId;
    setBusy(true);
    setError("");
    try {
      await endMissingTurns(target, missing);
      if (current.current !== target) return;
      onEnded();
      onOpenChange(false);
    } catch (e) {
      if (current.current === target) setError(errorText(e));
    } finally {
      if (current.current === target) setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={count === 1 ? "End the unconfirmed turn?" : `End ${count} unconfirmed turns?`}
      description="Only you can decide this. Nothing changes until you confirm."
    >
      <div className="end-missing-dialog">
        <p>
          Codex’s own history doesn’t have {count === 1 ? "the turn" : `${count} turns`} Yuzuno recorded as still
          running. Codex probably never saved {count === 1 ? "it" : "them"}, for example after a power cut, so
          reconnecting can’t tell what {count === 1 ? "it" : "they"} did. Checked {checked}.
        </p>
        <p>If you end {count === 1 ? "it" : "them"} here:</p>
        <ul>
          <li>{count === 1 ? "it’s" : "they’re"} marked interrupted, with the result unknown;</li>
          <li>this agent goes on in the same Codex session, with its history, permissions and tasks;</li>
          <li>
            nothing is sent again, and anything already done, such as commands or file changes, isn’t undone. Check
            your work if it matters.
          </li>
        </ul>
        {running && (
          <p role="alert" className="recovery-error">
            When it was checked, Codex said this session was running a turn. Let it finish or stop it in Codex, then
            reconnect and check again.
          </p>
        )}
        {error && (
          <p role="alert" className="recovery-error">
            Couldn’t end it: {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy || running} onClick={() => void end()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <CircleStop size={15} />}
            {busy ? "Ending…" : "End as interrupted"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
