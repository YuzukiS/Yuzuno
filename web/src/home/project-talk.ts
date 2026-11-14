import { readDeviceValue, saveDeviceValue } from "../device-storage";
import type { CardBinding } from "./types";
import { delivered, type ProjectRequest, type RequestCard, type RequestLine, type RequestReply } from "./project-talk-api";

/**
 * "Talk to the project" (YN-86 §4.1, §4.3–4.5) as pure facts from Core's
 * requests: which side shows, each request's state word, the requests list
 * in its order, and the conversation in time order. Nothing here guesses
 * what the user's words mean: every line comes from a field Core gave.
 */

/** A reassignment's why, as Core takes it: at most 120 characters, one short line (routes.rs MAX_LINE, in UTF-16 units). */
export const MAX_LINE_CHARS = 120;

/** What "Talk to the project" shows (§4.1, v8): the requests, both side by side, or the conversation. */
export const talkViews = ["requests", "both", "chat"] as const;
export type TalkView = (typeof talkViews)[number];

/**
 * A window at most this wide has no room for the two sides side by side:
 * two tabs, the requests first (§4.1). The approved preview v8 measures the
 * window (innerWidth <= 900), so a 940px window shows both, its requests side
 * narrower than 460px (§4.1).
 */
export const TALK_NARROW = 900;

/** What a narrow column shows for a choice: one side; "both" is the requests. */
export const shownView = (view: TalkView, narrow: boolean): TalkView =>
  narrow && view === "both" ? "requests" : view;

/** Whether a side is open in a view. */
export const sideOpen = (view: TalkView, side: "requests" | "chat") => view === "both" || view === side;

// Kept per Project on this device (device-storage.ts): nothing goes to Core.
const viewKey = (workspaceId: string, projectId: string) => `yuzuno.projectTalkView.${workspaceId}.${projectId}`;

/** This device's choice for a Project: "both" until one is made (§4.1). */
export function savedView(workspaceId: string, projectId: string): TalkView {
  if (!workspaceId) return "both";
  const saved = readDeviceValue(viewKey(workspaceId, projectId));
  return talkViews.includes(saved as TalkView) ? (saved as TalkView) : "both";
}

/** Keeps the choice on this device; a choice the browser refuses to keep still applies in this window. */
export function saveView(workspaceId: string, projectId: string, view: TalkView) {
  if (workspaceId) saveDeviceValue(viewKey(workspaceId, projectId), view);
}

/** A request's state word (§4.3): not confirmed delivered, waiting for the front desk, in progress, done, or answered with no card (YN-136). */
export type RequestState = "unconfirmed" | "waiting" | "doing" | "done" | "answered";

/** A request nothing more is coming for: every card's task ended, or answered with no card. */
export const settled = (request: ProjectRequest) => request.state === "done" || request.state === "answered";

export const requestState = (request: ProjectRequest): RequestState =>
  !delivered(request.delivery) ? "unconfirmed" : request.state;

/** Whether a follow-up's receipts all say it arrived. */
export const replyDelivered = (reply: RequestReply) =>
  reply.deliveredTo.length > 0 && reply.deliveredTo.every((to) => delivered(to.delivery));

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/** When something last happened on a request: its words, a follow-up, a note, a route, or one of Core's lines. */
export function lastActivity(request: ProjectRequest) {
  return Math.max(
    time(request.createdAt),
    ...request.replies.map((r) => time(r.at)),
    ...request.notes.map((n) => time(n.at)),
    ...request.routes.map((r) => time(r.at)),
    ...request.lines.map((l) => time(l.at)),
  );
}

/** The requests list (§4.1): those going on first, by latest activity; the settled ones (done or answered) apart, the same way. */
export function requestGroups(requests: readonly ProjectRequest[]) {
  const order = (list: ProjectRequest[]) =>
    list.sort((a, b) => lastActivity(b) - lastActivity(a) || b.n - a.n);
  return {
    open: order(requests.filter((r) => !settled(r))),
    done: order(requests.filter(settled)),
  };
}

/**
 * The card a request was joined to (§4.4): when every route that put it on
 * a card joined an existing one, the first of those cards; else null.
 */
export function mergedInto(request: ProjectRequest): RequestCard | null {
  const toCards = request.routes.filter((r) => r.state === "done" && (r.kind === "card" || r.kind === "existing"));
  if (!toCards.length || toCards.some((r) => r.kind !== "existing")) return null;
  return request.cards[0] ?? null;
}

/** A request's card as a card's foot reads it (card-responsible.ts): its task and who answers for it. */
export const cardBinding = (card: RequestCard): CardBinding => ({
  task: { id: card.task.id, title: card.title ?? "", status: card.task.status, archived: card.task.archived },
  responsible: card.responsible,
});

/** The title a request's card is shown with: the card's, else the task's key. */
export const cardTitle = (card: RequestCard) => card.title || card.key || card.task.id;

/** The first characters of the user's words, for a request the front desk has not titled yet (§4.1). */
export function untitledHint(text: string, length = 20) {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.slice(0, length).join("") + (chars.length > length ? "…" : "");
}

/** One entry of the conversation (§4.1), in time order. */
export type TalkItem =
  | { kind: "mine"; request: ProjectRequest; at: number }
  | { kind: "looking"; request: ProjectRequest; at: number }
  | { kind: "note"; request: ProjectRequest; note: ProjectRequest["notes"][number]; at: number }
  | { kind: "reply"; request: ProjectRequest; reply: RequestReply; at: number }
  | { kind: "line"; request: ProjectRequest; line: RequestLine; at: number };

const RANK: Record<TalkItem["kind"], number> = { mine: 0, looking: 1, note: 2, reply: 3, line: 4 };

/** A stable key for an item, for React and for finding it again. */
export function itemKey(item: TalkItem) {
  const n = item.request.n;
  switch (item.kind) {
    case "mine":
    case "looking":
      return `${item.kind}:${n}`;
    case "note":
      return `note:${n}:${item.note.at}`;
    case "reply":
      return `reply:${n}:${item.reply.n}`;
    case "line":
      return item.line.kind === "ask" ? `ask:${n}:${item.line.sectionId}` : `done:${n}:${item.line.task}`;
  }
}

/**
 * The conversation (§4.1): each request's words, then the project's short
 * replies (or "looking at it" while there is none and the words arrived),
 * the user's follow-ups, and Core's lines (an Ask, a card done), all by
 * time, the newest last. A line Core gives no time for stands at its
 * request's latest activity.
 */
export function conversation(requests: readonly ProjectRequest[]): TalkItem[] {
  const items: TalkItem[] = [];
  for (const request of requests) {
    const at = time(request.createdAt);
    items.push({ kind: "mine", request, at });
    if (!request.notes.length && delivered(request.delivery)) items.push({ kind: "looking", request, at });
    for (const note of request.notes) items.push({ kind: "note", request, note, at: time(note.at) });
    for (const reply of request.replies) items.push({ kind: "reply", request, reply, at: time(reply.at) });
    for (const line of request.lines) items.push({ kind: "line", request, line, at: line.at ? time(line.at) : lastActivity(request) });
  }
  return items.sort((a, b) => a.at - b.at || a.request.n - b.request.n || RANK[a.kind] - RANK[b.kind]);
}

/**
 * Where "earlier in the conversation" ends (§4.1): before the words of the
 * oldest request still going on, or, with none going on, before the newest
 * request's words. Everything earlier is folded until asked for.
 */
export function earlierBefore(requests: readonly ProjectRequest[]) {
  const going = requests.filter((r) => !settled(r));
  const from = going.length ? going : requests;
  if (!from.length) return 0;
  const times = from.map((r) => time(r.createdAt));
  return going.length ? Math.min(...times) : Math.max(...times);
}
