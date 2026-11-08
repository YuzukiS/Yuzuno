import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Folder,
  History,
  LoaderCircle,
  Monitor,
} from "lucide-react";
import { api, errorText, post } from "./api";
import { CodexPermissions } from "./CodexPermissions";
import { useLanguage } from "./i18n";
import { newAgentText } from "./new-agent-text";
import type {
  Agent,
  AgentDetail,
  AgentSettings,
  PermissionCatalog,
} from "./types";
import "./session-import.css";
import { Tip, TipText } from "./Tip";

export interface CodexSessionPreview {
  threadId: string;
  name: string;
  cwd: string;
  preview: string;
  model: string | null;
  reasoningEffort: string | null;
  turnCount: number;
  updatedAt: number | null;
  existingAgentId: string | null;
  warnings: string[];
  permissions?: PermissionCatalog;
}

const defaults: AgentSettings = {
  reasoningEffort: null,
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
  permissionPreset: "ask",
};
const sessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Why a typed ID wasn't read: worded when shown, so it follows the language. */
const BAD_ID = Symbol("not a session ID");

export function ImportCodexSession({
  disabled,
  close,
  onCreated,
  onBusyChange,
}: {
  disabled: boolean;
  close: () => void;
  /** `added`: Core says this import made the Agent (T-19 SH:R11). */
  onCreated: (agent: Agent, source?: "imported" | "existing", added?: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const language = useLanguage();
  const t = newAgentText(language);
  const [threadId, setThreadId] = useState("");
  const [preview, setPreview] = useState<CodexSessionPreview | null>(null);
  // The ID as typed when the shown preview was read.
  const [previewFor, setPreviewFor] = useState("");
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<AgentSettings>(defaults);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | typeof BAD_ID>("");
  const errorShown = error === BAD_ID ? t.codexBadId : error;
  const request = useRef<AbortController | null>(null);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  // Editing the ID keeps the preview, its name and permission, dimmed and
  // still, until a read replaces them (T-19 ST:SX-28): it is the session the
  // ID named before, so it cannot be added while the ID says another.
  const stale = !!preview && threadId.trim() !== previewFor;
  function changeId(value: string) {
    request.current?.abort();
    request.current = null;
    setThreadId(value);
    setLoading(false);
    setError("");
  }

  async function readPreview(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || importing.current || loading) return;
    const id = threadId.trim();
    if (!sessionId.test(id)) {
      setError(BAD_ID);
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<CodexSessionPreview>("/codex/sessions/preview", {
        method: "POST",
        body: JSON.stringify({ threadId: id }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPreview(result);
      setPreviewFor(id);
      setName((result.name || "Codex session").slice(0, 60));
      setSettings({ ...defaults, reasoningEffort: result.reasoningEffort });
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const preset = preview?.permissions?.presets.find(
    (choice) => choice.id === settings.permissionPreset,
  );
  const canImport = Boolean(preview && name.trim() && preset?.available);

  async function importSession(event: React.FormEvent) {
    event.preventDefault();
    if (
      disabled ||
      importing.current ||
      !preview ||
      stale ||
      (!preview.existingAgentId && !canImport)
    )
      return;
    importing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      let agent: Agent;
      let source: "imported" | "existing" = "existing";
      let added = false;
      if (preview.existingAgentId) {
        agent = (await api<AgentDetail>(`/agents/${encodeURIComponent(preview.existingAgentId)}`)).agent;
      } else {
        // What the import did, as Core says it: the session may have an
        // Agent since the preview (another window imported it). An older
        // Core does not say, and nothing then marks the row as added here.
        const { importOutcome, ...imported } = await post<Agent & { importOutcome?: "created" | "existing" }>("/codex/sessions/import", {
          threadId: preview.threadId,
          name: name.trim(),
          permissionPreset: settings.permissionPreset,
        });
        agent = imported;
        if (importOutcome !== "existing") source = "imported";
        added = importOutcome === "created";
      }
      if (!mounted.current) return;
      onCreated(agent, source, added);
      close();
    } catch (error) {
      if (mounted.current) setError(errorText(error));
    } finally {
      importing.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="session-import create-form remote-create">
      <form onSubmit={(event) => void readPreview(event)}>
        <label htmlFor="import-session-id">
          {t.codexId}
          <input
            id="import-session-id"
            autoFocus
            value={threadId}
            onChange={(event) => changeId(event.target.value)}
            placeholder="019…-…"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            disabled={disabled || busy}
            aria-describedby="import-session-hint"
          />
        </label>
        <p id="import-session-hint" className="remote-field-note">
          {t.codexHint}
        </p>
        <div className="session-preview-action">
          <span>
            <Monitor size={13} /> {t.coreHostCodex}
          </span>
          <button
            className="secondary-button"
            disabled={disabled || busy || loading || !threadId.trim()}
          >
            {loading ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <History size={14} />
            )}
            {loading ? t.readingSession : preview ? t.readAgain : t.previewSession}
          </button>
        </div>
      </form>

      {preview && (
        <form onSubmit={(event) => void importSession(event)}>
          {/* A preview whose ID has since been edited, or that is being read again, is out of
              reach; its actions row is not, so Cancel still works (T-19 ST:SX-28, R2 70ad905d). */}
          <div className="session-preview-body" data-stale={stale || loading ? "" : undefined} inert={stale || loading}>
            <section className="session-preview" aria-label={t.sessionPreview}>
              <div className="session-preview-heading">
                <span>
                  <CheckCircle2 size={14} /> {preview.existingAgentId ? t.alreadyIn : t.found}
                </span>
                <span>{t.turns(preview.turnCount)}</span>
              </div>
              <p className="session-preview-excerpt">
                {preview.preview || t.noExcerpt}
              </p>
              <div className="session-preview-folder">
                <Folder size={14} />
                <span>{preview.cwd}</span>
              </div>
              <p className="session-preview-model">
                {preview.model || t.codexDefaultModel}
                {preview.reasoningEffort ? t.reasoning(preview.reasoningEffort) : ""}
              </p>
            </section>
            {preview.warnings.length > 0 && (
              <div className="session-import-warnings" role="status">
                {preview.warnings.map((warning, index) => (
                  <p key={index}>{warning}</p>
                ))}
              </div>
            )}
            {!preview.existingAgentId && (
              <fieldset
                className="remote-form-fields"
                disabled={disabled || busy}
              >
                <label>
                  {t.agentName}
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={60}
                  />
                </label>
                <CodexPermissions
                  settings={settings}
                  catalog={preview.permissions}
                  disabled={disabled || busy}
                  onChange={setSettings}
                  language={language}
                />
                {!preview.permissions && (
                  <p className="remote-field-note">{t.readForPermissions}</p>
                )}
              </fieldset>
            )}
            <p className="session-handoff-note">
              {t.codexHandoff}
              {!preview.existingAgentId && t.codexAddsNothing}
            </p>
            {/* The error's two lines are kept while empty: a failure fills them instead of
                pushing the buttons down under the pointer. Below them it could fall out of this
                dialog's scrolled view (T-19 SX-35). */}
            {/* A stale preview is out of reach: its error shows below the form, once. */}
            {errorShown && !stale ? (
              // The whole error, when its one line cuts it.
              <Tip key="error" content={<TipText body={errorShown} />} size="wide" cut>
                <p role="alert" className="remote-field-error kept-error">
                  <span>{errorShown}</span>
                </p>
              </Tip>
            ) : (
              <p key="line" className="remote-field-error kept-error is-empty" aria-hidden="true">
                <span>&nbsp;</span>
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={close}
              disabled={busy}
            >
              {t.cancel}
            </button>
            <button
              className="primary-button"
              disabled={
                disabled || busy || stale || loading || (!preview.existingAgentId && !canImport)
              }
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowRight size={15} />
              )}
              {busy ? t.opening : preview.existingAgentId ? t.openAgent : t.addToWorkspace}
            </button>
          </div>
        </form>
      )}
      {(!preview || stale) && errorShown && (
        <p role="alert" className="remote-field-error">
          {errorShown}
        </p>
      )}
      {disabled && <p className="remote-field-note">{t.importDisabled}</p>}
    </div>
  );
}
