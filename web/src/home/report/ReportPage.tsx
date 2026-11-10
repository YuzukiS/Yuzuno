import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Eye, Info, LoaderCircle, MessageSquareReply } from "lucide-react";
import { errorText } from "../../api";
import { CopyButton } from "../../components";
import { useMessageLinks, type ReportLink } from "../../deep-link";
import { langTag, useLanguage, useStrings } from "../../i18n";
import { useTimeDisplay } from "../../time-preferences";
import type { Agent } from "../../types";
import { changedBlocks, type BlockChanges } from "../brief/block-changes";
import { reportMarkdown } from "../brief/brief-copy";
import { changedSinceSeen, readBefore, readVersion, unreadChange } from "../brief-layout";
import { unmaintained } from "../card-summary";
import { CardReply, replyableIn } from "../CardReply";
import { absolute, duration, relative } from "../format";
import type { SeenMark } from "../home-api";
import { BriefDensity } from "../home-density";
import { homeText } from "../home-text";
import { SectionBody } from "../SectionBody";
import type { BodyDrawn } from "../brief/BriefSectionBody";
import { BriefStateScope } from "../brief/brief-state";
import { SectionTime } from "../SectionCard";
import type { HomeData, Section, SectionAttachment } from "../types";
import { figuresOf, linkTo, outlineOf, partsOf, reportPlace, type FigureEntry, type OutlineEntry, type ReportPlace } from "./report-model";
import { reportText } from "./report-text";
import { useOpenedReceipt } from "./report-opened";
import "./report.css";
import { Tip, TipText } from "../../Tip";

/** Where a top-level block of the report is, for its outline. */
export const reportBlockDomId = (id: string) => `report-block-${id}`;
const RAIL_ID = "report-sources";

/**
 * A section's report (T-18): a whole page in the main pane, over Home,
 * which stays as it was below it and out of reach. It shows the linked
 * version only, from Home's reading: what the author named as its summary
 * first (the conclusion, what it holds under, one figure), each block once;
 * then the rest in the author's order, at full density, with only the parts
 * the author named as details folded; its sources and attachments beside
 * the body on wide panes and after it on narrow ones, never behind a click.
 * What has become of the version linked is said, never guessed.
 */
export function ReportPage({
  link,
  back,
  data,
  readFailed,
  workspaceId,
  agents,
  readOnly,
  onBack,
  onOpenVersion,
  onShowProject,
  onSeen,
  onOpened,
  readError = null,
  onRetry,
}: {
  link: ReportLink;
  /** Whether Back goes to the message the link was opened from. */
  back: boolean;
  data: HomeData | null;
  readFailed: boolean;
  workspaceId: string;
  /** The project's open Agents, for a reply. */
  agents: Agent[];
  readOnly: boolean;
  onBack: () => void;
  onOpenVersion: (link: ReportLink) => void;
  onShowProject: (projectId: string) => void;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
  /** Records that this page showed a live report's version whole (YN-86); the page says when. */
  onOpened?: (projectId: string, section: Section) => Promise<void>;
  /** Home's read failure, as Home words it ("" when it has no reason). */
  readError?: { reason: string } | null;
  /** Reads Home again, as Home's own Refresh does. */
  onRetry?: () => void;
}) {
  const language = useLanguage();
  const time = useTimeDisplay();
  const t = useStrings(reportText);
  const home = homeText(language);
  const links = useMessageLinks();
  const panel = data?.projects.find((p) => p.project.id === link.projectId);
  const place: ReportPlace | null = data ? reportPlace(link, panel) : null;
  // The version on screen stays on screen when Home no longer has it (a
  // newer one replaced it), until the user opens another: never new data
  // under the version linked.
  const [kept, setKept] = useState<Section | null>(null);
  if (place?.kind === "found" && place.section !== kept) setKept(place.section);
  const shown = place?.kind === "found" ? place.section : kept;
  const live = place?.kind === "found" && !place.section.history;
  const liveNow = panel && [...panel.brief.sections, ...(panel.brief.teamSections ?? [])].find((s) => s.key === link.key);
  const newer =
    place?.kind === "found" ? place.newer
      : shown && liveNow && liveNow.id === shown.id && liveNow.version > shown.version ? liveNow : null;
  const parts = useMemo(() => (shown ? partsOf(shown) : null), [shown]);
  const outline = useMemo(() => (shown && parts ? outlineOf(shown, parts.flow) : []), [shown, parts]);
  const figures = useMemo(() => {
    if (!shown || !parts) return [];
    return [...(parts.summary?.visual ? figuresOf(shown, [parts.summary.visual]) : []), ...figuresOf(shown, parts.flow)];
  }, [shown, parts]);
  // The blocks changed since the user last read it, as the page opened at this version: they stay marked while it is
  // on screen, after Core has recorded it opened (YN-86) or a read brings the same version again.
  const heldChanges = useRef<{ id: number | undefined; key: string; version: number; changes: BlockChanges | null } | null>(null);
  const changes = useMemo(() => {
    if (!shown || !live) return null;
    const held = heldChanges.current;
    if (held && held.id === shown.id && held.key === shown.key && held.version === shown.version) return held.changes;
    const found = changedBlocks(workspaceId, link.projectId, shown);
    heldChanges.current = { id: shown.id, key: shown.key, version: shown.version, changes: found };
    return found;
  }, [shown, live, workspaceId, link.projectId]);
  // Whether this version's body drew on the page (YN-86): every block it shows has told what it showed, none that
  // the section could not be drawn at all, and at least one drew real content; a block that shows only its unreadable
  // note is tolerated beside them, never counted as the body. Only then, for the live version on this Workspace's
  // Home, is it recorded as opened.
  const blockIds = useMemo(
    () => (parts ? [parts.summary?.lead, parts.summary?.visual, parts.summary?.conditions, ...parts.flow, ...parts.sources, ...parts.attachments]
      .filter((id): id is string => typeof id === "string") : []),
    [parts],
  );
  const expected = useRef(blockIds);
  expected.current = blockIds;
  const drawing = useRef<{ of: Section | null; told: Map<string, BodyDrawn> }>({ of: null, told: new Map() });
  const [drawn, setDrawn] = useState<Section | null>(null);
  const drawnBlock = useMemo(() => {
    const tellers = new Map<string, (drawn: BodyDrawn) => void>();
    return (id: string) => {
      let tell = tellers.get(id);
      if (!tell)
        tellers.set(id, (tell = (what: BodyDrawn) => {
          if (drawing.current.of !== shown) drawing.current = { of: shown, told: new Map() };
          const { told } = drawing.current;
          told.set(id, what);
          const blocks = expected.current;
          const whole = blocks.length > 0 && blocks.every((block) => told.has(block))
            && blocks.every((block) => told.get(block) !== "failed") && blocks.some((block) => told.get(block) === "drawn");
          setDrawn((was) => (whole ? shown : was === shown ? null : was));
        }));
      return tell;
    };
  }, [shown]);
  const receipt = useOpenedReceipt(
    !readOnly && live && shown && drawn === shown && link.workspaceId === workspaceId ? { workspaceId, projectId: link.projectId, section: shown } : null,
    onOpened,
  );
  const dataFiles = (shown?.attachments ?? []).filter((file) => file.kind === "data");
  const railed = !!parts && (parts.sources.length > 0 || parts.attachments.length > 0 || dataFiles.length > 0);
  // A reply where Home takes one (T-174): on the live version, or on a report marked seen that a reply can still
  // refer to (replyableIn), as its card and pin do (Lead 2655). Never another version kept in History.
  const replyable = !readOnly && place?.kind === "found" && replyableIn(panel, place.section);
  const [replying, setReplying] = useState(false);
  // Only ever opened by the user here; closed, focus goes back to Reply (T-19 HM:S7).
  const replyButton = useRef<HTMLButtonElement>(null);
  const [seeing, setSeeing] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  // The page takes focus as it opens, and gives it to its title once there
  // is one, unless the user has moved it meanwhile.
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const titled = !!shown;
  useEffect(() => {
    if (titled && document.activeElement === root.current) heading.current?.focus({ preventScroll: true });
  }, [titled]);
  async function seen() {
    if (!shown) return;
    setSeeing(true);
    setError("");
    try {
      await onSeen(link.projectId, [{ key: shown.key, version: shown.version }]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeing(false);
    }
  }
  const open = (section: Section) => onOpenVersion({ workspaceId: link.workspaceId, ...linkTo(link.projectId, section) });
  const title = shown?.title ?? (place?.kind === "unavailable" ? place.versions[0].title : undefined);
  const href = shown && links?.reportHref(linkTo(link.projectId, shown));
  const toProject = (
    <button type="button" className="report-notice-main" onClick={() => onShowProject(link.projectId)}>
      {t.showProject}
    </button>
  );
  const openNewer = newer && (
    <button type="button" className="report-notice-main" onClick={() => open(newer)}>
      {t.openVersion(newer.version)}
    </button>
  );
  const notice = !data ? null : place?.kind === "found" ? (
    place.section.history ? (
      <Notice actions={openNewer}>
        {t.history(place.section.historyReason ?? "removed")}
        {newer && <> {t.newerLive(newer.version)}</>}
      </Notice>
    ) : null
  ) : shown ? (
    <Notice actions={openNewer ?? toProject}>{newer ? t.arrived(shown.version, newer.version) : t.notKept(shown.version)}</Notice>
  ) : place?.kind === "unavailable" ? (
    <Notice
      actions={place.versions.map((section, index) => (
        <button key={`${section.history}:${section.version}`} type="button" className={index === 0 ? "report-notice-main" : "secondary-button"} onClick={() => open(section)}>
          {section.history ? t.openKept(section.version) : t.openCurrent(section.version)}
        </button>
      ))}
    >
      {t.unavailable(link.version)}
    </Notice>
  ) : place?.kind === "unknown" ? (
    <Notice actions={toProject}>{t.unknown}</Notice>
  ) : place?.kind === "gone" ? (
    <Notice actions={null}>{t.gone}</Notice>
  ) : null;
  const block = (id: string) => <SectionBody section={shown!} projectId={link.projectId} changes={changes} only={[id]} onDrawn={drawnBlock(id)} />;
  const retry = onRetry && (
    <button type="button" className="report-notice-main" onClick={onRetry}>
      {t.retry}
    </button>
  );
  const summary = parts?.summary ?? null;
  return (
    <section
      ref={root}
      className="home-report"
      tabIndex={-1}
      lang={langTag(language)}
      aria-label={t.page(title ?? t.report)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
        onBack();
      }}
    >
      <header className="report-bar">
        <button type="button" className="report-back" onClick={onBack} aria-label={back ? t.backToMessage : t.backHome}>
          <ArrowLeft size={15} />
          <span>{back ? t.backToMessage : t.home}</span>
        </button>
        <p className="report-crumb">
          {panel && <span>{panel.project.name}</span>}
          <span>{t.report}</span>
          {title && <span className="report-crumb-title">{title}</span>}
        </p>
        <span className="report-actions" role="group" aria-label={t.actions}>
          {href && <CopyButton text={href} label={t.copyLink} />}
          {shown?.kind === "report" && <CopyButton text={() => reportMarkdown(shown, link.projectId, language, time)} label={home.copyReport} />}
          {live && shown && changedSinceSeen(shown) && !readOnly && (
            <button type="button" className="quiet-button home-seen" disabled={seeing} onClick={() => void seen()} aria-label={home.seenLabel(shown.title)}>
              {seeing ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
              {home.seen}
            </button>
          )}
          {replyable && shown && (
            <Tip content={<TipText title={home.replyTitle(shown.owner.name)} />}>
              <button
                type="button"
                className="quiet-button home-reply-open"
                ref={replyButton}
                aria-expanded={replying}
                aria-label={home.replyLabel(shown.title)}
                onClick={() => setReplying((open) => !open)}
              >
                <MessageSquareReply size={13} />
                {home.reply}
              </button>
            </Tip>
          )}
        </span>
      </header>
      <div className="report-page">
        {/* A failed read is said, with a way to read again; never shown as
            still reading. With an earlier reading, that one stays. */}
        {readFailed && data && (
          <Notice actions={retry}>{t.readFailed}</Notice>
        )}
        {readFailed && !data && (
          <div className="report-notice" role="alert">
            <Info size={15} />
            <p>{t.firstReadFailed(readError?.reason ?? "")}</p>
            {retry}
          </div>
        )}
        {!data && !readFailed && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={19} />
            {t.reading}
          </div>
        )}
        {notice}
        {replyable && shown && replying && (
          <CardReply
            section={shown}
            projectId={link.projectId}
            workspaceId={workspaceId}
            agents={agents}
            opened
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
        {/* The page's variables (YN-16): every block of this version reads
            the same, and none of them is its card's. */}
        {shown && parts && (
          <BriefStateScope section={shown}>
          <BriefDensity.Provider value="high">
            <article className="report-article" aria-labelledby={headingId}>
              <div className="report-layout">
                <div className="report-main">
                  <header className="report-head">
                    <p className="report-kicker">
                      <span className={`home-kind kind-${shown.kind}`}>{home.kind[shown.kind]}</span>
                      {live && unreadChange(shown) && <span className="home-changed">{readBefore(shown) ? home.updated : home.new}</span>}
                      {unmaintained(shown) && <span className="home-unmaintained">{home.notMaintained}</span>}
                      {!!shown.repairs?.length && <span className="home-repaired">{home.repaired}</span>}
                      {panel && <span>{panel.project.name}</span>}
                    </p>
                    <h1 id={headingId} ref={heading} tabIndex={-1}>
                      {shown.title}
                    </h1>
                    {summary && <div className="report-lead">{block(summary.lead)}</div>}
                    <p className="report-meta">
                      <span>{shown.owner.name}</span>
                      <Tip content={<TipText title={absolute(shown.updatedAt, time)} />}>
                        <span>{relative(shown.updatedAt, language)}</span>
                      </Tip>
                      <span>{t.version(shown.version)}</span>
                      {shown.status && (
                        // Its time is in its words in full: no tip repeats it.
                        <span className={shown.status.stale ? "home-stale" : ""}>
                          {home.dataAsOf(absolute(shown.status.asOf, time))}
                          {shown.status.stale && home.pastValidity(duration(shown.status.validFor, language))}
                        </span>
                      )}
                      {/* The card says when its data is from; the page also says what is due and next. */}
                      <SectionTime label={home.due} iso={shown.time?.due} />
                      <SectionTime label={home.expected} iso={shown.time?.eta} />
                      <SectionTime label={home.nextUpdate} iso={shown.time?.nextUpdate} />
                      {changes && changes.size > 0 && <span className="report-changes">{t.blocksUpdated(changes.size)}</span>}
                    </p>
                    {/* Not recorded as read (YN-86): said, never retried here; it stays marked as changed. */}
                    {receipt !== null && (
                      <p className="home-note report-opened-note" role="status">
                        {t.notRecorded(receipt)}
                      </p>
                    )}
                    {/* What Core repaired to keep it, in Core's words (YN-14). */}
                    {!!shown.repairs?.length && <RepairedNote section={shown} />}
                    {/* Who left it and that it can be claimed, in words, not only in the card's tip (T-173). */}
                    {unmaintained(shown) && (
                      <p className="home-note home-unmaintained-note">
                        {home.notMaintainedNote(
                          shown.owner.name,
                          home.gone[shown.owner.state as keyof typeof home.gone] ?? home.inactive,
                          home.kindInSentence[shown.kind],
                        )}
                      </p>
                    )}
                    {summary?.conditions && (
                      <div className="report-conditions" role="group" aria-label={t.conditions}>
                        <span className="report-conditions-label">{t.conditions}</span>
                        {block(summary.conditions)}
                      </div>
                    )}
                  </header>
                  {outline.length + (railed ? 1 : 0) > 1 && (
                    <details className="report-contents">
                      <summary>
                        {t.contents} <span>· {t.parts(outline.length + (railed ? 1 : 0))}</span>
                      </summary>
                      <Outline entries={[...outline, ...(railed ? [{ id: RAIL_ID, title: t.sourcesAndAttachments }] : [])]} />
                    </details>
                  )}
                  {summary?.visual && (
                    // The figure says its own source (a chart its data file, an image its caption).
                    <figure className="report-hero" id={reportBlockDomId(summary.visual)} tabIndex={-1}>
                      {block(summary.visual)}
                    </figure>
                  )}
                  {parts.flow.map((id) =>
                    parts.details.has(id) ? (
                      <Detail key={id} id={id} title={groupTitle(shown, id)}>
                        {block(id)}
                      </Detail>
                    ) : (
                      <section key={id} className="report-block" id={reportBlockDomId(id)} data-block={nodeType(shown, id)} tabIndex={-1}>
                        {block(id)}
                      </section>
                    ),
                  )}
                </div>
                <aside className={`report-rail${railed ? "" : " is-bare"}`} id={RAIL_ID} tabIndex={-1} aria-label={t.aboutReport}>
                  {outline.length > 0 && (
                    <nav className="report-rail-part report-wide" aria-label={t.onThisPage}>
                      <h2>{t.onThisPage}</h2>
                      <Outline entries={outline} />
                    </nav>
                  )}
                  {figures.length > 0 && (
                    <section className="report-rail-part report-wide">
                      <h2>
                        {t.figuresAndTables} <span>· {figures.length}</span>
                      </h2>
                      <Figures entries={figures} />
                    </section>
                  )}
                  {railed && <h2 className="report-rail-heading">{t.sourcesAndAttachments}</h2>}
                  {(parts.sources.length > 0 || dataFiles.length > 0) && (
                    <section className="report-rail-part">
                      <h2>{t.sources}</h2>
                      {dataFiles.length > 0 && <DataFiles files={dataFiles} />}
                      {parts.sources.map((id) => (
                        <div key={id} className="report-rail-block" id={reportBlockDomId(id)}>
                          {block(id)}
                        </div>
                      ))}
                    </section>
                  )}
                  {parts.attachments.length > 0 && (
                    <section className="report-rail-part">
                      <h2>{t.attachments}</h2>
                      {parts.attachments.map((id) => (
                        <div key={id} className="report-rail-block" id={reportBlockDomId(id)}>
                          {block(id)}
                        </div>
                      ))}
                    </section>
                  )}
                  <section className="report-rail-part report-wide">
                    <h2>{t.versionPart}</h2>
                    <p>
                      {shown.version} · {live ? t.current : shown.history ? t.inHistory : t.version(shown.version)}
                    </p>
                    {live && (readVersion(shown) ?? shown.version) < shown.version && <p className="report-rail-note">{t.lastSaw(readVersion(shown)!)}</p>}
                  </section>
                </aside>
              </div>
            </article>
          </BriefDensity.Provider>
          </BriefStateScope>
        )}
      </div>
    </section>
  );
}

type Node = { type?: string; props?: Record<string, unknown> };
const nodeOf = (section: Section, id: string) => (section.body as { elements?: Record<string, Node> } | null)?.elements?.[id];
const nodeType = (section: Section, id: string) => nodeOf(section, id)?.type;
const groupTitle = (section: Section, id: string) => String(nodeOf(section, id)?.props?.title ?? "");

/** What Core repaired to keep this version (YN-14): its first few repairs, in Core's words. */
function RepairedNote({ section }: { section: Section }) {
  const home = useStrings(homeText);
  const repairs = section.repairs ?? [];
  const listed = repairs.slice(0, 3);
  return (
    <div className="home-note home-repaired-note">
      <p>{home.repairedNote(section.owner.name)}</p>
      <ul>
        {listed.map((repair, index) => (
          <li key={`${repair.code} ${repair.path} ${index}`}>{repair.reason.replace(/ \(brief_guide \w+\)$/, "")}</li>
        ))}
      </ul>
      {repairs.length > listed.length && <p>{home.moreRepairs(repairs.length - listed.length)}</p>}
    </div>
  );
}

function Notice({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div className="report-notice" role="status">
      <Info size={15} />
      <p>{children}</p>
      {actions}
    </div>
  );
}

/** Moves to a part of the page: buttons, not #anchors, so the address and its history keep no place in a report. */
function jump(id: string) {
  const target = document.getElementById(id === RAIL_ID ? RAIL_ID : reportBlockDomId(id));
  target?.scrollIntoView({ block: "start" });
  target?.focus({ preventScroll: true });
}

function Outline({ entries }: { entries: OutlineEntry[] }) {
  return (
    <ol className="report-outline">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button type="button" onClick={() => jump(entry.id)}>
            {entry.title}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Figures({ entries }: { entries: FigureEntry[] }) {
  const t = useStrings(reportText);
  return (
    <ol className="report-outline report-figures">
      {entries.map((entry, index) => (
        <li key={`${entry.id}:${index}`}>
          <button type="button" onClick={() => jump(entry.id)}>
            <span>{entry.title}</span>
            {entry.rows !== undefined && <small>{t.rows(entry.rows)}</small>}
          </button>
        </li>
      ))}
    </ol>
  );
}

const size = (bytes: number, language: string) =>
  bytes < 1024 ? `${bytes.toLocaleString(language)} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toLocaleString(language, { maximumFractionDigits: 1 })} KB` : `${(bytes / 1024 ** 2).toLocaleString(language, { maximumFractionDigits: 1 })} MB`;

/** The section's data files: what its charts and desks read, as Core kept them. */
function DataFiles({ files }: { files: SectionAttachment[] }) {
  const t = useStrings(reportText);
  const language = langTag(useLanguage());
  return (
    <ul className="report-files">
      {files.map((file) => (
        <li key={file.name}>
          <strong>{file.name}</strong>
          <span>{file.snapshot ? `${t.snapshot} · ${size(file.size, language)}` : t.reference}</span>
        </li>
      ))}
    </ul>
  );
}

/** A part the author named as supporting detail: its title and a short preview until opened, whole in the page. */
function Detail({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const t = useStrings(reportText);
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section className={`report-block report-detail${open ? " is-open" : ""}`} id={reportBlockDomId(id)} tabIndex={-1}>
      <button
        type="button"
        className="report-detail-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={open ? t.hideDetail(title) : t.showDetail(title)}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={15} />
        <span>{title}</span>
      </button>
      <div id={bodyId} className="report-detail-body" inert={open ? undefined : true}>
        {children}
      </div>
    </section>
  );
}
