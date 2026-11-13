import { useContext, useRef, useState, type RefObject } from "react";
import { Forward, MessageSquareReply, MessagesSquare } from "lucide-react";
import { useLanguage } from "../i18n";
import { Tip, TipText } from "../Tip";
import type { Agent } from "../types";
import { CardAgents, replyRecipient, shownResponsible, taskEnded } from "./card-responsible";
import { CardSource } from "./CardSource";
import { ReassignCard } from "./ReassignCard";
import { talkText } from "./talk-text";
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
 * says so. Above it, where the card came from (CardSource, §4.3). Reassign
 * gives the card to another Agent of the Project or a new executor (§3.3,
 * §4.3), or opens its task; once the task is over there is nothing to
 * reassign. Reply's tip names whom the reply goes to by default, as the
 * reply itself chooses (replyRecipient).
 */
export function CardResponsible({
  section,
  card,
  readOnly,
  reply,
  place,
}: {
  section: Section;
  card: CardBinding;
  readOnly: boolean;
  /** The card's Project, its Workspace and the Project's open Agents: where Reply and Reassign go. */
  place?: { projectId: string; workspaceId: string; agents: Agent[] };
  /** The card's Reply, where it takes one (a report or status, live): open or not, and its toggle. */
  reply?: { open: boolean; onToggle: () => void; button: RefObject<HTMLButtonElement | null> } | null;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const navigate = useHomeNavigation();
  const all = useContext(CardAgents);
  const who = shownResponsible(card, all, language);
  const [reassigning, setReassigning] = useState(false);
  const [done, setDone] = useState("");
  const reassignButton = useRef<HTMLButtonElement>(null);
  // Whom Reply sends to: Core's responsible Agent while open here, else the author; not a released executor.
  const recipient = place ? replyRecipient(section, place.agents) : who?.agentId ?? section.owner.agentId;
  const replyTo = (place?.agents.find((agent) => agent.id === recipient) ?? all.get(recipient))?.name
    ?? (recipient === section.owner.agentId ? section.owner.name : who?.name ?? section.owner.name);
  const ended = taskEnded(card);
  const task = card.task.id;
  // Who wrote the card, when that is not who answers for it.
  const author = who && who.agentId !== section.owner.agentId ? t.writtenBy(section.owner.name) : null;
  const canReassign = !!place && section.id !== undefined;
  const name = (
    <span className="home-card-responsible-name">
      <span className={`status-dot${who?.dot ? ` ${who.dot}` : ""}`} aria-hidden="true" />
      <strong>{who?.name}</strong>
    </span>
  );
  // The card a request was routed to: its topic's own section, not each sub-section bound to the same task.
  const source = card.handoffs && place && !section.key.includes("/") ? card.handoffs : null;
  return (
    <>
    {source && place && <CardSource section={section} handoffs={source} projectId={place.projectId} />}
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
          <Tip content={<TipText title={t.replyTitle(replyTo)} />} describe={false}>
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
          <Tip content={<TipText title={canReassign ? talkText(language).reassignTip : t.reassignTitle(task)} />} describe={false}>
            <button
              type="button"
              className="quiet-button home-card-reassign"
              ref={reassignButton}
              aria-haspopup={canReassign ? "dialog" : undefined}
              onClick={() => (canReassign ? setReassigning(true) : openTask(task))}
            >
              <Forward size={13} aria-hidden="true" />
              {t.reassign}
            </button>
          </Tip>
        )}
      </span>
    </div>
    {done && (
      <p className="home-note home-card-reassigned" role="status">
        {done}
      </p>
    )}
    {canReassign && place && (
      <ReassignCard
        open={reassigning}
        onOpenChange={(open) => {
          setReassigning(open);
          if (!open) requestAnimationFrame(() => reassignButton.current?.focus());
        }}
        section={section}
        sectionId={section.id!}
        projectId={place.projectId}
        workspaceId={place.workspaceId}
        members={place.agents}
        responsible={who && !who.former ? { agentId: who.agentId, name: who.name } : null}
        task={task}
        onOpenTask={() => {
          setReassigning(false);
          openTask(task);
        }}
        onDone={setDone}
      />
    )}
    </>
  );
}
