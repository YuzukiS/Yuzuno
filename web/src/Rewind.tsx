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
  const opencode = agent.harness === "opencode";
  return <>
    <button type="button" className="quiet-button rewind-open" disabled={blocked || !onDraft}
      title={blocked ? "Finish the active turn and pending answers before rewinding"
        : opencode ? "Preview reverting to before this turn, with its files" : "Preview going back to before this turn"}
      onClick={() => setOpen(true)}><RotateCcw size={12} />Rewind</button>
    {open && (opencode
      ? <RevertDialog agent={agent} turn={turn} onDraft={onDraft} onClose={() => setOpen(false)} />
      : <RewindDialog agent={agent} turn={turn} onDraft={onDraft} onClose={() => setOpen(false)} />)}
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
  return <Modal open confirm onOpenChange={next => !next && !busy && onClose()} title="Rewind"
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

type FileState = { state: "absent" } | { state: "file"; size: number; sha256: string; executable: boolean };
type RevertFile = { path: string; expected: FileState; current: FileState };
type RevertPreview = { previewId: string; removedTurns: number; keptTurns: number; draft: string; files: RevertFile[] };
type FileOutcome = { path: string; outcome: "verified" | "notRestored" | "drifted"; why?: string | null };
type RevertOutcome = { attemptId: string; status: "sending" | "unknown" | "failed" | "completed" | "unchanged"; message?: string; draft: string; files?: FileOutcome[] };

function stateText(state: FileState) {
  return state.state === "absent" ? "no file" : `${state.size} bytes${state.executable ? ", executable" : ""}`;
}

const fileOutcomeText: Record<FileOutcome["outcome"], string> = {
  verified: "as OpenCode's snapshot holds it",
  notRestored: "still as before: OpenCode did not send it back",
  drifted: "neither as before nor as the snapshot holds it",
};

/**
 * OpenCode's own revert (T-10): the turn and later ones leave the session,
 * and the files their changes touched go back as OpenCode's snapshots hold
 * them. Core reads it all first, keeps a copy of each file, and asks OpenCode
 * once; an outcome it cannot confirm holds the Agent back, never repeated.
 */
function RevertDialog({ agent, turn, onDraft, onClose }: { agent: Agent; turn: NativeTurn; onDraft?: (agentId: string, text: string) => void; onClose: () => void }) {
  const [preview, setPreview] = useState<RevertPreview>();
  const [outcome, setOutcome] = useState<RevertOutcome>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef(false);
  const copied = useRef(false);
  const base = `/agents/${encodeURIComponent(agent.id)}/rewind`;
  useEffect(() => {
    let live = true;
    void post<RevertPreview>(`${base}/preview`, { turnId: turn.id }).then(value => {
      if (live) setPreview(value);
    }).catch(e => { if (live) setError(errorText(e)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [base, turn.id]);
  const settled = (value: RevertOutcome) => {
    // Only a revert OpenCode keeps gives the original text back, once.
    if (value.status === "completed" && !copied.current && value.draft) { copied.current = true; onDraft?.(agent.id, value.draft); }
    setOutcome(value); setPreview(undefined);
    if (value.status === "completed" && (value.files ?? []).every(file => file.outcome === "verified")) onClose();
  };
  const run = async (action: "confirm" | "check") => {
    if (pending.current) return;
    const attemptId = action === "check" ? outcome?.attemptId : preview?.previewId;
    if (!attemptId) return;
    pending.current = true; setBusy(true); setError("");
    try {
      settled(await post<RevertOutcome>(`${base}/${action}`, action === "check" ? { attemptId } : { previewId: attemptId }));
    } catch (e) {
      setError(errorText(e));
      if (action === "confirm") {
        setPreview(undefined);
        setOutcome({ attemptId, status: "unknown", draft: "", message: "The request did not return a confirmed result. Check this attempt or reconnect; the revert is not repeated." });
      }
    } finally { pending.current = false; setBusy(false); }
  };
  const files = preview?.files ?? [];
  return <Modal open confirm onOpenChange={next => !next && !busy && onClose()} title="Revert"
    description="Go back to before this turn, in OpenCode’s conversation and in the files its changes touched.">
    <div className="rewind-dialog">
      {busy && <p role="status"><LoaderCircle size={14} className="spin" /> Reading OpenCode’s session and snapshots…</p>}
      {preview && <>
        <p>This turn and {Math.max(0, preview.removedTurns - 1)} later turns leave the conversation; {preview.keptTurns} earlier turns stay. OpenCode removes them from its session with the next message it gets.</p>
        {files.length === 0
          ? <p>No file is sent back: no change of these turns went through OpenCode’s snapshots.</p>
          : <>
            <p>{files.length === 1 ? "This file goes" : `These ${files.length} files go`} back as OpenCode’s snapshot holds {files.length === 1 ? "it" : "them"}. Any change made since, by you or another Agent, is overwritten; Core keeps a copy of each first.</p>
            <ul className="revert-files">
              {files.map(file => <li key={file.path}><code>{file.path}</code>: now {stateText(file.current)}, becomes {stateText(file.expected)}</li>)}
            </ul>
          </>}
        <p>Once the revert is confirmed, the original text is added to your draft for editing. Nothing is sent automatically.</p>
        <details><summary>Original input</summary><pre className="rewind-input">{preview.draft}</pre></details>
      </>}
      {outcome && <p role="status">{outcome.status === "completed" ? "Reverted. " : ["failed", "unchanged"].includes(outcome.status) ? "Not reverted. " : "The revert is not yet confirmed. "}{outcome.message}</p>}
      {outcome?.files && outcome.files.length > 0 && <ul className="revert-files">
        {outcome.files.map(file => <li key={file.path}><code>{file.path}</code>: {fileOutcomeText[file.outcome]}{file.why ? ` (${file.why})` : ""}</li>)}
      </ul>}
      {outcome && ["sending", "unknown"].includes(outcome.status) && <p>New messages to this Agent wait until the outcome is confirmed. The revert is never asked for again.</p>}
      <p className="rewind-note">Only files OpenCode’s snapshots recorded go back. Commands, submitted Jobs, PRs and approvals are not undone. Yuzuno keeps the removed history and execution records.</p>
      {error && <p role="alert" className="checkpoint-problem">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
        {outcome && ["sending", "unknown"].includes(outcome.status) && <button type="button" className="primary-button" disabled={busy} onClick={() => void run("check")}>Check outcome</button>}
        {preview?.previewId && !outcome && <button type="button" className="primary-button" disabled={busy} onClick={() => void run("confirm")}>Revert</button>}
      </div>
    </div>
  </Modal>;
}
