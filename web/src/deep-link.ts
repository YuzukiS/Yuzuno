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

/**
 * The message a pasted or clicked link names, or null when it is not one.
 * Any origin is accepted: the same Workspace may be opened from another
 * client or port, so the Workspace ID decides, not the address.
 */
export function parseMessageLink(text: string): MessageLink | null {
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  let hash: string;
  try {
    hash = new URL(value, "http://link.invalid/").hash;
  } catch {
    return null;
  }
  if (!hash.startsWith(PATH)) return null;
  const params = new URLSearchParams(hash.slice(PATH.length));
  const link: Partial<Record<(typeof FIELDS)[keyof typeof FIELDS], string>> = {};
  for (const [key, raw] of params) {
    const field = FIELDS[key as keyof typeof FIELDS];
    if (!field || field in link || !ID.test(raw)) return null;
    link[field] = raw;
  }
  if (!link.workspaceId || !link.agentId || !link.turnId) return null;
  return link as MessageLink;
}

/** Copying and opening message links, given by the app to what it shows. */
export interface MessageLinkApi {
  /** The link to a message of `agent`, or null where links are not offered. */
  href(agent: Agent, turnId: string, itemId?: string): string | null;
  open(link: MessageLink): void;
}
export const MessageLinks = createContext<MessageLinkApi | null>(null);
export const useMessageLinks = () => useContext(MessageLinks);
