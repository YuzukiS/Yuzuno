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
import { useLanguage, type Language } from "./i18n";
import { newAgentText, savedAgoIn } from "./new-agent-text";
import { activeProjects } from "./projects";
import type { Agent, AgentDetail, Project } from "./types";
import "./session-import.css";
import "./claude-sessions.css";

/** A Claude Code session saved on the Core host, as the list shows it. */
export interface ClaudeSession {
  sessionId: string;
  title: string | null;
  firstPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  tag: string | null;
  lastModified: number | null;
  createdAt: number | null;
  fileSize: number | null;
  existingAgentId?: string | null;
}

export interface ClaudeSessionPreview {
  session: ClaudeSession;
  saved: number;
  prompts: number;
  images: number;
  compacted: boolean;
  subagents: number;
  model: string | null;
  recent: {
    role: "user" | "assistant";
    text: string;
    images?: number;
    at: string | null;
  }[];
  folderExists: boolean;
  existingAgentId: string | null;
  /** Claude Code keeps no lock and reports no owner. */
  occupancy: "unknown";
}

interface Imported {
  agent: Agent;
  existing: boolean;
}

const PAGE = 20;
/** Saved this recently, a session may still be open in Claude Code. */
const RECENT_MS = 10 * 60 * 1000;
const sessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** In English unless a caller passes its language (T-189). */
export function savedAgo(at: number | null, now = Date.now(), language: Language = "en") {
  return savedAgoIn(language, at, now);
}

const folderName = (cwd: string | null, none: string) =>
  cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : none;
/** Why a typed ID wasn't read: worded when shown, so it follows the language. */
const BAD_ID = Symbol("not a session ID");

export function ImportClaudeSession({
  disabled,
  close,
  onCreated,
  onBusyChange,
  projects = [],
  initialProjectId = "",
}: {
  disabled: boolean;
  close: () => void;
  onCreated: (agent: Agent, source?: "imported" | "existing") => void;
  onBusyChange: (busy: boolean) => void;
  projects?: Project[];
  initialProjectId?: string;
}) {
  const language = useLanguage();
  const t = newAgentText(language);
  const ago = (at: number | null) => savedAgo(at, Date.now(), language);
  const activeProjectList = activeProjects(projects);
  const [programmatic, setProgrammatic] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");
  /** The folder whose sessions are listed; empty lists every folder. */
  const [dir, setDir] = useState("");
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState("");
  const [lookup, setLookup] = useState("");
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<ClaudeSessionPreview | null>(null);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(() =>
    activeProjectList.some((p) => p.id === initialProjectId)
      ? initialProjectId
      : "",
  );
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | typeof BAD_ID>("");
  const listRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listRequest.current?.abort();
      previewRequest.current?.abort();
    };
  }, []);

  async function loadPage(offset: number, include: boolean, folder: string) {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setListing(true);
    setListError("");
    try {
      const page = await api<{
        sessions: ClaudeSession[];
        next: number | null;
      }>(
        `/claude/sessions?offset=${offset}&limit=${PAGE}${include ? "&programmatic=true" : ""}${folder ? `&dir=${encodeURIComponent(folder)}` : ""}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      // A session saved meanwhile moves to the top; never list one twice.
      setSessions((current) => {
        const kept = offset === 0 ? [] : current;
        const seen = new Set(kept.map((s) => s.sessionId));
        return [
          ...kept,
          ...page.sessions.filter((s) => !seen.has(s.sessionId)),
        ];
      });
      setNext(page.next);
    } catch (e) {
      if (!controller.signal.aborted) setListError(errorText(e));
    } finally {
      if (!controller.signal.aborted) setListing(false);
    }
  }

  useEffect(() => {
    if (!disabled) void loadPage(0, programmatic, dir);
  }, [disabled, programmatic, dir]);

  async function readPreview(id: string) {
    if (disabled || importing.current) return;
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setSelected(id);
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const result = await api<ClaudeSessionPreview>(
        "/claude/sessions/preview",
        {
          method: "POST",
          body: JSON.stringify({ sessionId: id }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      setPreview(result);
      setName(
        (
          result.session.title ||
          result.session.firstPrompt ||
          "Claude session"
        ).slice(0, 60),
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function readLookup(event: React.FormEvent) {
    event.preventDefault();
    const id = lookup.trim();
    if (!sessionId.test(id)) {
      setError(BAD_ID);
      return;
    }
    void readPreview(id);
  }

  const existing = preview?.existingAgentId ?? null;
  const folder = preview?.session.cwd ?? null;
  const canImport = Boolean(
    preview && !existing && name.trim() && folder && preview.folderExists,
  );

  async function importSession(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || importing.current || !preview || (!existing && !canImport))
      return;
    importing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      let agent: Agent;
      let source: "imported" | "existing" = "existing";
      if (existing) {
        agent = (
          await api<AgentDetail>(`/agents/${encodeURIComponent(existing)}`)
        ).agent;
      } else {
        const result = await post<Imported>("/claude/sessions/import", {
          sessionId: preview.session.sessionId,
          name: name.trim(),
          projectId: projectId || null,
          cwd: folder,
        });
        agent = result.agent;
        if (!result.existing) source = "imported";
      }
      if (!mounted.current) return;
      onCreated(agent, source);
      close();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      importing.current = false;
      onBusyChange(false);
      if (mounted.current) setBusy(false);
    }
  }

  const warnings: string[] = [];
  if (preview) {
    if (!folder) warnings.push(t.noFolderWarning);
    else if (!preview.folderExists) warnings.push(t.folderGone(folder));
    if (preview.compacted) warnings.push(t.compacted);
    if (preview.images > 0) warnings.push(t.imagesShown(t.images(preview.images)));
    const at = preview.session.lastModified;
    if (at && Date.now() - at < RECENT_MS) warnings.push(t.mayBeOpen(ago(at)));
  }
  const errorShown = error === BAD_ID ? t.claudeBadId : error;

  return (
    <div className="session-import create-form remote-create claude-session-import">
      <section
        className="claude-sessions"
        aria-label={t.claudeSessions}
      >
        <div className="session-preview-action">
          <span>
            <Monitor size={13} /> {t.coreHostClaude}
          </span>
          <label className="claude-sessions-filter">
            <input
              type="checkbox"
              checked={programmatic}
              disabled={disabled || busy}
              onChange={(e) => setProgrammatic(e.target.checked)}
            />
            {t.includeScripts}
          </label>
        </div>
        <form
          className="claude-sessions-folder"
          onSubmit={(e) => {
            e.preventDefault();
            setDir(folderFilter.trim());
          }}
        >
          <input
            aria-label={t.folderFilter}
            placeholder={t.folderFilterPlaceholder}
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            disabled={disabled || busy}
          />
          <button
            className="secondary-button"
            disabled={disabled || busy || folderFilter.trim() === dir}
          >
            {t.filter}
          </button>
        </form>
        {sessions.length > 0 && (
          <ul className="claude-session-list" aria-busy={listing}>
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  type="button"
                  data-session={s.sessionId}
                  aria-pressed={selected === s.sessionId}
                  disabled={disabled || busy}
                  onClick={() => void readPreview(s.sessionId)}
                >
                  <strong>
                    {s.title || s.firstPrompt || t.untitled}
                  </strong>
                  <span>
                    {folderName(s.cwd, t.noFolder)} · {ago(s.lastModified)}
                    {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                  </span>
                  {s.existingAgentId && (
                    <em className="claude-session-badge">{t.inWorkspace}</em>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing ? (
          <p className="remote-field-note" role="status">
            <LoaderCircle size={13} className="spin" /> {t.readingSessions}
          </p>
        ) : listError ? (
          <p role="alert" className="remote-field-error">
            {listError}
          </p>
        ) : (
          sessions.length === 0 &&
          !disabled && (
            <p className="remote-field-note">{t.noSessions(programmatic, !!dir)}</p>
          )
        )}
        {next !== null && !listing && (
          <button
            type="button"
            className="secondary-button claude-sessions-more"
            disabled={disabled || busy}
            onClick={() => void loadPage(next, programmatic, dir)}
          >
            {t.showMore}
          </button>
        )}
      </section>

      <form onSubmit={readLookup}>
        <label htmlFor="claude-session-id">
          {t.orSessionId}
          <input
            id="claude-session-id"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="7f7263b1-…"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            disabled={disabled || busy}
          />
        </label>
        <div className="session-preview-action">
          <span>{t.coreHostOnly}</span>
          <button
            className="secondary-button"
            disabled={disabled || busy || loading || !lookup.trim()}
          >
            {loading ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <History size={14} />
            )}
            {loading ? t.readingSession : t.previewSession}
          </button>
        </div>
      </form>

      {preview && (
        <form onSubmit={(e) => void importSession(e)}>
          <section className="session-preview" aria-label={t.sessionPreview}>
            <div className="session-preview-heading">
              <span>
                <CheckCircle2 size={14} /> {existing ? t.alreadyIn : t.found}
              </span>
              <span>{t.prompts(preview.prompts)}</span>
            </div>
            {preview.recent.length > 0 ? (
              <ol
                className="claude-session-recent"
                aria-label={t.newestMessages}
              >
                {preview.recent.map((m, i) => (
                  <li key={i} data-role={m.role}>
                    <span>{m.role === "user" ? t.you : "Claude"}</span>
                    <p>
                      {m.text}
                      {m.images
                        ? `${m.text ? " " : ""}[${t.images(m.images)}]`
                        : ""}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="session-preview-excerpt">
                {t.emptySession}
              </p>
            )}
            <div className="session-preview-folder">
              <Folder size={14} />
              <span>{folder || t.noFolderRecorded}</span>
            </div>
            <p className="session-preview-model">
              {t.saved(ago(preview.session.lastModified))}
              {preview.session.gitBranch
                ? ` · ${preview.session.gitBranch}`
                : ""}
              {preview.model ? t.lastUsed(preview.model) : ""}
              {preview.subagents ? ` · ${t.subagents(preview.subagents)}` : ""}
            </p>
          </section>
          {warnings.length > 0 && (
            <div className="session-import-warnings" role="status">
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          {!existing && (
            <fieldset
              className="remote-form-fields"
              disabled={disabled || busy}
            >
              <label>
                {t.agentName}
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                />
              </label>
              <label>
                {t.project}
                <select
                  aria-label={t.project}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">{t.noProject}</option>
                  {activeProjectList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.folderLabel}
                <input value={folder ?? ""} readOnly aria-readonly="true" />
              </label>
              <p className="remote-field-note">{t.folderNote}</p>
            </fieldset>
          )}
          <p className="session-handoff-note">
            {t.claudeHandoff}
            {!existing && t.claudeAddsNothing}
          </p>
          {errorShown && (
            <p role="alert" className="remote-field-error">
              {errorShown}
            </p>
          )}
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
              disabled={disabled || busy || (!existing && !canImport)}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowRight size={15} />
              )}
              {busy ? t.opening : existing ? t.openAgent : t.addToWorkspace}
            </button>
          </div>
        </form>
      )}
      {!preview && errorShown && (
        <p role="alert" className="remote-field-error">
          {errorShown}
        </p>
      )}
      {disabled && <p className="remote-field-note">{t.importDisabled}</p>}
    </div>
  );
}
