import { useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, RotateCw } from "lucide-react";
import { errorText, reconnectAgent } from "./api";
import { nativeSession } from "./machine-checks";
import type { AgentDetail } from "./types";
import "./recovery.css";

/**
 * Why an Agent's last result needs checking before it can go on:
 * "running" when its last Turn was still running when the connection ended
 * (a Core restart, for example), "uncertain" when the result is unknown.
 * Null when there is nothing to check, nothing to reconnect to, or another
 * notice already offers a reconnect (a writer conflict, an unconfirmed
 * message) or the remote controls do.
 */
export function recoveryReason(detail: AgentDetail): "running" | "uncertain" | "collaboration" | null {
  const agent = detail.agent;
  if (agent.closedAt) return null;
  if (detail.collaboration?.ready === false) return "collaboration";
  if (agent.remote) return null;
  if (!nativeSession(agent)) return null;
  if (agent.harness !== "claude" && detail.codexHandoff?.writerConflictAt)
    return null;
  if (detail.messageReceipts?.some((r) => r.status === "sending" || r.status === "uncertain"))
    return null;
  if (agent.status === "uncertain" || agent.connectionState === "unconfirmed") return "uncertain";
  if (agent.connectionState === "connected") return null;
  if ((detail.conversation?.index || detail.turns).some((turn) => turn.status === "inProgress")) return "running";
  return null;
}

/** Reconnects to the same native session so Core can check what really
 * happened. Nothing is sent again and the draft stays where it is. */
export function RecoveryNotice({
  detail,
  disabled,
  hasDraft,
  onRecovered,
}: {
  detail: AgentDetail;
  disabled: boolean;
  hasDraft: boolean;
  onRecovered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const agentId = detail.agent.id;
  // A result for another Agent must not land on this one.
  const current = useRef(agentId);
  useEffect(() => {
    current.current = agentId;
    running.current = false;
    setBusy(false);
    setError("");
  }, [agentId]);
  const reason = recoveryReason(detail);
  if (!reason) return null;
  async function reconnect() {
    if (running.current || disabled) return;
    running.current = true;
    const target = agentId;
    setBusy(true);
    setError("");
    try {
      await reconnectAgent(target);
      if (current.current === target) onRecovered();
    } catch (e) {
      if (current.current === target) {
        setError(errorText(e));
        onRecovered();
      }
    } finally {
      if (current.current === target) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const connecting = busy || detail.agent.connectionState === "connecting";
  return (
    <div className="recovery-notice" role="status">
      <CircleAlert size={14} />
      <span>
        {reason === "collaboration"
          ? detail.collaboration?.error || "The workspace collaboration connection isn’t confirmed. New messages are paused; the current turn and approvals remain available."
          : reason === "running"
            ? "The last turn was still running when this agent’s connection ended, so its result isn’t confirmed."
            : "The previous result isn’t confirmed yet."}{" "}
        Reconnect to check it in the same session; nothing is sent again.
        {hasDraft ? " Your draft is kept." : ""}
      </span>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || connecting}
        onClick={() => void reconnect()}
      >
        {connecting ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
        {connecting ? "Reconnecting…" : error ? "Try again" : "Reconnect and check"}
      </button>
      {error && (
        <p role="alert" className="recovery-error">
          Couldn’t reconnect: {error}
        </p>
      )}
    </div>
  );
}
