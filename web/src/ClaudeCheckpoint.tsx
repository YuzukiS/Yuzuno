import { useEffect, useRef, useState } from "react";
import { FileClock, LoaderCircle, RotateCcw } from "lucide-react";
import { errorText, post } from "./api";
import { Modal } from "./components";
import type { Agent } from "./types";
import "./claude-checkpoint.css";

type PreviewFile = { path: string; shown: string; exists: boolean };
type Preview = {
  userMessageId: string;
  previewId: string | null;
  expiresInSeconds: number;
  canRewind: boolean | null;
  reason: "notEnabled" | "noCheckpoint" | "unavailable" | null;
  error: string | null;
  files: PreviewFile[];
  truncated: boolean;
  insertions: number | null;
  deletions: number | null;
};
type Outcome =
  | { status: "stale"; reason: string; changed: string[] }
  | {
      status: "restored" | "partial" | "failed" | "unconfirmed";
      files: string[];
      remaining: string[];
      skippedLinks: number | null;
      error: string | null;
      /** Why Claude Code's check after the restore confirmed nothing. */
      checkError?: string | null;
    };

const unavailable: Record<string, string> = {
  notEnabled:
    "File checkpoints aren’t turned on in this Claude Code session, so it has nothing to restore.",
  noCheckpoint:
    "Claude Code has no file checkpoint for this message. Messages sent before this session had checkpoints have none, and Claude Code does not keep one for every message.",
};
const staleReasons: Record<string, string> = {
  files: "These files changed after the preview, so nothing was restored:",
  expired: "The preview is more than 10 minutes old, so nothing was restored.",
  runtime: "Claude Code restarted after the preview, so nothing was restored.",
  session: "The Claude session changed after the preview, so nothing was restored.",
  checkpoint: "Claude Code’s checkpoint changed after the preview, so nothing was restored.",
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** Claude Code's own wording, without its full stop, to place in a sentence. */
const reason = (text: string | null | undefined) => (text || "no reason given").replace(/[.\s]+$/, "");

/** Opens the restore dialog for one of the user's messages to Claude. */
export function ClaudeCheckpointButton({
  agent,
  nativeUuid,
  turnRunning,
}: {
  agent: Agent;
  nativeUuid: string;
  turnRunning: boolean;
}) {
  const [open, setOpen] = useState(false);
  const busy = turnRunning || agent.status === "working" || agent.status === "waiting";
  const closed = !!agent.closedAt;
  return (
    <>
      <button
        type="button"
        className="quiet-button checkpoint-open"
        disabled={busy || closed}
        title={closed ? "This Agent is closed" : busy ? "Files can be restored between turns" : "Preview restoring the files Claude changed after this message"}
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={11} />
        Restore files…
      </button>
      {open && <RestoreDialog agentId={agent.id} nativeUuid={nativeUuid} onClose={() => setOpen(false)} />}
    </>
  );
}

export function RestoreDialog({
  agentId,
  nativeUuid,
  onClose,
}: {
  agentId: string;
  nativeUuid: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"preview" | "restore" | null>("preview");
  const live = useRef(true);
  // One request at a time, whatever the clicks: a second confirmation of
  // the same preview is never sent.
  const pending = useRef(false);
  const base = `/agents/${encodeURIComponent(agentId)}/claude/checkpoints`;
  const run = async <T,>(kind: "preview" | "restore", call: () => Promise<T>, done: (value: T) => void) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(kind);
    setError("");
    try {
      const value = await call();
      if (live.current) done(value);
    } catch (problem) {
      if (live.current) setError(errorText(problem));
    } finally {
      pending.current = false;
      if (live.current) setBusy(null);
    }
  };
  const load = () =>
    run("preview", () => post<Preview>(`${base}/preview`, { userMessageId: nativeUuid }), (value) => {
      setPreview(value);
      setOutcome(null);
    });
  // Core uses a preview up with its one confirmation, whatever the answer.
  const restore = (previewId: string) =>
    run("restore", async () => {
      try {
        return await post<Outcome>(`${base}/restore`, { previewId });
      } finally {
        if (live.current) setPreview(null);
      }
    }, setOutcome);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [base, nativeUuid]);

  const restorable = !outcome && preview?.previewId ? preview : null;
  const files = restorable?.files ?? [];
  return (
    <Modal
      open
      onOpenChange={(next) => !next && busy !== "restore" && onClose()}
      title="Restore files"
      description="Puts back the files Claude changed after this message, from Claude Code’s own checkpoint. The conversation stays as it is. Nothing changes until you confirm."
    >
      <div className="checkpoint-dialog">
        {busy === "preview" && (
          <p role="status" className="checkpoint-note">
            <LoaderCircle size={14} className="spin" /> Asking Claude Code what would change…
          </p>
        )}
        {preview && !outcome && <PreviewView preview={preview} />}
        {outcome && <OutcomeView outcome={outcome} />}
        {error && (
          <p role="alert" className="checkpoint-problem">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy === "restore"} onClick={onClose}>
            {outcome && outcome.status !== "stale" ? "Close" : "Cancel"}
          </button>
          {restorable ? (
            <button
              type="button"
              className="primary-button"
              disabled={!!busy}
              onClick={() => void restore(restorable.previewId!)}
            >
              {busy === "restore" ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}
              {busy === "restore" ? "Restoring…" : `Restore ${plural(files.length, "file")}`}
            </button>
          ) : (
            // Anything but a confirmed restore: see what differs now.
            ((outcome && outcome.status !== "restored") || (error && !busy)) && (
              <button type="button" className="primary-button" disabled={!!busy} onClick={() => void load()}>
                <FileClock size={15} />
                Preview again
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}

function PreviewView({ preview }: { preview: Preview }) {
  if (preview.reason)
    return (
      <p role="status" className="checkpoint-note">
        {unavailable[preview.reason] ?? `Claude Code can’t restore files at this message: ${reason(preview.error)}.`}
      </p>
    );
  if (preview.truncated)
    return (
      <p role="status" className="checkpoint-note">
        Claude Code would change more than {preview.files.length} files. Yuzuno only restores a list it can show in
        full, so nothing will be restored from here.
      </p>
    );
  if (!preview.files.length)
    return (
      <p role="status" className="checkpoint-note">
        Nothing to restore: the files Claude changed after this message already match its checkpoint.
      </p>
    );
  const lines = [
    preview.insertions != null && `+${preview.insertions}`,
    preview.deletions != null && `−${preview.deletions}`,
  ].filter(Boolean);
  return (
    <>
      <section className="checkpoint-preview" aria-label="Files to restore">
        <div className="checkpoint-preview-heading">
          <span>{plural(preview.files.length, "file")} would change</span>
          {lines.length > 0 && <span>{lines.join(" ")} lines</span>}
        </div>
        <ul className="checkpoint-files">
          {preview.files.map((file) => (
            <li key={file.path} title={file.path}>
              <code>{file.shown}</code>
              {!file.exists && <small>missing now · would be put back</small>}
            </li>
          ))}
        </ul>
      </section>
      <div className="checkpoint-limits">
        <p>
          Covers files Claude changed with Write, Edit and NotebookEdit after this message; files Claude created
          then are removed. Changes made by shell commands, sub-agents or anything outside Claude are not part of
          the checkpoint and stay as they are.
        </p>
        <p>
          This preview is valid for {Math.round(preview.expiresInSeconds / 60)} minutes. If any of these files
          changes before you confirm, nothing is restored and you are asked to preview again.
        </p>
      </div>
    </>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  if (outcome.status === "stale")
    return (
      <div role="alert" className="checkpoint-problem">
        <p>{staleReasons[outcome.reason] ?? "Something changed after the preview, so nothing was restored."}</p>
        {outcome.changed.length > 0 && (
          <ul className="checkpoint-files">
            {outcome.changed.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        )}
        <p>Preview again to see what a restore would change now.</p>
      </div>
    );
  const skipped = outcome.skippedLinks
    ? ` Claude Code skipped ${plural(outcome.skippedLinks, "symbolic link")}.`
    : "";
  if (outcome.status === "failed")
    return (
      <p role="alert" className="checkpoint-problem">
        Claude Code didn’t restore the files: {reason(outcome.error)}.
      </p>
    );
  return (
    <div role="status" className={outcome.status === "restored" ? "checkpoint-done" : "checkpoint-problem"}>
      <p>
        {outcome.status === "restored"
          ? `Restored ${plural(outcome.files.length, "file")} to how they were at this message.`
          : outcome.status === "partial"
            ? "Claude Code restored only some of the files. These still differ from the checkpoint:"
            : `Claude Code reported the restore, but its check afterwards didn’t confirm it: ${reason(outcome.checkError)}. These files may or may not be restored; preview again to see what still differs.`}
        {skipped}
      </p>
      <ul className="checkpoint-files">
        {(outcome.status === "partial" ? outcome.remaining : outcome.files).map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
