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

export function savedAgo(at: number | null, now = Date.now()) {
  if (!at) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 45
    ? "just now"
    : seconds < 3600
      ? `${Math.max(1, Math.round(seconds / 60))} min ago`
      : seconds < 86400
        ? `${Math.round(seconds / 3600)} h ago`
        : `${Math.round(seconds / 86400)} d ago`;
}

const folderName = (cwd: string | null) =>
  cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : "No folder";
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

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
  const [error, setError] = useState("");
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
      setError(
        "Paste a Claude Code session ID, such as the one claude --resume shows.",
      );
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
    if (!folder)
      warnings.push(
        "Claude didn’t record a folder for this session, so it can’t continue here.",
      );
    else if (!preview.folderExists)
      warnings.push(
        `This session’s folder no longer exists, so it can’t continue here: ${folder}`,
      );
    if (preview.compacted)
      warnings.push(
        "Claude compacted this session earlier. What came before its summary isn’t in the saved history, so it isn’t shown.",
      );
    if (preview.images > 0)
      warnings.push(
        `${plural(preview.images, "image")} in your messages: Yuzuno shows where they were, not the images.`,
      );
    const at = preview.session.lastModified;
    if (at && Date.now() - at < RECENT_MS)
      warnings.push(
        `Saved ${savedAgo(at)}: it may still be open in Claude Code.`,
      );
  }

  return (
    <div className="session-import create-form remote-create claude-session-import">
      <section
        className="claude-sessions"
        aria-label="Claude Code sessions on this machine"
      >
        <div className="session-preview-action">
          <span>
            <Monitor size={13} /> Core host · Claude Code
          </span>
          <label className="claude-sessions-filter">
            <input
              type="checkbox"
              checked={programmatic}
              disabled={disabled || busy}
              onChange={(e) => setProgrammatic(e.target.checked)}
            />
            Include sessions started by apps and scripts
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
            aria-label="Only sessions in this folder"
            placeholder="Every folder, or one such as /home/you/app"
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
            Filter
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
                    {s.title || s.firstPrompt || "Untitled session"}
                  </strong>
                  <span>
                    {folderName(s.cwd)} · {savedAgo(s.lastModified)}
                    {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                  </span>
                  {s.existingAgentId && (
                    <em className="claude-session-badge">In workspace</em>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing ? (
          <p className="remote-field-note" role="status">
            <LoaderCircle size={13} className="spin" /> Reading saved sessions…
          </p>
        ) : listError ? (
          <p role="alert" className="remote-field-error">
            {listError}
          </p>
        ) : (
          sessions.length === 0 &&
          !disabled && (
            <p className="remote-field-note">
              No saved Claude Code sessions
              {programmatic ? "" : " that you started"}
              {dir ? " in this folder" : " on this machine"}.
            </p>
          )
        )}
        {next !== null && !listing && (
          <button
            type="button"
            className="secondary-button claude-sessions-more"
            disabled={disabled || busy}
            onClick={() => void loadPage(next, programmatic, dir)}
          >
            Show more
          </button>
        )}
      </section>

      <form onSubmit={readLookup}>
        <label htmlFor="claude-session-id">
          Or a session ID
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
          <span>Reads sessions saved on your Core host only.</span>
          <button
            className="secondary-button"
            disabled={disabled || busy || loading || !lookup.trim()}
          >
            {loading ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <History size={14} />
            )}
            {loading ? "Reading session…" : "Preview session"}
          </button>
        </div>
      </form>

      {preview && (
        <form onSubmit={(e) => void importSession(e)}>
          <section className="session-preview" aria-label="Session preview">
            <div className="session-preview-heading">
              <span>
                <CheckCircle2 size={14} />{" "}
                {existing
                  ? "Already in your workspace"
                  : "Saved conversation found"}
              </span>
              <span>{plural(preview.prompts, "prompt")}</span>
            </div>
            {preview.recent.length > 0 ? (
              <ol
                className="claude-session-recent"
                aria-label="Newest messages"
              >
                {preview.recent.map((m, i) => (
                  <li key={i} data-role={m.role}>
                    <span>{m.role === "user" ? "You" : "Claude"}</span>
                    <p>
                      {m.text}
                      {m.images
                        ? `${m.text ? " " : ""}[${plural(m.images, "image")}]`
                        : ""}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="session-preview-excerpt">
                Claude saved no conversation in this session.
              </p>
            )}
            <div className="session-preview-folder">
              <Folder size={14} />
              <span>{folder || "No folder recorded"}</span>
            </div>
            <p className="session-preview-model">
              Saved {savedAgo(preview.session.lastModified)}
              {preview.session.gitBranch
                ? ` · ${preview.session.gitBranch}`
                : ""}
              {preview.model ? ` · last used ${preview.model}` : ""}
              {preview.subagents
                ? ` · ${plural(preview.subagents, "sub-agent")}`
                : ""}
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
                Agent name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                />
              </label>
              <label>
                Project
                <select
                  aria-label="Project"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">No project</option>
                  {activeProjectList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Folder
                <input value={folder ?? ""} readOnly aria-readonly="true" />
              </label>
              <p className="remote-field-note">
                Claude saved this session under this folder, so it continues
                there.
              </p>
            </fieldset>
          )}
          <p className="session-handoff-note">
            Claude Code doesn’t lock sessions, so Yuzuno can’t tell whether this
            one is still open in a terminal or editor. Close it there before you
            send from here: two programs writing one session can mix up its
            history.
            {!existing &&
              " Adding it runs nothing. Your first message here resumes this same session."}
          </p>
          {error && (
            <p role="alert" className="remote-field-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={close}
              disabled={busy}
            >
              Cancel
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
              {busy ? "Opening…" : existing ? "Open agent" : "Add to workspace"}
            </button>
          </div>
        </form>
      )}
      {!preview && error && (
        <p role="alert" className="remote-field-error">
          {error}
        </p>
      )}
      {disabled && (
        <p className="remote-field-note">
          Session import is disabled in the read-only design preview.
        </p>
      )}
    </div>
  );
}
