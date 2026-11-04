import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import { api, post, errorText } from "./api";
import { Modal } from "./components";
import { RestoreDialog } from "./ClaudeCheckpoint";
import type { Agent, NativeTurn } from "./types";
import "./rewind.css";

type Outcome = { attemptId: string; status: "sending" | "unknown" | "failed" | "completed" | "resolved"; message?: string; draft: string };
type Preview = { available: boolean; reason?: string; previewId?: string; removedTurns?: number; keptTurns?: number; draft?: string; attempt?: Outcome; fileUserMessageId?: string };

/** No native history/checkpoint reads until the user opens this turn's action. */
export function RewindButton({ agent, turn, onDraft }: { agent: Agent; turn: NativeTurn; onDraft?: (agentId: string, text: string) => void }) {
  const [open, setOpen] = useState(false);
  const openRevert = useContext(RevertHost);
  const blocked = !!agent.closedAt || ["working", "waiting"].includes(agent.status) || turn.status === "inProgress";
  const opencode = agent.harness === "opencode";
  // OpenCode's revert is held by the Agent's own host, not by this turn, which it removes.
  if (opencode && !openRevert) return null;
  return <>
    <button type="button" className="quiet-button rewind-open" disabled={blocked || !onDraft}
      title={blocked ? "Finish the active turn and pending answers before rewinding"
        : opencode ? "Preview reverting to before this turn, with its files" : "Preview going back to before this turn"}
      onClick={() => opencode ? openRevert?.(agent.id, turn.id) : setOpen(true)}><RotateCcw size={12} />Rewind</button>
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
/** One Agent's revert as this window holds it: the turn asked about, its preview, its outcome. */
type Revert = { turnId?: string; preview?: RevertPreview; outcome?: RevertOutcome; error?: string; busy?: boolean; open: boolean };

const unsettled = (outcome?: RevertOutcome) => !!outcome && ["sending", "unknown"].includes(outcome.status);

/**
 * Each OpenCode Agent's revert, kept outside any component (Lead 4128): an
 * answer that comes after its turn left, the host was mounted again or
 * another Agent was shown still settles the Agent it is for.
 */
const reverts = new Map<string, Revert>();
const listeners = new Set<() => void>();
let version = 0;
function put(agentId: string, change: Partial<Revert> | undefined) {
  if (change) reverts.set(agentId, { ...(reverts.get(agentId) ?? { open: false }), ...change });
  else reverts.delete(agentId);
  version++;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** Where a kept revert's text goes: the mounted host's, last given. */
let giveDraft: ((agentId: string, text: string) => void) | undefined;

// The attempts whose text went back to a draft, so none goes back twice: for
// this window, and across reloads (the draft itself is kept as drafts are).
const GIVEN = "yuzuno.revert.given.v1";
function given(attemptId: string): boolean {
  try { return (JSON.parse(localStorage.getItem(GIVEN) ?? "[]") as string[]).includes(attemptId); } catch { return false; }
}
function markGiven(attemptId: string) {
  let ids: string[] = [];
  try { ids = JSON.parse(localStorage.getItem(GIVEN) ?? "[]") as string[]; } catch { ids = []; }
  try { localStorage.setItem(GIVEN, JSON.stringify([...ids.filter(id => id !== attemptId), attemptId].slice(-50))); } catch { /* kept for this window only */ }
}
const givenHere = new Set<string>();

function settle(agentId: string, value: RevertOutcome) {
  // Only a revert OpenCode keeps gives the original text back, once, to the Agent it is for.
  if (value.status === "completed" && value.draft && !givenHere.has(value.attemptId) && !given(value.attemptId)) {
    givenHere.add(value.attemptId); markGiven(value.attemptId);
    giveDraft?.(agentId, value.draft);
  }
  put(agentId, { outcome: value, preview: undefined, busy: false });
}

async function preview(agentId: string, turnId: string) {
  put(agentId, { turnId, preview: undefined, outcome: undefined, error: "", busy: true, open: true });
  try {
    const value = await post<RevertPreview>(`/agents/${encodeURIComponent(agentId)}/rewind/preview`, { turnId });
    if (reverts.get(agentId)?.turnId === turnId) put(agentId, { preview: value, busy: false });
  } catch (e) {
    if (reverts.get(agentId)?.turnId === turnId) put(agentId, { error: errorText(e), busy: false });
  }
}

async function act(agentId: string, action: "confirm" | "check") {
  const revert = reverts.get(agentId);
  if (!revert || revert.busy) return;
  const attemptId = action === "check" ? revert.outcome?.attemptId : revert.preview?.previewId;
  if (!attemptId) return;
  put(agentId, { busy: true, error: "" });
  try {
    settle(agentId, await post<RevertOutcome>(`/agents/${encodeURIComponent(agentId)}/rewind/${action}`,
      action === "check" ? { attemptId } : { previewId: attemptId }));
  } catch (e) {
    put(agentId, { error: errorText(e), busy: false, preview: undefined,
      outcome: action === "confirm" || !revert.outcome ? { attemptId, status: "unknown", draft: "",
        message: "The request did not return a confirmed result. Check this attempt or reconnect; the revert is not repeated." } : revert.outcome });
  }
}

/** Opens the shown Agent's revert for one of its turns. */
const RevertHost = createContext<((agentId: string, turnId: string) => void) | null>(null);

/**
 * OpenCode's own revert (T-10), held at the Agent's level (Lead 4128): the
 * dialog and its result stay when the reverted turn leaves the conversation,
 * and an outcome not yet confirmed is read again from Core whenever the Agent
 * is shown, so its check is never lost with a window, a reload or another
 * Agent. Reading it asks OpenCode nothing; it is only ever checked.
 */
export function OpenCodeRevertHost({ agent, onDraft, children }: { agent?: Agent; onDraft?: (agentId: string, text: string) => void; children: ReactNode }) {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { giveDraft = onDraft; }, [onDraft]);
  const id = agent?.harness === "opencode" ? agent.id : undefined;
  useEffect(() => {
    if (!id) return;
    let live = true;
    void api<{ attempt: RevertOutcome | null }>(`/agents/${encodeURIComponent(id)}/rewind/attempt`).then(({ attempt }) => {
      const held = reverts.get(id);
      if (live && attempt && unsettled(attempt) && !held?.busy && held?.outcome?.attemptId !== attempt.attemptId) put(id, { outcome: attempt, preview: undefined });
    }).catch(() => { /* shown again on the next check */ });
    return () => { live = false; };
  }, [id]);
  const open = useCallback((agentId: string, turnId: string) => {
    // One not yet confirmed is shown again, never asked about anew.
    if (unsettled(reverts.get(agentId)?.outcome)) put(agentId, { open: true });
    else void preview(agentId, turnId);
  }, []);
  const revert = id ? reverts.get(id) : undefined;
  const close = () => { if (!id) return; if (unsettled(revert?.outcome)) put(id, { open: false }); else put(id, undefined); };
  return <RevertHost.Provider value={id && onDraft ? open : null}>
    {children}
    {id && revert && !revert.open && unsettled(revert.outcome) && <div className="revert-dock" role="status">
      <span>OpenCode’s revert is not yet confirmed: new messages to {agent?.name} wait.</span>
      <button type="button" className="secondary-button" onClick={() => put(id, { open: true })}>Check outcome</button>
    </div>}
    {id && revert?.open && <RevertDialog revert={revert} onConfirm={() => void act(id, "confirm")} onCheck={() => void act(id, "check")} onClose={close} />}
  </RevertHost.Provider>;
}

function stateText(state: FileState) {
  return state.state === "absent" ? "no file" : `${state.size} bytes${state.executable ? ", executable" : ""}`;
}

function fileOutcomeText(file: FileOutcome) {
  if (file.outcome === "verified") return "as OpenCode’s snapshot holds it";
  if (file.outcome === "notRestored") return "still as before: OpenCode did not send it back";
  // A read that failed says nothing of its content.
  return file.why ? `could not be checked: ${file.why}` : "neither as before nor as the snapshot holds it";
}

function RevertDialog({ revert, onConfirm, onCheck, onClose }: { revert: Revert; onConfirm: () => void; onCheck: () => void; onClose: () => void }) {
  const { preview, outcome, error, busy } = revert;
  const files = preview?.files ?? [];
  return <Modal open confirm onOpenChange={next => !next && !busy && onClose()} title="Revert"
    description="Go back to before this turn, in OpenCode’s conversation and in the files its changes touched.">
    <div className="rewind-dialog">
      {busy && <p role="status"><LoaderCircle size={14} className="spin" /> {outcome ? "Checking with OpenCode…" : preview ? "Reverting…" : "Reading OpenCode’s session and snapshots…"}</p>}
      {preview && !outcome && <>
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
        {outcome.files.map(file => <li key={file.path}><code>{file.path}</code>: {fileOutcomeText(file)}</li>)}
      </ul>}
      {unsettled(outcome) && <p>New messages to this Agent wait until the outcome is confirmed. The revert is never asked for again.</p>}
      <p className="rewind-note">Only files OpenCode’s snapshots recorded go back. Commands, submitted Jobs, PRs and approvals are not undone. Yuzuno keeps the removed history and execution records.</p>
      {error && <p role="alert" className="checkpoint-problem">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
        {unsettled(outcome) && <button type="button" className="primary-button" disabled={busy} onClick={onCheck}>Check outcome</button>}
        {preview?.previewId && !outcome && <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>Revert</button>}
      </div>
    </div>
  </Modal>;
}
