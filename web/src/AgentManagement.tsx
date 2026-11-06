import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BadgeCheck,
  CheckCheck,
  LoaderCircle,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { api, errorText, post } from "./api";
import { Modal } from "./components";
import { useSurfaceIn } from "./surface";
import { langTag, strings, useLanguage } from "./i18n";
import { agentHarnessName } from "./machine-checks";
import type { Agent } from "./types";
import "./agent-management.css";

export type AgentAction = "close" | "reopen" | "delete" | "release";

// The dialog's own words (T-189); names and Core's errors as they came.
const text = strings({
  reopen: "Reopen agent",
  close: "Close agent",
  reopenTitle: "Reopen this agent and keep its conversation",
  closeTitle: "Close this agent and keep its conversation",
  actions: "Conversation actions",
  closeAsk: (name: string) => `Close ${name}?`,
  deleteAsk: (name: string) => `Delete ${name}?`,
  deleteDescription: "Permanently remove this agent and its conversation from Yuzuno.",
  closeDescription: "Make a little room. You can reopen this agent whenever you need it.",
  actionsDescription: (name: string) => `${name} · Your agent, your workspace.`,
  reopenCard: "Return to your active agents with the same conversation.",
  closeCard: "Stop current work and save the conversation in Closed.",
  deleteCard: "Delete agent…",
  deleteCardNote: "Remove this agent and its Yuzuno history.",
  readNote: "Messages become read when you view the latest conversation.",
  markRead: "Mark all as read",
  interrupted: "The current turn will be interrupted.",
  rest: "Their work has a place to rest.",
  kept: (name: string) => `Conversation history, session, and your draft stay here. Find ${name} under Closed to pick up again.`,
  unconfirmedStop: (harness: string) =>
    `If ${harness} does not confirm the stop, closing ends its connection and marks that turn's result as unknown. Nothing is sent again.`,
  deleteWhat: "This removes the agent, Yuzuno conversation history, and saved draft.",
  stoppedFirst: "Current work will be stopped first. ",
  noUndo: "This cannot be undone in Yuzuno.",
  filesKept: (harness: string) => `Project files and the original ${harness} session remain on their machine.`,
  keep: "Keep agent",
  deleting: "Deleting…",
  closing: "Closing…",
  delete: "Delete agent",
  interruptClose: "Interrupt & close",
  reopening: "Reopening the same session…",
  closeDialog: "Close dialog",
  release: "Release executor",
  releaseCard: "Its work is accepted: close it for good and free its slot.",
  releaseAsk: (name: string) => `Release ${name}?`,
  releaseDescription: "A released executor stays closed: it can't be reopened.",
  releaseWhat: "Its runtime stops and its executor slot is freed.",
  releaseKept: "Its task, dispatch and result stay as they are, so record the acceptance on the task. For new work, dispatch the task again.",
  releasing: "Releasing…",
  releasedDescription: (name: string) => `${name} · Released: this executor stays closed.`,
  archivingCard: "Archiving",
  archivingNote: (reason: string) => `${reason} Releasing again tries now.`,
}, {
  reopen: "重新打开 Agent",
  close: "关闭 Agent",
  reopenTitle: "重新打开此 Agent，并保留其会话",
  closeTitle: "关闭此 Agent，并保留其会话",
  actions: "会话操作",
  closeAsk: (name) => `关闭 ${name}？`,
  deleteAsk: (name) => `删除 ${name}？`,
  deleteDescription: "从 Yuzuno 中永久移除此 Agent 及其会话。",
  closeDescription: "腾出一点空间。需要时可以随时重新打开此 Agent。",
  actionsDescription: (name) => `${name} · 你的 Agent，你的工作区。`,
  reopenCard: "回到活跃的 Agent 中，会话保持不变。",
  closeCard: "停止当前工作，并把会话保存在“已关闭”中。",
  deleteCard: "删除 Agent…",
  deleteCardNote: "移除此 Agent 及其在 Yuzuno 中的历史。",
  readNote: "查看最新的会话时，消息会标为已读。",
  markRead: "全部标为已读",
  interrupted: "当前 Turn 将被中断。",
  rest: "它的工作有了安放之处。",
  kept: (name) => `会话历史、原生会话和你的草稿都会保留。在“已关闭”中找到 ${name} 即可继续。`,
  unconfirmedStop: (harness) => `如果 ${harness} 没有确认停止，关闭会断开它的连接，并把该 Turn 的结果标为未知。不会重新发送任何内容。`,
  deleteWhat: "这会移除此 Agent、它在 Yuzuno 中的会话历史和已保存的草稿。",
  stoppedFirst: "会先停止当前工作。",
  noUndo: "此操作在 Yuzuno 中无法撤销。",
  filesKept: (harness) => `项目文件和原始的 ${harness} 会话仍保留在其所在的机器上。`,
  keep: "保留 Agent",
  deleting: "正在删除…",
  closing: "正在关闭…",
  delete: "删除 Agent",
  interruptClose: "中断并关闭",
  reopening: "正在重新打开同一会话…",
  closeDialog: "关闭对话框",
  release: "放行执行者",
  releaseCard: "工作已验收：永久关闭它，并释放其执行槽位。",
  releaseAsk: (name) => `放行 ${name}？`,
  releaseDescription: "放行后的执行者保持关闭，不能重新打开。",
  releaseWhat: "它的运行时会停止，执行槽位会被释放。",
  releaseKept: "它的任务、派发和结果保持不变，验收请记在任务上。如需新的工作，请重新派发任务。",
  releasing: "正在放行…",
  releasedDescription: (name) => `${name} · 已放行：此执行者保持关闭。`,
  archivingCard: "归档中",
  archivingNote: (reason) => `${reason} 再次放行会立即重试。`,
});

export function AgentManagement({
  agent,
  disabled,
  onOpenChange,
  onChanged,
  onRead,
  requestReopen = null,
  requestActions = null,
  actionsButton = true,
  projectControl,
}: {
  agent: Agent;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (action: AgentAction, agent?: Agent) => void;
  onRead: () => Promise<void>;
  requestReopen?: { agentId: string; sequence: number } | null;
  /** Opens these actions, from the Agent's action menu ("Manage…", T-184). */
  requestActions?: { agentId: string; sequence: number } | null;
  /** Its own "…" button; off where the Agent's action menu takes its place. */
  actionsButton?: boolean;
  /** Where this agent is listed; offered for open and closed agents alike. */
  projectControl?: React.ReactNode;
}) {
  const [mode, setMode] = useState<"actions" | "close" | "delete" | "release" | null>(null);
  // Actions → close or delete swaps the content in place (T-19 ST:AG2): the
  // confirmation fades in over small and Cancel takes focus, as the card that
  // had it is gone. Opened on its own, it comes in with the dialog.
  const [swaps, setSwaps] = useState(0);
  const confirmStep = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  useSurfaceIn(confirmStep, swaps, "small", swaps > 0);
  useLayoutEffect(() => {
    if (swaps) keepButton.current?.focus();
  }, [swaps]);
  const [busy, setBusy] = useState<AgentAction | "read" | null>(null);
  const [error, setError] = useState("");
  const working = agent.status === "working" || agent.status === "waiting";
  // A released executor stays closed (T-34): nothing reopens it.
  const released = !!agent.releasedAt;
  const releasable = agent.kind === "executor" && !released;
  // Released already, it waits for its work to end (T-36 S3): what it waits for.
  const archiving = agent.executor?.state === "archiving" ? agent.executor.reason || "" : null;
  const confirming = mode === "close" || mode === "delete" || mode === "release";
  const language = useLanguage();
  const t = text(language);
  function show(next: typeof mode) {
    if (busy) return;
    setError("");
    if (mode === "actions" && next !== "actions" && next) setSwaps((n) => n + 1);
    setMode(next);
    onOpenChange(!!next);
  }
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  useEffect(() => {
    if (requestReopen?.agentId === agent.id) void act("reopen");
  }, [requestReopen]);
  useEffect(() => {
    if (requestActions?.agentId === agent.id) show("actions");
  }, [requestActions]);
  async function act(action: AgentAction) {
    if (busy || disabled) return;
    setBusy(action);
    setError("");
    try {
      const path = `/agents/${encodeURIComponent(agent.id)}`;
      const updated =
        action === "delete"
          ? await api<undefined>(path, { method: "DELETE" })
          : action === "release"
            ? await post<Pick<Agent, "closedAt" | "releasedAt" | "releasedBy"> & { archiving?: { since: string; reason: string } | null }>(`${path}/release`)
              // Waiting for its work to end, it is archiving (T-36 S3), with what it waits for.
              .then(({ closedAt, releasedAt, releasedBy, archiving }) => ({ ...agent, closedAt, releasedAt, releasedBy,
                // From the answer even when the listing had none (#647 R1 333f9680).
                executor: archiving ? { ...(agent.executor ?? {}), agentId: agent.id, state: "archiving" as const, since: archiving.since, reason: archiving.reason }
                  : agent.executor }))
            : await post<Agent>(`${path}/${action}`);
      onChanged(action, updated);
      setMode(null);
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
      setMode(action === "reopen" ? "actions" : action);
      onOpenChange(true);
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {!released && <button
        type="button"
        className="conversation-action agent-close-button"
        disabled={disabled || !!busy}
        aria-label={agent.closedAt ? t.reopen : t.close}
        aria-haspopup={agent.closedAt ? undefined : "dialog"}
        title={agent.closedAt ? t.reopenTitle : t.closeTitle}
        onClick={() => (agent.closedAt ? void act("reopen") : show("close"))}
      >
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : agent.closedAt ? (
          <ArchiveRestore size={16} />
        ) : (
          <Archive size={16} />
        )}
      </button>}
      {actionsButton && (
        <button
          type="button"
          className="conversation-action"
          aria-label={t.actions}
          title={t.actions}
          aria-haspopup="dialog"
          aria-expanded={!!mode}
          disabled={!!busy}
          onClick={() => show("actions")}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      <Modal
        open={!!mode}
        confirm={confirming}
        onOpenChange={(open) => !open && show(null)}
        title={
          mode === "close"
            ? t.closeAsk(agent.name)
            : mode === "delete"
              ? t.deleteAsk(agent.name)
              : mode === "release"
                ? t.releaseAsk(agent.name)
                : t.actions
        }
        description={
          mode === "delete"
            ? t.deleteDescription
            : mode === "close"
              ? t.closeDescription
              : mode === "release"
                ? t.releaseDescription
                : released
                  ? t.releasedDescription(agent.name)
                  : t.actionsDescription(agent.name)
        }
        lang={langTag(language)}
        closeLabel={t.closeDialog}
      >
        {mode === "actions" ? (
          <div className="agent-action-list">
            {!released && <button
              className="agent-action-card"
              disabled={disabled || !!busy}
              onClick={() =>
                agent.closedAt ? void act("reopen") : show("close")
              }
            >
              {agent.closedAt ? (
                <ArchiveRestore size={20} />
              ) : (
                <Archive size={20} />
              )}
              <span>
                <strong>
                  {agent.closedAt ? t.reopen : t.close}
                </strong>
                <small>
                  {agent.closedAt ? t.reopenCard : t.closeCard}
                </small>
              </span>
            </button>}
            {releasable && (
              <button
                className="agent-action-card"
                disabled={disabled || !!busy}
                onClick={() => show("release")}
              >
                <BadgeCheck size={20} />
                {archiving ? (
                  <span data-archiving>
                    <strong>{t.archivingCard}</strong>
                    <small>{t.archivingNote(archiving)}</small>
                  </span>
                ) : (
                  <span>
                    <strong>{t.release}</strong>
                    <small>{t.releaseCard}</small>
                  </span>
                )}
              </button>
            )}
            {projectControl}
            <button
              className="agent-action-card danger-action"
              disabled={disabled || !!busy}
              onClick={() => show("delete")}
            >
              <Trash2 size={20} />
              <span>
                <strong>{t.deleteCard}</strong>
                <small>{t.deleteCardNote}</small>
              </span>
            </button>
            <div className="agent-read-actions">
              <p>{t.readNote}</p>
              <button
                className="quiet-button"
                disabled={disabled || !!busy || !agent.unreadCount}
                onClick={async () => {
                  setBusy("read");
                  setError("");
                  try {
                    await onRead();
                    setMode(null);
                    onOpenChange(false);
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <CheckCheck size={14} /> {t.markRead}
              </button>
            </div>
          </div>
        ) : (
          <div ref={confirmStep}>
            <div
              className={`agent-action-explanation ${mode === "delete" ? "delete-explanation" : ""}`}
            >
              {mode === "delete" ? <Trash2 size={25} /> : mode === "release" ? <BadgeCheck size={25} /> : <Archive size={25} />}
              <div>
                {mode === "release" ? (
                  <>
                    <strong>{t.releaseWhat}</strong>
                    <p>{t.releaseKept}</p>
                  </>
                ) : mode === "close" ? (
                  <>
                    <strong>
                      {working ? t.interrupted : t.rest}
                    </strong>
                    <p>{t.kept(agent.name)}</p>
                    {working && (agent.harness === "claude" || agent.harness === "opencode") && (
                      <p>{t.unconfirmedStop(agent.harness === "claude" ? "Claude" : "OpenCode")}</p>
                    )}
                  </>
                ) : (
                  <>
                    <strong>{t.deleteWhat}</strong>
                    <p>
                      {!agent.closedAt && working ? t.stoppedFirst : ""}
                      {t.noUndo}
                    </p>
                  </>
                )}
              </div>
            </div>
            <p className="agent-files-kept">{t.filesKept(agentHarnessName(agent))}</p>
            <div className="modal-actions">
              <button
                ref={keepButton}
                type="button"
                className="secondary-button"
                disabled={!!busy}
                onClick={() => show(null)}
              >
                {t.keep}
              </button>
              <button
                type="button"
                className={
                  mode === "delete" ? "danger-button" : "primary-button"
                }
                disabled={disabled || !!busy}
                onClick={() => void act(mode === "delete" ? "delete" : mode === "release" ? "release" : "close")}
              >
                {busy && <LoaderCircle size={15} className="spin" />}
                {busy
                  ? mode === "delete"
                    ? t.deleting
                    : mode === "release"
                      ? t.releasing
                      : t.closing
                  : mode === "delete"
                    ? t.delete
                    : mode === "release"
                      ? t.release
                      : working
                        ? t.interruptClose
                        : t.close}
              </button>
            </div>
          </div>
        )}
        {busy === "reopen" && (
          <p role="status" className="agent-files-kept">
            {t.reopening}
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
