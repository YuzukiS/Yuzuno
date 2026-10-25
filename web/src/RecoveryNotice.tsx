import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleStop, LoaderCircle, RotateCw } from "lucide-react";
import { errorText, reconnectAgent } from "./api";
import { nativeSession } from "./machine-checks";
import type { AgentDetail } from "./types";
import "./recovery.css";

/**
 * Why an Agent offers a reconnect before it can go on: "disconnected" when
 * the user disconnected it (T-184) and only their Reconnect starts it, "running" when its
 * last Turn was still running when the connection ended (a Core restart, for
 * example), "uncertain" when the result is unknown, and "offline" when its
 * session is simply not connected, its last Turn ended (T-184). Null when it
 * is connected, there is nothing to reconnect to, or another notice already
 * offers a reconnect (a writer conflict, an unconfirmed message) or the
 * remote controls do.
 */
export function recoveryReason(detail: AgentDetail): "disconnected" | "running" | "uncertain" | "offline" | "collaboration" | "missing" | null {
  const agent = detail.agent;
  if (agent.closedAt) return null;
  if (agent.disconnectedAt) return "disconnected";
  if (detail.collaboration?.ready === false) return "collaboration";
  if (agent.remote) return null;
  if (!nativeSession(agent)) return null;
  // A check found Turns Codex's own history doesn't have (T-198): no
  // reconnect can confirm them; only ending them lets the Agent go on.
  if (agent.harness !== "claude" && detail.codexHandoff?.missingTurns && agent.connectionState !== "connected")
    return "missing";
  if (agent.harness !== "claude" && detail.codexHandoff?.writerConflictAt)
    return null;
  if (detail.messageReceipts?.some((r) => r.status === "sending" || r.status === "uncertain"))
    return null;
  if (agent.status === "uncertain" || agent.connectionState === "unconfirmed") return "uncertain";
  if (agent.connectionState === "connected") return null;
  if ((detail.conversation?.index || detail.turns).some((turn) => turn.status === "inProgress")) return "running";
  if (agent.connectionState === "disconnected" || agent.connectionState === "connecting" || agent.status === "offline")
    return "offline";
  return null;
}

/** Reconnects to the same native session so Core can check what really
 * happened, or, offline, opens it again. Nothing is sent again and the draft
 * stays where it is; what the Agent is then doing is what Core reports. */
export function RecoveryNotice({
  detail,
  disabled,
  hasDraft,
  onRecovered,
  onEndMissing,
}: {
  detail: AgentDetail;
  disabled: boolean;
  hasDraft: boolean;
  onRecovered: () => void;
  /** Opens the confirmation that ends Turns missing from the native history. */
  onEndMissing?: () => void;
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
        {reason === "missing" ? (
          <>
            Codex’s own history doesn’t have the turn Yuzuno recorded as still running, so reconnecting can’t confirm
            it. You can end it as interrupted, result unknown, and go on in the same session; nothing is sent again.
          </>
        ) : reason === "disconnected" ? (
          <>
            You disconnected this agent
            {detail.agent.disconnectedAt ? ` on ${new Date(detail.agent.disconnectedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}.
            {detail.agent.disconnectUnconfirmed
              ? ` ${detail.agent.remote?.machine.name || "Its machine"} didn’t confirm that Claude stopped there, so it may still be running; Yuzuno treats it as disconnected.`
              : ""}
            {" "}Nothing starts it again, not new mail, a message or automatic continue, and messages for it wait. Reconnect
            to open the same session; waiting messages are then delivered.
          </>
        ) : reason === "offline" ? (
          <>This agent’s session isn’t connected. Reconnect to open the same session; nothing is sent.</>
        ) : (
          <>
            {reason === "collaboration"
              ? detail.collaboration?.error || "The workspace collaboration connection isn’t confirmed. New messages are paused; the current turn and approvals remain available."
              : reason === "running"
                ? "The last turn was still running when this agent’s connection ended, so its result isn’t confirmed."
                : "The previous result isn’t confirmed yet."}{" "}
            Reconnect to check it in the same session; nothing is sent again.
          </>
        )}
        {hasDraft ? " Your draft is kept." : ""}
      </span>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || connecting}
        onClick={() => void reconnect()}
      >
        {connecting ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
        {connecting ? "Reconnecting…" : error ? "Try again" : reason === "offline" || reason === "disconnected" ? "Reconnect" : "Reconnect and check"}
      </button>
      {reason === "missing" && onEndMissing && (
        <button type="button" className="primary-button" disabled={disabled || connecting} onClick={onEndMissing}>
          <CircleStop size={14} />
          End turn…
        </button>
      )}
      {error && (
        <p role="alert" className="recovery-error">
          Couldn’t reconnect: {error}
        </p>
      )}
    </div>
  );
}
