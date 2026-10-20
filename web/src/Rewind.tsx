import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { post, errorText } from "./api";
import { Modal } from "./components";
import { RestoreDialog } from "./ClaudeCheckpoint";
import type { Agent, NativeTurn } from "./types";
import "./rewind.css";

type Outcome = { attemptId: string; status: "sending" | "unknown" | "failed" | "completed" | "resolved"; message?: string; draft: string };
type Preview = { available: boolean; reason?: string; previewId?: string; removedTurns?: number; keptTurns?: number; draft?: string; attempt?: Outcome; fileUserMessageId?: string };

/** No native history/checkpoint reads until the user opens this turn's action. */
export function RewindButton({ agent, turn, onDraft }: { agent: Agent; turn: NativeTurn; onDraft?: (agentId: string, text: string) => void }) {
  const [open, setOpen] = useState(false);
  const blocked = !!agent.closedAt || ["working", "waiting"].includes(agent.status) || turn.status === "inProgress";
  return <>
    <button type="button" className="quiet-button rewind-open" disabled={blocked || !onDraft}
      title={blocked ? "Finish the active turn and pending answers before rewinding" : "Preview going back to before this turn"}
      onClick={() => setOpen(true)}><RotateCcw size={12} />Rewind</button>
    {open && <RewindDialog agent={agent} turn={turn} onDraft={onDraft} onClose={() => setOpen(false)} />}
  </>;
}

function RewindDialog({ agent, turn, onDraft, onClose }: { agent: Agent; turn: NativeTurn; onDraft?: (agentId: string, text: string) => void; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [files, setFiles] = useState(false);
  const pending = useRef(false);
  const copied = useRef(false);
  const base = `/agents/${encodeURIComponent(agent.id)}/rewind`;
  const firstUser = turn.items.find(item => item.type === "userMessage");
  const nativeUuid = firstUser?.nativeUuid ?? preview?.fileUserMessageId;
  const restoreAvailable = agent.harness === "claude" && !agent.remote && !!nativeUuid && !firstUser?._yuzunoDelivery;
  useEffect(() => {
    let live = true;
    void post<Preview>(`${base}/preview`, { turnId: turn.id }).then(value => {
      if (live) { setPreview(value); setOutcome(value.attempt); }
    }).catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [base, turn.id]);
  const run = async (action: "confirm" | "check" | "resolve") => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    const attemptId = action !== "confirm" ? outcome?.attemptId : preview?.previewId;
    if (!attemptId) { pending.current = false; setBusy(false); return; }
    const preserveDraft = (draft: string) => {
      // The async callback survives the selected turn leaving the virtualized
      // view. Do not append anything when admission definitively refuses.
      if (!copied.current && draft) { copied.current = true; onDraft?.(agent.id, draft); }
    };
    try {
      const value = await post<Outcome>(`${base}/${action}`, action !== "confirm" ? { attemptId } : { previewId: attemptId });
      if (action === "confirm" && ["completed", "unknown", "sending"].includes(value.status)) preserveDraft(value.draft);
      setOutcome(value); setPreview(undefined);
      if (value.status === "completed") onClose();
    } catch (e) {
      setError(errorText(e));
      if (action === "confirm") {
        preserveDraft(preview?.draft ?? "");
        setPreview(undefined);
        setOutcome({ attemptId, status: "unknown", draft: "", message: "The request did not return a confirmed result. Check this attempt or reconnect; do not repeat the rewind." });
      }
    } finally { pending.current = false; setBusy(false); }
  };
  if (files && nativeUuid) return <RestoreDialog agentId={agent.id} nativeUuid={nativeUuid} onClose={onClose} />;
  return <Modal open onOpenChange={next => !next && !busy && onClose()} title="Rewind"
    description="Go back to before this turn. Conversation history and file changes are separate.">
    <div className="rewind-dialog">
      <h3>Conversation</h3>
      {busy && <p role="status"><LoaderCircle size={14} className="spin" /> Checking native history…</p>}
      {preview?.available && <>
        <p>Remove this turn and {Math.max(0, (preview.removedTurns ?? 1) - 1)} later turns from the native conversation. Keep {preview.keptTurns} earlier turns.</p>
        <p>The original text will be added to your draft for editing. Nothing is sent automatically. Reattach any original images before sending.</p>
        <details><summary>Original input</summary><pre className="rewind-input">{preview.draft}</pre></details>
      </>}
      {preview && !preview.available && <p>{preview.reason}</p>}
      {outcome && <p role="status">{outcome.status === "failed" ? "Rewind did not complete. " : outcome.status === "completed" ? "Conversation rewound. " : outcome.status === "resolved" ? "Current history kept. " : "Rewind is not yet confirmed. "}{outcome.message}</p>}
      {outcome && ["sending", "unknown"].includes(outcome.status) && <div>
        <p>If checking cannot confirm the rewind, you can keep the current native history and allow new messages. This restarts the idle local connection, preserves the attempt record, and never repeats the rewind.</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void run("resolve")}>Keep current history</button>
      </div>}
      <p className="rewind-note">Files, commands, submitted Jobs, PRs and approvals are not undone. Yuzuno retains the removed history and execution records for traceability.</p>
      <h3>Files</h3>
      {restoreAvailable ? <><p>Preview the files covered by Claude Code’s checkpoint. The conversation stays unchanged.</p>
        <button type="button" className="secondary-button" disabled={busy || !!outcome} onClick={() => setFiles(true)}>Preview file restore…</button></> : <p>{agent.harness === "codex" ? "Codex conversation rewind does not restore files." : agent.remote ? "File checkpoint restore is available only on this machine." : "This turn has no confirmed native user-message UUID for a file checkpoint."}</p>}
      {error && <p role="alert" className="checkpoint-problem">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
        {outcome && ["sending", "unknown"].includes(outcome.status) && <button type="button" className="primary-button" disabled={busy} onClick={() => void run("check")}>Check outcome</button>}
        {preview?.available && preview.previewId && !outcome && <button type="button" className="primary-button" disabled={busy} onClick={() => void run("confirm")}>Rewind conversation</button>}
      </div>
    </div>
  </Modal>;
}
