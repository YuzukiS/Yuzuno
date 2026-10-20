import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CheckCheck,
  LoaderCircle,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import { api, errorText, post } from "./api";
import { Modal } from "./components";
import type { Agent } from "./types";
import "./agent-management.css";

export type AgentAction = "close" | "reopen" | "delete";

export function AgentManagement({
  agent,
  disabled,
  onOpenChange,
  onChanged,
  onRead,
  requestReopen = null,
  projectControl,
}: {
  agent: Agent;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (action: AgentAction, agent?: Agent) => void;
  onRead: () => Promise<void>;
  requestReopen?: { agentId: string; sequence: number } | null;
  /** Where this agent is listed; offered for open and closed agents alike. */
  projectControl?: React.ReactNode;
}) {
  const [mode, setMode] = useState<"actions" | "close" | "delete" | null>(null);
  const [busy, setBusy] = useState<AgentAction | "read" | null>(null);
  const [error, setError] = useState("");
  const working = agent.status === "working" || agent.status === "waiting";
  function show(next: typeof mode) {
    if (busy) return;
    setError("");
    setMode(next);
    onOpenChange(!!next);
  }
  useEffect(() => () => onOpenChange(false), [onOpenChange]);
  useEffect(() => {
    if (requestReopen?.agentId === agent.id) void act("reopen");
  }, [requestReopen]);
  async function act(action: AgentAction) {
    if (busy || disabled) return;
    setBusy(action);
    setError("");
    try {
      const path = `/agents/${encodeURIComponent(agent.id)}`;
      const updated =
        action === "delete"
          ? await api<undefined>(path, { method: "DELETE" })
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
      <button
        type="button"
        className="conversation-action agent-close-button"
        disabled={disabled || !!busy}
        aria-label={agent.closedAt ? "Reopen agent" : "Close agent"}
        aria-haspopup={agent.closedAt ? undefined : "dialog"}
        title={
          agent.closedAt
            ? "Reopen this agent and keep its conversation"
            : "Close this agent and keep its conversation"
        }
        onClick={() => (agent.closedAt ? void act("reopen") : show("close"))}
      >
        {busy ? (
          <LoaderCircle size={16} className="spin" />
        ) : agent.closedAt ? (
          <ArchiveRestore size={16} />
        ) : (
          <Archive size={16} />
        )}
      </button>
      <button
        type="button"
        className="conversation-action"
        aria-label="Conversation actions"
        title="Conversation actions"
        aria-haspopup="dialog"
        aria-expanded={!!mode}
        disabled={!!busy}
        onClick={() => show("actions")}
      >
        <MoreHorizontal size={16} />
      </button>
      <Modal
        open={!!mode}
        onOpenChange={(open) => !open && show(null)}
        title={
          mode === "close"
            ? `Close ${agent.name}?`
            : mode === "delete"
              ? `Delete ${agent.name}?`
              : "Conversation actions"
        }
        description={
          mode === "delete"
            ? "Permanently remove this agent and its conversation from Yuzuno."
            : mode === "close"
              ? "Make a little room. You can reopen this agent whenever you need it."
              : `${agent.name} · Your agent, your workspace.`
        }
      >
        {mode === "actions" ? (
          <div className="agent-action-list">
            <button
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
                  {agent.closedAt ? "Reopen agent" : "Close agent"}
                </strong>
                <small>
                  {agent.closedAt
                    ? "Return to your active agents with the same conversation."
                    : "Stop current work and save the conversation in Closed."}
                </small>
              </span>
            </button>
            {projectControl}
            <button
              className="agent-action-card danger-action"
              disabled={disabled || !!busy}
              onClick={() => show("delete")}
            >
              <Trash2 size={20} />
              <span>
                <strong>Delete agent…</strong>
                <small>Remove this agent and its Yuzuno history.</small>
              </span>
            </button>
            <div className="agent-read-actions">
              <p>Messages become read when you view the latest conversation.</p>
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
                <CheckCheck size={14} /> Mark all as read
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className={`agent-action-explanation ${mode === "delete" ? "delete-explanation" : ""}`}
            >
              {mode === "delete" ? <Trash2 size={25} /> : <Archive size={25} />}
              <div>
                {mode === "close" ? (
                  <>
                    <strong>
                      {working
                        ? "The current turn will be interrupted."
                        : "Their work has a place to rest."}
                    </strong>
                    <p>
                      Conversation history, session, and your draft stay here.
                      Find {agent.name} under Closed to pick up again.
                    </p>
                    {working && agent.harness === "claude" && (
                      <p>
                        If Claude does not confirm the stop, closing ends its
                        connection and marks that turn's result as unknown.
                        Nothing is sent again.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <strong>
                      This removes the agent, Yuzuno conversation history, and
                      saved draft.
                    </strong>
                    <p>
                      {!agent.closedAt && working
                        ? "Current work will be stopped first. "
                        : ""}
                      This cannot be undone in Yuzuno.
                    </p>
                  </>
                )}
              </div>
            </div>
            <p className="agent-files-kept">
              Project files and the original{" "}
              {agent.harness === "claude" ? "Claude Code" : "Codex"} session
              remain on their machine.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={!!busy}
                onClick={() => show(null)}
              >
                Keep agent
              </button>
              <button
                type="button"
                className={
                  mode === "delete" ? "danger-button" : "primary-button"
                }
                disabled={disabled || !!busy}
                onClick={() => void act(mode === "delete" ? "delete" : "close")}
              >
                {busy && <LoaderCircle size={15} className="spin" />}
                {busy
                  ? mode === "delete"
                    ? "Deleting…"
                    : "Closing…"
                  : mode === "delete"
                    ? "Delete agent"
                    : working
                      ? "Interrupt & close"
                      : "Close agent"}
              </button>
            </div>
          </>
        )}
        {busy === "reopen" && (
          <p role="status" className="agent-files-kept">
            Reopening the same session…
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
