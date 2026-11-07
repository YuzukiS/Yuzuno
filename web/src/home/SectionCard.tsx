import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLanguage, useStrings } from "../i18n";
import { systemTimeZone, timeZoneName, useTimeDisplay } from "../time-preferences";
import { BookOpen, CalendarClock, Check, Clock3, Eye, LoaderCircle, MessageSquareReply, Pin, PinOff } from "lucide-react";
import { errorText } from "../api";
import { CopyButton } from "../components";
import type { Agent } from "../types";
import { AskReply } from "./AskReply";
import { changedBlocks, rememberSeenBlocks } from "./brief/block-changes";
import { reportMarkdown } from "./brief/brief-copy";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { BriefMarkdown } from "./brief/Markdown";
import { changedSinceSeen, repliedThenUpdated, sectionDomId } from "./brief-layout";
import { DeckSizes } from "./card-sizes";
import { FoldButton, useCardFold } from "./card-fold";
import { sectionConditions, sectionSummary, unmaintained } from "./card-summary";
import { absolute, deferChoices, duration, relative } from "./format";
import { deferSection, type SeenMark } from "./home-api";
import { homeText } from "./home-text";
import { SectionBody } from "./SectionBody";
import type { Section } from "./types";
import { pinnable, PinsContext } from "./widget-layout";
import { useReportOpen } from "./report/report-open";
import { reportText } from "./report/report-text";

/** When a status's data is from, and whether it is past its validity. */
export function DataAsOf({ status, stale }: { status: NonNullable<Section["status"]>; stale: boolean }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  return (
    <span className={stale ? "home-stale" : ""} title={absolute(status.asOf, time)}>
      <Clock3 size={12} />
      {t.dataAsOf(absolute(status.asOf, time))}
      {stale && t.pastValidity(duration(status.validFor, language))}
    </span>
  );
}

/** A section's due, expected or next-update time, as its card and its report page say it. */
export function SectionTime({ label, iso }: { label: string; iso?: string }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  if (!iso) return null;
  return (
    <span title={absolute(iso, time)}>
      {label} {relative(iso, language)}
    </span>
  );
}

/**
 * Keeps a card at least as tall as it was before Core sent a new version, or
 * a new state of its ask (replied, as Core reads the reply: T-19 HM:A4, with
 * the version unchanged), until the reader touches it, so shorter content
 * never pulls up the blocks below while they are being read.
 */
function useReservedHeight(content: string, collapsed: boolean) {
  const ref = useRef<HTMLElement>(null);
  const last = useRef<{ content: string; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A collapsed card holds no room; expanded again, it starts afresh.
    if (collapsed) {
      element.style.minHeight = "";
      last.current = null;
      return;
    }
    const previous = last.current;
    if (previous && previous.content !== content && previous.height > 0)
      element.style.minHeight = `${previous.height}px`;
    last.current = { content, height: element.getBoundingClientRect().height };
  });
  const release = () => {
    if (ref.current?.style.minHeight) ref.current.style.minHeight = "";
  };
  return [ref, release] as const;
}

/** Pins a status or report section to the widget column, or takes it off.
 * Only this button follows the pins, so pinning redraws no card body.
 * `anchor` is the control that keeps its place while the widget comes in
 * (T-19 HM:W5), when this button is not itself always in view: a summary
 * card's More actions pass their trigger (Lead 3643, 3722). */
export function PinButton({ section, projectId, anchor }: { section: Section; projectId: string; anchor?: RefObject<HTMLElement | null> }) {
  const pins = useContext(PinsContext);
  const t = useStrings(homeText);
  if (!pins || !pinnable(section)) return null;
  const pinned = pins.isPinned(projectId, section);
  // Content Home keeps out of the default view (or history) is never pinned.
  if (!pinned && !pins.canPin(projectId, section)) return null;
  return (
    <button
      type="button"
      className="icon-button home-pin"
      aria-pressed={pinned}
      aria-label={pinned ? t.unpinLabel(section.title) : t.pinLabel(section.title)}
      title={pinned ? t.unpin : t.pin}
      onClick={(event) => pins.toggle(projectId, section, anchor?.current ?? event.currentTarget)}
    >
      {pinned ? <PinOff size={13} /> : <Pin size={13} />}
    </button>
  );
}

/** Drawn again only when its section (kept as the same object while it is
 * unchanged, see keepUnchanged) or its props change. */
export const SectionCard = memo(function SectionCard({
  section,
  projectId,
  workspaceId,
  agents,
  topic,
  readOnly,
  onSeen,
  onChanged,
  notice,
}: {
  section: Section;
  projectId: string;
  workspaceId: string;
  agents: Agent[];
  /** A sub-topic's topic, read as words: the card says it belongs there, labelled with its own author. */
  topic?: string;
  readOnly: boolean;
  onSeen: (marks: SeenMark[]) => Promise<void>;
  onChanged: () => void;
  /** A note above the card's head: where a reply's "Open on Home" landed (T-9). */
  notice?: ReactNode;
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  // A report or status opens whole as a page over Home (T-18).
  const openReport = useReportOpen();
  const reportWords = reportText(language);
  // Collapsing hides the body only: drafts, Defer and table state are kept,
  // and the header still says what changed and offers Seen (T-115).
  const [chosenFold, toggleFold] = useCardFold(`section:${projectId}:${section.key}`);
  // Answered and waiting for its owner, as it was when first shown in this
  // visit: one line, its reply in short, the rest one click away (YN-3). One
  // answered here keeps its card until the next visit (card-sizes.ts).
  const replied = section.ask?.state === "replied";
  const sizes = useContext(DeckSizes);
  const short = sizes ? sizes.short(projectId, section.key, section.version, replied) : replied;
  const [rowOpen, setRowOpen] = useState(false);
  const collapsed = short ? !rowOpen : chosenFold;
  const [ref, release] = useReservedHeight(`${section.version}:${section.ask?.state ?? ""}`, collapsed);
  const [seeing, setSeeing] = useState(false);
  const [deferOpen, setDeferOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A report or status card on Home takes a reply to its author (T-174); a
  // draft or unconfirmed reply opens it again after a reload.
  const replyable = !readOnly && section.kind !== "ask" && !section.history;
  const [replying, setReplying] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, section.key)));
  // Opened by the user here, not kept from before; closed, focus goes back to Reply (T-19 HM:S7).
  const [replyOpened, setReplyOpened] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const changed = changedSinceSeen(section);
  // Which blocks changed is marked on them; the card itself only says that it did.
  const blocks = useMemo(() => changedBlocks(workspaceId, projectId, section), [workspaceId, projectId, section]);
  useEffect(() => rememberSeenBlocks(workspaceId, projectId, section), [workspaceId, projectId, section]);
  const stale = !!section.status?.stale;
  // A folded card still says what it is about, when it is from and whether
  // anyone still keeps it up to date (T-173); unfolded, the body says so.
  const summary = useMemo(() => (section.kind === "ask" ? null : sectionSummary(section)), [section]);
  // What the author's conclusion holds under goes with it (T-18).
  const conditions = useMemo(() => (summary ? sectionConditions(section) : null), [summary, section]);
  const sub = topic !== undefined;
  const orphaned = unmaintained(section);
  const gone = t.gone[section.owner.state as keyof typeof t.gone] ?? t.inactive;
  // Answered, waiting for its owner: no longer the user's to decide, so it
  // shows in short, with the question and details one click away.
  const updatedSinceReply = replied && repliedThenUpdated(section);
  const deferred =
    !replied && section.ask?.deferredUntil && Date.parse(section.ask.deferredUntil) > Date.now()
      ? section.ask.deferredUntil
      : null;
  // The version on screen, exactly; one arriving meanwhile stays unseen.
  const shown: SeenMark = { key: section.key, version: section.version };
  async function seen() {
    setSeeing(true);
    setError("");
    try {
      await onSeen([shown]);
      release();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeing(false);
    }
  }
  async function defer(until: string) {
    setBusy(true);
    setError("");
    try {
      await deferSection(projectId, section.key, until);
      setDeferOpen(false);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      ref={ref}
      id={sectionDomId(projectId, section.key)}
      data-section-key={section.key}
      data-section-version={section.version}
      tabIndex={-1}
      className={`home-section kind-${section.kind}${sub ? " is-sub" : ""}${changed ? " is-changed" : ""}${stale ? " is-stale" : ""}${deferred ? " is-deferred" : ""}${replied ? " is-replied" : ""}${short ? " is-short" : ""}${collapsed ? " is-collapsed" : ""}`}
      onPointerDown={release}
      aria-labelledby={`${sectionDomId(projectId, section.key)}-title`}
    >
      {notice}
      <header className="home-section-head">
        <FoldButton
          collapsed={collapsed}
          onToggle={short ? () => setRowOpen((open) => !open) : toggleFold}
          label={section.title}
          controls={`${sectionDomId(projectId, section.key)}-body`}
        />
        {topic !== undefined && <span className="home-sub-of">{t.inTopic(topic)}</span>}
        <span className={`home-kind kind-${section.kind}${replied ? " is-replied" : ""}`}>
          {short ? t.repliedWaiting(section.owner.name) : replied ? t.replied : t.kind[section.kind]}
        </span>
        <h3 id={`${sectionDomId(projectId, section.key)}-title`}>{section.title}</h3>
        {/* Answered, it is never new to the user: only its owner's change since (YN-3). */}
        {changed && (
          <span className="home-changed" title={t.changedTitle}>
            {section.seen || replied ? t.updated : t.new}
          </span>
        )}
        {orphaned && (
          <span className="home-unmaintained" title={t.notMaintainedTitle(section.owner.name, gone, t.kindInSentence[section.kind])}>
            {t.notMaintained}
          </span>
        )}
        {short && section.ask?.replyText && (
          <span className="home-replied-short" title={section.ask.replyText}>
            {section.ask.replyText.replace(/\s+/g, " ").trim()}
          </span>
        )}
        <span className="home-section-meta">
          {/* In short, its owner is named in the row's first words, and the time is the reply's. */}
          {!short && (
            <span className="home-owner">
              {sub ? t.by : ""}
              {section.owner.name}
              {section.owner.state !== "active" && t.ownerState(section.owner.state)}
            </span>
          )}
          {short && section.ask?.repliedAt ? (
            <span title={absolute(section.ask.repliedAt, time)}>{relative(section.ask.repliedAt, language)}</span>
          ) : (
            <span title={absolute(section.updatedAt, time)}>{relative(section.updatedAt, language)}</span>
          )}
        </span>
        {openReport && section.kind !== "ask" && (
          <button
            type="button"
            className="quiet-button home-report-open"
            aria-label={reportWords.openReportLabel(section.title)}
            onClick={(event) => openReport(projectId, section, event.currentTarget)}
          >
            <BookOpen size={13} />
            {reportWords.openReport}
          </button>
        )}
        {replyable && (
          <button
            type="button"
            className="quiet-button home-reply-open"
            ref={replyButton}
            aria-expanded={replying}
            aria-label={t.replyLabel(section.title)}
            title={t.replyTitle(section.owner.name)}
            onClick={() => {
              setReplyOpened(true);
              setReplying((open) => !open);
            }}
          >
            <MessageSquareReply size={13} />
            {t.reply}
          </button>
        )}
        {/* Written from the stored body when clicked, so the clipboard write
            stays in the click (Safari) and a folded card copies in full. */}
        {section.kind === "report" && <CopyButton text={() => reportMarkdown(section, projectId, language, time)} label={t.copyReport} />}
        {!readOnly && <PinButton section={section} projectId={projectId} />}
        {changed && !readOnly && (
          <button
            type="button"
            className="quiet-button home-seen"
            disabled={seeing}
            onClick={() => void seen()}
            aria-label={t.seenLabel(section.title)}
          >
            {seeing ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
            {t.seen}
          </button>
        )}
      </header>
      {collapsed && (summary || section.status) && (
        <div className="home-card-glance">
          {summary && (
            <div className="home-card-summary">
              <BriefMarkdown text={summary} />
            </div>
          )}
          {conditions && (
            <div className="home-card-conditions" role="group" aria-label={reportWords.conditions}>
              <span className="home-card-conditions-label">{reportWords.conditions}</span>
              <SectionBody section={section} projectId={projectId} only={[conditions]} />
            </div>
          )}
          {section.status && (
            <p className="home-section-time">
              <DataAsOf status={section.status} stale={stale} />
            </p>
          )}
        </div>
      )}
      <div className="home-card-body" id={`${sectionDomId(projectId, section.key)}-body`} hidden={collapsed}>
      {orphaned && (
        <p className="home-note home-unmaintained-note">
          {t.notMaintainedNote(section.owner.name, gone, t.kindInSentence[section.kind])}
        </p>
      )}
      {(section.status || section.time) && (
        <div className="home-section-time">
          {section.status && <DataAsOf status={section.status} stale={stale} />}
          <SectionTime label={t.due} iso={section.time?.due} />
          <SectionTime label={t.expected} iso={section.time?.eta} />
          <SectionTime label={t.nextUpdate} iso={section.time?.nextUpdate} />
        </div>
      )}
      {!replied && section.ask && <p className="home-question">{section.ask.question}</p>}
      {(!replied || updatedSinceReply) && (
        <div className="home-section-body">
          <SectionBody section={section} projectId={projectId} changes={blocks} />
        </div>
      )}
      {section.ask && section.ask.state !== "resolved" && (
        <div className="home-ask">
          {deferred && (
            <p className="home-note">
              <CalendarClock size={12} /> {t.deferredUntil(absolute(deferred, time))}
            </p>
          )}
          <AskReply
            key={section.key}
            section={section}
            inRow={short}
            projectId={projectId}
            workspaceId={workspaceId}
            agents={agents}
            readOnly={readOnly}
            onSent={onChanged}
          />
          {!readOnly && !replied && (
            <div className="home-defer">
              <button
                type="button"
                className="quiet-button"
                aria-expanded={deferOpen}
                onClick={() => setDeferOpen((open) => !open)}
              >
                <CalendarClock size={13} />
                {t.defer}
              </button>
              {deferOpen && (
                <span role="group" aria-label={t.deferUntil}>
                  {deferChoices(language).map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      title={absolute(choice.until, time)}
                      onClick={() => void defer(choice.until)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </span>
              )}
              {/* Times here are shown in another zone, but Defer's 9:00 is
                  this device's own (T-189): said where it is chosen. */}
              {deferOpen && time.timeZone && time.timeZone !== systemTimeZone() && (
                <p className="home-note home-defer-zone">{t.deferZone(timeZoneName(systemTimeZone()))}</p>
              )}
            </div>
          )}
        </div>
      )}
      {replied && (
        <details className="home-replied-details">
          <summary>{updatedSinceReply ? t.question : t.questionAndDetails}</summary>
          <p className="home-question">{section.ask!.question}</p>
          {!updatedSinceReply && (
            <div className="home-section-body">
              <SectionBody section={section} projectId={projectId} changes={blocks} />
            </div>
          )}
        </details>
      )}
      {section.ask?.state === "resolved" && (
        <p className="home-note">
          <Check size={12} /> {t.resolvedBy(section.owner.name)}
        </p>
      )}
      </div>
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
});
