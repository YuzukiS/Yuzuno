import { useContext, type RefObject } from "react";
import { Forward, MessageSquareReply, MessagesSquare } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import { CardAgents, shownResponsible, taskEnded } from "./card-responsible";
import { homeText } from "./home-text";
import { useHomeNavigation } from "./home-navigation";
import type { CardBinding, Section } from "./types";
import "./card-responsible.css";

/** Opens a task in the task window, as a Live Reference to it does (LiveRefs.tsx). */
export const openTask = (taskId: string) =>
  window.dispatchEvent(new CustomEvent("yuzuno:open-task-review", { detail: { taskId } }));

/**
 * The foot of a card bound to a task (YN-86 §3.2, the user's A): who answers
 * for it, in what state, as the rail says it; its task's key, which opens the
 * task; and Reply (to them, by default), Open session and Reassign. It takes
 * the place of the author's byline; where the author is someone else, its tip
 * says so. Reassign, for now, opens the task where it is assigned or
 * dispatched again (§3.3); once the task is over there is nothing to reassign.
 */
export function CardResponsible({
  section,
  card,
  readOnly,
  reply,
}: {
  section: Section;
  card: CardBinding;
  readOnly: boolean;
  /** The card's Reply, where it takes one (a report or status, live): open or not, and its toggle. */
  reply?: { open: boolean; onToggle: () => void; button: RefObject<HTMLButtonElement | null> } | null;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const navigate = useHomeNavigation();
  const who = shownResponsible(card, useContext(CardAgents), language);
  const ended = taskEnded(card);
  const task = card.task.id;
  // Who wrote the card, when that is not who answers for it.
  const author = who && who.agentId !== section.owner.agentId ? t.writtenBy(section.owner.name) : null;
  const name = (
    <span className="home-card-responsible-name">
      <span className={`status-dot${who?.dot ? ` ${who.dot}` : ""}`} aria-hidden="true" />
      <strong>{who?.name}</strong>
    </span>
  );
  return (
    <div className="home-card-responsible" role="group" aria-label={t.responsibleLabel(section.title)} data-responsible={who?.agentId ?? ""}>
      <span className="home-card-responsible-who">
        <span className="home-card-responsible-label">{t.responsible}</span>
        {who ? (
          <>
            {author ? <Tip content={<TipText title={author} />}>{name}</Tip> : name}
            {/* Its whole state, when the line cuts it. */}
            <Tip content={<TipText title={who.state} />} cut>
              <span className="home-card-responsible-state" data-dot={who.dot || undefined}>{who.state}</span>
            </Tip>
          </>
        ) : (
          <span className="home-card-responsible-none">{t.noResponsible}</span>
        )}
        <Tip content={<TipText title={card.task.title || t.openTask(task)} />} describe={false}>
          <button type="button" className="home-card-task" aria-label={t.openTask(task)} onClick={() => openTask(task)}>
            {task}
          </button>
        </Tip>
      </span>
      <span className="home-card-responsible-actions">
        {reply && (
          <Tip content={<TipText title={t.replyTitle(who?.name ?? section.owner.name)} />} describe={false}>
            <button
              type="button"
              className="quiet-button home-reply-open"
              ref={reply.button}
              aria-expanded={reply.open}
              aria-label={t.replyLabel(section.title)}
              onClick={reply.onToggle}
            >
              <MessageSquareReply size={13} aria-hidden="true" />
              {t.reply}
            </button>
          </Tip>
        )}
        {who && (
          <button
            type="button"
            className="quiet-button home-card-session"
            aria-label={t.openSessionLabel(who.name)}
            onClick={() => navigate({ kind: "agent", agentId: who.agentId })}
          >
            <MessagesSquare size={13} aria-hidden="true" />
            {t.openSession}
          </button>
        )}
        {!readOnly && !ended && (
          <Tip content={<TipText title={t.reassignTitle(task)} />} describe={false}>
            <button type="button" className="quiet-button home-card-reassign" onClick={() => openTask(task)}>
              <Forward size={13} aria-hidden="true" />
              {t.reassign}
            </button>
          </Tip>
        )}
      </span>
    </div>
  );
}
