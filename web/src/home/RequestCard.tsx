import { forwardRef, useContext } from "react";
import { LoaderCircle } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { CardAgents, shownResponsible } from "./card-responsible";
import { absolute, relative } from "./format";
import { cardBinding, cardTitle, mergedInto, requestState, untitledHint } from "./project-talk";
import type { ProjectRequest } from "./project-talk-api";
import { requestTrail, RoutingEvents, type ShowCard } from "./RoutingEvents";
import { talkText } from "./talk-text";

/**
 * One request in the requests column (YN-86 §4.1, §4.5, as a parent issue
 * lists its sub-issues): the project's title for it (never the user's
 * words, which stay in the conversation), or a light placeholder until it
 * has one; its state, cards and progress; Follow up and its handoffs,
 * folded; then one row per card, which shows that card on the page.
 */
export const RequestCard = forwardRef<
  HTMLDivElement,
  {
    request: ProjectRequest;
    selected: boolean;
    trailOpen: boolean;
    readOnly: boolean;
    resending: boolean;
    onTitle: () => void;
    onFollowUp: () => void;
    onTrail: () => void;
    onResend: () => void;
    onCard: ShowCard;
  }
>(function RequestCard({ request, selected, trailOpen, readOnly, resending, onTitle, onFollowUp, onTrail, onResend, onCard }, ref) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  const agents = useContext(CardAgents);
  const state = requestState(request);
  const merged = mergedInto(request);
  const trail = requestTrail(request);
  const title = request.title?.trim() || "";
  const label = title || t.untitled(untitledHint(request.text));
  return (
    <div
      ref={ref}
      className="request-card"
      data-request={request.n}
      data-selected={selected ? "" : undefined}
      tabIndex={-1}
    >
      <Tip content={<TipText title={label} body={t.titleTip} meta={absolute(request.createdAt, time)} />} describe={false}>
        <button type="button" className="request-card-title" data-untitled={title ? undefined : ""} onClick={onTitle}>
          <span>{label}</span>
          <time dateTime={request.createdAt}>{relative(request.createdAt, language)}</time>
        </button>
      </Tip>
      <div className="request-card-head">
        <span className="request-card-state" data-state={state}>
          {t.state[state]}
        </span>
        {state === "unconfirmed" && !readOnly && (
          <button type="button" className="talk-link" disabled={resending} onClick={onResend}>
            {resending && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
            {t.resend}
          </button>
        )}
        {merged ? (
          <span className="request-card-merged">{t.merged(cardTitle(merged))}</span>
        ) : request.progress.cards > 0 ? (
          <span className="request-card-count">{t.cards(request.progress.cards, request.progress.ended)}</span>
        ) : null}
        <span className="request-card-actions">
          {!readOnly && (
            <button type="button" className="talk-link" aria-label={t.followUpLabel(label)} onClick={onFollowUp}>
              {t.followUp}
            </button>
          )}
          {trail.length > 0 && (
            <button type="button" className="talk-link" aria-expanded={trailOpen} onClick={onTrail}>
              {trailOpen ? t.hideTrail : t.trail(trail.length)}
            </button>
          )}
        </span>
      </div>
      {request.cards.length > 0 ? (
        <ol className="request-card-cards" aria-label={t.requestCards}>
          {request.cards.map((card, index) => {
            const who = shownResponsible(cardBinding(card), agents, language);
            const name = cardTitle(card);
            return (
              <li key={`${card.sectionId ?? card.task.id}:${index}`}>
                <button
                  type="button"
                  className="request-card-row"
                  aria-label={t.openCardLabel(name)}
                  onClick={() => onCard(card.key, card.task.id)}
                >
                  <span className={`status-dot${who?.dot ? ` ${who.dot}` : ""}`} aria-hidden="true" />
                  <span className="request-card-row-title">{name}</span>
                  <span className="request-card-row-who">{who?.name ?? ""}</span>
                  <span className="request-card-row-state">{who?.state ?? ""}</span>
                  <span className="request-card-row-go" aria-hidden="true">
                    {t.openCard}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        state === "waiting" && <p className="request-card-wait">{t.noCard}</p>
      )}
      {trailOpen && (
        <div className="request-card-trail">
          <RoutingEvents events={trail} onCard={onCard} />
        </div>
      )}
    </div>
  );
});
