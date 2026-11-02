import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Eye, Info, LoaderCircle, MessageSquareReply } from "lucide-react";
import { errorText } from "../../api";
import { CopyButton } from "../../components";
import { useMessageLinks, type ReportLink } from "../../deep-link";
import { useLanguage, useStrings } from "../../i18n";
import { useTimeDisplay } from "../../time-preferences";
import type { Agent } from "../../types";
import { changedBlocks, type BlockChanges } from "../brief/block-changes";
import { reportMarkdown } from "../brief/brief-copy";
import { changedSinceSeen } from "../brief-layout";
import { CardReply } from "../CardReply";
import { absolute, duration, relative } from "../format";
import type { SeenMark } from "../home-api";
import { BriefDensity } from "../home-density";
import { homeText } from "../home-text";
import { SectionBody } from "../SectionBody";
import type { HomeData, Section } from "../types";
import { linkTo, outlineOf, reportPlace, restOf, summaryOf, type ReportPlace } from "./report-model";
import { reportText } from "./report-text";
import "./report.css";

/** Where a block of the report is, for its outline. */
export const reportBlockDomId = (id: string) => `report-block-${id}`;

/**
 * A section's report (T-18): a page over Home, which stays as it was below
 * it. It reads the section Home read, at the linked version only: its
 * summary first (the conclusion, then the key figure, the same blocks the
 * card shows), then the rest of the body in the author's order, at full
 * density, long text folded and sources on demand. What has become of the
 * version linked is said from Home's reading, never guessed.
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
}) {
  const language = useLanguage();
  const time = useTimeDisplay();
  const t = useStrings(reportText);
  const home = homeText(language);
  const links = useMessageLinks();
  const panel = data?.projects.find((p) => p.project.id === link.projectId);
  const place: ReportPlace | null = data ? reportPlace(link, panel) : null;
  // Home reads only a section's newest version: the version on screen stays
  // on screen when a newer one arrives, until the user opens that one.
  const [kept, setKept] = useState<Section | null>(null);
  if (place?.kind === "live" && place.section !== kept) setKept(place.section);
  const shown =
    place?.kind === "live" || place?.kind === "history" ? place.section : kept?.version === link.version ? kept : null;
  const live = place?.kind === "live";
  const summary = useMemo(() => (shown ? summaryOf(shown) : null), [shown]);
  const rest = useMemo(() => (shown && summary ? restOf(shown, summary) : []), [shown, summary]);
  const outline = useMemo(() => (shown ? outlineOf(shown, rest) : []), [shown, rest]);
  const changes = useMemo(
    () => (shown && !shown.history ? changedBlocks(workspaceId, link.projectId, shown) : null),
    [shown, workspaceId, link.projectId],
  );
  const [replying, setReplying] = useState(false);
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
  const title = shown?.title ?? (place?.kind === "later" ? place.section.title : undefined);
  const href = shown && links?.reportHref(linkTo(link.projectId, shown));
  const current = place?.kind === "later" ? place.section : null;
  const openCurrent = current && (
    <button type="button" className="secondary-button" onClick={() => onOpenVersion({ workspaceId: link.workspaceId, ...linkTo(link.projectId, current) })}>
      {t.openVersion(current.version)}
    </button>
  );
  const toProject = (
    <button type="button" className="secondary-button" onClick={() => onShowProject(link.projectId)}>
      {t.showProject}
    </button>
  );
  const notice =
    !data ? null
      : place?.kind === "later" ? (
        <Notice actions={openCurrent}>{shown ? t.arrived(link.version, place.section.version) : t.later(link.version, place.section.version)}</Notice>
      ) : place?.kind === "history" ? (
        <Notice actions={panel ? toProject : null}>
          {t.history(place.section.historyReason ?? "removed")}
          {place.section.version !== link.version && <> {t.historyVersion(link.version, place.section.version)}</>}
        </Notice>
      ) : place?.kind === "unknown" ? (
        <Notice actions={toProject}>{t.unknown}</Notice>
      ) : place?.kind === "gone" ? (
        <Notice actions={null}>{t.gone}</Notice>
      ) : null;
  return (
    <section
      ref={root}
      className="home-report"
      tabIndex={-1}
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
          {live && shown && !readOnly && shown.kind !== "ask" && (
            <button
              type="button"
              className="quiet-button home-reply-open"
              aria-expanded={replying}
              aria-label={home.replyLabel(shown.title)}
              title={home.replyTitle(shown.owner.name)}
              onClick={() => setReplying((open) => !open)}
            >
              <MessageSquareReply size={13} />
              {home.reply}
            </button>
          )}
        </span>
      </header>
      <div className="report-page">
        {readFailed && data && <p className="home-note report-read-note">{t.readFailed}</p>}
        {!data && (
          <div className="loading-state">
            <LoaderCircle className="spin" size={19} />
            {t.reading}
          </div>
        )}
        {notice}
        {live && shown && replying && (
          <CardReply section={shown} projectId={link.projectId} workspaceId={workspaceId} agents={agents} onClose={() => setReplying(false)} />
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {shown && summary && (
          <article className="report-article" aria-labelledby={headingId}>
            <header className="report-head">
              <span className={`home-kind kind-${shown.kind}`}>{home.kind[shown.kind]}</span>
              <h1 id={headingId} ref={heading} tabIndex={-1}>
                {shown.title}
              </h1>
              <p className="report-meta">
                <span>{shown.owner.name}</span>
                <span>{t.version(shown.version)}</span>
                <span title={absolute(shown.updatedAt, time)}>{relative(shown.updatedAt, language)}</span>
                {shown.status && (
                  <span className={shown.status.stale ? "home-stale" : ""} title={absolute(shown.status.asOf, time)}>
                    {home.dataAsOf(absolute(shown.status.asOf, time))}
                    {shown.status.stale && home.pastValidity(duration(shown.status.validFor, language))}
                  </span>
                )}
              </p>
              {changes && changes.size > 0 && <p className="report-changes">{t.blocksUpdated(changes.size)}</p>}
            </header>
            <BriefDensity.Provider value="high">
              <div className="report-layout">
                <div className="report-main">
                  {outline.length > 0 && (
                    <details className="report-contents">
                      <summary>{t.contents}</summary>
                      <Outline entries={outline} />
                    </details>
                  )}
                  {summary.lead && (
                    <div className="report-lead" id={reportBlockDomId(summary.lead)}>
                      <SectionBody section={shown} projectId={link.projectId} changes={changes} only={[summary.lead]} />
                    </div>
                  )}
                  {summary.visual && (
                    <figure className="report-hero" id={reportBlockDomId(summary.visual)}>
                      <SectionBody section={shown} projectId={link.projectId} changes={changes} only={[summary.visual]} />
                    </figure>
                  )}
                  {rest.map((id) => (
                    <ReportBlock key={id} id={id} section={shown} projectId={link.projectId} changes={changes} />
                  ))}
                </div>
                {outline.length > 0 && (
                  <nav className="report-rail" aria-label={t.onThisPage}>
                    <p className="report-rail-title">{t.onThisPage}</p>
                    <Outline entries={outline} />
                  </nav>
                )}
              </div>
            </BriefDensity.Provider>
          </article>
        )}
      </div>
    </section>
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

function Outline({ entries }: { entries: { id: string; title: string }[] }) {
  // Buttons, not #anchors: the address keeps no place in a report.
  return (
    <ol className="report-outline">
      {entries.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            onClick={() => {
              const target = document.getElementById(reportBlockDomId(entry.id));
              target?.scrollIntoView({ block: "start" });
              target?.focus({ preventScroll: true });
            }}
          >
            {entry.title}
          </button>
        </li>
      ))}
    </ol>
  );
}

type Node = { type?: string; props?: { items?: unknown[] } };

/** One top-level block of the report: long text folds, sources and files open on demand. */
function ReportBlock({ id, section, projectId, changes }: { id: string; section: Section; projectId: string; changes: BlockChanges | null }) {
  const t = useStrings(reportText);
  const node = (section.body as { elements?: Record<string, Node> }).elements?.[id];
  const body = <SectionBody section={section} projectId={projectId} changes={changes} only={[id]} />;
  const count = Array.isArray(node?.props?.items) ? node.props.items.length : 0;
  if (node?.type === "Sources" || node?.type === "Attachments")
    return (
      <details className="report-block report-more" id={reportBlockDomId(id)} tabIndex={-1}>
        <summary>{node.type === "Sources" ? t.sources(count) : t.attachments(count)}</summary>
        {body}
      </details>
    );
  return (
    <section className="report-block" id={reportBlockDomId(id)} data-block={node?.type} tabIndex={-1}>
      {node?.type === "Markdown" ? <Fold version={section.version}>{body}</Fold> : body}
    </section>
  );
}

/** Long text, whole in the page, folded after about a dozen lines behind "Show all". */
function Fold({ version, children }: { version: number; children: ReactNode }) {
  const t = useStrings(reportText);
  const body = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [long, setLong] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || all) return;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [all, version]);
  return (
    <div className={`report-fold${all ? "" : " is-folded"}${long ? " is-long" : ""}`}>
      <div ref={body} id={bodyId} className="report-fold-body">
        {children}
      </div>
      {long && (
        <button type="button" className="quiet-button report-fold-toggle" aria-expanded={all} aria-controls={bodyId} onClick={() => setAll(!all)}>
          {all ? t.showLess : t.showAll}
        </button>
      )}
    </div>
  );
}
