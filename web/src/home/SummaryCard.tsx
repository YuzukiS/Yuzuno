import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Eye, FileText, Globe, Image as ImageIcon, LoaderCircle, Maximize2, MessageSquareReply, MoreHorizontal, Square, SquareCheckBig } from "lucide-react";
import { errorText } from "../api";
import { CopyButton } from "../components";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import type { Agent } from "../types";
import { attachmentUrl, type ChartProps, type ResearchDeskProps } from "./brief/brief-catalog";
import { BriefContext } from "./brief/BriefContext";
import { briefText } from "./brief/brief-text";
import { CardChart, type ChartKind } from "./brief/Charts";
import { rememberSeenBlocks } from "./brief/block-changes";
import { reportMarkdown } from "./brief/brief-copy";
import { keptSnapshot, useKeptImage } from "./brief/kept-image";
import { useKeptImagePreview } from "./brief/image-preview";
import { BriefMarkdown } from "./brief/Markdown";
import { BriefStateScope } from "./brief/brief-state";
import { DeskCardClaim } from "./brief/ResearchDesk";
import { changedSinceSeen, sectionDomId } from "./brief-layout";
import { PinOff } from "lucide-react";
import { CardFoldWorkspace } from "./card-fold";
import { CARD_FILES, cardContent, LARGE_METRICS, LARGE_TABLE_PREVIEW, selfContained, shownSize, TABLE_PREVIEW, type CardFigure, type CardFile, type CardSize } from "./card-preview";
import { CardPage, CardPageLine } from "./CardPage";
import { openInPortal } from "../portal";
import { DeckSizes, sizable } from "./card-sizes";
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
 * card's own controls stay theirs. A kept image it shows opens whole in
 * place, as on its report page (YN-3), not the report. What it shows is
 * what the author named (the conclusion, what it holds under, one figure);
 * when they named none, how its body opens (cardContent, YN-3). A figure of
 * inputs (YN-16) works on the card: its parts share the card's variables,
 * which are the card's own, never its report page's.
 */
export const SummaryCard = memo(function SummaryCard({
  section,
  projectId,
  workspaceId,
  agents,
  topic,
  deck = false,
  widget,
  referable = false,
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
  /**
   * Pinned to the user's widgets (T-18, Dev 7's v19): the same card, at the
   * size the user gave the widget or else its Agent's, with Size and Unpin in
   * its More actions. Its own element ids, so the card in its project stays
   * the one found by key.
   */
  widget?: { id: string; chosen: CardSize | null; onResize: (size: CardSize | null) => void; onUnpin: () => void };
  /** In History: whether it still takes a reply (replyableIn), as a pinned report the user marked seen does. */
  referable?: boolean;
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
  // Only a card on the deck has a size: its author's, as first shown in this visit.
  const sizes = useContext(DeckSizes);
  const { size, source, own } = deck || widget
    ? shownSize(section, content, widget?.chosen ?? null, sizes && sizable(section) ? (computed) => sizes.held(projectId, section.id!, computed) : undefined)
    : { size: null, source: null, own: null };
  const changed = changedSinceSeen(section);
  const stale = !!section.status?.stale;
  const orphaned = unmaintained(section);
  // Where Home takes a reply (T-174): a live card, or a report marked seen that a reply can still refer to, so a
  // pinned report the user marks seen keeps its Reply and the reply being written (Lead 2655).
  const replyable = !readOnly && section.kind !== "ask" && (!section.history || referable);
  const [replying, setReplying] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, section.key)));
  // Opened by the user here, not kept from before; closed, focus goes back to Reply (T-19 HM:S7).
  const [replyOpened, setReplyOpened] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const [seeing, setSeeing] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => rememberSeenBlocks(workspaceId, projectId, section), [workspaceId, projectId, section]);
  const domId = widget ? `${widget.id}-card` : sectionDomId(projectId, section.key);
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
  // A card that is its whole report has no way to a page that would show only the same (YN-3); the page keeps its address.
  const contained = useMemo(() => selfContained(section, content, size), [section, content, size]);
  const report = contained ? null : openReport;
  const open = (from: HTMLElement) => report?.(projectId, section, from);
  const status = section.kind === "status";
  // A small card draws no figure (Dev 7's v12, v15): Metrics as big numbers;
  // a kept image, a button that opens it whole in place (YN-3); any other,
  // one line naming it and where it is read, "Open report" below.
  const shown = content.figure;
  // A figure of inputs is drawn at every size: the reader sets it on the card (YN-16).
  const figure = !shown ? null : size !== "small" || shown.kind === "interactive" ? (
    <FigureFrame section={section} projectId={projectId} figure={shown} large={size === "large"} />
  ) : metricsOf(section, shown) ? (
    <BigNumbers items={metricsOf(section, shown)!} />
  ) : shown.kind === "image" && shown.kept ? (
    <ImageView section={section} projectId={projectId} figure={shown} />
  ) : shown.kind === "page" ? (
    <CardPageLine section={section} projectId={projectId} figure={shown} title={section.title} />
  ) : (
    <p className="home-card-figure-note">{t.figureOnPage(figureKindOf(section, shown, t.figureKind), status)}</p>
  );
  const card = (
    <article
      id={domId}
      data-section-key={widget ? undefined : section.key}
      data-pin-widget={widget?.id}
      data-section-version={section.version}
      data-card-size={size ?? undefined}
      data-size-source={source ?? undefined}
      tabIndex={-1}
      className={`home-section home-summary-card kind-${section.kind}${size ? ` size-${size}` : ""}${content.kind === "unnamed" ? " is-unnamed" : ""}${contained ? " is-whole" : ""}${sub ? " is-sub" : ""}${changed ? " is-changed" : ""}${stale ? " is-stale" : ""}`}
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
              ref={replyButton}
              aria-expanded={replying}
              aria-label={home.replyLabel(section.title)}
              title={home.replyTitle(section.owner.name)}
              onClick={() => {
                setReplyOpened(true);
                setReplying((value) => !value);
              }}
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
          <MoreActions section={section} projectId={projectId} readOnly={readOnly} widget={widget && own ? { ...widget, own } : undefined} />
        </span>
      </header>
      {/* The text, and beside it on a wide card or under it otherwise, the one figure. */}
      <div className={`home-summary-body${figure ? " has-figure" : ""}`}>
        <div className="home-summary-text">
          <h3 id={`${domId}-title`} className="home-summary-title">
            {report ? (
              <button type="button" className="home-summary-title-link" onClick={(event) => open(event.currentTarget)}>
                {section.title}
              </button>
            ) : (
              section.title
            )}
          </h3>
          {content.lead && (
            <div className="home-summary-lead">
              <BriefMarkdown text={content.lead} />
            </div>
          )}
          {content.kind === "named" && content.conditions && (
            <CardConditions section={section} projectId={projectId} id={content.conditions} lines={size === "large" ? 3 : 2} />
          )}
        </div>
        {figure}
      </div>
      {content.files.length > 0 && <CardFiles section={section} projectId={projectId} files={content.files} onReport={report ? open : null} />}
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
        {report && (
          <button type="button" className="home-report-open" aria-label={t.openLabel(section.title)} onClick={(event) => open(event.currentTarget)}>
            {status ? t.openStatus : t.openReport}
            <ArrowRight size={14} />
          </button>
        )}
      </footer>
      {replyable && replying && (
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
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
  // The card's variables, which its figure and conditions share (YN-16).
  return <BriefStateScope section={section}>{card}</BriefStateScope>;
});

/**
 * Behind "More actions": Pin and Copy report; on a pinned widget, its size
 * first (Follow Agent, Small, Wide, Large), then Unpin and Copy report.
 */
function MoreActions({
  section,
  projectId,
  readOnly,
  widget,
}: {
  section: Section;
  projectId: string;
  readOnly: boolean;
  widget?: { id: string; chosen: CardSize | null; own: CardSize; onResize: (size: CardSize | null) => void; onUnpin: () => void };
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
  if (!pin && !copy) return null;
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
        {widget && (
          <SizeChoice name={`${widget.id}-size`} legend={t.widgetSizeHeading} value={widget.chosen} own={widget.own} variant="menu" onChange={widget.onResize} />
        )}
        {widget ? (
          <button type="button" className="quiet-button" onClick={widget.onUnpin}>
            <PinOff size={13} aria-hidden="true" /> {homeText(language).unpinShort}
          </button>
        ) : (
          pin && <PinButton section={section} projectId={projectId} anchor={trigger} />
        )}
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
 *
 * A Checklist's own title names the box, else "Conditions" (YN-7). Its open
 * items come first, each group in the author's order, so what is folded
 * first is what is already done, and the fold says how many of the folded
 * are still open. The report page keeps the author's order.
 */
function CardConditions({ section, projectId, id, lines: most }: { section: Section; projectId: string; id: string; lines: number }) {
  const t = useStrings(cardText);
  const node = (section.body as { elements?: Record<string, { type?: string; props?: Record<string, unknown> }> }).elements?.[id];
  const listed = node?.type === "Checklist" && Array.isArray(node.props?.items) ? (node.props.items as ChecklistItem[]) : null;
  const items = useMemo(() => (listed ? [...listed.filter((item) => !item.done), ...listed.filter((item) => item.done)] : null), [listed]);
  const title = node?.type === "Checklist" && typeof node.props?.title === "string" && node.props.title.trim() ? node.props.title : null;
  const label = title ?? t.conditions;
  const list = useRef<HTMLUListElement>(null);
  const prose = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [all, setAll] = useState(false);
  const [hidden, setHidden] = useState(0);
  const [hiddenOpen, setHiddenOpen] = useState(0);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      if (items && list.current) {
        const chips = [...list.current.children] as HTMLElement[];
        chips.forEach((chip) => chip.removeAttribute("hidden"));
        if (all) {
          setHiddenOpen(0);
          return setHidden(0);
        }
        const lines = [...new Set(chips.map((chip) => chip.offsetTop))].sort((a, b) => a - b);
        const past = lines[most];
        let over = past === undefined ? 0 : chips.filter((chip) => chip.offsetTop >= past).length;
        if (over === 1) over = 0;
        chips.slice(chips.length - over).forEach((chip) => chip.setAttribute("hidden", ""));
        setHidden(over);
        setHiddenOpen(over ? items.slice(items.length - over).filter((item) => !item.done).length : 0);
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
    <div className={`home-card-conditions${all ? " is-open" : ""}`} role="group" aria-label={label}>
      <span className="home-card-conditions-label">{label}</span>
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
          {all ? t.fewerConditions : items ? t.moreConditions(hidden, hiddenOpen) : t.allConditions}
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

const CHARTS: Record<string, ChartKind> = { LineChart: "line", BarChart: "bar", ScatterChart: "scatter" };
/** A chart figure's kind and its block's props; null for any other figure. */
function chartOf(section: Section, figure: CardFigure) {
  if (figure.kind !== "block") return null;
  const node = (section.body as { elements?: Record<string, { type?: string; props?: Partial<ChartProps> }> }).elements?.[figure.id];
  const kind = CHARTS[node?.type ?? ""];
  return kind && node?.props?.x && node.props.y ? { kind, props: node.props as ChartProps } : null;
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

/** A small card's kept image (YN-3): not drawn in a frame, but one click
 * or key away, whole, in the image viewer, as from its report page. */
/** The body's other files, named under the picture, each opened in place; past three, "+n more" (YN-3). */
function CardFiles({ section, projectId, files, onReport }: { section: Section; projectId: string; files: CardFile[]; onReport: ((from: HTMLElement) => void) | null }) {
  const t = useStrings(cardText);
  return (
    <ul className="home-card-files" aria-label={t.filesLabel}>
      {files.slice(0, CARD_FILES).map((file) => (
        <li key={file.name}>
          <CardFileChip section={section} projectId={projectId} file={file} onReport={onReport} />
        </li>
      ))}
      {files.length > CARD_FILES && (
        <li>
          {onReport ? (
            <button type="button" className="quiet-button home-card-file-more" onClick={(event) => onReport(event.currentTarget)}>
              {t.filesMore(files.length - CARD_FILES)}
            </button>
          ) : (
            <span className="home-card-file-more">{t.filesMore(files.length - CARD_FILES)}</span>
          )}
        </li>
      )}
    </ul>
  );
}

/** One file: a kept image opens in the viewer, a kept page in the Portal, any other on the report page. */
function CardFileChip({ section, projectId, file, onReport }: { section: Section; projectId: string; file: CardFile; onReport: ((from: HTMLElement) => void) | null }) {
  const attachment = section.attachments.find((item) => item.name === file.name);
  const viewer = useKeptImagePreview(projectId, section, file.kind === "image" && file.kept ? attachment : undefined, attachment?.caption);
  const inPlace = file.kept && (file.kind === "image" || file.kind === "page");
  const Icon = file.kind === "image" ? ImageIcon : file.kind === "page" ? Globe : FileText;
  return (
    <>
      <button
        type="button"
        className="home-card-file"
        title={file.name}
        disabled={!inPlace && !onReport}
        onClick={(event) => {
          if (file.kind === "image" && inPlace) viewer.open();
          else if (file.kind === "page" && inPlace)
            openInPortal({
              kind: "snapshot",
              source: { kind: "briefAttachment", projectId, section: section.key, name: file.name, version: section.version },
              name: file.name,
              from: `Home · ${section.title}`,
            }, event.currentTarget);
          else onReport?.(event.currentTarget);
        }}
      >
        <Icon size={12} aria-hidden="true" />
        <span>{file.name}</span>
      </button>
      {viewer.dialog}
    </>
  );
}

function ImageView({ section, projectId, figure }: { section: Section; projectId: string; figure: Extract<CardFigure, { kind: "image" }> }) {
  const t = useStrings(cardText);
  const file = section.attachments.find((item) => item.name === figure.name);
  const viewer = useKeptImagePreview(projectId, section, file, figure.caption ?? undefined);
  return (
    <div className="home-card-figure-note">
      <button type="button" className="quiet-button home-card-image-view" aria-label={t.viewImageLabel(figure.name)} onClick={viewer.open}>
        <ImageIcon size={13} aria-hidden="true" />
        {t.viewImage}
      </button>
      {viewer.dialog}
    </div>
  );
}

/**
 * The card's one figure, bounded, in a fixed frame. Only a kept image is a
 * control: it opens whole in the image viewer, in place, as on its report
 * page (YN-3); anything else in the frame opens nothing. A large card shows
 * more of what the figure has (Dev 7, 2547): a table's first 8 rows and 6
 * columns, up to 6 Metrics values in a grid; anything shorter than the frame
 * sits in its middle. A chart is drawn
 * to fit the frame, its axes and legend with it (CardChart, Lead 2655); the
 * report page has the whole chart.
 */
function FigureFrame({ section, projectId, figure, large }: { section: Section; projectId: string; figure: CardFigure; large: boolean }) {
  const t = useStrings(cardText);
  const words = useStrings(briefText);
  // A kept image arrives as on its report page (T-19 HM:B14, kept-image.ts): the same snapshot (this Workspace, the
  // project, the section's key and id, the file kept) and read (with the card's version and the address), so it stays
  // unseen until its decode succeeds, then fades in once in this window, and a failed load or decode says so in the
  // frame. An older read's late load or decode changes nothing; a snapshot shown on its report page is here at once.
  const workspaceId = useContext(CardFoldWorkspace);
  const file = figure.kind === "image" ? section.attachments.find((item) => item.name === figure.name) : undefined;
  const snapshot = figure.kind === "image" && figure.kept
    ? keptSnapshot({ workspaceId, projectId, sectionKey: section.key, sectionId: section.id, name: figure.name,
      takenAt: file?.takenAt ?? figure.takenAt, size: file?.size, mime: file?.mime })
    : "";
  const src = figure.kind === "image" ? attachmentUrl(projectId, section.key, figure.name, section.version) : "";
  const kept = useKeptImage(snapshot, `${snapshot}\n${section.version}\n${src}`);
  const viewer = useKeptImagePreview(projectId, section, figure.kind === "image" && figure.kept ? file : undefined, figure.kind === "image" ? figure.caption ?? undefined : undefined);
  // What a click or a key opens: a kept image while it is not known to have failed.
  const opens = figure.kind === "image" && figure.kept && !kept.failed && !!file;
  const shape = large ? LARGE_TABLE_PREVIEW : TABLE_PREVIEW;
  const table = figure.kind === "table" ? { columns: figure.columns.slice(0, shape.columns), rows: figure.rows.slice(0, shape.rows) } : null;
  const metrics = large ? metricsOf(section, figure) : null;
  const chart = chartOf(section, figure);
  const brief = useMemo(() => ({ projectId, section }), [projectId, section]);
  // A desk with a claim is drawn as its lead claim (YN-7); one with none, by its question and counts.
  const desk = figure.kind === "desk" && figure.lead
    ? ((section.body as { elements?: Record<string, { props?: unknown }> }).elements?.[figure.id]?.props as ResearchDeskProps | undefined)
    : undefined;
  // Inputs and the blocks they show or hide, drawn by their own renderer, live:
  // the frame is not inert, and grows to hold them whole.
  if (figure.kind === "interactive")
    return (
      <figure className="home-card-frame kind-interactive">
        <div className="home-card-frame-body">
          <BriefDensity.Provider value="low">
            <SectionBody section={section} projectId={projectId} only={[figure.id]} />
          </BriefDensity.Provider>
        </div>
      </figure>
    );
  if (figure.kind === "page")
    return (
      <figure className="home-card-frame kind-page">
        <CardPage projectId={projectId} section={section} figure={figure} title={section.title} />
        {figure.caption && <figcaption>{figure.caption}</figcaption>}
      </figure>
    );
  return (
    <figure className={`home-card-frame kind-${figure.kind}${chart ? " is-chart" : ""}`}>
      <FrameBody opens={opens} label={figure.kind === "image" ? words.openImage(figure.name) : ""} onOpen={viewer.open}>
        {metrics ? (
          <MetricsGrid items={metrics} />
        ) : chart ? (
          <BriefContext.Provider value={brief}>
            <CardChart kind={chart.kind} props={chart.props} elementKey={figure.id} legendLines={large ? 2 : 1} />
          </BriefContext.Provider>
        ) : figure.kind === "block" ? (
          <BriefDensity.Provider value="low">
            <SectionBody section={section} projectId={projectId} only={[figure.id]} />
          </BriefDensity.Provider>
        ) : figure.kind === "table" && table ? (
          <table className="home-card-table">
            <thead>
              <tr>{table.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.id}>
                  {table.columns.map((column) => <td key={column.key}>{String(row.cells[column.key] ?? "—")}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        ) : figure.kind === "image" ? (
          // As its report page says them (AttachmentView.tsx): a referenced image is named, never asked for;
          // a kept one that could not be loaded says so.
          !figure.kept ? (
            <p className="home-card-figure-unavailable">
              <ImageIcon size={16} aria-hidden="true" />
              <span>{words.referenced} · {figure.name}</span>
              <small>{words.notKept}</small>
            </p>
          ) : kept.failed ? (
            <p className="home-card-figure-unavailable" role="status">
              <ImageIcon size={16} aria-hidden="true" />
              <span>{words.imageNotLoaded}</span>
            </p>
          ) : (
            <img
              key={snapshot}
              ref={kept.picture}
              src={src}
              alt={figure.caption ?? figure.name}
              data-loading={kept.loading ? "" : undefined}
              onLoad={kept.onLoad}
              onError={kept.onError}
            />
          )
        ) : figure.kind === "desk" && desk ? (
          <BriefContext.Provider value={brief}>
            <DeskCardClaim
              desk={desk}
              elementKey={figure.id}
              more={<>{figure.claims > 1 && <>{t.deskMore(figure.claims - 1)} · </>}{t.deskInteractive}</>}
            />
          </BriefContext.Provider>
        ) : figure.kind === "desk" ? (
          <p className="home-card-desk">
            <strong>{figure.title}</strong>
            <span>{t.deskCounts(figure.claims, figure.plots)} · {t.deskInteractive}</span>
          </p>
        ) : null}
      </FrameBody>
      {(table || (figure.kind === "image" && figure.caption) || (metrics && metrics.length > LARGE_METRICS)) && (
        <figcaption>
          {table && figure.kind === "table" && t.tableCounts(table.rows.length, figure.totalRows, table.columns.length, figure.totalColumns)}
          {figure.kind === "image" && figure.caption}
          {metrics && metrics.length > LARGE_METRICS && t.valuesShown(LARGE_METRICS, metrics.length)}
        </figcaption>
      )}
      {viewer.dialog}
    </figure>
  );
}

/** The frame's body: inert, so nothing drawn in it takes focus or a click; or, for an image that opens, the button that
 * opens it, with the report page's sign that it opens larger, for touch as for the pointer. */
function FrameBody({ opens, label, onOpen, children }: { opens: boolean; label: string; onOpen: () => void; children: React.ReactNode }) {
  if (!opens)
    return (
      <div className="home-card-frame-body" inert>
        {children}
      </div>
    );
  return (
    <button type="button" className="home-card-frame-body home-card-image-open" aria-label={label} onClick={onOpen}>
      {children}
      <span className="brief-image-zoom" aria-hidden="true">
        <Maximize2 size={13} />
      </span>
    </button>
  );
}

/** Up to six Metrics values in a grid, on a large card; each number with its unit on one line. */
function MetricsGrid({ items }: { items: Metric[] }) {
  return (
    <dl className="home-card-metrics-grid">
      {items.slice(0, LARGE_METRICS).map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>
            {String(item.value)}
            {item.unit ? `\u00a0${item.unit}` : ""}
          </dd>
        </div>
      ))}
    </dl>
  );
}
