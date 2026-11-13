import { useContext, useId, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { absolute, relative } from "./format";
import { useHomeNavigation } from "./home-navigation";
import { routeEvent, RoutingEvents } from "./RoutingEvents";
import { ProjectTalkLink } from "./talk-link";
import { talkText } from "./talk-text";
import type { CardHandoffs, Section } from "./types";
import "./card-source.css";

/**
 * Where a card came from (YN-86 §4.3, §4.5, as a sub-issue links its
 * parent): one muted line above who answers for it, "Request: <title>",
 * with how many cards that request made and how many more requests were
 * joined to this one; Details opens each request with its time and "See
 * words →", the request's other cards, and the card's handoffs. Never the
 * user's words: "See words" goes to them in the conversation, on the
 * Project's page; off it, to the Project's page at this card.
 */
export function CardSource({ section, handoffs, projectId }: { section: Section; handoffs: CardHandoffs; projectId: string }) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  const link = useContext(ProjectTalkLink);
  const navigate = useHomeNavigation();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const requests = handoffs.requests;
  if (!requests.length) return null;
  const titleOf = (request: { n: number; title: string | null }) => request.title?.trim() || `R-${request.n}`;
  // The request the card was made for; those joined to it after, apart.
  const first = requests.find((request) => !request.merged) ?? requests[0];
  const joined = requests.length - 1;
  const read = link?.requests.find((request) => request.n === first.n);
  const others = (read?.cards ?? []).filter((card) => card.key && card.key !== section.key);
  // On the Project's page, the page shows the card (or its task, where the card is gone); off it, the page opens there.
  const toCard = (key: string | null, task?: string | null) =>
    link ? link.showCard(key, task) : key ? navigate({ kind: "project", projectId, sectionKey: key }) : undefined;
  const seeWords = (n: number) => (link ? link.reveal(n) : toCard(section.key));
  // Each event's card by its section: this one, or another card a request of it went to.
  const cardOf = (sectionId: number | null) => {
    if (sectionId === null) return null;
    if (sectionId === section.id) return { title: section.title, key: section.key, live: !section.history };
    for (const request of link?.requests ?? []) {
      const card = request.cards.find((c) => c.sectionId === sectionId);
      if (card) return { title: card.title || card.key || card.task.id, key: card.key, live: card.live };
    }
    return null;
  };
  // A link to this very card leads nowhere new.
  const events = handoffs.events
    .map((event) => routeEvent(event, cardOf))
    .map((event) => (event.card?.key === section.key ? { ...event, card: null } : event));
  const label = titleOf(first);
  return (
    <div className="card-source" role="group" aria-label={t.sourceLabel(section.title)}>
      <button type="button" className="card-source-line" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
        <MessageSquare size={12} aria-hidden="true" />
        <span className="card-source-text">
          {t.source(label)}
          {read && read.cards.length > 1 ? t.sourceCards(read.cards.length) : ""}
          {joined > 0 ? t.sourceJoined(joined) : ""}
        </span>
        <span className="card-source-more">{open ? t.hideDetails : t.details}</span>
      </button>
      {open && (
        <div className="card-source-detail" id={detailId}>
          <ol className="card-source-requests">
            {requests.map((request) => (
              <li key={request.n}>
                <span className="card-source-request">
                  {titleOf(request)}
                  {request.merged && (
                    <>
                      {" "}
                      <small>{t.joinedTag}</small>
                    </>
                  )}
                </span>
                <Tip content={<TipText title={absolute(request.at, time)} />} describe={false}>
                  <time dateTime={request.at}>{relative(request.at, language)}</time>
                </Tip>
                <button type="button" className="talk-link" aria-label={t.seeWordsLabel(titleOf(request))} onClick={() => seeWords(request.n)}>
                  {t.seeWords}
                </button>
              </li>
            ))}
          </ol>
          {others.length > 0 && (
            <ul className="card-source-others">
              {others.map((card) => (
                <li key={card.key}>
                  <button type="button" className="talk-link" onClick={() => toCard(card.key, card.task.id)}>
                    {t.otherCard(card.title || card.key || card.task.id)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {events.length > 0 && <RoutingEvents events={events} onCard={toCard} />}
        </div>
      )}
    </div>
  );
}
