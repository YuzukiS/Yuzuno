import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { ArrowDown, ArrowRight, Eye, LoaderCircle, MessageSquareReply } from "lucide-react";
import { errorText } from "../api";
import { useLanguage } from "../i18n";
import { projectColour } from "../project-groups";
import { Tip, TipText } from "../Tip";
import { BriefMarkdown } from "./brief/Markdown";
import { briefText } from "./brief/brief-text";
import { changedSinceSeen, readBefore, sectionDomId, unreadChange } from "./brief-layout";
import { cardContent } from "./card-preview";
import { cardText } from "./card-text";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { homeText } from "./home-text";
import { useReportOpen } from "./report/report-open";
import { authorOf, forYouTodo, splitLead } from "./request-blocks";
import { blockText, When, type BlockCommon } from "./RequestBlocks";
import { RelatedRequests } from "./RequestProgress";
import { DataAsOf } from "./SectionCard";
import { MoreActions } from "./SummaryCard";
import type { Section } from "./types";

/** What a click on the banner leaves to the control it lands on. */
const CONTROLS = "button, a, summary, input, textarea, select, label, .home-card-reply, .home-summary-more";

/**
 * Where the project stands, under its name on its page (R-27, the user's H4): the card the page leads with
 * (projectLine), its lead's opening as a heading and the rest of it under that, who wrote it and when, and, when its
 * author names a Checklist of what the user is asked to do (`summary.forYou`), its first two open items beside it.
 * Without one it shows the conclusion alone. Past its validity it says so, in the attention colour, and stays the
 * same card. A click on it opens the card's page; one on a control in it does what the control does.
 *
 * With other cards, "Project cards N" leads to the group below, where the card itself is. With none (`more` 0), the
 * banner is the card's one place on the page (the lead's call on YN-218, seq 12072): it carries the card's id, so a
 * link, a jump or a reply's "Open on Home" lands here with its note, says a status's "Data as of" as its card does,
 * says New or Updated as its card does, and offers the card's own Reply (the same draft and recipient, CardReply), Seen
 * (the page's) and More actions (Pin, Copy report), as a read-only Home withholds them from the card.
 */
export function ProjectNow({
  section,
  more,
  onMore,
  common,
  related = [],
  onShowBlock,
}: {
  section: Section;
  /** How many the Project cards group holds; 0 when it is not drawn (projectCardsCount). */
  more: number;
  /** Shows the Project cards group, opened. */
  onMore: () => void;
  common: BlockCommon;
  /** The requests its common items serve (R-38 §2.4): only by the tasks its LiveRefs name. */
  related?: readonly { task: string; n: number }[];
  onShowBlock?: (n: number) => void;
}) {
  const { projectId, workspaceId, agents, readOnly } = common;
  const language = useLanguage();
  const tb = blockText(language);
  const tc = cardText(language);
  const bt = briefText(language);
  const home = homeText(language);
  const openReport = useReportOpen();
  const alone = more === 0;
  const status = section.kind === "status";
  const stale = !!section.status?.stale;
  const lead = splitLead(cardContent(section).lead);
  const todo = forYouTodo(section);
  const open = (from: HTMLElement) => openReport?.(projectId, section, from);
  const openFrom = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest(CONTROLS)) return;
    open(event.currentTarget);
  };
  // The card's own actions, when the banner is its one place: as its card has them (SummaryCard).
  const replyable = alone && !readOnly;
  // New or Updated since the user last read it, as the card says it (SummaryCard): only where the banner is the card.
  const changed = alone && section.historyReason !== "archived" && unreadChange(section);
  const [replying, setReplying] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, section.key)));
  const [replyOpened, setReplyOpened] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const [seeing, setSeeing] = useState(false);
  const [error, setError] = useState("");
  async function seen() {
    setSeeing(true);
    setError("");
    try {
      await common.onSeen([{ key: section.key, version: section.version }]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeing(false);
    }
  }
  return (
    <section
      className={`now-hero${todo ? " has-side" : ""}${stale ? " is-stale" : ""}${alone ? " is-alone" : ""}`}
      style={{ "--project-colour": projectColour(projectId) } as CSSProperties}
      aria-label={tb.nowLabel}
      id={alone ? sectionDomId(projectId, section.key) : undefined}
      data-section-key={alone ? section.key : undefined}
      data-now-key={section.key}
      tabIndex={-1}
      onClick={openFrom}
    >
      <div className="now-hero-main">
        {alone && common.notice?.(section)}
        <p className="now-hero-label">
          {stale ? tb.nowStale : tb.now}
          {changed && (
            <Tip content={<TipText body={home.changedTitle} />}>
              <span className="home-changed">{readBefore(section) ? home.updated : home.new}</span>
            </Tip>
          )}
        </p>
        <p className="now-hero-head">{lead?.head ?? section.title}</p>
        {lead?.rest && (
          <div className="now-hero-text">
            <BriefMarkdown text={lead.rest} />
          </div>
        )}
        {onShowBlock && <RelatedRequests related={related} onShowBlock={onShowBlock} />}
        <p className="now-meta">
          {lead && <span className="now-meta-part now-meta-title">{section.title}</span>}
          <span className="now-meta-part">{authorOf(section)}</span>
          {alone && status && section.status ? (
            <span className="now-meta-part">
              <DataAsOf status={section.status} stale={stale} />
            </span>
          ) : (
            <>
              <span className="now-meta-part">
                <When at={section.status?.asOf ?? section.updatedAt} />
              </span>
              {stale && <span className="now-meta-part request-block-stale">{tb.fact.stale}</span>}
            </>
          )}
          <span className="now-actions">
            {alone && (
              <span className="now-card-actions">
                {replyable && (
                  <Tip content={<TipText title={home.replyTitle(section.owner.name)} />} describe={false}>
                    <button
                      type="button"
                      className="icon-button home-reply-open"
                      ref={replyButton}
                      aria-expanded={replying}
                      aria-label={home.replyLabel(section.title)}
                      onClick={() => {
                        setReplyOpened(true);
                        setReplying((value) => !value);
                      }}
                    >
                      <MessageSquareReply size={14} />
                    </button>
                  </Tip>
                )}
                {changedSinceSeen(section) && !readOnly && (
                  <Tip content={<TipText title={home.seen} />} describe={false}>
                    <button type="button" className="icon-button home-seen" disabled={seeing} aria-label={home.seenLabel(section.title)} onClick={() => void seen()}>
                      {seeing ? <LoaderCircle size={14} className="spin" /> : <Eye size={14} />}
                    </button>
                  </Tip>
                )}
                <MoreActions section={section} projectId={projectId} readOnly={readOnly} />
              </span>
            )}
            {more > 0 && (
              <button type="button" className="talk-link" onClick={onMore}>
                {tb.nowCards(more)}
                <ArrowDown size={12} aria-hidden="true" />
              </button>
            )}
            {openReport && (
              <button type="button" className="home-report-open" aria-label={tc.openLabel(section.title)} onClick={(event) => open(event.currentTarget)}>
                {status ? tc.openStatus : tc.openReport}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
          </span>
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {todo && (
        <aside className="now-hero-aside" aria-label={todo.title ?? bt.checklist}>
          <p className="now-todo-head">
            <span className="now-todo-count">{todo.open}</span>
            {tb.nowOpen(todo.title)}
          </p>
          <ul className="now-todo-list">
            {todo.items.slice(0, 2).map((item) => (
              <li key={item.id}>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
          {todo.open > 2 && openReport && (
            <button type="button" className="now-todo-more" onClick={(event) => open(event.currentTarget)}>
              {tb.nowMore(todo.open - 2)}
            </button>
          )}
        </aside>
      )}
      {replyable && replying && (
        <div className="now-hero-reply">
          <CardReply
            section={section}
            projectId={projectId}
            workspaceId={workspaceId}
            agents={agents}
            opened={replyOpened}
            onClose={() => {
              replyButton.current?.focus();
              setReplying(false);
            }}
          />
        </div>
      )}
    </section>
  );
}
