import { createContext, useContext } from "react";
import type { Agent } from "./types";

/**
 * A link to one message in one Agent's conversation (T-166). It names the
 * message by the identities Core keeps (Workspace, Agent, Turn, Item) and the
 * Agent's native session when it was copied, never by a list position. It
 * holds no token and no message text, and opening it only navigates: it never
 * answers, approves or changes anything.
 */
export interface MessageLink {
  workspaceId: string;
  agentId: string;
  turnId: string;
  itemId?: string;
  /** The Agent's native session when the link was copied. */
  threadId?: string;
}

const PATH = "#/message?";
const FIELDS = { w: "workspaceId", a: "agentId", t: "turnId", i: "itemId", s: "threadId" } as const;
// IDs come from Core and the native runtimes; they are opaque, but never
// blank, spaced or control characters, and never long.
const ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/;

/** The link to a message, on `base` (this client's page, without query or fragment). */
export function messageLinkHref(base: string, link: MessageLink): string {
  const params = new URLSearchParams();
  for (const [key, field] of Object.entries(FIELDS)) {
    const value = link[field];
    if (value) params.set(key, value);
  }
  return `${base}${PATH}${params}`;
}

/** The fields a link's fragment after `path` gives, by `fields`; null when
 * it is not such a link, or names a field twice, one it doesn't know, or an
 * ID that can't be one. */
function linkFields<F extends string>(text: string, path: string, fields: Record<string, F>): Partial<Record<F, string>> | null {
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  let hash: string;
  try {
    hash = new URL(value, "http://link.invalid/").hash;
  } catch {
    return null;
  }
  if (!hash.startsWith(path)) return null;
  const params = new URLSearchParams(hash.slice(path.length));
  const link: Partial<Record<F, string>> = {};
  for (const [key, raw] of params) {
    const field = fields[key];
    if (!field || field in link || !ID.test(raw)) return null;
    link[field] = raw;
  }
  return link;
}

/**
 * The message a pasted or clicked link names, or null when it is not one.
 * Any origin is accepted: the same Workspace may be opened from another
 * client or port, so the Workspace ID decides, not the address.
 */
export function parseMessageLink(text: string): MessageLink | null {
  const link = linkFields(text, PATH, FIELDS);
  if (!link?.workspaceId || !link.agentId || !link.turnId) return null;
  return link as MessageLink;
}

/**
 * A link to one Agent (T-184): its Workspace and the Agent, nothing else, so
 * an Agent that has no Turn yet can be linked too. Opening it only selects
 * that Agent: nothing is reconnected, sent, created or changed.
 */
export interface AgentLink {
  workspaceId: string;
  agentId: string;
}

const AGENT_PATH = "#/agent?";
const AGENT_FIELDS = { w: "workspaceId", a: "agentId" } as const;

/** The link to an Agent, on `base` (this client's page, without query or fragment). */
export function agentLinkHref(base: string, link: AgentLink): string {
  return `${base}${AGENT_PATH}${new URLSearchParams({ w: link.workspaceId, a: link.agentId })}`;
}

/** The Agent a pasted or opened link names, or null when it is not one;
 * any origin, as for a message link. */
export function parseAgentLink(text: string): AgentLink | null {
  const link = linkFields(text, AGENT_PATH, AGENT_FIELDS);
  if (!link?.workspaceId || !link.agentId) return null;
  return link as AgentLink;
}

/**
 * A link to a Workspace's Home (T-200): where a push notification about an
 * Ask, or several updates at once, opens. It names the Workspace and, for a
 * Project's page, that project (YN-86). Opening it only shows Home.
 */
export interface HomeLink {
  workspaceId: string;
  /** The Project whose page to open; absent for the whole of Home. */
  projectId?: string;
}

const HOME_PATH = "#/home?";
const HOME_FIELDS = { w: "workspaceId", p: "projectId" } as const;

/** The link to a Workspace's Home, on `base` (this client's page, without query or fragment). */
export function homeLinkHref(base: string, link: HomeLink): string {
  const params = new URLSearchParams({ w: link.workspaceId });
  if (link.projectId) params.set("p", link.projectId);
  return `${base}${HOME_PATH}${params}`;
}

/** The Home an opened link names, or null when it is not one. */
export function parseHomeLink(text: string): HomeLink | null {
  const link = linkFields(text, HOME_PATH, HOME_FIELDS);
  return link?.workspaceId ? (link as HomeLink) : null;
}

/**
 * A link to one Home report (T-18): a section of a Project's Brief, at the
 * version it was linked at, named by the identities Core keeps (Workspace,
 * Project, section key and version, and the section's identity on Home, which
 * tells it from another later written under the same key). It holds no token,
 * path or text, and opening it only shows the report: it never answers, marks
 * seen or changes anything.
 */
export interface ReportLink {
  workspaceId: string;
  projectId: string;
  key: string;
  version: number;
  /** The section's identity on Home (its `id`) when the link was made. */
  sectionId?: number;
}

const REPORT_PATH = "#/report?";
const REPORT_FIELDS = { w: "workspaceId", p: "projectId", k: "key", v: "version", s: "sectionId" } as const;
// A Brief section key (brief-contract.ts, BRIEF_KEY_PATTERN): a topic, or topic/sub.
const SECTION_KEY = /^[a-z0-9][a-z0-9-]{0,47}(\/[a-z0-9][a-z0-9-]{0,47})?$/;
const COUNT = /^[1-9][0-9]{0,14}$/;

/** The link to a Home report, on `base` (this client's page, without query or fragment). */
export function reportLinkHref(base: string, link: ReportLink): string {
  const params = new URLSearchParams({ w: link.workspaceId, p: link.projectId, k: link.key, v: String(link.version) });
  if (link.sectionId !== undefined) params.set("s", String(link.sectionId));
  return `${base}${REPORT_PATH}${params}`;
}

/** The report a pasted or clicked link names, or null when it is not one. */
export function parseReportLink(text: string): ReportLink | null {
  const link = linkFields(text, REPORT_PATH, REPORT_FIELDS);
  if (!link?.workspaceId || !link.projectId || !link.key || !link.version) return null;
  if (!SECTION_KEY.test(link.key) || !COUNT.test(link.version) || (link.sectionId !== undefined && !COUNT.test(link.sectionId))) return null;
  return {
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    key: link.key,
    version: Number(link.version),
    ...(link.sectionId !== undefined ? { sectionId: Number(link.sectionId) } : {}),
  };
}

/** What an address or pasted text links to: a message, an Agent, a Workspace's Home or a Home report. */
export type AppLink =
  | ({ kind: "message" } & MessageLink)
  | ({ kind: "agent" } & AgentLink)
  | ({ kind: "home" } & HomeLink)
  | ({ kind: "report" } & ReportLink);
export function parseAppLink(text: string): AppLink | null {
  const message = parseMessageLink(text);
  if (message) return { kind: "message", ...message };
  const agent = parseAgentLink(text);
  if (agent) return { kind: "agent", ...agent };
  const report = parseReportLink(text);
  if (report) return { kind: "report", ...report };
  const home = parseHomeLink(text);
  return home ? { kind: "home", ...home } : null;
}

/** Copying and opening message links, given by the app to what it shows. */
export interface MessageLinkApi {
  /** The link to a message of `agent`, or null where links are not offered. */
  href(agent: Agent, turnId: string, itemId?: string): string | null;
  open(link: MessageLink): void;
  /** The link to a section's report on Home (T-18), or null where links are not offered. */
  reportHref(link: Omit<ReportLink, "workspaceId">): string | null;
  /** Opens a report link; `from`, the message it was clicked in, is where Back returns. */
  openReport(link: ReportLink, from?: { turnId: string; itemId?: string }): void;
}
export const MessageLinks = createContext<MessageLinkApi | null>(null);
export const useMessageLinks = () => useContext(MessageLinks);
