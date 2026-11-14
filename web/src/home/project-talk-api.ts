/**
 * Talking to a Project (YN-86 §4.1–4.5): its front desk, the requests the
 * user made to it and what routing made of them, as Core's browser routes
 * give them (core/src/project_requests.rs and its progress.rs, routes.rs).
 * Core owns every fact; the page only sends what the user said, with the
 * client ID it keeps until Core gives a final answer, as Home's outbox does
 * for a reply (home-api.ts).
 */
import { api, HttpError, post } from "../api";
import type { TextBlock } from "../message-content";
import { randomId } from "../random-id";
import type { MessageReceipt } from "../types";
import { outboxKey } from "./home-api";
import { draftStore } from "./reply-drafts";

/** A Project's front desk (front_desk.rs): the lead chosen, and who requests go to now. */
export type FrontDesk = { version: number; agentId: string | null; effectiveAgentId: string | null };

/** An Agent as a route names it: its name as Core has it now ("" when gone). */
export type RouteAgent = { agentId: string; name: string };

/** How a message's receipt stands (MessageReceipt's status), or null without one. */
export type Delivery = MessageReceipt["status"] | null;

/** One route of a request, or the user's reassignment of one of its cards (routes.rs `json`). */
export type RouteEvent = {
  kind: "card" | "existing" | "answer" | "reassign";
  index: number | null;
  /** The request it routed, by number; null for a reassignment. */
  request: number | null;
  at: string;
  state: "pending" | "done" | "failed";
  why: string;
  /** Who made it: the front desk; null for the user. */
  by: RouteAgent | null;
  to: RouteAgent | null;
  /** The task's key now (YN-92). */
  task: string | null;
  cardKey: string | null;
  sectionId: number | null;
  /** A new card's title. */
  title?: string;
  /** A reassignment's earlier responsible Agent. */
  from?: RouteAgent | null;
  error?: string;
};

/** One card a request went to (progress.rs): as Home shows it, and who answers for it now. */
export type RequestCard = {
  sectionId: number | null;
  key: string | null;
  title: string | null;
  live: boolean;
  task: { id: string; status: string; archived: boolean };
  responsible: { agentId: string; name: string; kind: "executor" | "lead" | "agent"; state: string } | null;
};

/** Core's line in the conversation (progress.rs): an Ask on one of its cards, or a card's task that ended. */
export type RequestLine =
  | { kind: "ask"; sectionId: number; key: string; title: string; state: "open" | "replied" | "resolved"; at: string; task: string; cardSectionId: number | null }
  | { kind: "done"; task: string; status: "done" | "cancelled" | "archived"; at: string | null; cardSectionId: number | null; title: string | null };

export type RequestReply = {
  n: number;
  text: string;
  textBlocks: TextBlock[] | null;
  at: string;
  messageId: string;
  deliveredTo: { agentId: string; delivery: Delivery }[];
};

/** A request as the Project's page reads it (project_requests.rs `view`). */
export type ProjectRequest = {
  id: string;
  n: number;
  text: string;
  textBlocks: TextBlock[] | null;
  /** The front desk's title for it; null until it gives one. */
  title: string | null;
  createdAt: string;
  frontAgentId: string;
  messageId: string;
  delivery: Delivery;
  replies: RequestReply[];
  notes: { note: string; by: RouteAgent; at: string }[];
  routes: RouteEvent[];
  cards: RequestCard[];
  /** answered (YN-136): no card, the front desk answered it in its note, and nothing was said since. */
  state: "waiting" | "doing" | "done" | "answered";
  progress: { cards: number; ended: number };
  lines: RequestLine[];
};

export type RequestPage = { requests: ProjectRequest[]; hasMore: boolean };

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const readFrontDesk = (projectId: string, signal?: AbortSignal) =>
  api<FrontDesk>(`${base(projectId)}/front-desk`, { signal });

/** The user's choice of front desk, or none (`null`), against the version read. */
export const saveFrontDesk = (projectId: string, expectedVersion: number, agentId: string | null) =>
  api<FrontDesk>(`${base(projectId)}/front-desk`, { method: "PUT", body: JSON.stringify({ expectedVersion, agentId }) });

/** The Project's requests, newest first: the newest page, or those numbered below `before`. */
export const readRequests = (projectId: string, before?: number, signal?: AbortSignal) =>
  api<RequestPage>(`${base(projectId)}/requests${before ? `?before=${before}` : ""}`, { signal });

/** Whether a message's receipt says it reached its Agent. */
export const delivered = (delivery: Delivery) => delivery === "accepted" || delivery === "queued";

/**
 * What the user sent and Core has not answered yet, kept in this browser
 * across reloads under Home's outbox slot (`outboxKey`) for a new request,
 * or for a follow-up to request `n`: the same words again go with the same
 * client ID, so Core never keeps or sends them twice.
 */
type Outbound = { text: string; textBlocks?: TextBlock[]; clientMessageId: string; at: string };
const outbox = draftStore<Outbound>("yuzuno.project-talk-outbox.v1");

export const talkSlot = (workspaceId: string, projectId: string, request?: number) =>
  outboxKey(workspaceId, projectId, request ? `request:${request}` : "request");

/** The words sent in this slot whose delivery is not confirmed. */
export const pendingWords = (slot: string): Outbound | undefined => outbox.load()[slot];

export type Words = { text: string; textBlocks?: TextBlock[] };

const sameBlocks = (a?: readonly TextBlock[] | null, b?: readonly TextBlock[] | null) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Forgets the words kept in `slot`: Core keeps them now (its request or follow-up is listed), or the user discarded them. */
export const forgetWords = (slot: string) => outbox.save(slot, null);

/**
 * Sends the user's words: a new request (`request` absent) or a follow-up to
 * request `request`. The words the slot kept are sent again under their
 * client ID; other words are a new message. Once Core answers it keeps the
 * message, listed with how its delivery stands and sent again from there
 * (`resendKept`), and the slot is cleared; so is it when Core refused it
 * before keeping it. Without an answer the words stay in the slot.
 */
export async function sendWords(slot: string, projectId: string, workspaceId: string, words: Words, request?: number) {
  const kept = pendingWords(slot);
  const same = kept && kept.text === words.text && sameBlocks(kept.textBlocks, words.textBlocks);
  const record: Outbound = same
    ? kept
    : { text: words.text, ...(words.textBlocks?.length ? { textBlocks: words.textBlocks } : {}), clientMessageId: randomId(), at: new Date().toISOString() };
  outbox.save(slot, record);
  const settle = () => {
    if (pendingWords(slot)?.clientMessageId === record.clientMessageId) forgetWords(slot);
  };
  const path = request ? `${base(projectId)}/requests/${request}/replies` : `${base(projectId)}/requests`;
  try {
    const answer = await post<{ receipt?: MessageReceipt; receipts?: MessageReceipt[] }>(path, {
      workspaceId,
      text: record.text,
      ...(record.textBlocks ? { textBlocks: record.textBlocks } : {}),
      clientMessageId: record.clientMessageId,
    });
    settle();
    return { clientMessageId: record.clientMessageId, receipts: answer.receipts ?? (answer.receipt ? [answer.receipt] : []) };
  } catch (error) {
    // Core says nothing was kept or sent: sending again is a new message.
    if (error instanceof HttpError && error.code === "message_not_submitted") settle();
    throw error;
  }
}

/**
 * Sends again, exactly as kept, a request or follow-up Core keeps whose
 * delivery is not confirmed: its own words and client ID, so Core finds it
 * and sends only what did not arrive.
 */
export function resendKept(projectId: string, workspaceId: string, kept: { text: string; textBlocks: TextBlock[] | null; messageId: string }, request?: number) {
  const path = request ? `${base(projectId)}/requests/${request}/replies` : `${base(projectId)}/requests`;
  return post<unknown>(path, {
    workspaceId,
    text: kept.text,
    ...(kept.textBlocks ? { textBlocks: kept.textBlocks } : {}),
    clientMessageId: kept.messageId,
  });
}

/** Who takes a card on its reassignment (reassign.rs): an open member of the Project, or a new executor from a template. */
export type ReassignTo = { agentId: string } | { executor: { templateId: string } };

/** What a reassignment answers: the route it recorded, and the earlier executor's release, if there was one to make. */
export type Reassigned = { route: RouteEvent; released: { agentId: string; note: string } | null };

/**
 * The user's reassignment of a card (YN-86 §4.2, §4.3): Core dispatches the
 * card's task to its new responsible Agent first, then releases the earlier
 * executor (archiving first, never cut off). The same client ID again is the
 * same reassignment: a release that failed is made then.
 */
export const reassignCard = (projectId: string, sectionId: number, input: { workspaceId: string; to: ReassignTo; why?: string; clientRequestId: string }) =>
  post<Reassigned>(`${base(projectId)}/cards/${sectionId}/reassign`, input);
