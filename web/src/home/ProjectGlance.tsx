import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import type { MouseEvent } from "react";
import { useLanguage } from "../i18n";
import { projectColour } from "../project-groups";
import { useTimeDisplay } from "../time-preferences";
import { Tip, TipText } from "../Tip";
import type { Agent } from "../types";
import { BriefMarkdown } from "./brief/Markdown";
import { projectDomId } from "./brief-layout";
import { cardTask } from "./card-responsible";
import { absolute, relative } from "./format";
import { homeText } from "./home-text";
import { projectGlance } from "./project-glance";
import type { NeedsYouItem, ProjectPanel } from "./types";
import "./project-glance.css";

/**
 * Each project at a glance on the whole of Home (YN-86 §2.1), in Project
 * Priority: what needs the user and what is new to them, what the project
 * says now, the facts Core has of its work, and the cards that changed last.
 * A project with none of that is one line. The whole card opens the
 * project's page, as its Open project button does for the keyboard; a recent
 * card opens the page at that card. Nothing here is answered or marked.
 */
export function ProjectGlance({
  panels,
  needsYou,
  agentsOf,
  reorder,
  onOpen,
}: {
  /** The projects in Home's order. */
  panels: ProjectPanel[];
  needsYou: NeedsYouItem[];
  /** A project's open Agents, its executors among them. */
  agentsOf: (projectId: string) => Agent[];
  /** While the user reorders: each project's arrows, unavailable while the order saves. */
  reorder: { busy: boolean; move: (index: number, by: -1 | 1) => void } | null;
  onOpen: (projectId: string, sectionKey?: string) => void;
}) {
  const language = useLanguage();
  const time = useTimeDisplay();
  const t = homeText(language);
  // A click on the card opens its page; one on a control in it does what the control does.
  const openFrom = (projectId: string) => (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button, a, summary, input, textarea, select")) return;
    onOpen(projectId);
  };
  return (
    <section className="project-glance-list" aria-labelledby="home-projects-title">
      <h2 className="project-glance-title" id="home-projects-title">
        {t.glanceTitle}
        <span className="project-glance-count">{t.glanceCount(panels.length)}</span>
        <span className="project-glance-note">{t.glanceNote}</span>
      </h2>
      {panels.length === 0 ? (
        <p className="home-note home-empty">{t.noProjects}</p>
      ) : (
        <div className="project-glance-grid">
          {panels.map((panel, index) => {
            const id = panel.project.id;
            const name = panel.project.name;
            const glance = projectGlance(panel, needsYou, agentsOf(id), (section) => cardTask(section.card));
            const arrows = reorder && (
              // Unavailable while the order saves, or at the end it would move past, an arrow says so but stays
              // focusable, so the one just pressed keeps the focus (T-19 HM:H7).
              <span className="home-reorder" role="group" aria-label={t.move(name)}>
                <button
                  type="button"
                  className="icon-button"
                  data-move="up"
                  aria-label={t.moveUp(name)}
                  aria-disabled={index === 0 || reorder.busy || undefined}
                  onClick={() => { if (index > 0 && !reorder.busy) reorder.move(index, -1); }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  data-move="down"
                  aria-label={t.moveDown(name)}
                  aria-disabled={index === panels.length - 1 || reorder.busy || undefined}
                  onClick={() => { if (index < panels.length - 1 && !reorder.busy) reorder.move(index, 1); }}
                >
                  <ArrowDown size={14} />
                </button>
              </span>
            );
            const dot = <span className="project-dot" style={{ background: projectColour(id) }} aria-hidden />;
            const open = (
              <button type="button" className="project-glance-open" aria-label={t.openProject(name)} onClick={() => onOpen(id)}>
                {glance.quiet ? t.glanceOpenShort : t.glanceOpen}
                <ArrowRight size={13} aria-hidden />
              </button>
            );
            if (glance.quiet)
              return (
                <article key={id} id={projectDomId(id)} className="project-glance is-quiet" data-glance-project={id} onClick={openFrom(id)}>
                  {dot}
                  <h3>{name}</h3>
                  <span className="project-glance-quiet">
                    {glance.updatedAt ? t.glanceQuietSince(relative(glance.updatedAt, language)) : t.glanceQuiet}
                  </span>
                  {arrows}
                  {open}
                </article>
              );
            const { facts } = glance;
            const executors = [facts.running ? t.glanceRunning(facts.running) : "", facts.queued ? t.glanceQueued(facts.queued) : ""]
              .filter(Boolean)
              .join(" · ");
            return (
              <article key={id} id={projectDomId(id)} className="project-glance" data-glance-project={id} onClick={openFrom(id)}>
                <header className="project-glance-head">
                  {dot}
                  <h3>{name}</h3>
                  <span className="home-panel-chips">
                    {glance.needs > 0 && <span className="home-chip is-attention">{t.needCount(glance.needs)}</span>}
                    {glance.unseen > 0 && <span className="home-chip is-new">{t.newCount(glance.unseen)}</span>}
                  </span>
                  {arrows}
                </header>
                <div className="project-glance-line">
                  {glance.line?.kind === "status" ? (
                    <>
                      {glance.line.text ? <BriefMarkdown text={glance.line.text} /> : <p>{glance.line.section.title}</p>}
                      <small className="project-glance-source">{t.glanceSource(glance.line.section.owner.name, glance.line.section.title)}</small>
                    </>
                  ) : glance.line?.kind === "report" ? (
                    <p>{t.glanceLatestReport(glance.line.section.title)}</p>
                  ) : (
                    <p className="project-glance-none">{t.glanceNoCards}</p>
                  )}
                </div>
                <p className="project-glance-facts">
                  <span>{t.glanceDoing(facts.doing)}</span>
                  {executors && (
                    <span>
                      <span className={`status-dot ${facts.running ? "working" : "waiting"}`} aria-hidden />
                      {t.glanceExecutors(executors)}
                    </span>
                  )}
                  {facts.jobs > 0 && <span>{t.glanceJobs(facts.jobs)}</span>}
                  {facts.errors > 0 && <span className="is-error">{t.glanceErrors(facts.errors)}</span>}
                </p>
                {glance.recent.length > 0 && (
                  <ul className="project-glance-recent" aria-label={t.glanceRecent}>
                    {glance.recent.map(({ section, unread }) => (
                      <li key={section.key}>
                        <button type="button" onClick={() => onOpen(id, section.key)}>
                          {unread && <span className="project-glance-new" aria-label={t.glanceUnread} role="img" />}
                          <span className="project-glance-card">{section.title}</span>
                        </button>
                        <Tip content={<TipText title={absolute(section.updatedAt, time)} />}>
                          <time dateTime={section.updatedAt}>{relative(section.updatedAt, language)}</time>
                        </Tip>
                      </li>
                    ))}
                  </ul>
                )}
                {open}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
