import { forwardRef, useContext, type ReactNode } from "react";
import { FileText, GitPullRequest, LoaderCircle, MessageSquare, Tag } from "lucide-react";
import type { ReportLink } from "../deep-link";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { useTimeDisplay } from "../time-preferences";
import { CardAgents, shownResponsible, taskEnded, type ShownResponsible } from "./card-responsible";
import { openTask } from "./CardResponsible";
import { absolute, relative } from "./format";
import { cardBinding, cardTitle, mergedInto, requestState, untitledHint } from "./project-talk";
import type { Deliverable, ProjectRequest, RequestCard as RequestCardShown } from "./project-talk-api";
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
    /** Opens a report a card's task delivered (YN-208), over Home. */
    onReport: OpenDeliveredReport;
  }
>(function RequestCard(
  { request, selected, trailOpen, readOnly, resending, confirming, confirmError, onTitle, onFollowUp, onTrail, onResend, onConfirm, onCard, onReport },
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
      {one && <CardDeliverables card={one} one onReport={onReport} />}
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
                <CardDeliverables card={card} onReport={onReport} />
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

/** Opens a report a card's task delivered (YN-208): the exact version its result named, by its identity on Home. */
export type OpenDeliveredReport = (link: Omit<ReportLink, "workspaceId" | "projectId">) => void;

/**
 * What a card's task delivered (YN-208), under its card: each deliverable its newest result that named any named,
 * opened from here, with where it stands now. Nothing is guessed: a task that ended with none says so and opens the
 * task. An older Core, which reads no deliverables, shows nothing here.
 */
function CardDeliverables({ card, one = false, onReport }: { card: RequestCardShown; one?: boolean; onReport: OpenDeliveredReport }) {
  const language = useLanguage();
  const t = talkText(language);
  const time = useTimeDisplay();
  if (card.deliverables === undefined) return null;
  const items = card.deliverables?.items ?? [];
  const name = cardTitle(card);
  if (!items.length) {
    if (!taskEnded(cardBinding(card))) return null;
    const why = card.task.status === "cancelled" ? t.cancelledNone : card.result ? t.noDeliverable : t.noResult;
    return (
      <p className="request-deliverables-none" data-one={one ? "" : undefined}>
        <span>{why}</span>
        <button type="button" className="talk-link" aria-label={t.openTaskLabel(card.task.id)} onClick={() => openTask(card.task.id)}>
          {t.openTask}
        </button>
      </p>
    );
  }
  return (
    <ul className="request-deliverables" data-one={one ? "" : undefined} aria-label={t.deliverables(name)}>
      {items.map((item, index) => (
        <li key={index}>
          <DeliverableLine item={item} task={card.task.id} onReport={onReport} time={(at) => absolute(at, time)} ago={(at) => relative(at, language)} />
        </li>
      ))}
    </ul>
  );
}

/** One deliverable, opened from where it is listed: a request's card here, a request's block (RequestBlocks.tsx). */
export function DeliverableLine({ item, task, onReport, time, ago }: {
  item: Deliverable;
  task: string;
  onReport: OpenDeliveredReport;
  time: (at: string) => string;
  ago: (at: string) => string;
}) {
  const t = talkText(useLanguage());
  const body = (icon: ReactNode, title: string, meta: string, go: string | null) => (
    <>
      {icon}
      <span className="request-deliverable-title">{title}</span>
      {go && <span className="request-deliverable-go" aria-hidden="true">{go}</span>}
      <span className="request-deliverable-meta">{[meta, item.note].filter(Boolean).join(" · ")}</span>
    </>
  );
  const tip = (title: string, meta: string, extra?: string) => <TipText title={title} body={[item.note, extra].filter(Boolean).join("\n") || undefined} meta={meta} />;
  switch (item.kind) {
    case "report": {
      const open = item.state === "replaced" ? item.currentVersion : item.state === "gone" ? null : item.version;
      const newer = item.currentVersion !== null && item.currentVersion > item.version ? item.currentVersion : null;
      const meta = item.state === "history" ? t.reportInHistory(item.version, newer)
        : item.state === "replaced" ? t.reportReplaced(item.version, item.currentVersion ?? item.version)
          : item.state === "gone" ? t.reportGone(item.version) : t.reportVersion(item.version);
      const go = open === null ? t.openTask : open === item.version ? t.openReport : t.openVersion(open);
      return (
        <Tip content={tip(item.title, meta)} describe={false}>
          <button
            type="button"
            className="request-deliverable"
            data-kind="report"
            data-state={item.state}
            aria-label={open === null ? t.openTaskLabel(task) : t.openReportLabel(item.title, open)}
            onClick={(event) => {
              if (open === null) {
                openTask(task);
                return;
              }
              // Focus first, where a browser does not focus a clicked button (Safari): Back from the report returns here.
              event.currentTarget.focus({ preventScroll: true });
              onReport({ key: item.key, version: open, sectionId: item.sectionId });
            }}
          >
            {body(<FileText size={13} aria-hidden="true" />, item.title, meta, go)}
          </button>
        </Tip>
      );
    }
    case "pr": {
      const meta = t.prMeta(item.number, t.prState[item.state], item.observedAt ? ago(item.observedAt) : "");
      return (
        <Tip content={tip(item.title, meta, item.observedAt ? t.prObserved(time(item.observedAt)) : undefined)} describe={false}>
          <a className="request-deliverable" data-kind="pr" data-state={item.state} href={item.url} target="_blank" rel="noopener noreferrer">
            {body(<GitPullRequest size={13} aria-hidden="true" />, item.title, meta, t.openPr)}
          </a>
        </Tip>
      );
    }
    case "release": {
      const meta = t.releaseMeta(item.tag);
      return (
        <Tip content={tip(item.title, meta, t.releaseTip)} describe={false}>
          <a className="request-deliverable" data-kind="release" href={item.url} target="_blank" rel="noopener noreferrer">
            {body(<Tag size={13} aria-hidden="true" />, item.title, meta, t.openRelease)}
          </a>
        </Tip>
      );
    }
    case "answer":
      // Whole, wrapped: a phone has no tip to read the rest in.
      return (
        <p className="request-deliverable" data-kind="answer">
          {body(<MessageSquare size={13} aria-hidden="true" />, item.text, item.title ?? t.answer, null)}
        </p>
      );
  }
}
