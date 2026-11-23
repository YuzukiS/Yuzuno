import type { CSSProperties, MouseEvent } from "react";
import { ArrowDown, ArrowRight } from "lucide-react";
import { useLanguage } from "../i18n";
import { projectColour } from "../project-groups";
import { BriefMarkdown } from "./brief/Markdown";
import { briefText } from "./brief/brief-text";
import { cardContent } from "./card-preview";
import { cardText } from "./card-text";
import { useReportOpen } from "./report/report-open";
import { authorOf, forYouTodo, splitLead } from "./request-blocks";
import { blockText, When } from "./RequestBlocks";
import type { Section } from "./types";

/**
 * Where the project stands, under its name on its page (R-27, the user's H4): the card the page leads with
 * (projectLine), its lead's opening as a heading and the rest of it under that, who wrote it and when, and, when its
 * author names a Checklist of what the user is asked to do (`summary.forYou`), its first two open items beside it.
 * Without one it shows the conclusion alone. Past its validity it says so, in the attention colour, and stays the
 * same card. A click on it opens the card's page; one on a control in it does what the control does. Project cards
 * leads to the group below, where the card itself is (with its Pin, Reply and Seen) and carries its id.
 */
export function ProjectNow({
  projectId,
  section,
  more,
  onMore,
}: {
  projectId: string;
  section: Section;
  /** How many the Project cards group holds (projectCardsCount). */
  more: number;
  /** Shows the Project cards group, opened. */
  onMore: () => void;
}) {
  const language = useLanguage();
  const tb = blockText(language);
  const tc = cardText(language);
  const bt = briefText(language);
  const openReport = useReportOpen();
  const status = section.kind === "status";
  const stale = !!section.status?.stale;
  const lead = splitLead(cardContent(section).lead);
  const todo = forYouTodo(section);
  const open = (from: HTMLElement) => openReport?.(projectId, section, from);
  const openFrom = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, a, summary, input, textarea, select")) return;
    open(event.currentTarget);
  };
  return (
    <section
      className={`now-hero${todo ? " has-side" : ""}${stale ? " is-stale" : ""}`}
      style={{ "--project-colour": projectColour(projectId) } as CSSProperties}
      aria-label={tb.nowLabel}
      data-now-key={section.key}
      tabIndex={-1}
      onClick={openFrom}
    >
      <div className="now-hero-main">
        <p className="now-hero-label">{stale ? tb.nowStale : tb.now}</p>
        <p className="now-hero-head">{lead?.head ?? section.title}</p>
        {lead?.rest && (
          <div className="now-hero-text">
            <BriefMarkdown text={lead.rest} />
          </div>
        )}
        <p className="now-meta">
          {lead && <span className="now-meta-part now-meta-title">{section.title}</span>}
          <span className="now-meta-part">{authorOf(section)}</span>
          <span className="now-meta-part">
            <When at={section.status?.asOf ?? section.updatedAt} />
          </span>
          {stale && <span className="now-meta-part request-block-stale">{tb.fact.stale}</span>}
          <span className="now-actions">
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
    </section>
  );
}
