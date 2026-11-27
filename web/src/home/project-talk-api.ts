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
import type { HomeFile } from "./home-files";
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

/**
 * One deliverable a card's task registered on a result (YN-208), as Core reads it now: its title and one-line note
 * as the result named them, and whether it can be opened. A report is the version the result named (`sectionId`
 * tells it from another report later under its key): live, in History, replaced by a newer version of the same
 * report (`currentVersion`), or no longer on Home. A PR's state is GitHub's as Core last read it.
 */
export type Deliverable =
  | { kind: "report"; title: string; note: string | null; key: string; version: number; sectionId: number;
      state: "live" | "history" | "replaced" | "gone"; currentVersion: number | null }
  | { kind: "pr"; title: string; note: string | null; url: string; repository: string; number: number;
      state: "open" | "merged" | "closed" | "unknown"; observedAt: string | null }
  | { kind: "release"; title: string; note: string | null; url: string; repository: string; tag: string }
  | { kind: "answer"; title: string | null; note: null; text: string };

/**
 * A pull request a card's task links (R-38 §2.6, github/installed.rs), as Core last read it. `installed` is true
 * only once Core kept GitHub's compare saying its merge commit is in the release this Core runs, false once it kept
 * that it is not; null otherwise: not merged, its merge commit not read, no compare kept, a repository without the
 * release's commit, or a Core that runs no release. A milestone or version never decides it.
 */
export type RequestPull = {
  number: number;
  title: string | null;
  url: string;
  repository: string;
  state: "open" | "draft" | "closed" | "merged" | "unknown";
  mergedAt: string | null;
  installed: boolean | null;
};

/** One card a request went to (progress.rs): as Home shows it, and who answers for it now. */
export type RequestCard = {
  sectionId: number | null;
  key: string | null;
  title: string | null;
  live: boolean;
  /**
   * `progress` and `blocker` (R-38): what its lead or executor wrote on the task, at most 280 characters each (a
   * longer one ends in "…"), null when unset; absent from an older Core. `progressAt`: when the progress was last
   * written, as the task's activity keeps it; null without one or when no record says (unknown, never guessed).
   */
  task: { id: string; status: string; archived: boolean; progress?: string | null; progressAt?: string | null; blocker?: string | null };
  responsible: { agentId: string; name: string; kind: "executor" | "lead" | "agent"; state: string } | null;
  /** The task's newest result (YN-208), or null without one; absent from an older Core. */
  result?: { id: string; status: string; reportedAt: string } | null;
  /** What the newest result that named deliverables named (YN-208), or null; absent from an older Core. */
  deliverables?: { resultId: string; reportedAt: string; items: Deliverable[] } | null;
  /** The pull requests its task links, by repository and number (R-38); absent from an older Core. */
  prs?: { items: RequestPull[] };
};

/** Core's line in the conversation (progress.rs): an Ask on one of its cards, or a card's task that ended. */
export type RequestLine =
  | { kind: "ask"; sectionId: number; key: string; title: string; state: "open" | "replied" | "resolved"; at: string; task: string; cardSectionId: number | null }
  | { kind: "done"; task: string; status: "done" | "cancelled" | "archived"; at: string | null; cardSectionId: number | null; title: string | null };

export type RequestReply = {
  n: number;
  text: string;
  textBlocks: TextBlock[] | null;
  /** The images the user attached (YN-134), by their IDs in the Project's images; none from an older Core. */
  images: string[];
  /** The files the user attached (YN-145); none from an older Core. */
  files: HomeFile[];
  at: string;
  messageId: string;
  /** Who it went to and how each message stands; each one's name now (R-45), none from an older Core. */
  deliveredTo: { agentId: string; delivery: Delivery; name?: string }[];
};

/**
 * One of the front desk's notes (progress.rs `notes`): its number and the user's follow-ups it answers (`replyTo`,
 * R-45), as its author named them; null, or none from an older Core, when it named none.
 */
export type RequestNote = { n?: number; note: string; by: RouteAgent; at: string; replyTo?: number[] | null };

/** A request as the Project's page reads it (project_requests.rs `view`). */
export type ProjectRequest = {
  id: string;
  n: number;
  text: string;
  textBlocks: TextBlock[] | null;
  /** The images the user attached (YN-134), by their IDs in the Project's images; none from an older Core. */
  images: string[];
  /** The files the user attached (YN-145); none from an older Core. */
  files: HomeFile[];
  /** The front desk's title for it; null until it gives one. */
  title: string | null;
  createdAt: string;
  frontAgentId: string;
  messageId: string;
  delivery: Delivery;
  replies: RequestReply[];
  notes: RequestNote[];
  routes: RouteEvent[];
  cards: RequestCard[];
  /**
   * ended (YN-184): every card's task ended, and the user has not confirmed it since; answered (YN-136): no card, the
   * front desk answered it in its note, nothing was said since, and not confirmed since; done: the user confirmed it,
   * and nothing changed after.
   */
  state: "waiting" | "doing" | "ended" | "answered" | "done";
  /** The user's newest confirmation (YN-184), or null; none from an older Core. */
  confirmedAt?: string | null;
  progress: { cards: number; ended: number };
  lines: RequestLine[];
};

/** The release this Core runs (R-38 §2.6): its manifest's id, version and full commit. */
export type InstalledRelease = { releaseId: string; version: string; gitSha: string };

export type RequestPage = {
  requests: ProjectRequest[];
  hasMore: boolean;
  /**
   * On the first page, the older requests Core keeps beside it (YN-237): each going on (a task not ended, or never
   * routed and waiting for the front desk) or routed to a task a live card is of, newest first. Not the page's own:
   * `hasMore` and the next page go by `requests`. Absent from an older Core.
   */
  kept?: ProjectRequest[];
  /** The release this Core runs; null for a source build, absent from an older Core. */
  installedRelease?: InstalledRelease | null;
  /**
   * How many PRs linked to the Project's tasks are merged and kept as not in that release; null without a release
   * or while any merged one is not known yet, absent from an older Core.
   */
  mergedAfterInstalled?: number | null;
};

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export const readFrontDesk = (projectId: string, signal?: AbortSignal) =>
  api<FrontDesk>(`${base(projectId)}/front-desk`, { signal });

/** The user's choice of front desk, or none (`null`), against the version read. */
export const saveFrontDesk = (projectId: string, expectedVersion: number, agentId: string | null) =>
  api<FrontDesk>(`${base(projectId)}/front-desk`, { method: "PUT", body: JSON.stringify({ expectedVersion, agentId }) });

/** A request as Core gives it: a Core from before Home's images (YN-134) lists none, and one from before its files (YN-145) either. */
const shown = (request: ProjectRequest): ProjectRequest => ({
  ...request,
  images: request.images ?? [],
  files: request.files ?? [],
  replies: request.replies.map((reply) => ({ ...reply, images: reply.images ?? [], files: reply.files ?? [] })),
});

/** The Project's requests, newest first: the newest page, or those numbered below `before`. */
export const readRequests = (projectId: string, before?: number, signal?: AbortSignal) =>
  api<RequestPage>(`${base(projectId)}/requests${before ? `?before=${before}` : ""}`, { signal }).then((page) => ({
    ...page,
    requests: page.requests.map(shown),
    kept: (page.kept ?? []).map(shown),
  }));

/**
 * The request Core answered a new request with (project_requests.rs `submit`), as the page reads it: only one whole
 * enough to draw a block from, and the one these words made; else none, and the page reads its requests for it.
 */
function answered(value: unknown, clientMessageId: string): ProjectRequest | null {
  const request = value as Partial<ProjectRequest> | null | undefined;
  if (!request || typeof request !== "object" || typeof request.n !== "number" || typeof request.id !== "string") return null;
  if (request.messageId !== clientMessageId || typeof request.text !== "string" || typeof request.createdAt !== "string") return null;
  const lists = [request.replies, request.notes, request.routes, request.cards, request.lines];
  if (!lists.every(Array.isArray) || typeof request.state !== "string" || typeof request.progress !== "object" || !request.progress) return null;
  return shown(request as ProjectRequest);
}

/** The user's confirmation that request R-n is done (YN-184): only the user's page sends it. */
export const confirmRequest = (projectId: string, n: number, workspaceId: string) =>
  post<{ request: ProjectRequest }>(`${base(projectId)}/requests/${n}/confirm`, { workspaceId });

/** Whether a message's receipt says it reached its Agent. */
export const delivered = (delivery: Delivery) => delivery === "accepted" || delivery === "queued";

/**
 * What the user sent and Core has not answered yet, kept in this browser
 * across reloads under Home's outbox slot (`outboxKey`) for a new request,
 * or for a follow-up to request `n`: the same words again go with the same
 * client ID, so Core never keeps or sends them twice.
 */
type Outbound = { text: string; textBlocks?: TextBlock[]; images?: string[]; files?: HomeFile[]; clientMessageId: string; at: string };
const outbox = draftStore<Outbound>("yuzuno.project-talk-outbox.v1");

export const talkSlot = (workspaceId: string, projectId: string, request?: number) =>
  outboxKey(workspaceId, projectId, request ? `request:${request}` : "request");

/** The words sent in this slot whose delivery is not confirmed. */
export const pendingWords = (slot: string): Outbound | undefined => outbox.load()[slot];

/** What the user says: the words, their pasted blocks, the images attached (YN-134) by their IDs, and the files (YN-145). */
export type Words = { text: string; textBlocks?: TextBlock[]; images?: string[]; files?: HomeFile[] };

const sameIds = (a?: readonly string[], b?: readonly string[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const sameBlocks = (a?: readonly TextBlock[] | null, b?: readonly TextBlock[] | null) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const sameFileRefs = (a?: readonly HomeFile[], b?: readonly HomeFile[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Forgets the words kept in `slot`: Core keeps them now (its request or follow-up is listed), or the user discarded them. */
export const forgetWords = (slot: string) => outbox.save(slot, null);

/**
 * Sends the user's words: a new request (`request` absent) or a follow-up to
 * request `request`. The words the slot kept are sent again under their
 * client ID; other words are a new message. Once Core answers it keeps the
 * message, listed with how its delivery stands and sent again from there
 * (`resendKept`), and the slot is cleared; so is it when Core refused it
 * before keeping it. Without an answer the words stay in the slot. A new
 * request comes back as Core answered it (`request`), when whole (YN-226);
 * the client ID is in the slot before anything is sent (`pendingWords`).
 */
export async function sendWords(slot: string, projectId: string, workspaceId: string, words: Words, request?: number) {
  const kept = pendingWords(slot);
  const same = kept && kept.text === words.text && sameBlocks(kept.textBlocks, words.textBlocks) && sameIds(kept.images, words.images) &&
    sameFileRefs(kept.files, words.files);
  const record: Outbound = same
    ? kept
    : {
        text: words.text,
        ...(words.textBlocks?.length ? { textBlocks: words.textBlocks } : {}),
        ...(words.images?.length ? { images: words.images } : {}),
        ...(words.files?.length ? { files: words.files } : {}),
        clientMessageId: randomId(),
        at: new Date().toISOString(),
      };
  outbox.save(slot, record);
  const settle = () => {
    if (pendingWords(slot)?.clientMessageId === record.clientMessageId) forgetWords(slot);
  };
  const path = request ? `${base(projectId)}/requests/${request}/replies` : `${base(projectId)}/requests`;
  try {
    const answer = await post<{ receipt?: MessageReceipt; receipts?: MessageReceipt[]; request?: unknown; reply?: { n?: unknown } }>(path, {
      workspaceId,
      text: record.text,
      ...(record.textBlocks ? { textBlocks: record.textBlocks } : {}),
      // Only with images or files: words without go to an older Core as before.
      ...(record.images?.length ? { images: record.images } : {}),
      ...(record.files?.length ? { files: record.files } : {}),
      clientMessageId: record.clientMessageId,
    });
    settle();
    return {
      clientMessageId: record.clientMessageId,
      receipts: answer.receipts ?? (answer.receipt ? [answer.receipt] : []),
      request: request ? null : answered(answer.request, record.clientMessageId),
      reply: request && typeof answer.reply?.n === "number" ? answer.reply.n : null,
    };
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
export function resendKept(
  projectId: string,
  workspaceId: string,
  kept: { text: string; textBlocks: TextBlock[] | null; images?: string[]; files?: HomeFile[]; messageId: string },
  request?: number,
) {
  const path = request ? `${base(projectId)}/requests/${request}/replies` : `${base(projectId)}/requests`;
  return post<unknown>(path, {
    workspaceId,
    text: kept.text,
    ...(kept.textBlocks ? { textBlocks: kept.textBlocks } : {}),
    ...(kept.images?.length ? { images: kept.images } : {}),
    ...(kept.files?.length ? { files: kept.files } : {}),
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
