// Claude Code sessions saved on this machine, for an explicit import into
// Yuzuno (T-27). Read only through the SDK's session readers (listSessions,
// getSessionInfo, getSessionMessages, listSubagents): nothing here resumes,
// forks, renames, tags or deletes a session, and no query is started, so
// no hook runs and no model is called. Claude Code keeps no lock on a
// session and the SDK reports no owner, so whether another Claude Code is
// using one is not known here; only its last saved time is.
import { isAbsolute } from 'node:path';

const NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SESSION_PAGE = 20;
export const MAX_SESSION_PAGE = 50;
// The newest conversation messages a preview shows, and how much of each.
const PREVIEW_MESSAGES = 6;
const PREVIEW_CHARS = 400;

const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const millis = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

function reader(api, name) {
  if (typeof api?.[name] !== 'function') throw new Error(`This Claude SDK has no ${name}; saved sessions cannot be read`);
  return api[name];
}

function sessionId(command) {
  if (typeof command.sessionId !== 'string' || !NATIVE_UUID.test(command.sessionId)) throw new Error('Invalid native session UUID');
  return command.sessionId;
}

/** What the list and preview show of a session: no transcript content but its title and first prompt. */
export function sessionFacts(info) {
  return {
    sessionId: info.sessionId,
    title: text(info.customTitle, 200) ?? text(info.summary, 200),
    firstPrompt: text(info.firstPrompt, 200),
    cwd: text(info.cwd, 4096),
    gitBranch: text(info.gitBranch, 200),
    tag: text(info.tag, 200),
    lastModified: millis(info.lastModified),
    createdAt: millis(info.createdAt),
    fileSize: Number.isSafeInteger(info.fileSize) && info.fileSize >= 0 ? info.fileSize : null,
  };
}

/**
 * One page of saved sessions, newest first: all of them, or those of one
 * folder (`dir`, with its git worktrees). By default only sessions a person
 * started (as terminal /resume lists them); `programmatic` adds SDK and
 * daemon sessions, Yuzuno's own Agents' among them. The SDK reads file
 * metadata to sort and only this page's files for their titles.
 */
export async function listSessionsPage(api, command) {
  const list = reader(api, 'listSessions');
  const limit = Number.isSafeInteger(command.limit) && command.limit > 0 ? Math.min(command.limit, MAX_SESSION_PAGE) : SESSION_PAGE;
  const offset = Number.isSafeInteger(command.offset) && command.offset >= 0 ? command.offset : 0;
  if (command.programmatic !== undefined && typeof command.programmatic !== 'boolean') throw new Error('Invalid programmatic filter');
  if (command.dir !== undefined && (typeof command.dir !== 'string' || !isAbsolute(command.dir))) throw new Error('dir must be an absolute path');
  // One more than the page says whether another follows.
  const found = await list({ limit: limit + 1, offset, includeProgrammatic: command.programmatic === true,
    ...(command.dir ? { dir: command.dir } : {}) });
  const page = (Array.isArray(found) ? found : []).slice(0, limit);
  return {
    sessions: page.filter(info => typeof info?.sessionId === 'string' && NATIVE_UUID.test(info.sessionId)).map(sessionFacts),
    offset,
    next: Array.isArray(found) && found.length > limit ? offset + limit : null,
  };
}

/** A session's metadata by id, from its own file only; null when Claude Code has no such session. */
export async function sessionInfo(api, command) {
  const id = sessionId(command);
  const info = await reader(api, 'getSessionInfo')(id, {});
  return { session: info?.sessionId === id ? sessionFacts(info) : null };
}

/** A main-chain message as a preview shows it, or null when it is not conversation. */
function said(saved) {
  if (saved?.type !== 'user' && saved?.type !== 'assistant') return null;
  if (saved.parent_tool_use_id || saved.is_meta === true || saved.isCompactSummary === true || saved.isCompletedLocalCommand === true) return null;
  const message = saved.message && typeof saved.message === 'object' ? saved.message : {};
  if (saved.type === 'assistant' && message.model === '<synthetic>') return null;
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  if (saved.type === 'user' && content.some(b => b?.type === 'tool_result')) return null;
  const body = content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
  const images = saved.type === 'user' ? content.filter(b => b?.type === 'image').length : 0;
  if (!body && !images) return null;
  return {
    role: saved.type,
    text: body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body,
    ...(images ? { images } : {}),
    at: typeof saved.timestamp === 'string' ? saved.timestamp : null,
  };
}

/**
 * What a person needs to recognize a session before importing it: its
 * facts, how much Claude saved, and its newest few messages. Read on
 * demand for the one session chosen.
 */
export async function sessionPreview(api, command) {
  const { session } = await sessionInfo(api, command);
  if (!session) return { session: null };
  const where = session.cwd ? { dir: session.cwd } : {};
  const saved = await reader(api, 'getSessionMessages')(session.sessionId, { ...where, includeSystemMessages: true });
  const messages = Array.isArray(saved) ? saved : [];
  const shown = messages.map(said).filter(Boolean);
  // A compaction summary is saved as meta too.
  const first = messages.find(m => (m?.type === 'user' || m?.type === 'assistant') && !m.parent_tool_use_id
    && (m.is_meta !== true || m.isCompactSummary === true));
  const model = messages.findLast(m => m?.type === 'assistant' && typeof m.message?.model === 'string' && m.message.model !== '<synthetic>')?.message.model;
  const agents = typeof api.listSubagents === 'function' ? await api.listSubagents(session.sessionId, where) : [];
  return {
    session,
    saved: messages.length,
    prompts: shown.filter(m => m.role === 'user').length,
    images: shown.reduce((n, m) => n + (m.images ?? 0), 0),
    // The saved chain starts at a compaction summary: what came before is not in it.
    compacted: first?.isCompactSummary === true,
    subagents: Array.isArray(agents) ? agents.length : 0,
    model: text(model, 200),
    recent: shown.slice(-PREVIEW_MESSAGES),
  };
}

/** The read of a session for an import: its id and the folder Claude saved it under. */
export function importTarget(command) {
  const id = sessionId(command);
  if (typeof command.dir !== 'string' || !isAbsolute(command.dir)) throw new Error('dir must be an absolute path');
  return { sessionId: id, dir: command.dir };
}
