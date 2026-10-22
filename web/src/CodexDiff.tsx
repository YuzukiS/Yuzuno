import { useEffect, useRef, useState } from "react";
import { FileCode2, FolderGit2, LoaderCircle } from "lucide-react";
import { api, errorText, post, remove } from "./api";
import { Modal } from "./components";
import { changesLimits, headLines, lineKinds } from "./changes";
import { diffFiles, readToken, stagedLabel, type DiffPart, type DiffReport, type DiffTarget } from "./codex-diff";
import type { Agent } from "./types";
import "./codex-changes.css";
import "./codex-diff.css";

/** Files listed per "Show more files", adjustable by tests. */
export const diffLimits = { files: 200 };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Why there is nothing to read, in the user's terms. */
const unavailable: Record<string, string> = {
  not_connected: "This Agent isn't connected to Codex. /diff reads through its Codex connection and doesn't connect by itself; once it's connected, use Refresh.",
  closed: "This Agent is closed.",
  harness: "/diff is for Codex Agents.",
  old_protocol: "This Agent's Codex can't run this read; a newer Codex can.",
  platform: "Codex on this machine can't run this read with a size limit, so Yuzuno doesn't read without one.",
  git_missing: "Git isn't available where this Agent's Codex runs.",
  target_changed: "This Agent's connection or folder changed just before the read, so nothing was read. Refresh reads it as it is now.",
  busy: "A /diff read of this Agent is already running.",
};
const failures: Record<string, string> = {
  dubious_ownership: "Git refused this folder because another user owns it (Git's safe.directory check). Yuzuno doesn't change that setting.",
  filter_config: "Git's filter settings couldn't be read, so nothing was read: a filter could otherwise run.",
  timeout: "Git took longer than this read allows.",
  budget: "The read reached its time limit before Git answered.",
  connection: "The connection to Codex ended during the read.",
  refused: "Codex refused the read.",
  git: "Git couldn't read the changes.",
  total: "The read reached its size limit.",
};
const stops: Record<string, string> = {
  budget: "The read stopped at its time limit (30 seconds); what was read by then is shown.",
  total: "The read stopped at its size limit (4 MiB in all); what was read by then is shown.",
  cancelled: "You cancelled the read; what was read by then is shown.",
  connection: "The connection to Codex ended during the read; what was read by then is shown.",
};
const notReadReasons: Record<string, string> = {
  nested_repository: "A separate Git repository inside this folder; not read.",
  limit: "Not read: this read shows at most 100 untracked files.",
  total: "Not read: the read reached its size limit.",
  stopped: "Not read: the read stopped first.",
};

type Phase = "target" | "reading" | "done";

/**
 * `/diff` (T-29): Git's diff of this Codex Agent's folder, read where its
 * Codex runs, as Codex's own CLI shows it (changes not yet staged and the
 * untracked files), with the names of staged changes, which that view leaves
 * out.
 *
 * - It reads as soon as it opens: what it reads (machine and folder) is shown
 *   first and the read is bound to it. Refresh reads again only when clicked.
 * - Close or Cancel stops this read only, by its own token. A late answer of
 *   a read that is no longer this dialog's is dropped.
 * - The result stays in this dialog: it is not sent to the model, not kept
 *   in the conversation and not read again by itself.
 */
export function CodexDiffDialog({ agent, open, onOpenChange }: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("target");
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [report, setReport] = useState<DiffReport | null>(null);
  const [error, setError] = useState("");
  const [readAt, setReadAt] = useState<Date | null>(null);
  /** The read this dialog is waiting for; any other answer is dropped. */
  const current = useRef<string | null>(null);
  const reading = useRef(false);
  const path = `/agents/${encodeURIComponent(agent.id)}/codex/diff`;

  function stop() {
    const token = current.current;
    current.current = null;
    if (token && reading.current) remove(`${path}?token=${encodeURIComponent(token)}`).catch(() => undefined);
    reading.current = false;
  }

  async function read() {
    stop();
    const token = readToken();
    current.current = token;
    setPhase("target");
    setError("");
    try {
      const shown = await api<DiffTarget>(path);
      if (current.current !== token) return;
      setTarget(shown);
      if (shown.state !== "ready" || shown.generation === null) {
        setReport(null);
        setPhase("done");
        return;
      }
      setPhase("reading");
      reading.current = true;
      const answer = await post<DiffReport>(path, { token, generation: shown.generation, cwd: shown.cwd });
      if (current.current !== token) return;
      reading.current = false;
      setReport(answer);
      setReadAt(new Date());
    } catch (e) {
      if (current.current !== token) return;
      reading.current = false;
      setError(errorText(e));
    }
    if (current.current === token) setPhase("done");
  }

  useEffect(() => {
    void read();
    return stop;
    // One read when it opens; later ones only by Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    const token = current.current;
    if (token && reading.current) remove(`${path}?token=${encodeURIComponent(token)}`).catch(() => undefined);
  }

  const machine = agent.remote?.machine.name || "Core host";
  const folder = target?.cwd || agent.cwd;
  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) stop(); onOpenChange(next); }} wide className="codex-changes codex-diff"
      title="Folder diff" description={`Git's view of this Agent's folder · ${agent.name}`}>
      <div className="changes-body">
        <section className="diff-target" aria-label="What is read">
          <strong><FolderGit2 size={14} /> <span className="changes-path">{folder}</span></strong>
          <span className="changes-note">On {machine}, read with Git where this Agent's Codex runs{readAt && phase === "done" && report ? ` · read at ${readAt.toLocaleTimeString()}` : ""}.</span>
          <span className="changes-note">
            Shown: changes not yet staged and untracked files, as Codex's own /diff shows them, and the names of staged
            changes. Not shown: staged content and ignored files.
          </span>
        </section>
        {phase === "target" && <p role="status"><LoaderCircle size={12} className="spin" /> Checking this Agent's connection…</p>}
        {phase === "reading" && (
          <p role="status">
            <LoaderCircle size={12} className="spin" /> Reading the folder…{" "}
            <button type="button" className="inline-link" onClick={cancel}>Cancel</button>
          </p>
        )}
        {phase === "done" && error && <p role="alert" className="remote-field-error">Couldn't read the folder: {error}</p>}
        {phase === "done" && !error && target && target.state !== "ready" && (
          <p role="status" className="remote-field-note">{unavailable[target.reason] ?? `Nothing was read (${target.reason}).`}</p>
        )}
        {phase === "done" && !error && report && <Result report={report} />}
        <p className="remote-field-note changes-scope">
          Read-only: Yuzuno runs a fixed set of Git commands with hooks, filters, external diff and textconv programs off,
          and changes nothing in the folder. The result stays in this dialog: it isn't sent to the model or kept in the
          conversation.
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="secondary-button" disabled={phase !== "done"} onClick={() => void read()}>Refresh</button>
        <button type="button" className="secondary-button" onClick={() => { stop(); onOpenChange(false); }}>Close</button>
      </div>
    </Modal>
  );
}

/** A read's outcome: why nothing was read, or each part as read. */
function Result({ report }: { report: DiffReport }) {
  const detail = report.detail ? <pre className="diff-detail">{report.detail}</pre> : null;
  if (report.state === "not_repository") {
    return <div role="status"><p className="remote-field-note">This folder isn't in a Git work tree, so there is no Git diff to show.</p>{detail}</div>;
  }
  if (report.state === "unavailable" || report.state === "busy") {
    return <div role="status"><p className="remote-field-note">{unavailable[report.reason] ?? `Nothing was read (${report.reason}).`}</p>{detail}</div>;
  }
  if (report.state === "cancelled" && !report.tracked) return <p role="status" className="remote-field-note">You cancelled the read before anything was read.</p>;
  if (report.state === "failed") {
    return <div role="alert"><p className="remote-field-error">{failures[report.reason] ?? "The read failed."} Nothing is shown.</p>{detail}</div>;
  }
  const tracked = report.tracked;
  const staged = report.staged;
  const untracked = report.untracked;
  const trackedFiles = tracked ? diffFiles(tracked.text) : [];
  const noTracked = !!tracked && tracked.complete && !tracked.text;
  const noStaged = !!staged && staged.complete && !staged.error && !staged.entries.length;
  const noUntracked = !!untracked && untracked.listedAll && !untracked.error && !untracked.files.length;
  return (
    <>
      {report.stopped && <p role="status" className="diff-stopped">{stops[report.stopped] ?? `The read stopped (${report.stopped}).`}</p>}
      {noTracked && noStaged && noUntracked && report.complete && (
        <p role="status" className="diff-clean">No changes here: nothing unstaged, nothing staged and no untracked files (ignored files aren't listed).</p>
      )}
      <section className="changes-file" aria-label="Changes not staged">
        <h3 className="diff-heading">Changes not staged{tracked && trackedFiles.length ? ` · ${plural(trackedFiles.length, "file")}` : ""}</h3>
        {!tracked ? <p className="changes-note">Not read.</p> : noTracked ? (
          <p className="changes-note">
            {staged?.entries.length ? "None: every change is staged (listed below; their content isn't shown)." : "None."}
          </p>
        ) : (
          <>
            <PartNotes part={tracked} what="the changes" />
            <FileList files={trackedFiles.map((file) => ({ key: file.path || "(header)", path: file.path || "Git's output", text: file.text }))} />
          </>
        )}
      </section>
      <section className="changes-file" aria-label="Staged changes">
        <h3 className="diff-heading">Staged changes, names only{staged && staged.entries.length ? ` · ${plural(staged.entries.length, "file")}` : ""}</h3>
        {!staged ? <p className="changes-note">Not read.</p> : staged.error ? (
          <p role="alert" className="remote-field-error">Git couldn't list them: {staged.error}</p>
        ) : noStaged ? <p className="changes-note">None.</p> : (
          <>
            <ul className="diff-names">
              {staged.entries.map((entry, index) => (
                <li key={`${entry.path}:${index}`}>
                  <span className="diff-status">{stagedLabel(entry.status)}</span>{" "}
                  {entry.from && <><span className="changes-path">{entry.from}</span> → </>}
                  <span className="changes-path">{entry.path}</span>
                </li>
              ))}
            </ul>
            {!staged.complete && <p className="changes-note">There are more staged changes than this read lists.</p>}
          </>
        )}
      </section>
      <section className="changes-file" aria-label="Untracked files">
        <h3 className="diff-heading">Untracked files{untracked && untracked.files.length ? ` · ${plural(untracked.files.length, "file")}` : ""}</h3>
        {!untracked ? <p className="changes-note">Not read.</p> : untracked.error ? (
          <p role="alert" className="remote-field-error">Git couldn't list them: {untracked.error}</p>
        ) : noUntracked ? <p className="changes-note">None (ignored files aren't listed).</p> : (
          <>
            <FileList files={untracked.files.map((file) => ({ key: file.path, path: file.path, text: file.diff?.text ?? "", part: file.diff,
              notRead: file.notRead ? notReadReasons[file.notRead] ?? `Git couldn't read it: ${file.notRead}` : null }))} />
            {!untracked.listedAll && <p className="changes-note">There are more untracked files than this read lists.</p>}
          </>
        )}
      </section>
    </>
  );
}

/** What a part's text is: cut at a limit, or with bytes that aren't text. */
function PartNotes({ part, what }: { part: DiffPart; what: string }) {
  return (
    <>
      {!part.complete && <p className="changes-note">Git wrote more than this read keeps; only the start of {what} is shown.</p>}
      {part.notUtf8 && <p className="changes-note">Some bytes aren't UTF-8 text and show as �.</p>}
    </>
  );
}

interface Listed { key: string; path: string; text: string; part?: DiffPart | null; notRead?: string | null }

/** Files in steps of diffLimits.files, each closed until asked. */
function FileList({ files }: { files: Listed[] }) {
  const [shown, setShown] = useState(diffLimits.files);
  return (
    <>
      <ol className="diff-files">
        {files.slice(0, shown).map((file, index) => <DiffRow key={`${file.key}:${index}`} file={file} />)}
      </ol>
      {files.length > shown && (
        <button type="button" className="inline-link" onClick={() => setShown((n) => n + diffLimits.files)}>
          Show {plural(Math.min(files.length - shown, diffLimits.files), "more file")} ({files.length - shown} left)
        </button>
      )}
    </>
  );
}

/** One file: closed until asked, then drawn in bounded steps, as /changes draws an edit. */
function DiffRow({ file }: { file: Listed }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState(1);
  const lines = Math.min(steps * changesLimits.segmentLines, changesLimits.maxLines);
  const chars = Math.min(steps * changesLimits.segmentChars, changesLimits.maxChars);
  const shown = open ? headLines(file.text, lines, chars) : null;
  const kinds = shown ? lineKinds(shown.lines, "update") : [];
  const capped = lines >= changesLimits.maxLines || chars >= changesLimits.maxChars;
  return (
    <li className="changes-edit">
      <div className="changes-edit-heading">
        <FileCode2 size={14} />
        <span className="changes-path">{file.path}</span>
        {file.notRead ? <span className="changes-note">{file.notRead}</span> : (
          <button type="button" className="inline-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {shown && (
        <div className="changes-edit-body">
          {file.part && <PartNotes part={file.part} what="this file" />}
          {shown.lines.length ? (
            <pre className="changes-lines">
              {shown.lines.map((line, index) => <span key={index} data-line={kinds[index]}>{line}{"\n"}</span>)}
            </pre>
          ) : <p className="changes-note">Git showed no text for it.</p>}
          {shown.cut && <p className="changes-note">A line too long to show here was shortened.</p>}
          {shown.more > 0 && (capped
            ? <p className="changes-note">The rest ({plural(shown.more, "more line")}) is not shown here.</p>
            : (
              <button type="button" className="inline-link" onClick={() => setSteps((n) => n + 1)}>
                Show {Math.min(shown.more, changesLimits.segmentLines)} more lines ({shown.more} left)
              </button>
            ))}
        </div>
      )}
    </li>
  );
}
