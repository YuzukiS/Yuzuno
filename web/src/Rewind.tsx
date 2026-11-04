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
/** One Agent's revert as this window holds it, in one Workspace: the turn asked about, its preview, its outcome. */
type Revert = { workspace: string; agent: string; turnId?: string; preview?: RevertPreview; outcome?: RevertOutcome; error?: string;
  busy?: boolean; open: boolean; undelivered?: boolean; version: number };

const unsettled = (outcome?: RevertOutcome) => !!outcome && ["sending", "unknown"].includes(outcome.status);
const keyOf = (workspace: string, agent: string) => JSON.stringify([workspace, agent]);

/**
 * Each OpenCode Agent's revert, by Workspace and Agent, kept outside any
 * component (Lead 4128, 4133): an answer that comes after its turn left, the
 * host was mounted again, another Agent or another Workspace was shown still
 * settles the one it is for, and only that one. `version` counts what was
 * done to it here, so that a read begun before is not let undo it.
 */
const reverts = new Map<string, Revert>();
const listeners = new Set<() => void>();
let changes = 0;
function put(key: string, change: Partial<Revert> | undefined, base?: Pick<Revert, "workspace" | "agent">) {
  const held = reverts.get(key);
  if (change === undefined) reverts.delete(key);
  else if (held || base) reverts.set(key, { ...(held ?? { ...base!, open: false, version: 0 }), ...change });
  changes++;
  for (const listener of listeners) listener();
}
/** A step the user took: what was read before it no longer applies. */
const step = (key: string, change: Partial<Revert>, base: Pick<Revert, "workspace" | "agent">) =>
  put(key, { ...change, version: (reverts.get(key)?.version ?? 0) + 1 }, base);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The Workspace the page shows now: no request goes out for, nor an answer is taken into, another. */
let shownWorkspace = "";
/**
 * Where each Workspace's kept revert texts go: its host's draft, while it
 * shows that Workspace. It adds a text once per `origin`, saved with the
 * draft in the same write, and says whether the draft was saved.
 */
type Deliverer = (agentId: string, text: string, origin: string) => boolean;
const deliverers = new Map<string, Deliverer>();

// The attempts asked for here, until seen through: settled, closed, and their
// text given if kept. So one that settles while the page is away is found
// again by its ID (Lead 4133).
const ASKED = "yuzuno.revert.asked.v1";
type Asked = { workspace: string; agent: string; attemptId: string };
function asked(): Asked[] {
  try { const list = JSON.parse(localStorage.getItem(ASKED) ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}
function remember(entry: Asked) {
  const list = asked().filter(e => !(e.workspace === entry.workspace && e.attemptId === entry.attemptId));
  try { localStorage.setItem(ASKED, JSON.stringify([...list, entry].slice(-20))); } catch { /* found again only while this window lives */ }
}
function forget(workspace: string, attemptId: string) {
  try { localStorage.setItem(ASKED, JSON.stringify(asked().filter(e => !(e.workspace === workspace && e.attemptId === attemptId)))); } catch { /* left to find */ }
}

// The attempts whose text went back to a draft, so none goes back twice: for
// this window, and across reloads (the draft itself is kept as drafts are).
const GIVEN = "yuzuno.revert.given.v1";
const givenHere = new Set<string>();
function given(workspace: string, attemptId: string): boolean {
  const id = JSON.stringify([workspace, attemptId]);
  if (givenHere.has(id)) return true;
  try { return (JSON.parse(localStorage.getItem(GIVEN) ?? "[]") as string[]).includes(id); } catch { return false; }
}
function markGiven(workspace: string, attemptId: string) {
  const id = JSON.stringify([workspace, attemptId]);
  givenHere.add(id);
  let ids: string[] = [];
  try { ids = JSON.parse(localStorage.getItem(GIVEN) ?? "[]") as string[]; } catch { ids = []; }
  try { localStorage.setItem(GIVEN, JSON.stringify([...ids.filter(other => other !== id), id].slice(-50))); } catch { /* given in this window only */ }
}

/**
 * A kept revert's text to its Agent's draft, once (Lead 4133): only through
 * the host of the Workspace it is for, only while the page shows that
 * Workspace, and counted as given only once the draft took it and saved it.
 * Otherwise it is left to give, and the next time that Agent is shown again
 * (or Add to draft) tries once more. Never over a draft it could not read.
 */
function deliver(key: string) {
  const revert = reverts.get(key);
  const outcome = revert?.outcome;
  if (!revert || outcome?.status !== "completed" || !outcome.draft) return;
  if (given(revert.workspace, outcome.attemptId)) { put(key, { undelivered: false }); return; }
  const to = deliverers.get(revert.workspace);
  let saved = false;
  if (to && revert.workspace === shownWorkspace) {
    // Added once, by its origin, in the same write as the draft: a retry saves that one, never adds a second.
    try { saved = to(revert.agent, outcome.draft, `opencode-revert:${outcome.attemptId}`); } catch { saved = false; }
  }
  if (saved) markGiven(revert.workspace, outcome.attemptId);
  put(key, { undelivered: !saved });
}

/** An answer taken: a step too, so that no read begun before it undoes it (Lead 4139). */
function settle(key: string, value: RevertOutcome) {
  put(key, { outcome: value, preview: undefined, busy: false, version: (reverts.get(key)?.version ?? 0) + 1 });
  deliver(key);
}

async function preview(key: string, workspace: string, agent: string, turnId: string) {
  step(key, { turnId, preview: undefined, outcome: undefined, error: "", busy: true, open: true, undelivered: false }, { workspace, agent });
  const version = reverts.get(key)!.version;
  const current = () => workspace === shownWorkspace && reverts.get(key)?.version === version;
  // A preview whose Workspace is no longer shown when it comes is dropped, and nothing of it left waiting (Lead 4139).
  const left = () => workspace !== shownWorkspace && reverts.get(key)?.version === version;
  try {
    const value = await post<RevertPreview>(`/agents/${encodeURIComponent(agent)}/rewind/preview`, { turnId });
    if (current()) put(key, { preview: value, busy: false });
    else if (left()) put(key, undefined);
  } catch (e) {
    if (current()) put(key, { error: errorText(e), busy: false });
    else if (left()) put(key, undefined);
  }
}

async function act(key: string, action: "confirm" | "check") {
  const revert = reverts.get(key);
  if (!revert || revert.busy || revert.workspace !== shownWorkspace) return;
  const attemptId = action === "check" ? revert.outcome?.attemptId : revert.preview?.previewId;
  if (!attemptId) return;
  // Kept before it is asked, so it is found again however this page ends.
  if (action === "confirm") remember({ workspace: revert.workspace, agent: revert.agent, attemptId });
  step(key, { busy: true, error: "" }, revert);
  // An answer for another Workspace than the one shown when it comes is not taken: its attempt is found again there.
  const ours = () => revert.workspace === shownWorkspace;
  try {
    const value = await post<RevertOutcome>(`/agents/${encodeURIComponent(revert.agent)}/rewind/${action}`,
      action === "check" ? { attemptId } : { previewId: attemptId });
    if (ours()) settle(key, value); else put(key, { busy: false });
  } catch (e) {
    if (!ours()) { put(key, { busy: false }); return; }
    put(key, { error: errorText(e), busy: false, preview: undefined,
      outcome: action === "confirm" || !revert.outcome ? { attemptId, status: "unknown", draft: "",
        message: "The request did not return a confirmed result. Check this attempt or reconnect; the revert is not repeated." } : revert.outcome });
  }
}

/**
 * What Core keeps of this Agent's reverts, read whenever it is shown: the one
 * not yet known, and each one asked for here and not yet seen through, by its
 * ID, whatever it became meanwhile. Reading asks OpenCode nothing. A read
 * that comes after anything was done here is not taken (`version`).
 */
async function recover(key: string, workspace: string, agent: string) {
  const version = reverts.get(key)?.version ?? 0;
  const base = { workspace, agent };
  const read = (query: string) => api<{ attempt: RevertOutcome | null }>(`/agents/${encodeURIComponent(agent)}/rewind/attempt${query}`);
  const mine = asked().filter(e => e.workspace === workspace && e.agent === agent);
  try {
    const [pending, ...ours] = await Promise.all([read(""), ...mine.map(e => read(`?id=${encodeURIComponent(e.attemptId)}`))]);
    if (workspace !== shownWorkspace || (reverts.get(key)?.version ?? 0) !== version || reverts.get(key)?.busy) return;
    mine.forEach((entry, i) => { if (!ours[i].attempt) forget(workspace, entry.attemptId); });
    // One not yet known first: it holds the Agent back. Else the latest asked here that is not seen through.
    const found = pending.attempt ?? ours.map(o => o.attempt).filter((a): a is RevertOutcome => !!a).at(-1);
    if (!found) return;
    // A settled outcome is never taken back to one not yet known.
    const held = reverts.get(key)?.outcome;
    if (held?.attemptId === found.attemptId && !unsettled(held) && unsettled(found)) return;
    if (reverts.get(key)?.outcome?.attemptId === found.attemptId && reverts.get(key)?.outcome?.status === found.status) { deliver(key); return; }
    put(key, { outcome: found, preview: undefined, turnId: undefined }, base);
    deliver(key);
  } catch { /* read again the next time it is shown */ }
}

/** Opens the shown Agent's revert for one of its turns. */
const RevertHost = createContext<((agentId: string, turnId: string) => void) | null>(null);

/**
 * OpenCode's own revert (T-10), held at the Agent's level (Lead 4128, 4133):
 * the dialog and its result stay when the reverted turn leaves the
 * conversation, and what Core keeps of it is read again whenever the Agent
 * is shown, so its check, or its result and text, are never lost with a
 * window, a reload, another Agent or another Workspace. It is only ever
 * checked, never confirmed again or resolved.
 */
export function OpenCodeRevertHost({ workspaceId, agent, onDraft, children }: { workspaceId: string; agent?: Agent;
  onDraft?: Deliverer; children: ReactNode }) {
  useSyncExternalStore(subscribe, () => changes);
  const id = agent?.harness === "opencode" && workspaceId ? agent.id : undefined;
  const key = id ? keyOf(workspaceId, id) : undefined;
  useEffect(() => {
    shownWorkspace = workspaceId;
    if (!workspaceId || !onDraft) return;
    deliverers.set(workspaceId, onDraft);
    return () => { if (deliverers.get(workspaceId) === onDraft) deliverers.delete(workspaceId); };
  }, [workspaceId, onDraft]);
  useEffect(() => { if (key && id) void recover(key, workspaceId, id); }, [key, id, workspaceId]);
  const open = useCallback((agentId: string, turnId: string) => {
    const at = keyOf(workspaceId, agentId);
    const held = reverts.get(at);
    // One not yet seen through is shown again, never asked about anew.
    if (held?.outcome && (unsettled(held.outcome) || held.undelivered)) step(at, { open: true }, held);
    else void preview(at, workspaceId, agentId, turnId);
  }, [workspaceId]);
  const revert = key ? reverts.get(key) : undefined;
  const close = () => {
    if (!key || !revert) return;
    if (unsettled(revert.outcome) || revert.undelivered) { step(key, { open: false }, revert); return; }
    if (revert.outcome) forget(revert.workspace, revert.outcome.attemptId);
    put(key, undefined);
  };
  // Closed with something still to see through: one not yet known, a text not yet given, or an outcome found again.
  const waiting = !!revert && !revert.open && !!revert.outcome;
  return <RevertHost.Provider value={id && onDraft ? open : null}>
    {children}
    {key && revert && waiting && revert.outcome && <div className="revert-dock" role="status">
      <span>{unsettled(revert.outcome) ? `OpenCode’s revert is not yet confirmed: new messages to ${agent?.name} wait.`
        : revert.undelivered ? "OpenCode’s revert was kept; its original text is not yet in the draft."
        : "OpenCode’s revert has an outcome you have not seen yet."}</span>
      <button type="button" className="secondary-button" onClick={() => step(key, { open: true }, revert)}>{unsettled(revert.outcome) ? "Check outcome" : "Show outcome"}</button>
    </div>}
    {key && revert?.open && <RevertDialog revert={revert} onConfirm={() => void act(key, "confirm")} onCheck={() => void act(key, "check")}
      onDeliver={() => deliver(key)} onClose={close} />}
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

function RevertDialog({ revert, onConfirm, onCheck, onDeliver, onClose }: { revert: Revert; onConfirm: () => void; onCheck: () => void; onDeliver: () => void; onClose: () => void }) {
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
      {revert.undelivered && <p role="alert">The original text could not be added to the draft (the draft cannot be edited or saved here now). It is kept for you to add.</p>}
      <p className="rewind-note">Only files OpenCode’s snapshots recorded go back. Commands, submitted Jobs, PRs and approvals are not undone. Yuzuno keeps the removed history and execution records.</p>
      {error && <p role="alert" className="checkpoint-problem">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
        {unsettled(outcome) && <button type="button" className="primary-button" disabled={busy} onClick={onCheck}>Check outcome</button>}
        {revert.undelivered && <button type="button" className="secondary-button" disabled={busy} onClick={onDeliver}>Add to draft</button>}
        {preview?.previewId && !outcome && <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>Revert</button>}
      </div>
    </div>
  </Modal>;
}
