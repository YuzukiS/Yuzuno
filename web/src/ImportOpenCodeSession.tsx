import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, FileUp, Folder, LoaderCircle, Monitor, RotateCw } from "lucide-react";
import { api, errorText, NetworkError, post } from "./api";
import { useLanguage } from "./i18n";
import { newAgentText } from "./new-agent-text";
import type { Agent } from "./types";
import "./session-import.css";
import { Tip, TipText } from "./Tip";

/** What Core read from an uploaded OpenCode 2.x export (T-61 slice 8). */
export interface OpenCodeImportPreview {
  requestId: string;
  sourceSession: string;
  title: string | null;
  /** The folder the session worked in, as the file says. */
  cwd: string | null;
  turns: number;
  messages: number;
  model: string | null;
  agent: string | null;
  droppedPermissions: boolean;
  droppedMetadata: boolean;
  cost: number | null;
  /** The Agent this same file already made. */
  existing: Agent | null;
  /** An import of this same file not yet finished: its request. */
  pending: string | null;
  /** Agents made from other exports of the same session. */
  earlierCopies: { agentId: string; name: string }[];
}

type ImportAnswer =
  | {
      state: "completed";
      requestId: string;
      agent: Agent;
      importOutcome: "created" | "existing";
      warnings?: string[];
    }
  | {
      state: "uncertain" | "pending" | "failed" | "uploaded" | "none";
      requestId?: string;
      message?: string;
    };

/** Core's cap on an uploaded file. */
export const OPENCODE_IMPORT_CAP = 64 << 20;
/** Core's cap on an Agent name, in UTF-8 bytes. */
const NAME_BYTES = 100;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
/** The longest start of `text` within `limit` UTF-8 bytes, whole characters only. */
export function withinBytes(text: string, limit: number) {
  let out = "";
  for (const char of text) {
    if (bytes(out + char) > limit) break;
    out += char;
  }
  return out;
}

/** Where an import stopped short of an Agent, and what goes on with it. */
type Halt = { requestId: string; message: string; kind: "again" | "continue" | "check" };

export function ImportOpenCodeSession({
  disabled,
  close,
  onCreated,
  onBusyChange,
}: {
  disabled: boolean;
  close: () => void;
  /** `added`: Core says this import made the Agent. */
  onCreated: (agent: Agent, source?: "imported" | "existing", added?: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const language = useLanguage();
  const t = newAgentText(language);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<OpenCodeImportPreview | null>(null);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [halt, setHalt] = useState<Halt | null>(null);
  /** The upload's import failed: only a new upload goes on. */
  const [spent, setSpent] = useState(false);
  /** Made, with what Core said beside it: shown before the Agent opens. */
  const [made, setMade] = useState<{ agent: Agent; added: boolean; warnings: string[] } | null>(null);
  const upload = useRef<AbortController | null>(null);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      upload.current?.abort();
    };
  }, []);

  async function readFile(input: HTMLInputElement) {
    const file = input.files?.[0];
    // The same file chosen again is read again.
    input.value = "";
    if (!file || disabled || importing.current) return;
    upload.current?.abort();
    setPreview(null);
    setHalt(null);
    setMade(null);
    setSpent(false);
    setError("");
    if (file.size > OPENCODE_IMPORT_CAP) {
      setError(t.ocTooBig);
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    setReading(true);
    try {
      const result = await api<OpenCodeImportPreview>("/opencode/sessions/import/file", {
        method: "POST",
        body: file,
        headers: { "Content-Type": "application/octet-stream" },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPreview(result);
      setName(withinBytes((result.title || "").trim() || "OpenCode session", NAME_BYTES));
      setCwd(result.cwd ?? "");
      if (result.pending)
        setHalt({ requestId: result.pending, message: t.ocPending, kind: "continue" });
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  }

  function finish(agent: Agent, source: "imported" | "existing", added: boolean) {
    onCreated(agent, source, added);
    close();
  }

  /** What Core answered for an import, shown or acted on. */
  function settle(answer: ImportAnswer, requestId: string) {
    if (answer.state === "completed") {
      const added = answer.importOutcome === "created";
      const warnings = answer.warnings ?? [];
      if (warnings.length) setMade({ agent: answer.agent, added, warnings });
      else finish(answer.agent, added ? "imported" : "existing", added);
      return;
    }
    const message = answer.message || "";
    if (answer.state === "uncertain")
      setHalt({ requestId: answer.requestId || requestId, message: message || t.ocUncertain, kind: "again" });
    else if (answer.state === "pending")
      setHalt({ requestId: answer.requestId || requestId, message: message || t.ocPending, kind: "continue" });
    else if (answer.state === "uploaded") setHalt(null);
    else {
      setSpent(true);
      setError(answer.state === "none" ? t.ocExpired : message || t.ocFailed);
    }
  }

  /** Sends one import (a new one, or one again by its request, which goes on
   * from where it stands); an answer lost on the way is read back by its
   * request, never guessed. */
  async function send(requestId: string, check = false) {
    if (disabled || importing.current) return;
    importing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      let answer: ImportAnswer;
      try {
        answer = check
          ? await api<ImportAnswer>(`/opencode/sessions/import?requestId=${encodeURIComponent(requestId)}`)
          : await post<ImportAnswer>("/opencode/sessions/import", { requestId, name: name.trim(), cwd: cwd.trim() });
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
        try {
          answer = await api<ImportAnswer>(`/opencode/sessions/import?requestId=${encodeURIComponent(requestId)}`);
        } catch {
          if (mounted.current) setHalt({ requestId, message: t.ocNoAnswer, kind: "check" });
          return;
        }
      }
      if (!mounted.current) return;
      if (check && answer.state === "uploaded") {
        // It never started: the import can be sent as it was.
        setHalt(null);
        return;
      }
      settle(answer, requestId);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      importing.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }

  const existing = preview?.existing ?? null;
  const nameBytes = bytes(name.trim());
  const nameTooLong = nameBytes > NAME_BYTES;
  const canImport = Boolean(
    preview && !existing && !halt && !spent && name.trim() && !nameTooLong && cwd.trim(),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!preview) return;
    if (existing) {
      finish(existing, "existing", false);
      return;
    }
    if (halt) {
      void send(halt.requestId, halt.kind === "check");
      return;
    }
    if (canImport) void send(preview.requestId);
  }

  const notes: string[] = [];
  if (preview && !existing) {
    if (preview.earlierCopies.length)
      notes.push(t.ocEarlier(preview.earlierCopies.map((c) => c.name).join(", ")));
    if (preview.model) notes.push(t.ocModelKept(preview.model));
    if (preview.droppedPermissions) notes.push(t.ocDropsPermissions);
    if (preview.droppedMetadata) notes.push(t.ocDropsMetadata);
  }
  const details = preview
    ? [
        t.ocMessages(preview.messages),
        preview.model ? t.ocModel(preview.model) : "",
        preview.agent ? t.ocAgent(preview.agent) : "",
        preview.cost ? t.ocCost(preview.cost) : "",
      ].filter(Boolean)
    : [];

  if (made) {
    return (
      <div className="session-import create-form remote-create opencode-session-import">
        <section className="session-preview" aria-label={t.sessionPreview}>
          <div className="session-preview-heading">
            <span>
              <CheckCircle2 size={14} /> {made.added ? t.ocImported : t.alreadyIn}
            </span>
            <span>{made.agent.name}</span>
          </div>
        </section>
        <div className="session-import-warnings" role="status">
          {made.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
        <div className="modal-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => finish(made.agent, made.added ? "imported" : "existing", made.added)}
          >
            <ArrowRight size={15} />
            {t.openAgent}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="session-import create-form remote-create opencode-session-import">
      <label className="opencode-import-file">
        {t.ocFile}
        <input
          type="file"
          accept=".json,application/json"
          disabled={disabled || busy || reading}
          onChange={(e) => void readFile(e.currentTarget)}
        />
      </label>
      <div className="session-preview-action">
        <span>
          <Monitor size={13} /> {t.coreHostOpenCode}
        </span>
        {reading && (
          <span role="status">
            <LoaderCircle size={13} className="spin" /> {t.ocReading}
          </span>
        )}
      </div>
      <p className="remote-field-note">{t.ocFileHint}</p>

      {preview && (
        <form onSubmit={submit}>
          <section className="session-preview" aria-label={t.sessionPreview}>
            <div className="session-preview-heading">
              <span>
                <CheckCircle2 size={14} /> {existing ? t.alreadyIn : t.ocFound}
              </span>
              <span>{t.turns(preview.turns)}</span>
            </div>
            <p className="session-preview-excerpt">{preview.title || t.untitled}</p>
            <div className="session-preview-folder">
              <Folder size={14} />
              <span>{preview.cwd || t.noFolderRecorded}</span>
            </div>
            <p className="session-preview-model">{details.join(" · ")}</p>
          </section>
          {notes.length > 0 && (
            <div className="session-import-warnings" role="status">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}
          {!existing && (
            <fieldset className="remote-form-fields" disabled={disabled || busy || Boolean(halt) || spent}>
              <label>
                {t.agentName}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  aria-invalid={nameTooLong || undefined}
                />
              </label>
              {nameTooLong && <p className="remote-field-error">{t.ocNameTooLong(nameBytes)}</p>}
              <label>
                {t.folderLabel}
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  required
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </label>
              <p className="remote-field-note">{t.ocFolderNote}</p>
            </fieldset>
          )}
          <p className="session-handoff-note">{existing ? t.ocSameFile : t.ocHandoff}</p>
          {halt && (
            <div className="session-import-warnings" role="status">
              <p>{halt.message}</p>
            </div>
          )}
          {/* As in the other import tabs, the error's line is kept while empty
              so a failure doesn't push the buttons under the pointer. */}
          {error ? (
            // The whole error, when its one line cuts it.
            <Tip key="error" content={<TipText body={error} />} size="wide" cut>
              <p role="alert" className="remote-field-error kept-error">
                <span>{error}</span>
              </p>
            </Tip>
          ) : (
            <p key="line" className="remote-field-error kept-error is-empty" aria-hidden="true">
              <span>&nbsp;</span>
            </p>
          )}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={close} disabled={busy}>
              {t.cancel}
            </button>
            <button
              className="primary-button"
              disabled={disabled || busy || (!existing && !halt && !canImport)}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : halt ? (
                <RotateCw size={15} />
              ) : existing ? (
                <ArrowRight size={15} />
              ) : (
                <FileUp size={15} />
              )}
              {busy
                ? t.ocImporting
                : existing
                  ? t.openAgent
                  : halt
                    ? halt.kind === "check"
                      ? t.ocCheck
                      : halt.kind === "continue"
                        ? t.ocContinue
                        : t.ocAgain
                    : t.ocImport}
            </button>
          </div>
        </form>
      )}
      {!preview && error && (
        <p role="alert" className="remote-field-error">
          {error}
        </p>
      )}
      {disabled && <p className="remote-field-note">{t.importDisabled}</p>}
    </div>
  );
}
