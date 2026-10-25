import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Unplug } from "lucide-react";
import { Modal } from "./components";
import { disconnectAgent, errorText } from "./api";
import type { Agent } from "./types";
import "./recovery.css";

/**
 * Disconnecting an Agent (T-184): its native session on this computer, or on
 * its SSH machine once that machine confirms it, stops, and nothing starts
 * it until the user reconnects it. An SSH machine that can't confirm the
 * stop leaves it held as disconnected, and Core answers with an error.
 * Unlike Close the Agent stays open, with its conversation, settings, tasks
 * and drafts, and its Jobs go on. Core disconnects it only if it can confirm
 * the Agent is idle; otherwise it says why and nothing changes. Nothing
 * happens until the user confirms here.
 */
export function DisconnectAgentDialog({
  agent,
  open,
  onOpenChange,
  onDone,
}: {
  agent: Agent | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentId = agent?.id ?? "";
  // A result for another Agent must not land on this one.
  const current = useRef(agentId);
  useEffect(() => {
    current.current = agentId;
    setBusy(false);
    setError("");
  }, [agentId, open]);
  if (!agent) return null;
  const harness = agent.harness === "claude" ? "Claude Code" : "Codex";
  const machine = agent.remote?.machine.name;
  async function confirm() {
    if (busy || !agent) return;
    const target = agent.id;
    setBusy(true);
    setError("");
    try {
      await disconnectAgent(target);
      if (current.current !== target) return;
      onDone(agent.name);
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
      title={`Disconnect ${agent.name}?`}
      description="Nothing changes until you confirm."
    >
      <div className="end-missing-dialog disconnect-dialog">
        <p>
          This stops the agent’s {harness} session on {machine || "this computer"}. The agent stays open:
        </p>
        <ul>
          <li>its conversation, settings, permissions, tasks and your drafts are kept;</li>
          <li>Jobs it started keep running, and their results wait for it;</li>
          <li>
            nothing starts it again, not new mail, a message you send or automatic continue, until you press Reconnect,
            which opens the same session. Messages that waited are then delivered.
          </li>
        </ul>
        <p>
          It is disconnected only if Core can confirm it is idle: no turn, request, unconfirmed message or background
          work. Otherwise nothing changes, and you are told why. To end the agent instead, use Close.
        </p>
        {machine && (
          <p>
            {machine} is asked to stop {harness} there and to say once it has. If it can’t say so, you are told, and the
            agent stays disconnected until you press Reconnect.
          </p>
        )}
        {error && (
          <p role="alert" className="recovery-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Unplug size={15} />}
            {busy ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
