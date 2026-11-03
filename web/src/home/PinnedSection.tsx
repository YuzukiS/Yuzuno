import { useEffect, useId, useRef, useState } from "react";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { ArrowUpRight, Clock3, Eye, MessageSquareReply, NotebookText, Pin as PinIcon, PinOff, Scaling, TriangleAlert } from "lucide-react";
import type { Agent } from "../types";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { absolute, duration, relative } from "./format";
import { SectionBody } from "./SectionBody";
import { pinWidgetId, type Pin, type PinSource } from "./widget-layout";
import { FoldButton, useCardFold } from "./card-fold";
import { homeText } from "./home-text";
import type { CardSize } from "./card-preview";
import { cardText } from "./card-text";
import { SizeChoice } from "./SizeChoice";

/**
 * A Brief section the user pinned to the widget column: the same section
 * Home reads for its project, drawn by the same renderer. It shows where it
 * comes from (project, author, update time) and leads back there. Seen
 * stays with the section in its project, so pinning counts nothing twice. A
 * reply to its author (T-174) can start here: it is the same reply as on the
 * card, shared, never a second one. A source that is gone or now another
 * section says so instead of showing content as current.
 */
export function PinnedSection({
  pin,
  source,
  onOpen,
  onUnpin,
  onPinCurrent,
  reply,
  size,
}: {
  pin: Pin;
  source: PinSource;
  /** The widget's size: the user's (`chosen`), else its Agent's (`own`); absent in the design preview. */
  size?: { own: CardSize; chosen: CardSize | null; onChange: (size: CardSize | null) => void };
  onOpen: () => void;
  onUnpin: () => void;
  /** Only when the section now under the key may itself be pinned (not an ask). */
  onPinCurrent?: () => void;
  /** Where replies can be sent from (not the design preview): the workspace and the project's open Agents. */
  reply?: { workspaceId: string; agents: Agent[] };
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  const title = source.state === "shown" ? source.section.title : pin.title;
  const projectName = source.state === "shown" ? source.projectName : pin.projectName;
  // Collapsing hides its content only; a source that is gone or not current
  // still says so (T-115).
  const [folded, toggleFold] = useCardFold(`widget:${pinWidgetId(pin)}`);
  const collapsed = folded && source.state === "shown";
  const body = `${pinWidgetId(pin)}-body`;
  // Shown, it is its current version or the report last written and marked
  // seen: both are versions Core can bind a reply to.
  const [replying, setReplying] = useState(
    () => !!reply && hasCardReply(cardReplySlot(reply.workspaceId, pin.projectId, pin.key)),
  );
  return (
    <section className={`home-pinned${collapsed ? " is-collapsed" : ""}`} data-pin-state={source.state} aria-label={t.pinnedFrom(title, projectName)}>
      <header className="home-pinned-head">
        <h2>
          {source.state === "shown" && <FoldButton collapsed={collapsed} onToggle={toggleFold} label={title} controls={body} />}
          <NotebookText size={14} aria-hidden="true" />
          <span>{title}</span>
          {size && <SizeMenu title={title} widgetId={pinWidgetId(pin)} {...size} />}
        </h2>
        <span className="home-pinned-from">
          {projectName}
          {source.state === "shown" && (
            <>
              {" · "}
              {source.section.owner.name}
              {" · "}
              <span title={absolute(source.section.updatedAt, time)}>{t.updatedWhen(relative(source.section.updatedAt, language))}</span>
            </>
          )}
        </span>
      </header>
      {source.state === "shown" ? (
        <>
          {!source.current && (
            <p className="home-pinned-note" role="status">
              <TriangleAlert size={12} aria-hidden="true" /> {t.notCurrent}
            </p>
          )}
          <div className="home-card-body" id={body} hidden={collapsed}>
          {source.seen && (
            <p className="home-pinned-time" role="status">
              <Eye size={12} aria-hidden="true" /> {t.markedSeen}
            </p>
          )}
          {source.section.status && (
            <p className={`home-pinned-time${source.section.status.stale ? " home-stale" : ""}`} title={absolute(source.section.status.asOf, time)}>
              <Clock3 size={12} aria-hidden="true" />
              {t.dataAsOf(absolute(source.section.status.asOf, time))}
              {source.section.status.stale && t.pastValidity(duration(source.section.status.validFor, language))}
            </p>
          )}
          <div className="home-pinned-body">
            <SectionBody section={source.section} projectId={pin.projectId} />
          </div>
          <footer className="home-pinned-foot">
            <button type="button" className="quiet-button" onClick={onOpen}>
              <ArrowUpRight size={13} /> {t.openIn(projectName)}
            </button>
            {reply && (
              <button
                type="button"
                className="quiet-button"
                aria-expanded={replying}
                aria-label={t.replyLabel(source.section.title)}
                title={t.replyTitle(source.section.owner.name)}
                onClick={() => setReplying((open) => !open)}
              >
                <MessageSquareReply size={13} /> {t.reply}
              </button>
            )}
          </footer>
          </div>
          {reply && replying && (
            <CardReply
              section={source.section}
              projectId={pin.projectId}
              workspaceId={reply.workspaceId}
              agents={reply.agents}
              onClose={() => setReplying(false)}
            />
          )}
        </>
      ) : source.state === "reading" ? (
        <p className="home-pinned-note">{t.readingShort}</p>
      ) : (
        <div className="home-pinned-gone">
          <p className="home-pinned-note" role="status">
            <TriangleAlert size={12} aria-hidden="true" />
            {t.pinGone[source.state]}
          </p>
          <span className="home-pinned-actions">
            {onPinCurrent && (
              <button type="button" className="quiet-button" onClick={onPinCurrent}>
                <PinIcon size={13} /> {t.pinNew}
              </button>
            )}
            <button type="button" className="quiet-button" onClick={onUnpin}>
              <PinOff size={13} /> {t.unpinShort}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * The widget's size, in its own small menu (T-18, Lead 2473): Agent (the
 * card's own size), Small, Wide or Large. Escape closes it and gives focus
 * back to its button; so does a click outside.
 */
function SizeMenu({
  title,
  widgetId,
  own,
  chosen,
  onChange,
}: {
  title: string;
  widgetId: string;
  own: CardSize;
  chosen: CardSize | null;
  onChange: (size: CardSize | null) => void;
}) {
  const t = useStrings(cardText);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <span
      className="home-pinned-size"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={t.widgetSize(title)}
        title={t.size}
        onClick={() => setOpen((value) => !value)}
      >
        <Scaling size={13} />
      </button>
      <span id={listId} className="home-summary-more-list home-pinned-size-list" role="group" aria-label={t.size} hidden={!open}>
        <SizeChoice name={`${widgetId}-size`} legend={t.size} value={chosen} own={own} variant="menu" onChange={onChange} />
      </span>
    </span>
  );
}
