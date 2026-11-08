import { useRef, useState } from "react";
import { useLanguage } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { ArrowUpRight, Clock3, Eye, MessageSquareReply, NotebookText, Pin as PinIcon, PinOff, TriangleAlert } from "lucide-react";
import type { Agent } from "../types";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { absolute, duration, relative } from "./format";
import { SectionBody } from "./SectionBody";
import { pinWidgetId, type Pin, type PinSource } from "./widget-layout";
import { FoldButton, useCardFold } from "./card-fold";
import { homeText } from "./home-text";
import { Tip, TipText } from "../Tip";

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
}: {
  pin: Pin;
  source: PinSource;
  onOpen: () => void;
  onUnpin: () => void;
  /** Only when the section now under the key may itself be pinned (not an ask). */
  /** `pressed` is the button pressed, which keeps its place (T-19 HM:W5). */
  onPinCurrent?: (pressed: HTMLElement) => void;
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
  // Opened by the user here, not kept from before; closed, focus goes back to
  // Reply (T-19 HM:S7), or, with the card folded meanwhile and Reply hidden in
  // it, to the card's fold button. The card stays as the user folded it.
  const [replyOpened, setReplyOpened] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);
  const closeReply = () => {
    const fold = card.current?.querySelector<HTMLButtonElement>(".home-pinned-head .home-fold");
    (collapsed ? fold : replyButton.current)?.focus();
    setReplying(false);
  };
  return (
    <section className={`home-pinned${collapsed ? " is-collapsed" : ""}`} data-pin-state={source.state} aria-label={t.pinnedFrom(title, projectName)} ref={card}>
      <header className="home-pinned-head">
        <h2>
          {source.state === "shown" && <FoldButton collapsed={collapsed} onToggle={toggleFold} label={title} controls={body} />}
          <NotebookText size={14} aria-hidden="true" />
          <span>{title}</span>
        </h2>
        <span className="home-pinned-from">
          {projectName}
          {source.state === "shown" && (
            <>
              {" · "}
              {source.section.owner.name}
              {" · "}
              <Tip content={<TipText title={absolute(source.section.updatedAt, time)} />}>
                <span>{t.updatedWhen(relative(source.section.updatedAt, language))}</span>
              </Tip>
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
            // Its time is in its words in full: no tip repeats it.
            <p className={`home-pinned-time${source.section.status.stale ? " home-stale" : ""}`}>
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
              <Tip content={<TipText title={t.replyTitle(source.section.owner.name)} />}>
                <button
                  type="button"
                  className="quiet-button"
                  ref={replyButton}
                  aria-expanded={replying}
                  aria-label={t.replyLabel(source.section.title)}
                  onClick={() => {
                    setReplyOpened(true);
                    setReplying((open) => !open);
                  }}
                >
                  <MessageSquareReply size={13} /> {t.reply}
                </button>
              </Tip>
            )}
          </footer>
          </div>
          {reply && replying && (
            <CardReply
              section={source.section}
              projectId={pin.projectId}
              workspaceId={reply.workspaceId}
              agents={reply.agents}
              opened={replyOpened}
              onClose={closeReply}
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
              <button type="button" className="quiet-button" onClick={(event) => onPinCurrent(event.currentTarget)}>
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
 * What a pinned card shown as its summary card says above its head (T-18):
 * that Home's last read failed, so it may not be current; or that it is a
 * report the user marked seen, shown as last written. Never as new.
 */
export function PinNotes({ source }: { source: PinSource }) {
  const t = homeText(useLanguage());
  if (source.state !== "shown" || (source.current && !source.seen)) return null;
  return (
    <>
      {!source.current && (
        <p className="home-pinned-note" role="status">
          <TriangleAlert size={12} aria-hidden="true" /> {t.notCurrent}
        </p>
      )}
      {source.seen && (
        <p className="home-pinned-time" role="status">
          <Eye size={12} aria-hidden="true" /> {t.markedSeen}
        </p>
      )}
    </>
  );
}
