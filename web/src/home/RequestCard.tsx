import { forwardRef, useContext } from "react";
import { LoaderCircle } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { CardAgents, shownResponsible, taskEnded, type ShownResponsible } from "./card-responsible";
import { absolute, relative } from "./format";
import { cardBinding, cardTitle, mergedInto, requestState, untitledHint } from "./project-talk";
import type { ProjectRequest, RequestCard as RequestCardShown } from "./project-talk-api";
import { requestTrail, RoutingEvents, type ShowCard } from "./RoutingEvents";
import { talkText } from "./talk-text";

/**
 * One request in the requests column (YN-86 §4.1, §4.5, as a parent issue
 * lists its sub-issues): the project's title for it (never the user's
 * words, which stay in the conversation), or a light placeholder until it
 * has one; its state, cards and progress; Confirm done while it waits for
 * the user (YN-184); Follow up and its handoffs, folded; then its cards. One
 * card is on the request's own line (YN-184: the row would only repeat its
 * title, which the front desk wrote with the request's in the same route);
 * several are one row each. A row, or the line's card, shows that card on
 * the page.
 */
export const RequestCard = forwardRef<
  HTMLDivElement,
  {
    request: ProjectRequest;
    selected: boolean;
    trailOpen: boolean;
    readOnly: boolean;
    resending: boolean;
    confirming: boolean;
    confirmError: string;
    onTitle: () => void;
    onFollowUp: () => void;
    onTrail: () => void;
    onResend: () => void;
    onConfirm: () => void;
    onCard: ShowCard;
  }
>(function RequestCard(
  { request, selected, trailOpen, readOnly, resending, confirming, confirmError, onTitle, onFollowUp, onTrail, onResend, onConfirm, onCard },
  ref,
) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  const agents = useContext(CardAgents);
  const state = requestState(request);
  const merged = mergedInto(request);
  const trail = requestTrail(request);
  const title = request.title?.trim() || "";
  // Answered with no card (YN-136): the answer is the project's newest note, shown while it waits and once done.
  const answer = !request.cards.length && (state === "answered" || state === "done") ? request.notes.at(-1)?.note ?? "" : "";
  // Its cards ended, or answered: the user's to confirm (YN-184).
  const awaiting = state === "ended" || state === "answered";
  // One card (YN-184): the request's own line shows it, with no row of its own; several keep their list.
  const one = request.cards.length === 1 ? request.cards[0] : null;
  // A card's state: what its task ended as, once over; else its responsible Agent's state, as the rail says it.
  const cardState = (card: RequestCardShown, who: ShownResponsible | null) =>
    taskEnded(cardBinding(card)) ? t.taskEnded[endedAs(card)] : who?.state ?? "";
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
      <div className="request-card-head" data-one={one ? "" : undefined}>
        {!(one && state === "doing") && (
          <span className="request-card-state" data-state={state}>
            {t.state[state]}
          </span>
        )}
        {awaiting && !readOnly && (
          <Tip content={<TipText title={t.confirmTip} />} describe={false}>
            <button type="button" className="request-card-confirm" disabled={confirming} aria-label={t.confirmLabel(label)} onClick={onConfirm}>
              {confirming && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
              {t.confirm}
            </button>
          </Tip>
        )}
        {state === "unconfirmed" && !readOnly && (
          <button type="button" className="talk-link" disabled={resending} onClick={onResend}>
            {resending && <LoaderCircle size={12} className="spin" aria-hidden="true" />}
            {t.resend}
          </button>
        )}
        {merged && <span className="request-card-merged">{t.merged(cardTitle(merged))}</span>}
        {one ? (
          <OneCard card={one} state={state} cardState={cardState} onCard={onCard} />
        ) : !merged && request.progress.cards > 0 ? (
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
      {confirmError && <p className="request-card-error" role="alert">{t.confirmFailed(confirmError)}</p>}
      {request.cards.length > 1 ? (
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
                  <span className="request-card-row-state">{cardState(card, who)}</span>
                  <span className="request-card-row-go" aria-hidden="true">
                    {t.openCard}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : one ? null : state === "waiting" ? (
        <p className="request-card-wait">{t.noCard}</p>
      ) : answer ? (
        <Tip content={<TipText title={answer} />} cut describe={false}>
          <p className="request-card-answer">{t.answerLine(answer)}</p>
        </Tip>
      ) : null}
      {trailOpen && (
        <div className="request-card-trail">
          <RoutingEvents events={trail} onCard={onCard} />
        </div>
      )}
    </div>
  );
});

/** What a card's task ended as, as Core's lines say it (progress.rs): done or cancelled, else archived. */
const endedAs = (card: RequestCardShown) =>
  card.task.status === "done" || card.task.status === "cancelled" ? card.task.status : "archived";

/**
 * A request's one card, on the request's own line (YN-184): who answers for it and its state, and Open → to show
 * it; the card's title in its tip. A request whose one card is done says Done once: the card's own word is left out.
 */
function OneCard({
  card,
  state,
  cardState,
  onCard,
}: {
  card: RequestCardShown;
  state: string;
  cardState: (card: RequestCardShown, who: ShownResponsible | null) => string;
  onCard: ShowCard;
}) {
  const language = useLanguage();
  const t = talkText(language);
  const agents = useContext(CardAgents);
  const who = shownResponsible(cardBinding(card), agents, language);
  const name = cardTitle(card);
  const said = state === "done" && endedAs(card) === "done" ? "" : cardState(card, who);
  return (
    <Tip content={<TipText title={name} />} describe={false}>
      <button type="button" className="request-card-one" aria-label={t.openCardLabel(name)} onClick={() => onCard(card.key, card.task.id)}>
        <span className={`status-dot${who?.dot ? ` ${who.dot}` : ""}`} aria-hidden="true" />
        {who && <span className="request-card-one-who">{who.name}</span>}
        {said && <span className="request-card-one-state">{said}</span>}
        <span className="request-card-row-go" aria-hidden="true">
          {t.openCard}
        </span>
      </button>
    </Tip>
  );
}
