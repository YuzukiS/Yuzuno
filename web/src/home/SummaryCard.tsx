import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Eye, LoaderCircle, MessageSquareReply, MoreHorizontal, Square, SquareCheckBig } from "lucide-react";
import { errorText } from "../api";
import { CopyButton } from "../components";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import type { Agent } from "../types";
import { attachmentUrl } from "./brief/brief-catalog";
import { rememberSeenBlocks } from "./brief/block-changes";
import { reportMarkdown } from "./brief/brief-copy";
import { BriefMarkdown } from "./brief/Markdown";
import { changedSinceSeen, sectionDomId } from "./brief-layout";
import { allowedSizes, cardContent, shownSize, type CardContent, type CardFigure, type CardSize } from "./card-preview";
import { CardSizes, sizable, type CardSizeControl } from "./card-sizes";
import { SizeChoice } from "./SizeChoice";
import { cardText } from "./card-text";
import { unmaintained } from "./card-summary";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { absolute, relative } from "./format";
import type { SeenMark } from "./home-api";
import { BriefDensity } from "./home-density";
import { homeText } from "./home-text";
import { useReportOpen } from "./report/report-open";
import { DataAsOf, PinButton } from "./SectionCard";
import { SectionBody } from "./SectionBody";
import type { Section } from "./types";
import "./summary-card.css";

/**
 * A report or status on Home as its summary (T-18, Lead 2270; Dev 7's v7
 * and v9): the whole body is read on the report page. Its title and "Open
 * report" are the two ways there; nothing else on the card opens it, so the
 * card's own controls stay theirs. What it shows is what the author named
 * (the conclusion, what it holds under, one figure); when they named none,
 * only that, under its title: nothing is taken from the body for them.
 */
export const SummaryCard = memo(function SummaryCard({
  section,
  projectId,
  workspaceId,
  agents,
  topic,
  deck = false,
  readOnly,
  onSeen,
  notice,
}: {
  section: Section;
  projectId: string;
  workspaceId: string;
  agents: Agent[];
  /** A sub-topic's topic, read as words: the card says it belongs there. */
  topic?: string;
  /** On the project's deck, where cards have sizes; elsewhere (the team's details) a card keeps its frame. */
  deck?: boolean;
  readOnly: boolean;
  onSeen: (marks: SeenMark[]) => Promise<void>;
  notice?: React.ReactNode;
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const home = homeText(language);
  const t = useStrings(cardText);
  const openReport = useReportOpen();
  const content = useMemo(() => cardContent(section), [section]);
  const sub = topic !== undefined;
  // Only a card on the deck has a size; the user may choose it where Core names the section.
  const sizes = useContext(CardSizes);
  const sizing = deck && sizes && sizable(section) ? { control: sizes, id: section.id } : null;
  const { size, source, own } = deck
    ? shownSize(section, content, sizing?.control.chosen(projectId, sizing.id), sizing ? (computed) => sizing.control.held(projectId, sizing.id, computed) : undefined)
    : { size: null, source: null, own: null };
  const changed = changedSinceSeen(section);
  const stale = !!section.status?.stale;
  const orphaned = unmaintained(section);
  const replyable = !readOnly && !section.history;
  const [replying, setReplying] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, section.key)));
  const [seeing, setSeeing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => rememberSeenBlocks(workspaceId, projectId, section), [workspaceId, projectId, section]);
  const domId = sectionDomId(projectId, section.key);
  async function seen() {
    setSeeing(true);
    setError("");
    try {
      await onSeen([{ key: section.key, version: section.version }]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeing(false);
    }
  }
  const open = (from: HTMLElement) => openReport?.(projectId, section, from);
  const status = section.kind === "status";
  // A small card draws no figure (Dev 7's v12, v15): Metrics as big numbers;
  // any other, one line naming it and where it is read, "Open report" below.
  const shown = content.kind === "named" ? content.figure : null;
  const figure = !shown ? null : size !== "small" ? (
    <FigureFrame section={section} projectId={projectId} figure={shown} />
  ) : metricsOf(section, shown) ? (
    <BigNumbers items={metricsOf(section, shown)!} />
  ) : (
    <p className="home-card-figure-note">{t.figureOnPage(figureKindOf(section, shown, t.figureKind), status)}</p>
  );
  return (
    <article
      id={domId}
      data-section-key={section.key}
      data-section-version={section.version}
      data-card-size={size ?? undefined}
      data-size-source={source ?? undefined}
      tabIndex={-1}
      className={`home-section home-summary-card kind-${section.kind}${size ? ` size-${size}` : ""}${content.kind === "unnamed" ? " is-unnamed" : ""}${sub ? " is-sub" : ""}${changed ? " is-changed" : ""}${stale ? " is-stale" : ""}`}
      aria-labelledby={`${domId}-title`}
    >
      {notice}
      <header className="home-summary-head">
        {sub && <span className="home-sub-of">{home.inTopic(topic)}</span>}
        <span className={`home-kind kind-${section.kind}`}>{home.kind[section.kind]}</span>
        {changed && (
          <span className="home-changed" title={home.changedTitle}>
            {section.seen ? home.updated : home.new}
          </span>
        )}
        {orphaned && (
          <span
            className="home-unmaintained"
            title={home.notMaintainedTitle(section.owner.name, home.gone[section.owner.state as keyof typeof home.gone] ?? home.inactive, home.kindInSentence[section.kind])}
          >
            {home.notMaintained}
          </span>
        )}
        <span className="home-summary-actions">
          {replyable && (
            <button
              type="button"
              className="icon-button home-reply-open"
              aria-expanded={replying}
              aria-label={home.replyLabel(section.title)}
              title={home.replyTitle(section.owner.name)}
              onClick={() => setReplying((value) => !value)}
            >
              <MessageSquareReply size={14} />
            </button>
          )}
          {changed && !readOnly && (
            <button
              type="button"
              className="icon-button home-seen"
              disabled={seeing}
              aria-label={home.seenLabel(section.title)}
              title={home.seen}
              onClick={() => void seen()}
            >
              {seeing ? <LoaderCircle size={14} className="spin" /> : <Eye size={14} />}
            </button>
          )}
          <MoreActions section={section} projectId={projectId} readOnly={readOnly} content={content} sizing={sizing && own ? { ...sizing, own } : null} />
        </span>
      </header>
      {/* The text, and beside it on a wide card or under it otherwise, the one figure. */}
      <div className={`home-summary-body${figure ? " has-figure" : ""}`}>
        <div className="home-summary-text">
          <h3 id={`${domId}-title`} className="home-summary-title">
            {openReport ? (
              <button type="button" className="home-summary-title-link" onClick={(event) => open(event.currentTarget)}>
                {section.title}
              </button>
            ) : (
              section.title
            )}
          </h3>
          {content.kind === "named" ? (
            <>
              {content.lead && (
                <div className="home-summary-lead">
                  <BriefMarkdown text={content.lead} />
                </div>
              )}
              {content.conditions && (
                <CardConditions section={section} projectId={projectId} id={content.conditions} lines={size === "large" ? 3 : 2} />
              )}
            </>
          ) : (
            <p className="home-summary-unnamed">{t.noSummary}</p>
          )}
        </div>
        {figure}
      </div>
      <footer className="home-summary-foot">
        <span className="home-summary-byline">
          {/* A sub-topic is labelled with its own author, as before (T-197). */}
          <span className="home-owner">
            {sub ? home.by : ""}
            {section.owner.name}
            {section.owner.state !== "active" && home.ownerState(section.owner.state)}
          </span>
          {status && section.status ? (
            <DataAsOf status={section.status} stale={stale} />
          ) : (
            <span title={absolute(section.updatedAt, time)}>{relative(section.updatedAt, language)}</span>
          )}
        </span>
        {openReport && (
          <button type="button" className="home-report-open" aria-label={t.openLabel(section.title)} onClick={(event) => open(event.currentTarget)}>
            {status ? t.openStatus : t.openReport}
            <ArrowRight size={14} />
          </button>
        )}
      </footer>
      {replyable && replying && (
        <CardReply section={section} projectId={projectId} workspaceId={workspaceId} agents={agents} onClose={() => setReplying(false)} />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
});

/** Pin, Copy report and the card's size, behind "More actions". */
function MoreActions({
  section,
  projectId,
  readOnly,
  content,
  sizing,
}: {
  section: Section;
  projectId: string;
  readOnly: boolean;
  content: CardContent;
  sizing: { control: CardSizeControl; id: number; own: CardSize } | null;
}) {
  const t = useStrings(cardText);
  const language = useLanguage();
  const time = useTimeDisplay();
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
  const pin = !readOnly;
  const copy = section.kind === "report";
  if (!pin && !copy && !sizing) return null;
  return (
    <span
      className="home-summary-more"
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
        aria-label={t.moreLabel(section.title)}
        title={t.more}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} />
      </button>
      <span id={listId} className="home-summary-more-list" role="group" aria-label={t.more} hidden={!open}>
        {/* The card's size first, then its other actions (Dev 7's v14). */}
        {sizing && (
          <SizeChoice
            name={`${listId}-size`}
            legend={t.size}
            value={sizing.control.chosen(projectId, sizing.id)}
            own={sizing.own}
            variant="menu"
            allowed={allowedSizes(content)}
            onChange={(size) => sizing.control.choose(projectId, sizing.id, size)}
          />
        )}
        {pin && <PinButton section={section} projectId={projectId} />}
        {copy && <CopyButton text={() => reportMarkdown(section, projectId, language, time)} label={homeText(language).copyReport} />}
      </span>
    </span>
  );
}

type ChecklistItem = { id: string; text: string; done: boolean };

/**
 * What the author's conclusion holds under, with it on the card (Dev 7's
 * v9): a Checklist as chips, as many as two lines take (three on a large
 * card), then "+N more conditions" (never one: a lone last chip takes a
 * line of its own); Markdown in two lines, then "Show all conditions".
 * Either opens in place, and the card grows to hold it.
 */
function CardConditions({ section, projectId, id, lines: most }: { section: Section; projectId: string; id: string; lines: number }) {
  const t = useStrings(cardText);
  const node = (section.body as { elements?: Record<string, { type?: string; props?: Record<string, unknown> }> }).elements?.[id];
  const items = node?.type === "Checklist" && Array.isArray(node.props?.items) ? (node.props.items as ChecklistItem[]) : null;
  const list = useRef<HTMLUListElement>(null);
  const prose = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [all, setAll] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      if (items && list.current) {
        const chips = [...list.current.children] as HTMLElement[];
        chips.forEach((chip) => chip.removeAttribute("hidden"));
        if (all) return setHidden(0);
        const lines = [...new Set(chips.map((chip) => chip.offsetTop))].sort((a, b) => a - b);
        const past = lines[most];
        let over = past === undefined ? 0 : chips.filter((chip) => chip.offsetTop >= past).length;
        if (over === 1) over = 0;
        chips.slice(chips.length - over).forEach((chip) => chip.setAttribute("hidden", ""));
        setHidden(over);
      } else if (prose.current) {
        setClamped(!all && prose.current.scrollHeight > prose.current.clientHeight + 1);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    const target = list.current ?? prose.current;
    if (target) observer.observe(target);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [all, items, section.version, most]);
  return (
    <div className={`home-card-conditions${all ? " is-open" : ""}`} role="group" aria-label={t.conditions}>
      <span className="home-card-conditions-label">{t.conditions}</span>
      {items ? (
        <ul ref={list} id={bodyId} className="home-card-condition-chips">
          {items.map((item) => (
            <li key={item.id} data-done={item.done || undefined}>
              {item.done ? <SquareCheckBig size={12} aria-hidden /> : <Square size={12} aria-hidden />}
              {item.text}
            </li>
          ))}
        </ul>
      ) : (
        <div ref={prose} id={bodyId} className={`home-card-condition-text${all ? "" : " is-clamped"}`}>
          <SectionBody section={section} projectId={projectId} only={[id]} />
        </div>
      )}
      {(hidden > 0 || clamped || all) && (
        <button type="button" className="quiet-button home-card-conditions-toggle" aria-expanded={all} aria-controls={bodyId} onClick={() => setAll(!all)}>
          {all ? t.fewerConditions : items ? t.moreConditions(hidden) : t.allConditions}
        </button>
      )}
    </div>
  );
}

type Metric = { label: string; value: string | number; unit?: string };

/** A figure's kind in words, for the line a small card shows in its place. */
function figureKindOf(section: Section, figure: CardFigure, names: Record<string, string>) {
  if (figure.kind !== "block") return names[figure.kind];
  const type = (section.body as { elements?: Record<string, { type?: string }> }).elements?.[figure.id]?.type ?? "";
  return names[type] ?? type;
}

/** A Metrics figure's values, for a small card; null for any other figure. */
function metricsOf(section: Section, figure: CardFigure): Metric[] | null {
  if (figure.kind !== "block") return null;
  const node = (section.body as { elements?: Record<string, { type?: string; props?: { items?: unknown } }> }).elements?.[figure.id];
  return node?.type === "Metrics" && Array.isArray(node.props?.items) ? (node.props.items as Metric[]) : null;
}

/**
 * Metrics on a small card (Dev 7's v12): the first value large under its
 * label, the second smaller beside it; a number never parted from its unit.
 * A small card shows two at most; the page shows them all.
 */
function BigNumbers({ items }: { items: Metric[] }) {
  const t = useStrings(cardText);
  return (
    <div className="home-card-numbers-frame">
      <dl className="home-card-numbers">
        {items.slice(0, 2).map((item, index) => (
          <div key={index} className={index === 0 ? "is-first" : undefined}>
            <dt>{item.label}</dt>
            <dd>
              {String(item.value)}
              {item.unit ? `\u00a0${item.unit}` : ""}
            </dd>
          </div>
        ))}
      </dl>
      {/* Nothing dropped unsaid (Dev 7, 2403): how many the page has. */}
      {items.length > 2 && <p className="home-card-numbers-count">{t.valuesShown(2, items.length)}</p>}
    </div>
  );
}

/** The card's one figure, bounded, in a fixed frame; it is no control and opens nothing. */
function FigureFrame({ section, projectId, figure }: { section: Section; projectId: string; figure: CardFigure }) {
  const t = useStrings(cardText);
  return (
    <figure className={`home-card-frame kind-${figure.kind}`}>
      <div className="home-card-frame-body" inert>
        {figure.kind === "block" ? (
          <BriefDensity.Provider value="low">
            <SectionBody section={section} projectId={projectId} only={[figure.id]} />
          </BriefDensity.Provider>
        ) : figure.kind === "table" ? (
          <table className="home-card-table">
            <thead>
              <tr>{figure.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {figure.rows.map((row) => (
                <tr key={row.id}>
                  {figure.columns.map((column) => <td key={column.key}>{String(row.cells[column.key] ?? "—")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : figure.kind === "image" ? (
          <img src={attachmentUrl(projectId, section.key, figure.name, section.version)} alt={figure.caption ?? figure.name} />
        ) : (
          <p className="home-card-desk">
            <strong>{figure.title}</strong>
            <span>{t.deskCounts(figure.claims, figure.plots)} · {t.deskInteractive}</span>
          </p>
        )}
      </div>
      {(figure.kind === "table" || (figure.kind === "image" && figure.caption)) && (
        <figcaption>
          {figure.kind === "table" && t.tableCounts(figure.rows.length, figure.totalRows, figure.columns.length, figure.totalColumns)}
          {figure.kind === "image" && figure.caption}
        </figcaption>
      )}
    </figure>
  );
}
