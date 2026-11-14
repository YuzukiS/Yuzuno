import { CircleCheck, Forward, GitMerge, MessageSquare, MessageSquareReply, SquarePlus } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { absolute, relative } from "./format";
import type { ProjectRequest, RouteEvent } from "./project-talk-api";
import { talkText } from "./talk-text";
import "./routing-events.css";

/**
 * One event of a handoff trail (YN-86 §4.3, as Intercom's conversation
 * events): who did what, to whom, with why on the line below, its time and
 * a link to the card. The same events show on a request and on a card.
 */
export type TrailEvent = {
  id: string;
  kind: "card" | "existing" | "answer" | "reassign" | "note" | "done";
  at: string | null;
  /** The user, for a reassignment; else the project (its front desk). */
  byUser?: boolean;
  /** The card's title, as the request or the card knows it. */
  title?: string;
  to?: string;
  from?: string;
  why?: string;
  note?: string;
  state?: RouteEvent["state"];
  error?: string;
  /** The card it went to: its key on Home, and whether it is live there. */
  card?: { key: string; live: boolean } | null;
  /** Its task's key, opened where the card is no longer on the page. */
  task?: string | null;
};

/** Shows a card on the page, or, where it is no longer there (archived longer ago than Home keeps it), its task. */
export type ShowCard = (key: string | null, task?: string | null) => void;

/** A route as a trail event, its card's title and place found by `card` (by section). */
export function routeEvent(route: RouteEvent, card: (sectionId: number | null) => { title: string; key: string | null; live: boolean } | null): TrailEvent {
  const found = card(route.sectionId);
  const key = found?.key ?? route.cardKey;
  return {
    id: `route:${route.kind}:${route.request ?? ""}:${route.index ?? ""}:${route.at}`,
    kind: route.kind,
    at: route.at,
    byUser: route.by === null,
    title: route.title || found?.title || route.cardKey || route.task || "",
    to: route.to?.name || undefined,
    from: route.from?.name || undefined,
    why: route.why || undefined,
    state: route.state,
    error: route.error,
    card: key ? { key, live: found?.live ?? true } : null,
    task: route.task,
  };
}

/** A request's trail (§4.3): its routes and its cards' reassignments, the project's notes, and "all done" once it is. */
export function requestTrail(request: ProjectRequest): TrailEvent[] {
  const card = (sectionId: number | null) => {
    const found = sectionId === null ? null : request.cards.find((c) => c.sectionId === sectionId);
    return found ? { title: found.title || found.key || found.task.id, key: found.key, live: found.live } : null;
  };
  const events: TrailEvent[] = [
    ...request.routes.map((route) => routeEvent(route, card)),
    ...request.notes.map((note, index) => ({ id: `note:${index}`, kind: "note" as const, at: note.at, note: note.note })),
  ];
  if (request.state === "done") {
    const ends = request.lines.filter((line) => line.kind === "done").map((line) => line.at ?? "");
    events.push({ id: "done", kind: "done", at: ends.sort().at(-1) || null });
  }
  return events.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

const ICONS = { card: SquarePlus, existing: GitMerge, answer: MessageSquareReply, reassign: Forward, note: MessageSquare, done: CircleCheck };

export function RoutingEvents({ events, onCard }: { events: TrailEvent[]; onCard?: ShowCard }) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  return (
    <ol className="routing-events">
      {events.map((event) => {
        const Icon = ICONS[event.kind];
        const action =
          event.kind === "card" ? t.opened(event.title ?? "")
            : event.kind === "existing" ? t.joined(event.title ?? "")
              : event.kind === "reassign" ? t.reassigned(event.title ?? "")
                : event.kind === "answer" ? t.answered(event.why ?? "")
                  : null;
        // An answer says its why on its own line; the others below it.
        const why = event.kind === "answer" ? "" : event.why ?? "";
        return (
          <li key={event.id} className="routing-event" data-kind={event.kind} data-state={event.state}>
            <span className="routing-event-icon" aria-hidden="true">
              <Icon size={12} />
            </span>
            <span className="routing-event-text">
              {event.kind === "note" ? (
                <>
                  <span className="routing-event-actor">{t.project}</span>
                  {t.colon}
                  {event.note}
                </>
              ) : event.kind === "done" ? (
                t.allDone
              ) : (
                <>
                  <span className="routing-event-actor">{event.byUser ? t.you : t.project}</span> {action}
                  {event.to && (
                    <>
                      {t.handedTo} <b>{event.to}</b>
                    </>
                  )}
                  {event.state === "pending" && <span className="routing-event-state"> · {t.pending}</span>}
                </>
              )}
              {(why || event.from || event.state === "failed") && (
                <small>
                  {[event.from ? t.from(event.from) : "", why, event.state === "failed" ? t.failed(event.error ?? "") : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              )}
            </span>
            {event.at ? (
              <Tip content={<TipText title={absolute(event.at, time)} />} describe={false}>
                <time dateTime={event.at}>{relative(event.at, language)}</time>
              </Tip>
            ) : (
              <span />
            )}
            {event.card && onCard ? (
              <button type="button" className="talk-link routing-event-link" onClick={() => onCard(event.card!.key, event.task)}>
                {event.card.live ? t.cardLink : t.archiveLink}
              </button>
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ol>
  );
}
