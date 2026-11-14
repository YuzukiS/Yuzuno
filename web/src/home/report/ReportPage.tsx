import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, AlarmClock, ChevronRight, Eye, Info, LoaderCircle, MessageSquareReply } from "lucide-react";
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
import { homeText } from "../home-text";
import { SectionBody } from "../SectionBody";
import type { BodyDrawn } from "../brief/BriefSectionBody";
import { BriefStateScope } from "../brief/brief-state";
import { SectionTime } from "../SectionCard";
import type { HomeData, Section, SectionAttachment } from "../types";
import { figuresOf, linkTo, outlineOf, partsOf, reportPlace, type FigureEntry, type OutlineEntry, type ReportPlace } from "./report-model";
import { reportText } from "./report-text";
import { useOpenedReceipt } from "./report-opened";
import { RefreshPanel } from "../RefreshPanel";
import { RefreshVersions } from "../RefreshVersions";
import { useRefreshChanged } from "../refresh-changed";
import { refreshDateTime } from "../refresh-state";
import { refreshText } from "../refresh-text";
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
  onRefreshChanged,
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
  /** Reads Home again after the user changed this card's refresh schedule (YN-113 R3). */
  onRefreshChanged?: () => void;
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
  // A refreshing report (YN-113 R3): its live issue's schedule, and past issues Core keeps out of Home's history.
  // A past issue is read whole from Core and shown read only, above the page's own words (design §3.4).
  const [oldIssue, setOldIssue] = useState<Section | null>(null);
  const [issueAt, setIssueAt] = useState<string | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const refreshPanelId = useId();
  const banner = useRef<HTMLDivElement>(null);
  const refreshChangedFromHome = useRefreshChanged();
  const refreshDates = useMemo(() => refreshDateTime(time), [time]);
  const tRefresh = useStrings(refreshText);
  // The schedule is Core's for this card's identity: the live issue's, or the live one's when the page shows a
  // version kept in history (a card the user marked seen keeps its schedule; design §3.2).
  const refreshHolder = shown?.refresh ? shown : liveNow && (typeof shown?.id !== "number" || liveNow.id === shown.id) ? liveNow : null;
  const refreshOf = refreshHolder?.refresh ?? null;
  const refreshIdentity = refreshOf && typeof refreshHolder?.id === "number" ? refreshHolder.id : null;
  /** What the page reads: the past issue on screen, else the version linked. */
  const page = oldIssue ?? shown;
  useEffect(() => {
    if (oldIssue) banner.current?.focus({ preventScroll: true });
  }, [oldIssue]);
  const newer =
    place?.kind === "found" ? place.newer
      : shown && liveNow && liveNow.id === shown.id && liveNow.version > shown.version ? liveNow : null;
  const parts = useMemo(() => (page ? partsOf(page) : null), [page]);
  const outline = useMemo(() => (page && parts ? outlineOf(page, parts.flow) : []), [page, parts]);
  const figures = useMemo(() => {
    if (!page || !parts) return [];
    return [...(parts.summary?.visual ? figuresOf(page, [parts.summary.visual]) : []), ...figuresOf(page, parts.flow)];
  }, [page, parts]);
  // The blocks changed since the user last read it, as the page opened at this version: they stay marked while it is
  // on screen, after Core has recorded it opened (YN-86) or a read brings the same version again.
  const heldChanges = useRef<{ id: number | undefined; key: string; version: number; changes: BlockChanges | null } | null>(null);
  const changes = useMemo(() => {
    if (!page || !live || page !== shown) return null;
    const held = heldChanges.current;
    if (held && held.id === page.id && held.key === page.key && held.version === page.version) return held.changes;
    const found = changedBlocks(workspaceId, link.projectId, page);
    heldChanges.current = { id: page.id, key: page.key, version: page.version, changes: found };
    return found;
  }, [page, shown, live, workspaceId, link.projectId]);
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
          if (drawing.current.of !== page) drawing.current = { of: page, told: new Map() };
          const { told } = drawing.current;
          told.set(id, what);
          const blocks = expected.current;
          const whole = blocks.length > 0 && blocks.every((block) => told.has(block))
            && blocks.every((block) => told.get(block) !== "failed") && blocks.some((block) => told.get(block) === "drawn");
          setDrawn((was) => (whole ? page : was === page ? null : was));
        }));
      return tell;
    };
  }, [page]);
  const receipt = useOpenedReceipt(
    !readOnly && live && shown && page === shown && drawn === shown && link.workspaceId === workspaceId ? { workspaceId, projectId: link.projectId, section: shown } : null,
    onOpened,
  );
  const dataFiles = (page?.attachments ?? []).filter((file) => file.kind === "data");
  const railed = !!parts && (parts.sources.length > 0 || parts.attachments.length > 0 || dataFiles.length > 0);
  // A reply where Home takes one (T-174): on the live version, or on a report marked seen that a reply can still
  // refer to (replyableIn), as its card and pin do (Lead 2655). Never another version kept in History.
  const replyable = !readOnly && !oldIssue && place?.kind === "found" && replyableIn(panel, place.section);
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
  const titled = !!page;
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
  const title = page?.title ?? (place?.kind === "unavailable" ? place.versions[0].title : undefined);
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
  const block = (id: string) => <SectionBody section={page!} projectId={link.projectId} changes={changes} only={[id]} onDrawn={drawnBlock(id)} />;
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
          {page?.kind === "report" && <CopyButton text={() => reportMarkdown(page, link.projectId, language, time)} label={home.copyReport} />}
          {live && !oldIssue && shown && changedSinceSeen(shown) && !readOnly && (
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
        {/* A past issue is read from Core, read only, and says which it is (YN-113 §3.4). */}
        {oldIssue && (
          <div className="report-issue-banner" ref={banner} role="status" tabIndex={-1}>
            <Info size={15} aria-hidden="true" />
            <p>
              {tRefresh.issues.banner(refreshDates(issueAt ?? oldIssue.updatedAt))}{" "}
              <small>{tRefresh.issues.readOnly}</small>
            </p>
            <button type="button" className="quiet-button" onClick={() => setOldIssue(null)}>
              {tRefresh.issues.back}
            </button>
          </div>
        )}
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
        {!oldIssue && notice}
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
        {page && parts && (
          <BriefStateScope section={page}>
            <article className="report-article" aria-labelledby={headingId}>
              <div className="report-layout">
                <div className="report-main">
                  <header className="report-head">
                    <p className="report-kicker">
                      <span className={`home-kind kind-${page.kind}`}>{home.kind[page.kind]}</span>
                      {live && unreadChange(page) && <span className="home-changed">{readBefore(page) ? home.updated : home.new}</span>}
                      {unmaintained(page) && <span className="home-unmaintained">{home.notMaintained}</span>}
                      {!!page.repairs?.length && <span className="home-repaired">{home.repaired}</span>}
                      {panel && <span>{panel.project.name}</span>}
                    </p>
                    <h1 id={headingId} ref={heading} tabIndex={-1}>
                      {page.title}
                    </h1>
                    {refreshOf && refreshIdentity !== null && (
                      <div className="report-issue-row">
                        <RefreshVersions
                          projectId={link.projectId}
                          identity={refreshIdentity}
                          linkedVersion={shown?.version ?? page.version}
                          liveVersion={refreshHolder?.version ?? shown?.version ?? page.version}
                          liveAt={refreshHolder?.updatedAt ?? shown?.updatedAt ?? page.updatedAt}
                          selected={oldIssue?.version ?? null}
                          onSelect={(section, at) => {
                            setOldIssue(section);
                            setIssueAt(at);
                          }}
                        />
                        {!oldIssue && (
                          <button
                            type="button"
                            className="quiet-button report-refresh-toggle"
                            aria-expanded={refreshOpen}
                            aria-controls={refreshPanelId}
                            onClick={() => setRefreshOpen((open) => !open)}
                          >
                            <AlarmClock size={13} aria-hidden="true" />
                            {tRefresh.panel.title}
                          </button>
                        )}
                      </div>
                    )}
                    {!oldIssue && refreshOf && refreshOpen && (
                      <RefreshPanel
                        section={shown ?? page}
                        projectId={link.projectId}
                        refresh={refreshOf}
                        readOnly={readOnly}
                        variant="report"
                        panelId={refreshPanelId}
                        onChanged={() => (onRefreshChanged ?? refreshChangedFromHome)?.()}
                        onClose={() => setRefreshOpen(false)}
                      />
                    )}
                    {summary && <div className="report-lead">{block(summary.lead)}</div>}
                    <p className="report-meta">
                      <span>{page.owner.name}</span>
                      <Tip content={<TipText title={absolute(page.updatedAt, time)} />}>
                        <span>{relative(page.updatedAt, language)}</span>
                      </Tip>
                      <span>{t.version(page.version)}</span>
                      {page.status && (
                        // Its time is in its words in full: no tip repeats it.
                        <span className={page.status.stale ? "home-stale" : ""}>
                          {home.dataAsOf(absolute(page.status.asOf, time))}
                          {page.status.stale && home.pastValidity(duration(page.status.validFor, language))}
                        </span>
                      )}
                      {/* The card says when its data is from; the page also says what is due and next. */}
                      <SectionTime label={home.due} iso={page.time?.due} />
                      <SectionTime label={home.expected} iso={page.time?.eta} />
                      <SectionTime label={home.nextUpdate} iso={page.time?.nextUpdate} />
                      {changes && changes.size > 0 && <span className="report-changes">{t.blocksUpdated(changes.size)}</span>}
                    </p>
                    {/* Not recorded as read (YN-86): said, never retried here; it stays marked as changed. */}
                    {receipt !== null && (
                      <p className="home-note report-opened-note" role="status">
                        {t.notRecorded(receipt)}
                      </p>
                    )}
                    {/* What Core repaired to keep it, in Core's words (YN-14). */}
                    {!!page.repairs?.length && <RepairedNote section={page} />}
                    {/* Who left it and that it can be claimed, in words, not only in the card's tip (T-173). */}
                    {unmaintained(page) && (
                      <p className="home-note home-unmaintained-note">
                        {home.notMaintainedNote(
                          page.owner.name,
                          home.gone[page.owner.state as keyof typeof home.gone] ?? home.inactive,
                          home.kindInSentence[page.kind],
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
                      <Detail key={id} id={id} title={groupTitle(page, id)}>
                        {block(id)}
                      </Detail>
                    ) : (
                      <section key={id} className="report-block" id={reportBlockDomId(id)} data-block={nodeType(page, id)} tabIndex={-1}>
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
                      {page.version} · {page === shown && live ? t.current : page.history || page !== shown ? t.inHistory : t.version(page.version)}
                    </p>
                    {page === shown && live && (readVersion(shown) ?? shown.version) < shown.version && (
                      <p className="report-rail-note">{t.lastSaw(readVersion(shown)!)}</p>
                    )}
                  </section>
                </aside>
              </div>
            </article>
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
