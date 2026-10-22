import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileCode2, ListTree, LoaderCircle } from "lucide-react";
import { errorText } from "./api";
import { Modal } from "./components";
import { changesLimits, displayPath, headLines, isEdit, lineKinds, turnChanges, type FileEdit } from "./changes";
import { userText } from "./message-content";
import { loadFullItem } from "./item-payload";
import type { Agent, NativeItem, NativeTurn } from "./types";
import "./codex-changes.css";

const statusLabels: Record<string, string> = { completed: "Applied", failed: "Failed", declined: "Declined", inProgress: "In progress" };
const kindLabels: Record<FileEdit["kind"], string> = { add: "Added", delete: "Deleted", update: "Updated", unknown: "Changed" };
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What an edit was when it was read: a read shows only while the edit is still that. */
const signature = (item: NativeItem) => JSON.stringify([item.status ?? null, item._yuzunoTruncated ?? null, item.changes?.length ?? 0]);

/**
 * `/changes` (T-29): Yuzuno's record of the file edits Codex made in one
 * turn, fixed when this opened: the turn's `fileChange` Items grouped by file,
 * each file's edits in order with their status and kind, as plain text.
 *
 * - It lists files from what the conversation already holds. An edit's full
 *   text is read only when the reader asks, one Item at a time, through the
 *   payload cache the conversation uses. Nothing else of the turn is read.
 * - A read belongs to its Agent, turn and Item, and shows only while the
 *   Item is still what was read. Nothing is read again by itself.
 * - It is not a Git diff of the folder: only Codex's own file edits are
 *   recorded, as it applied them.
 */
export function CodexChangesDialog({ agent, open, turnId, turns, turnNumber, olderNotLoaded, onOpenChange, onFile, onShowEdit }: {
  agent: Agent;
  open: boolean;
  /** The turn chosen when this opened; null when no loaded turn has an edit. */
  turnId: string | null;
  /** The turns whose bodies are loaded here. */
  turns: NativeTurn[];
  turnNumber: number | null;
  /** Earlier turns exist that are not loaded here. */
  olderNotLoaded: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the file as it is now. */
  onFile: (path: string) => void;
  /** Shows the edit in the conversation. */
  onShowEdit: (turnId: string, itemId: string) => void;
}) {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, { item: NativeItem; signature: string }>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const reading = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const turn = turnId ? turns.find((t) => t.id === turnId) : undefined;
  const items = (turn?.items.filter(isEdit) || []).map((item) => {
    const kept = loaded.get(item.id);
    return kept && kept.signature === signature(item) ? kept.item : item;
  });
  const { files, edits, hidden } = turnChanges(items, agent.cwd);

  /** One read per Item at a time; its answer is used only while it is current. */
  function load(item: NativeItem) {
    if (!turnId || reading.current.has(item.id)) return;
    reading.current.add(item.id);
    const read = signature(item);
    setLoading((ids) => new Set(ids).add(item.id));
    setFailed((errors) => { const next = new Map(errors); next.delete(item.id); return next; });
    loadFullItem(agent.id, turnId, item).then(
      (full) => { if (alive.current) setLoaded((all) => new Map(all).set(item.id, { item: full, signature: read })); },
      (e) => { if (alive.current) setFailed((errors) => new Map(errors).set(item.id, errorText(e))); },
    ).finally(() => {
      reading.current.delete(item.id);
      if (alive.current) setLoading((ids) => { const next = new Set(ids); next.delete(item.id); return next; });
    });
  }

  const counts = new Map<string, number>();
  for (const item of edits) counts.set(item.status || "unknown", (counts.get(item.status || "unknown") || 0) + 1);
  const ask = turn?.items.find((item) => item.type === "userMessage");
  const askText = ask ? userText(ask).trim().replace(/\s+/g, " ") : "";
  const label = turnNumber ? `Turn ${turnNumber}` : "This turn";
  return (
    <Modal open={open} onOpenChange={onOpenChange} wide className="codex-changes" title="Changes in this turn"
      description={`Yuzuno's record of the file edits Codex made · ${agent.name}`}>
      <div className="changes-body">
        {!turnId ? (
          <p role="status" className="remote-field-note">
            No file edits are recorded in the turns loaded here.
            {olderNotLoaded && " Earlier turns are not loaded; load them in the conversation to look further back."}
          </p>
        ) : !turn ? (
          <p role="status" className="remote-field-note">{label} is no longer among the turns loaded here.</p>
        ) : (
          <>
            <section className="changes-turn" aria-label="Turn">
              <strong><ListTree size={14} /> {label}</strong>
              {askText && <span className="changes-ask">“{askText.length > 90 ? `${askText.slice(0, 89)}…` : askText}”</span>}
              <p>
                The latest turn with recorded edits among the turns loaded here
                {olderNotLoaded ? "; earlier turns are not loaded" : ""}.
                {" "}{plural(files.length, "file")} · {plural(edits.length, "edit")}
                {[...counts].map(([status, count]) => ` · ${count} ${(statusLabels[status] || status).toLowerCase()}`).join("")}
              </p>
              {/inProgress|running/.test(turn.status) && <p role="status">This turn is still running: its new edits show here as Codex records them.</p>}
              {turn._yuzunoSlice && <p role="status">Only part of this turn is loaded here, so edits outside that part are not listed.</p>}
            </section>
            {files.map((file) => (
              <section key={file.key} className="changes-file" aria-label={displayPath(file.path, agent.cwd)}>
                <div className="changes-file-heading">
                  <FileCode2 size={14} />
                  <span className="changes-path">{displayPath(file.path, agent.cwd)}</span>
                  <span className="changes-count">{plural(file.edits.length, "edit")}</span>
                  <button type="button" className="inline-link" title="Opens the file as it is now" onClick={() => onFile(file.path)}>
                    Open file <ArrowUpRight size={12} />
                  </button>
                </div>
                <ol>
                  {file.edits.map((edit) => (
                    <EditRow key={`${edit.item.id}:${edit.index}`} edit={edit} total={edits.length} cwd={agent.cwd}
                      loading={loading.has(edit.item.id)} error={failed.get(edit.item.id) || ""}
                      onLoad={() => load(edit.item)} onShow={() => turnId && onShowEdit(turnId, edit.item.id)} />
                  ))}
                </ol>
              </section>
            ))}
            {hidden.map(({ item, editNumber, count }) => (
              <p key={item.id} className="changes-hidden">
                Edit {editNumber} also changed {plural(count, "more file")}, not in the preview.{" "}
                <LoadState loading={loading.has(item.id)} error={failed.get(item.id) || ""} what={`edit ${editNumber}`}
                  onLoad={() => load(item)} />
              </p>
            ))}
          </>
        )}
        <p className="remote-field-note changes-scope">
          Recorded here: the file edits Codex made with its patch tool, as it applied them. Not recorded: changes made by
          shell commands, your own edits and sub-agents' edits. This is not a Git diff of the folder, and a file may have
          changed since; Open file shows it as it is now.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={() => onOpenChange(false)}>Close</button>
      </div>
    </Modal>
  );
}

/** Reading an edit in full: a button, its progress, or why it failed (read again only when asked). */
function LoadState({ loading, error, what, onLoad }: { loading: boolean; error: string; what: string; onLoad: () => void }) {
  if (loading) return <span role="status"><LoaderCircle size={12} className="spin" /> Loading {what}…</span>;
  return (
    <>
      {error && <span role="alert" className="remote-field-error">Couldn't load {what}: {error}. </span>}
      <button type="button" className="inline-link" onClick={onLoad}>{error ? "Try again" : `Load ${what}`}</button>
    </>
  );
}

/** One file's part of one edit: closed until asked, then drawn in bounded steps. */
function EditRow({ edit, total, cwd, loading, error, onLoad, onShow }: {
  edit: FileEdit; total: number; cwd: string; loading: boolean; error: string; onLoad: () => void; onShow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState(1);
  const status = edit.item.status || "unknown";
  const lines = Math.min(steps * changesLimits.segmentLines, changesLimits.maxLines);
  const chars = Math.min(steps * changesLimits.segmentChars, changesLimits.maxChars);
  const shown = open ? headLines(edit.text, lines, chars) : null;
  const kinds = shown ? lineKinds(shown.lines, edit.kind) : [];
  const capped = lines >= changesLimits.maxLines || chars >= changesLimits.maxChars;
  return (
    <li className="changes-edit" data-status={status}>
      <div className="changes-edit-heading">
        <button type="button" className="inline-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide" : "Show"}
        </button>
        <span>
          Edit {edit.editNumber} of {total} · {kindLabels[edit.kind]}
          {edit.movePath && <> · moved to <span className="changes-path">{displayPath(edit.movePath, cwd)}</span></>}
          {" · "}<span className="changes-status">{statusLabels[status] || status}</span>
        </span>
      </div>
      {shown && (
        <div className="changes-edit-body">
          {edit.kind === "add" && <p className="changes-note">The added file's content, as Codex wrote it.</p>}
          {edit.kind === "delete" && <p className="changes-note">The deleted file's content, as it was before.</p>}
          {!edit.complete && (
            <p className="changes-note">
              Only the start of this edit is in the preview.{" "}
              <LoadState loading={loading} error={error} what="the full edit" onLoad={onLoad} />
            </p>
          )}
          {shown.lines.length ? (
            <pre className="changes-lines">
              {shown.lines.map((line, index) => <span key={index} data-line={kinds[index]}>{line}{"\n"}</span>)}
            </pre>
          ) : <p className="changes-note">{edit.complete ? "This edit recorded no text." : "No text of it is in the preview."}</p>}
          {shown.cut && <p className="changes-note">A line too long to show here was shortened.</p>}
          {shown.more > 0 && (capped ? (
            <p className="changes-note">
              The rest of this edit ({plural(shown.more, "more line")}) is not shown here.{" "}
              <button type="button" className="inline-link" onClick={onShow}>Show in conversation</button>
            </p>
          ) : (
            <button type="button" className="inline-link" onClick={() => setSteps((n) => n + 1)}>
              Show {Math.min(shown.more, changesLimits.segmentLines)} more lines ({shown.more} left)
            </button>
          ))}
          {!shown.more && (
            <button type="button" className="inline-link changes-source" onClick={onShow}>Show in conversation</button>
          )}
        </div>
      )}
    </li>
  );
}
