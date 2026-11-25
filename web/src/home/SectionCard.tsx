import { Component, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useLanguage, useStrings } from "../i18n";
import { systemTimeZone, timeZoneName, useTimeDisplay } from "../time-preferences";
import { BookOpen, CalendarClock, Check, ChevronDown, ClipboardCopy, Clock3, Eye, LoaderCircle, MessageSquareReply, Pin, PinOff } from "lucide-react";
import { errorText } from "../api";
import { CopyButton } from "../components";
import type { Agent } from "../types";
import { AskReply, withoutFormIds } from "./AskReply";
import { changedBlocks, rememberSeenBlocks } from "./brief/block-changes";
import { reportMarkdown } from "./brief/brief-copy";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { CardResponsible } from "./CardResponsible";
import { BriefMarkdown } from "./brief/Markdown";
import { changedSinceSeen, readBefore, repliedThenUpdated, sectionDomId, unreadChange } from "./brief-layout";
import { DeckSizes } from "./card-sizes";
import { packDeckOf } from "./deck-packing";
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
import { dissolveFrom, fadeInFrom, resizeFrom, resizeTarget, showFocusWhenSettled, snapshotOf, watchAct, type Drawn, type Snapshot } from "../surface";
import { Tip, TipText } from "../Tip";
import { ImageAttachments } from "../ImageAttachments";
import { FileAttachments } from "../FileAttachments";
import { homeImageUrl } from "./home-images";
import { homeFileUrl } from "./home-files";
import { homeReplyText, useCopy, Words } from "../home-reply/HomeReply";
import { answerText, unanswered } from "../home-reply/home-reply-model";
import { answerLine, answerShown, fieldAnswer, otherOptions, questionParts } from "./answer-card";

/** When a status's data is from, and whether it is past its validity. */
export function DataAsOf({ status, stale }: { status: NonNullable<Section["status"]>; stale: boolean }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  return (
    // Its time is in its words in full: no tip repeats it.
    <span className={stale ? "home-stale" : ""}>
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
    <Tip content={<TipText title={absolute(iso, time)} />}>
      <span>
        {label} {relative(iso, language)}
      </span>
    </Tip>
  );
}

/**
 * Keeps a card at least as tall as it was before Core sent a new version, or
 * a new state of its ask (replied, as Core reads the reply: T-19 HM:A4, with
 * the version unchanged), until the reader touches it, so shorter content
 * never pulls up the blocks below while they are being read. A reply sent
 * from the card itself is the user's own act: it becomes its answer card,
 * which holds no room (YN-21, `collapsed`). What Core sends next, as when
 * its owner resolves it, is held at that answer card's height (YN-28).
 */
function useReservedHeight(content: string, collapsed: boolean) {
  const ref = useRef<HTMLElement>(null);
  const last = useRef<{ content: string; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A collapsed card holds no room, but its height is what a new version
    // must not shrink. Expanded again, at the same content, it holds none.
    // (How it moves to its new height is CardResize's, YN-203.)
    if (collapsed) {
      element.style.minHeight = "";
      last.current = { content, height: resizeTarget(element) };
      return;
    }
    const previous = last.current;
    if (previous && previous.content !== content && previous.height > 0)
      element.style.minHeight = `${previous.height}px`;
    last.current = { content, height: resizeTarget(element) };
  });
  // Let go by the reader: the card closes up to its content (YN-203).
  const release = () => {
    const element = ref.current;
    if (!element?.style.minHeight) return;
    const box = element.getBoundingClientRect();
    element.style.minHeight = "";
    resizeFrom(element, { height: box.height, top: box.top });
  };
  return [ref, release] as const;
}

/**
 * A card changes as the user acts on it (YN-203): their reply turns an Ask
 * into its answer card (YN-21), Reply again opens its body and closes it,
 * its answer record, a card's fold, a report's Reply; and Core sends a
 * new version of what it holds (`content`). Each time, the card as it was
 * drawn is read before React changes it: its edge then moves from that
 * height to its new one (surface.ts resizeFrom), from where a change under
 * way had it, and what it showed fades out over what it shows now
 * (dissolveFrom). What changed is kept unseen until the old has faded out,
 * then fades in (fadeInFrom): the user's round 3, "渐隐到消失之后再开始渐显".
 * What did not change is the same in both and does not move. Played before
 * the frame is painted, once the deck has packed the card (useDeckPacking's
 * layout effect, after the card's, when Core's read changed it). An act of
 * the user's lets go of anything held for the card it was; a new version
 * from Core keeps what is held (T-19 HM:A4: it does not shrink while read).
 */
type ResizeProps = {
  target: RefObject<HTMLElement | null>;
  /** The Ask or its answer card; a report's summary card (SummaryCard), whose Reply alone is followed. */
  face: "ask" | "answer" | "summary";
  /** Its body shown. */
  open: boolean;
  /** Each own reply sent from it, and each Reply again on an Ask's reply block: what changes is its reply area. */
  step: string;
  /** A report's reply being written on it. */
  reply: boolean;
  /** Core's version of what it holds. */
  content: string;
};
type Before = { drawn: Drawn; snapshot: Snapshot | null };
/** Where what changed is, by what changed: kept unseen while the old fades out. */
const CHANGED = {
  face: ":scope > :not(.card-ghost)",
  open: ":scope > .home-card-body",
  close: ":scope > .home-card-glance",
  step: ":scope > .home-card-body .home-ask",
  reply: ":scope > .home-card-reply",
  content: ":scope > .home-card-body, :scope > .home-answer .home-answer-update, :scope > .home-card-glance",
};
const same = (a: Readonly<ResizeProps>, b: Readonly<ResizeProps>) =>
  a.face === b.face && a.open === b.open && a.step === b.step && a.reply === b.reply && a.content === b.content;
export class CardResize extends Component<ResizeProps, object, Before | null> {
  getSnapshotBeforeUpdate(previous: Readonly<ResizeProps>) {
    const card = this.props.target.current;
    if (!card || same(previous, this.props)) return null;
    const box = card.getBoundingClientRect();
    return { drawn: { height: box.height, top: box.top }, snapshot: snapshotOf(card) };
  }
  componentDidUpdate(previous: Readonly<ResizeProps>, _state: object, before?: Before | null) {
    const card = this.props.target.current;
    if (!before || !card) return;
    const now = this.props;
    const acted = previous.face !== now.face || previous.open !== now.open || previous.step !== now.step || previous.reply !== now.reply;
    if (acted) card.style.minHeight = "";
    const changed =
      previous.face !== now.face ? CHANGED.face
      : previous.open !== now.open ? (now.open ? CHANGED.open : CHANGED.close)
      : previous.step !== now.step ? CHANGED.step
      : previous.reply !== now.reply ? (now.reply ? CHANGED.reply : null)
      : CHANGED.content;
    queueMicrotask(() => {
      if (!card.isConnected) return;
      packDeckOf(card);
      resizeFrom(card, before.drawn);
      dissolveFrom(card, before.snapshot);
      if (changed)
        for (const part of card.querySelectorAll<HTMLElement>(changed))
          if (!part.hidden && !part.classList.contains("card-ghost")) fadeInFrom(part);
      // Focus that went into the body it opened (Reply again) is shown, once it is there.
      const body = card.querySelector<HTMLElement>(":scope > .home-card-body");
      if (now.open && !previous.open && body) showFocusWhenSettled(card, body);
    });
  }
  render() {
    return null;
  }
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
    <Tip content={<TipText title={pinned ? t.unpin : t.pin} />} describe={false}>
      <button
        type="button"
        className="icon-button home-pin"
        aria-pressed={pinned}
        aria-label={pinned ? t.unpinLabel(section.title) : t.pinLabel(section.title)}
        onClick={(event) => pins.toggle(projectId, section, anchor?.current ?? event.currentTarget)}
      >
        {pinned ? <PinOff size={13} /> : <Pin size={13} />}
      </button>
    </Tip>
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
  answer = false,
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
  /** An answered Ask drawn as its answer card wherever it is, as a request's line opened to it (YN-223), resolved too. */
  answer?: boolean;
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
  // visit or answered here: an answer card, a small card on the deck (YN-3,
  // the design the user chose, D3): the question's title, the reply quoted,
  // who acts next or what its owner changed since, Reply again; the answer's
  // record one toggle away (YN-230). One answered elsewhere keeps its card
  // until the next visit (card-sizes.ts).
  const replied = section.ask?.state === "replied";
  const sizes = useContext(DeckSizes);
  const short = (answer && !!section.ask && section.ask.state !== "open") || (sizes ? sizes.short(projectId, section.key, section.version, replied) : replied);
  // Its owner resolved it: nothing more is sent from its card (YN-223).
  const resolved = section.ask?.state === "resolved";
  const [rowOpen, setRowOpen] = useState(false);
  // Each step is the answer card's Reply again (AskReply).
  const [againRequest, setAgainRequest] = useState(0);
  // The user's reply from this card, as Core accepted it (YN-21, the user's choice): the user acted, so the
  // card is its answer card once Core reads the ask replied, in this visit. Its place on the deck stays
  // (card-sizes.ts). A reply from elsewhere keeps the rules above.
  const [own, setOwn] = useState<{ version: number; n: number } | null>(null);
  // Until Core's read has that reply (the reply's time is no longer the one Core showed as it was sent), the
  // card stays as it is; Reply again's opened card then closes to its answer card with the new reply on it.
  const [awaiting, setAwaiting] = useState<{ before: string | null } | null>(null);
  // Each step is a Reply again from the reply on an open Ask's face (AskReply).
  const [again, setAgain] = useState(0);
  const againHere = useCallback(() => setAgain((n) => n + 1), []);
  if (awaiting && (section.ask?.repliedAt ?? null) !== awaiting.before) {
    setAwaiting(null);
    setRowOpen(false);
  }
  const repliedHere = useCallback(
    (version: number, before: string | null) => {
      sizes?.answered(projectId, section.key, version);
      setOwn((was) => ({ version, n: (was?.n ?? 0) + 1 }));
      setAwaiting({ before });
    },
    [sizes, projectId, section.key],
  );
  // Each own reply the card now shows in short collapses it once, as Core's read has it.
  const collapse = short && !awaiting && own?.version === section.version ? String(own.n) : null;
  // Its body shown: the Ask as its owner keeps it, and Reply again's controls.
  const opened = rowOpen;
  // Its answer record shown (YN-230, R-41's design): the whole answer as given, the options not chosen, the user's
  // notes and files, and its owner's update since; and whether the user's words are longer than its one line.
  const [recordOpen, setRecordOpen] = useState(false);
  const [wordsLong, setWordsLong] = useState(false);
  const replyWords = useStrings(homeReplyText);
  const [answerCopy, copyAnswer] = useCopy();
  const collapsed = short ? !opened : chosenFold;
  const [ref, release] = useReservedHeight(`${section.version}:${section.ask?.state ?? ""}`, collapsed);
  // A press in the card, by pointer or keyboard: what it changes there glides too (YN-203, surface.ts watchAct).
  const acted = () => {
    if (ref.current) watchAct(ref.current);
  };
  const actedByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) acted();
  };
  // Focus that went with the reply's controls goes to the card, which says what was answered.
  useLayoutEffect(() => {
    const card = ref.current;
    if (collapse === null || !card) return;
    const active = document.activeElement;
    if (!active || active === document.body || (card.contains(active) && active.closest("[hidden]")))
      card.focus({ preventScroll: true });
    // Only as an own reply collapses it; `ref` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapse]);
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
  const toggleReply = () => {
    setReplyOpened(true);
    setReplying((open) => !open);
  };
  // What the card shows, as far as its size goes (YN-203): a new one resizes it.
  const resize = (
    <CardResize
      target={ref}
      face={short ? "answer" : "ask"}
      open={!collapsed}
      step={`${own?.n ?? 0}:${again}:${recordOpen}`}
      reply={replyable && replying}
      content={`${section.version}:${section.ask?.state ?? ""}`}
    />
  );
  // Bound to a task (YN-86 S2b): who answers for it takes the byline's place at its foot.
  const bound = section.card ?? null;
  // New or Updated since the user last read it (YN-86: marked seen, or a report opened whole); Seen is still offered
  // until they mark this version seen, which is what puts a report into History.
  const changed = unreadChange(section);
  const seenable = changedSinceSeen(section);
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
  // shows in short, with the record of the answer one toggle away.
  const updatedSinceReply = replied && repliedThenUpdated(section);
  // What its owner says now, after the reply: the body's opening, on the answer card.
  const update = useMemo(() => (short && updatedSinceReply ? sectionSummary(section) : null), [short, updatedSinceReply, section]);
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
  // Whether it changed for the user, or nobody keeps it up to date.
  const badges = (
    <>
      {/* Answered, it is never new to the user: only its owner's change since (YN-3), resolving it too (YN-223). */}
      {changed && (
        <Tip content={<TipText body={t.changedTitle} />}>
          <span className="home-changed">
            {readBefore(section) || replied || resolved ? t.updated : t.new}
          </span>
        </Tip>
      )}
      {orphaned && (
        <Tip content={<TipText body={t.notMaintainedTitle(section.owner.name, gone, t.kindInSentence[section.kind])} />}>
          <span className="home-unmaintained">
            {t.notMaintained}
          </span>
        </Tip>
      )}
      {!!section.repairs?.length && (
        <Tip content={<TipText body={t.repairedTitle(section.owner.name)} />}>
          <span className="home-repaired">
            {t.repaired}
          </span>
        </Tip>
      )}
    </>
  );
  // The title, and those marks.
  const heading = (
    <>
      <h3 id={`${sectionDomId(projectId, section.key)}-title`}>{section.title}</h3>
      {badges}
    </>
  );
  const seenButton = seenable && !readOnly && (
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
  );
  if (short) {
    const domId = sectionDomId(projectId, section.key);
    const bodyId = `${domId}-body`;
    const answerId = `${domId}-answer`;
    const recordId = `${domId}-record`;
    // A form's answers without the line of IDs Core reads them by, then the user's words (YN-213).
    const replyText = withoutFormIds(section.ask?.replyText ?? "").trim();
    // R-29's answer card (YN-223, the design the user settled): the question as the user answered it, its note,
    // then their reply as they gave it, from the snapshot Core kept with it; an earlier reply as it was sent.
    const shownAnswer = answerShown(section.ask!, replyText);
    const question = questionParts(shownAnswer.question);
    const snapshot = shownAnswer.snapshot;
    const copied = snapshot ? answerText(snapshot, replyWords.notAnswered) : replyText;
    // R-41's two states (YN-230, the design the user approved): the question whole and one line of what the user
    // decided; the record of the answer as they gave it one toggle away, only when it holds more than that line.
    const line = snapshot ? answerLine(snapshot, { list: t.listJoin, fields: t.fieldJoin }) : { text: replyText, words: true, notes: 0 };
    const others = snapshot ? otherOptions(snapshot, section.ask?.reply.form, !updatedSinceReply) : [];
    const images = section.ask?.replyImages ?? [];
    const files = section.ask?.replyFiles ?? [];
    const hasRecord =
      !!snapshot?.form || line.notes > 0 || others.length > 0 || images.length > 0 || files.length > 0 || updatedSinceReply ||
      (line.words && wordsLong);
    const showRecord = recordOpen && hasRecord;
    const copyButton = copied ? (
      <button type="button" className={`home-reply-action home-answer-copy${answerCopy === "copied" ? " done" : ""}`} onClick={() => copyAnswer(copied)}>
        {answerCopy === "copied" ? <Check size={15} aria-hidden="true" /> : <ClipboardCopy size={15} aria-hidden="true" />}
        {answerCopy === "copied" ? replyWords.copied : answerCopy === "error" ? replyWords.copyFailed : replyWords.copyAnswer}
      </button>
    ) : null;
    // The user's words in the record: whole, as Markdown.
    const words = (text: string) => <Words text={text} whole />;
    return (
      <article
        ref={ref}
        id={domId}
        data-section-key={section.key}
        data-section-version={section.version}
        // Closed, a small card the deck packs (deck-packing.ts); opened, it takes its row, as an open Ask does.
        data-card-size={opened ? undefined : "small"}
        tabIndex={-1}
        className={`home-section kind-ask is-replied is-short is-answer${sub ? " is-sub" : ""}${changed ? " is-changed" : ""}${opened ? " is-open" : " is-collapsed"}${showRecord ? " is-record" : ""}`}
        onPointerDown={release}
        onClickCapture={acted}
        onKeyDownCapture={actedByKey}
        aria-labelledby={`${domId}-title`}
      >
        {resize}
        {notice}
        {/* Whose card it is and that the heading below is the question as the user answered it; whom it waits for. */}
        <header className="home-section-head home-answer-byline">
          {topic !== undefined && <span className="home-sub-of">{t.inTopic(topic)}</span>}
          <span className="home-answer-source">
            {/* Its title gives way on one line: whole in its tip, when cut. */}
            <Tip content={<TipText body={section.title} />} cut describe={false}>
              <span id={`${domId}-title`} className="home-answer-name">{section.title}</span>
            </Tip>
            <span aria-hidden="true">·</span>
            <span className="home-answer-then">{shownAnswer.questionKept ? t.askedThen : t.askedNow}</span>
            {badges}
          </span>
          <span className="home-section-meta home-answer-state">
            <span className="home-kind kind-ask is-replied">
              {resolved ? t.resolvedBy(section.owner.name) : updatedSinceReply ? t.updatedBy(section.owner.name) : t.waitingFor(section.owner.name)}
            </span>
            {/* The reply's time; once its owner changed it since, that change's. */}
            {section.ask?.repliedAt && !updatedSinceReply ? (
              <Tip content={<TipText title={absolute(section.ask.repliedAt, time)} />}>
                <span>{relative(section.ask.repliedAt, language)}</span>
              </Tip>
            ) : (
              <Tip content={<TipText title={absolute(section.updatedAt, time)} />}>
                <span>{relative(section.updatedAt, language)}</span>
              </Tip>
            )}
          </span>
          {!readOnly && <PinButton section={section} projectId={projectId} />}
          {seenButton}
        </header>
        <div className="home-answer" id={answerId}>
          <div className="home-answer-question">
            <h3 className="home-answer-ask">{question.head}</h3>
            {question.note && <p className="home-answer-hint">{question.note}</p>}
            {!shownAnswer.questionKept && <p className="home-answer-unkept">{t.questionNotKept}</p>}
          </div>
          {/* Closed: one line of what the user decided, never the form's own wording or a field left empty. */}
          <div className="home-answer-reply">
          {!showRecord && (
            <div className="home-answer-line">
              <span className="home-answer-label">{t.yourAnswer}</span>
              <div className="home-answer-value">
                {!line.text ? (
                  <p className="home-answer-picks" data-empty="">{t.skipped}</p>
                ) : line.words ? (
                  <Words text={line.text} lines={2} onLong={setWordsLong} />
                ) : (
                  <p className="home-answer-picks">{line.text}</p>
                )}
                {line.notes > 0 && <span className="home-answer-notes">{t.moreNotes(line.notes)}</span>}
              </div>
            </div>
          )}
          {/* Open: the answer as the user gave it to that version, apart from what its owner says now. */}
          {showRecord && (
            <section id={recordId} className="home-answer-record" aria-label={t.answerRecordLabel}>
              <p className="home-answer-record-head">
                <strong>{t.answerRecord}</strong>
                {snapshot?.form && <span>{snapshot.form.title}</span>}
              </p>
              {snapshot?.form || snapshot?.choice ? (
                <dl className="home-answer-fields">
                  {snapshot.choice && (
                    <div>
                      <dt>{t.yourChoice}</dt>
                      <dd>{snapshot.choice.label}</dd>
                    </div>
                  )}
                  {snapshot.form?.fields.map((field) => (
                    <div key={field.id}>
                      <dt>{field.label}</dt>
                      {unanswered(field.answer) ? (
                        <dd data-empty="">{t.skipped}</dd>
                      ) : field.type === "text" && !Array.isArray(field.answer) ? (
                        <dd>{words(field.answer)}</dd>
                      ) : (
                        <dd>{fieldAnswer(field.answer, t.listJoin)}</dd>
                      )}
                    </div>
                  ))}
                  {snapshot.text?.trim() && (
                    <div>
                      <dt>{t.yourNote}</dt>
                      <dd>{words(snapshot.text)}</dd>
                    </div>
                  )}
                </dl>
              ) : (
                (snapshot?.text ?? replyText) && words(snapshot?.text ?? replyText)
              )}
              {/* The images and files that reply took (YN-134, YN-145), to open and download. */}
              <ImageAttachments images={images.map((id) => ({ id }))} imageUrl={(id, thumb) => homeImageUrl(projectId, id, thumb)} />
              <FileAttachments files={files} href={(file) => homeFileUrl(projectId, file.id, file.name)} projectId={projectId} />
              {others.length > 0 && (
                <div className="home-answer-others">
                  <p className="home-answer-others-head">{t.otherOptions}</p>
                  {others.map((group, n) => (
                    <div key={n}>
                      {others.length > 1 && group.field && <p className="home-answer-others-field">{group.field}</p>}
                      <ul>
                        {group.labels.map((label, i) => (
                          <li key={i}>
                            <span aria-hidden="true">–</span>
                            <span>{label}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
              {copyButton && <div className="home-answer-tools">{copyButton}</div>}
            </section>
          )}
          </div>
          {/* What its owner says now, after the reply: apart from the record, never as part of it. */}
          {showRecord && updatedSinceReply && (
            <div className="home-answer-update">
              <p className="home-answer-update-head">{t.updatedAfterReply(section.owner.name, relative(section.updatedAt, language))}</p>
              {update && <BriefMarkdown text={update} />}
            </div>
          )}
          <footer className="home-answer-bar">
            {hasRecord ? (
              <button type="button" className="home-reply-action home-answer-toggle" aria-expanded={showRecord} aria-controls={recordId}
                onClick={() => setRecordOpen(!showRecord)}>
                {showRecord ? t.hideRecord : t.showRecord}
                <ChevronDown size={14} className="chev" aria-hidden="true" />
              </button>
            ) : (
              copyButton
            )}
            {/* Reply again opens the Ask as its owner keeps it and the reply's controls; again, it closes them. */}
            {!readOnly && !resolved && (
              <button
                type="button"
                className="home-reply-action home-answer-again"
                aria-expanded={opened}
                aria-controls={bodyId}
                onClick={() => {
                  setAwaiting(null);
                  if (opened) setRowOpen(false);
                  else {
                    setRowOpen(true);
                    setAgainRequest((n) => n + 1);
                  }
                }}
              >
                <MessageSquareReply size={15} aria-hidden="true" />
                {t.addReply}
              </button>
            )}
          </footer>
        </div>
        <div className="home-card-body" id={bodyId} hidden={!opened}>
          {orphaned && (
            <p className="home-note home-unmaintained-note">
              {t.notMaintainedNote(section.owner.name, gone, t.kindInSentence[section.kind])}
            </p>
          )}
          <div className="home-section-body">
            <SectionBody section={section} projectId={projectId} changes={blocks} />
          </div>
          {!resolved && <div className="home-ask">
            <AskReply
              key={section.key}
              section={section}
              inRow
              face
              againRequest={againRequest}
              projectId={projectId}
              workspaceId={workspaceId}
              agents={agents}
              readOnly={readOnly}
              onSent={onChanged}
              onReplied={repliedHere}
            />
          </div>}
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </article>
    );
  }
  return (
    <article
      ref={ref}
      id={sectionDomId(projectId, section.key)}
      data-section-key={section.key}
      data-section-version={section.version}
      tabIndex={-1}
      className={`home-section kind-${section.kind}${sub ? " is-sub" : ""}${changed ? " is-changed" : ""}${stale ? " is-stale" : ""}${deferred ? " is-deferred" : ""}${replied ? " is-replied" : ""}${collapsed ? " is-collapsed" : ""}`}
      onPointerDown={release}
      onClickCapture={acted}
      onKeyDownCapture={actedByKey}
      aria-labelledby={`${sectionDomId(projectId, section.key)}-title`}
    >
      {resize}
      {notice}
      <header className="home-section-head">
        <FoldButton
          collapsed={collapsed}
          onToggle={toggleFold}
          label={section.title}
          controls={`${sectionDomId(projectId, section.key)}-body`}
        />
        {topic !== undefined && <span className="home-sub-of">{t.inTopic(topic)}</span>}
        <span className={`home-kind kind-${section.kind}${replied ? " is-replied" : ""}`}>
          {replied ? t.replied : t.kind[section.kind]}
        </span>
        {heading}
        <span className="home-section-meta">
          {!bound && (
            <span className="home-owner">
              {sub ? t.by : ""}
              {section.owner.name}
              {section.owner.state !== "active" && t.ownerState(section.owner.state)}
            </span>
          )}
          <Tip content={<TipText title={absolute(section.updatedAt, time)} />}>
            <span>{relative(section.updatedAt, language)}</span>
          </Tip>
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
        {replyable && !bound && (
          <Tip content={<TipText title={t.replyTitle(section.owner.name)} />}>
            <button
              type="button"
              className="quiet-button home-reply-open"
              ref={replyButton}
              aria-expanded={replying}
              aria-label={t.replyLabel(section.title)}
              onClick={toggleReply}
            >
              <MessageSquareReply size={13} />
              {t.reply}
            </button>
          </Tip>
        )}
        {/* Written from the stored body when clicked, so the clipboard write
            stays in the click (Safari) and a folded card copies in full. */}
        {section.kind === "report" && <CopyButton text={() => reportMarkdown(section, projectId, language, time)} label={t.copyReport} />}
        {!readOnly && <PinButton section={section} projectId={projectId} />}
        {seenButton}
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
            projectId={projectId}
            workspaceId={workspaceId}
            agents={agents}
            readOnly={readOnly}
            onSent={onChanged}
            onReplied={repliedHere}
            onAgain={againHere}
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
                    <Tip key={choice.id} content={<TipText title={absolute(choice.until, time)} />}>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => void defer(choice.until)}
                      >
                        {choice.label}
                      </button>
                    </Tip>
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
      {bound && (
        <CardResponsible
          section={section}
          card={bound}
          readOnly={readOnly}
          reply={replyable ? { open: replying, onToggle: toggleReply, button: replyButton } : null}
          place={{ projectId, workspaceId, agents }}
        />
      )}
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
