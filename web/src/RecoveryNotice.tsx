import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleStop, LoaderCircle, RotateCw } from "lucide-react";
import { errorText, reconnectAgent } from "./api";
import { nativeSession } from "./machine-checks";
import { langTag, strings, useLanguage } from "./i18n";
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

// The notice's own words (T-189); names, dates and Core's errors as they came.
const text = strings({
  missing: "Codex’s own history doesn’t have the turn Yuzuno recorded as still running, so reconnecting can’t confirm it. You can end it as interrupted, result unknown, and go on in the same session; nothing is sent again.",
  disconnected: (when: string | null, unconfirmed: string) =>
    `You disconnected this agent${when ? ` on ${when}` : ""}.${unconfirmed ? ` ${unconfirmed}` : ""} Nothing starts it again, not new mail, a message or automatic continue, and messages for it wait. Reconnect to open the same session; waiting messages are then delivered.`,
  unconfirmed: (machine: string | null, harness: string) =>
    `${machine || "Its machine"} didn’t confirm that ${harness} stopped there, so it may still be running; Yuzuno treats it as disconnected.`,
  offline: "This agent’s session isn’t connected. Reconnect to open the same session; nothing is sent.",
  collaboration: "The workspace collaboration connection isn’t confirmed. New messages are paused; the current turn and approvals remain available.",
  running: "The last turn was still running when this agent’s connection ended, so its result isn’t confirmed.",
  uncertain: "The previous result isn’t confirmed yet.",
  check: " Reconnect to check it in the same session; nothing is sent again.",
  draftKept: " Your draft is kept.",
  reconnecting: "Reconnecting…",
  tryAgain: "Try again",
  reconnect: "Reconnect",
  reconnectCheck: "Reconnect and check",
  endTurn: "End turn…",
  failed: (error: string) => `Couldn’t reconnect: ${error}`,
}, {
  missing: "Codex 自己的历史中没有 Yuzuno 记录为仍在运行的那个 Turn，因此重新连接无法确认它。你可以把它结束为“已中断，结果未知”，然后在同一会话中继续；不会重新发送任何内容。",
  disconnected: (when, unconfirmed) =>
    `你${when ? `在 ${when} ` : ""}断开了此 Agent 的连接。${unconfirmed}不会有任何东西再启动它，包括新邮件、消息或自动继续，发给它的消息会等待。重新连接即可打开同一会话，等待的消息随后会送达。`,
  unconfirmed: (machine, harness) => `${machine || "它所在的机器"}没有确认 ${harness} 已在那里停止，因此它可能仍在运行；Yuzuno 将其视为已断开。`,
  offline: "此 Agent 的会话未连接。重新连接即可打开同一会话；不会发送任何内容。",
  collaboration: "工作区协作连接尚未确认。新消息已暂停；当前 Turn 和审批仍可使用。",
  running: "此 Agent 的连接结束时，上一个 Turn 仍在运行，因此其结果尚未确认。",
  uncertain: "上一个结果尚未确认。",
  check: "重新连接即可在同一会话中核对；不会重新发送任何内容。",
  draftKept: "你的草稿会保留。",
  reconnecting: "正在重新连接…",
  tryAgain: "重试",
  reconnect: "重新连接",
  reconnectCheck: "重新连接并核对",
  endTurn: "结束 Turn…",
  failed: (error) => `无法重新连接：${error}`,
});

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
  const language = useLanguage();
  const t = text(language);
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
    <div className="recovery-notice" role="status" lang={langTag(language)}>
      <CircleAlert size={14} />
      <span>
        {reason === "missing" ? (
          t.missing
        ) : reason === "disconnected" ? (
          t.disconnected(
            detail.agent.disconnectedAt
              ? new Date(detail.agent.disconnectedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
              : null,
            detail.agent.disconnectUnconfirmed
              ? t.unconfirmed(detail.agent.remote?.machine.name || null, detail.agent.harness === "codex" ? "Codex" : "Claude Code")
              : "",
          )
        ) : reason === "offline" ? (
          t.offline
        ) : (
          <>
            {reason === "collaboration"
              ? detail.collaboration?.error || t.collaboration
              : reason === "running"
                ? t.running
                : t.uncertain}
            {t.check}
          </>
        )}
        {hasDraft ? t.draftKept : ""}
      </span>
      <button
        type="button"
        className="secondary-button"
        disabled={disabled || connecting}
        onClick={() => void reconnect()}
      >
        {connecting ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
        {connecting ? t.reconnecting : error ? t.tryAgain : reason === "offline" || reason === "disconnected" ? t.reconnect : t.reconnectCheck}
      </button>
      {reason === "missing" && onEndMissing && (
        <button type="button" className="primary-button" disabled={disabled || connecting} onClick={onEndMissing}>
          <CircleStop size={14} />
          {t.endTurn}
        </button>
      )}
      {error && (
        <p role="alert" className="recovery-error">
          {t.failed(error)}
        </p>
      )}
    </div>
  );
}
