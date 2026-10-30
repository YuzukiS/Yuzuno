/**
 * Home's reads and writes (interfaces.md §3). Core owns every fact here; the
 * client only sends what the user explicitly did, with the versions it showed.
 */
import { api, HttpError, post } from "../api";
import type { MessageReceipt } from "../types";
import type { HomeData, MachineLoad } from "./types";

const project = (id: string) => `/projects/${encodeURIComponent(id)}/brief`;

/** A section version exactly as it was displayed when the user marked it. */
export type SeenMark = { key: string; version: number };

export type HomeReplyInput = {
  /** The section replied to; absent for a project-level reply. */
  key?: string;
  agentId: string;
  text: string;
  clientMessageId: string;
  /** The id of the option or approach the user picked, when they picked one. */
  choice?: string;
  /** A reply to a report or status card (T-174): the version of `key` on
   * screen when the user began it, and its title there. Core binds the reply
   * to exactly that version or sends nothing. */
  version?: number;
  title?: string;
  /** A reply to an ask (T-9): the version of the ask the user answered and
   * the Workspace that page showed. Core sends it only while that version is
   * the live, unresolved ask, and marks only that version replied. Never
   * `version`, which is a card's. */
  askVersion?: number;
  workspaceId?: string;
};

export type LinkedRepositories = {
  repositories: {
    id: number;
    fullName: string;
    url: string;
    syncedAt: string | null;
    error: string | null;
  }[];
  links: import("../GitHubLinks").GitHubLink[];
};

export const readHome = (signal?: AbortSignal) =>
  api<HomeData>("/home", { signal });

/** Project Priority: only the display order changes. */
export const saveHomeOrder = (projectIds: string[]) =>
  post<unknown>("/home/order", { projectIds });

export const markSeen = (projectId: string, sections: SeenMark[]) =>
  post<unknown>(`${project(projectId)}/seen`, { sections });

export const deferSection = (projectId: string, key: string, until: string) =>
  post<unknown>(`${project(projectId)}/defer`, { key, until });

export const postReply = (projectId: string, input: HomeReplyInput) =>
  post<MessageReceipt>(`${project(projectId)}/reply`, input);

export const readMachineLoad = (signal?: AbortSignal) =>
  api<MachineLoad>("/machine-load", { signal });

/** The repositories linked to a Project (a list read; it starts no GitHub sync). */
export const readLinkedRepositories = (projectId: string, signal?: AbortSignal) =>
  api<LinkedRepositories>("/collaboration/github_repositories", {
    method: "POST",
    body: JSON.stringify({ projectId }),
    signal,
  });

// Replies keep their client id until Core gives a final answer, including
// across a reload, as the composer's outbox does (useConversationSend.ts).
// Core never delivers one client id twice.
const OUTBOX = "yuzuno.home-outbox.v1";
type Outbound = Omit<HomeReplyInput, "key">;
function loadOutbox(): Record<string, Outbound> {
  try {
    const value = JSON.parse(localStorage.getItem(OUTBOX) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function saveOutbox(value: Record<string, Outbound>) {
  try {
    if (Object.keys(value).length) localStorage.setItem(OUTBOX, JSON.stringify(value));
    else localStorage.removeItem(OUTBOX);
  } catch {
    /* The in-memory attempt still keeps its id for this window. */
  }
}
/** A card reply has its own slot: the same key may also hold an ask's reply. */
export const outboxKey = (workspaceId: string, projectId: string, key?: string, card = false) =>
  JSON.stringify(card ? [workspaceId, projectId, key ?? "", "card"] : [workspaceId, projectId, key ?? ""]);

/** A reply whose delivery is not confirmed yet, kept for its retry. */
export function pendingReply(slot: string): Outbound | undefined {
  return loadOutbox()[slot];
}

/** Forgets a reply Core refused before reading it (it was never submitted). */
export function dropPendingReply(slot: string) {
  const outbox = loadOutbox();
  delete outbox[slot];
  saveOutbox(outbox);
}

export const sentStatus = (receipt: MessageReceipt) =>
  receipt.status === "accepted" || receipt.status === "queued";

/**
 * Sends one reply. Retrying the same text to the same Agent (and, for a card
 * or an ask, the same version) reuses the client id; anything else is a new
 * message. Throws when it was not delivered.
 */
export async function sendReply(
  slot: string,
  projectId: string,
  reply: {
    key?: string; agentId: string; text: string; choice?: string; version?: number; title?: string;
    askVersion?: number; workspaceId?: string;
  },
): Promise<MessageReceipt> {
  const outbox = loadOutbox();
  const kept = outbox[slot];
  const same =
    kept &&
    kept.agentId === reply.agentId &&
    kept.text === reply.text &&
    (kept.choice ?? null) === (reply.choice ?? null) &&
    (kept.version ?? null) === (reply.version ?? null) &&
    (kept.title ?? null) === (reply.title ?? null) &&
    (kept.askVersion ?? null) === (reply.askVersion ?? null) &&
    (kept.workspaceId ?? null) === (reply.workspaceId ?? null);
  const input: Outbound = same
    ? kept
    : {
        agentId: reply.agentId,
        text: reply.text,
        clientMessageId: crypto.randomUUID(),
        ...(reply.choice ? { choice: reply.choice } : {}),
        ...(reply.version !== undefined ? { version: reply.version, title: reply.title ?? "" } : {}),
        ...(reply.askVersion !== undefined ? { askVersion: reply.askVersion, workspaceId: reply.workspaceId ?? "" } : {}),
      };
  saveOutbox({ ...outbox, [slot]: input });
  const settle = () => {
    const current = loadOutbox();
    if (current[slot]?.clientMessageId === input.clientMessageId) {
      delete current[slot];
      saveOutbox(current);
    }
  };
  let receipt: MessageReceipt;
  try {
    receipt = await postReply(projectId, {
      ...(reply.key ? { key: reply.key } : {}),
      ...input,
    });
  } catch (error) {
    // Core says nothing was submitted: sending again is a new message.
    if (error instanceof HttpError && error.code === "message_not_submitted") settle();
    throw error;
  }
  const sent = sentStatus(receipt);
  // Rejected and unknown are final, as in the composer.
  if (sent || receipt.status === "rejected" || receipt.status === "unknown") settle();
  if (!sent)
    throw new Error(
      receipt.error ||
        "Delivery is not confirmed. Check the conversation; this reply will not be sent twice.",
    );
  return receipt;
}
