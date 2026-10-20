import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CircleAlert,
  Folder,
  GitFork,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { errorText, post } from "./api";
import { Modal } from "./components";
import { permissionLabel } from "./CodexPermissions";
import type { Agent, AgentDetail, ForkOutcome, ForkPreview } from "./types";
import "./session-import.css";
import "./codex-fork.css";

// One request ID per source and boundary, kept across reloads, so a retry
// after a lost response settles the same attempt instead of forking again.
const storageKey = "yuzuno.codexForkRequests";
function requests(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
function saveRequests(value: Record<string, string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* The in-memory attempt still applies for this page. */
  }
}

/** Explains another client's ownership, or where the session continues. */
export function CodexWriterNotice({
  detail,
  agents,
  disabled,
  onReconnect,
  onFork,
  onOpen,
}: {
  detail: AgentDetail;
  agents: Agent[];
  disabled: boolean;
  onReconnect: () => Promise<void>;
  onFork: () => void;
  onOpen: (agentId: string) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const handoff = detail.codexHandoff;
  const forkedTo = handoff?.forkedTo;
  // A closed continuation still exists; a deleted one no longer continues
  // anything, so the conflict and its explicit fork are offered again.
  const target =
    forkedTo && agents.find((agent) => agent.id === forkedTo.agentId);
  if (forkedTo && target) {
    return (
      <div className="codex-writer-notice is-continued" role="status">
        <GitFork size={14} />
        <span>
          This conversation continues in <strong>{target.name}</strong>
          {target.closedAt ? " (closed)" : ""}, from a Codex fork of its first{" "}
          {forkedTo.turnCount} {forkedTo.turnCount === 1 ? "turn" : "turns"}.
          This session was not changed.
        </span>
        <button
          type="button"
          className="inline-link"
          onClick={() => onOpen(target.id)}
        >
          Open
          <ArrowUpRight size={12} />
        </button>
      </div>
    );
  }
  if (!handoff?.writerConflictAt || detail.agent.connectionState === "connected")
    return null;
  return (
    <div className="codex-writer-notice" role="status">
      <CircleAlert size={14} />
      <span>
        Another Codex client still owns this session, even if its turn has
        finished, so it can’t continue here. Release it in that client and try
        again, or continue from an official Codex fork.
      </span>
      <span className="codex-writer-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || retrying}
          onClick={() => {
            setRetrying(true);
            void onReconnect().finally(() => setRetrying(false));
          }}
        >
          {retrying ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Try again
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={disabled}
          onClick={onFork}
        >
          <GitFork size={14} />
          Continue in a fork…
        </button>
      </span>
    </div>
  );
}

/** One explicit fork. Cancel changes nothing; only Fork and continue writes. */
export function ForkCodexDialog({
  agent,
  open,
  projectLabel,
  onOpenChange,
  onForked,
}: {
  agent: Agent;
  open: boolean;
  projectLabel: (projectId: string | null) => string;
  onOpenChange: (open: boolean) => void;
  onForked: (outcome: ForkOutcome) => void;
}) {
  const [preview, setPreview] = useState<ForkPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(agent.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<ForkOutcome | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (!open) return;
    let valid = true;
    setPreview(null);
    setOutcome(null);
    setError("");
    setName(agent.name);
    setLoading(true);
    post<ForkPreview>(
      `/agents/${encodeURIComponent(agent.id)}/codex/fork/preview`,
    )
      .then((result) => valid && setPreview(result))
      .catch((e) => valid && setError(errorText(e)))
      .finally(() => valid && setLoading(false));
    return () => {
      valid = false;
    };
  }, [open, agent.id]);

  const through = preview?.throughTurnId;
  const uncertain = outcome?.state === "uncertain";
  async function fork() {
    if (running.current || !through || !name.trim()) return;
    running.current = true;
    setBusy(true);
    setError("");
    const key = `${agent.id}:${through}`;
    const saved = requests();
    // Forking again after an unconfirmed result is the user's explicit
    // choice: a new attempt that gives the old one up. Nothing else is new.
    const abandonUnconfirmed = uncertain;
    const requestId =
      (!abandonUnconfirmed && saved[key]) || crypto.randomUUID();
    saveRequests({ ...saved, [key]: requestId });
    try {
      const result = await post<ForkOutcome>(
        `/agents/${encodeURIComponent(agent.id)}/codex/fork`,
        {
          requestId,
          throughTurnId: through,
          name: name.trim(),
          ...(abandonUnconfirmed ? { abandonUnconfirmed } : {}),
        },
      );
      const current = requests();
      if (result.state === "uncertain") {
        // A retry reports this same attempt; it is never repeated by itself.
        saveRequests({ ...current, [key]: result.requestId });
        setOutcome(result);
      } else {
        delete current[key];
        saveRequests(current);
        if (result.state === "completed" && result.agent) {
          onForked(result);
          onOpenChange(false);
        } else setOutcome(result);
      }
    } catch (e) {
      // The request may have reached Core; keep its ID for the next try.
      setError(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title="Continue in a Codex fork"
      description="Creates a new native Codex session and a new agent from this conversation’s history through its latest completed turn. Nothing happens until you confirm."
    >
      <form
        className="session-import create-form codex-fork-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void fork();
        }}
      >
        {loading && (
          <p role="status" className="remote-field-note">
            <LoaderCircle size={14} className="spin" /> Reading this session’s
            history…
          </p>
        )}
        {preview && (
          <>
            <section className="session-preview" aria-label="Fork preview">
              <div className="session-preview-heading">
                <span>
                  <GitFork size={14} /> Copies {preview.includedTurns}{" "}
                  {preview.includedTurns === 1 ? "turn" : "turns"}
                </span>
                {preview.excludedTurns > 0 && (
                  <span>{preview.excludedTurns} later not included</span>
                )}
              </div>
              <p className="session-preview-excerpt">
                {preview.throughCompletedAt
                  ? `History up to and including the latest completed turn, completed ${new Date(preview.throughCompletedAt * 1000).toLocaleString()}.`
                  : "History up to and including the latest completed turn."}
              </p>
              <div className="session-preview-folder">
                <Folder size={14} />
                <span>{preview.cwd}</span>
              </div>
              <p className="session-preview-model">
                {preview.model}
                {preview.reasoningEffort
                  ? ` · ${preview.reasoningEffort} reasoning`
                  : ""}
                {" · "}
                {permissionLabel(preview.permissionPreset) ||
                  "Current permissions"}
                {preview.projectId
                  ? ` · ${projectLabel(preview.projectId)}`
                  : ""}
              </p>
            </section>
            {preview.warnings.length > 0 && (
              <div className="session-import-warnings" role="status">
                {preview.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            )}
            <fieldset
              className="remote-form-fields"
              disabled={busy || !through}
            >
              <label>
                Agent name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={60}
                />
              </label>
            </fieldset>
            <p className="session-handoff-note">
              This creates a <strong>new native session</strong> and a{" "}
              <strong>new agent</strong> with this folder, model, reasoning and
              permissions. The original session, its client and this entry stay
              open; nothing is closed for you.
              {preview.excludedTurns > 0 &&
                " Later turns (running, interrupted or failed) stay with the original session."}{" "}
              Live sub-agents and the other client’s tools don’t carry over.
              Your unsent draft is copied to the new agent’s message box (unless
              it already has one); nothing is sent.
            </p>
          </>
        )}
        {outcome && (
          <p role="alert" className="remote-field-error">
            {uncertain
              ? "The fork result isn’t confirmed yet. "
              : "The fork didn’t complete. "}
            {outcome.message}
          </p>
        )}
        {error && (
          <p role="alert" className="remote-field-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || loading || !through || !name.trim()}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <GitFork size={15} />
            )}
            {busy
              ? "Forking…"
              : uncertain
                ? "Fork again anyway"
                : outcome
                  ? "Try again"
                  : "Fork and continue"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
