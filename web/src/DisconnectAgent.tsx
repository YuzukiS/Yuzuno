import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Unplug } from "lucide-react";
import { Modal } from "./components";
import { disconnectAgent, errorText } from "./api";
import { langTag, strings, useLanguage } from "./i18n";
import type { Agent } from "./types";
import "./recovery.css";

// The confirmation's own words (T-189); names of the Agent, its harness and
// its machine, and Core's refusal, as they came.
const text = strings({
  title: (name: string) => `Disconnect ${name}?`,
  description: "Nothing changes until you confirm.",
  stops: (harness: string, machine: string | null) => `This stops the agent’s ${harness} session on ${machine || "this computer"}. The agent stays open:`,
  kept: "its conversation, settings, permissions, tasks and your drafts are kept;",
  jobs: "Jobs it started keep running, and their results wait for it;",
  nothing: "nothing starts it again, not new mail, a message you send or automatic continue, until you press Reconnect, which opens the same session. Messages that waited are then delivered.",
  idle: "It is disconnected only if Core can confirm it is idle: no turn, request, unconfirmed message or background work. Otherwise nothing changes, and you are told why. To end the agent instead, use Close.",
  remote: (machine: string, harness: string) => `${machine} is asked to stop ${harness} there and to say once it has. If it can’t say so, you are told, and the agent stays disconnected until you press Reconnect.`,
  cancel: "Cancel",
  close: "Close dialog",
  disconnecting: "Disconnecting…",
  disconnect: "Disconnect",
}, {
  title: (name) => `断开 ${name} 的连接？`,
  description: "在你确认之前，不会有任何改变。",
  stops: (harness, machine) => `这会停止此 Agent 在${machine ? ` ${machine} ` : "此电脑"}上的 ${harness} 会话。此 Agent 仍保持打开：`,
  kept: "它的会话、设置、权限、任务和你的草稿都会保留；",
  jobs: "它启动的 Job 会继续运行，结果会等待它；",
  nothing: "在你按下“重新连接”之前，没有任何东西会再次启动它，包括新邮件、你发送的消息或自动继续；重新连接会打开同一会话，之后再递送等待中的消息。",
  idle: "只有在 Core 能确认它处于空闲状态（没有 Turn、请求、未确认的消息或后台工作）时才会断开连接。否则不会有任何改变，并会告诉你原因。如果要结束此 Agent，请改用“关闭”。",
  remote: (machine, harness) => `会请求 ${machine} 停止那里的 ${harness}，并在完成后告知。如果它无法告知，你会得到通知，此 Agent 会保持断开状态，直到你按下“重新连接”。`,
  cancel: "取消",
  close: "关闭对话框",
  disconnecting: "正在断开连接…",
  disconnect: "断开连接",
});

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
  const language = useLanguage();
  const t = text(language);
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
      title={t.title(agent.name)}
      description={t.description}
      lang={langTag(language)}
      closeLabel={t.close}
    >
      <div className="end-missing-dialog disconnect-dialog">
        <p>{t.stops(harness, machine ?? null)}</p>
        <ul>
          <li>{t.kept}</li>
          <li>{t.jobs}</li>
          <li>{t.nothing}</li>
        </ul>
        <p>{t.idle}</p>
        {machine && <p>{t.remote(machine, harness)}</p>}
        {error && (
          <p role="alert" className="recovery-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={() => onOpenChange(false)}>
            {t.cancel}
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Unplug size={15} />}
            {busy ? t.disconnecting : t.disconnect}
          </button>
        </div>
      </div>
    </Modal>
  );
}
