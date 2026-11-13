import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, LoaderCircle, Settings } from "lucide-react";
import { errorText } from "../api";
import { lifecycleText } from "../executor-lifecycle";
import { useLanguage, useStrings } from "../i18n";
import { projectColour } from "../project-groups";
import type { Agent } from "../types";
import { changedSinceSeen, sectionDomId } from "./brief-layout";
import { settleWhenLanded } from "../settle";
import { unfoldAround } from "./card-fold";
import { homeText } from "./home-text";
import type { HomeTarget } from "./home-navigation";
import type { SeenMark } from "./home-api";
import { askKey, HomeJumps, nextAsk, scrollWithinHome, waitingAsks } from "./HomeJumps";
import { HomeDensity, RefreshHome } from "./home-tools";
import { ProjectDeck, ProjectFacts, RepoBlock, useProjectDeck } from "./HomePanel";
import { ProjectReply } from "./AskReply";
import { SectionCard } from "./SectionCard";
import { SummaryCard } from "./SummaryCard";
import { projectUnseen } from "./unseen";
import type { NeedsYouItem, ProjectPanel, Section } from "./types";
import "./project-home.css";
import { Tip, TipText } from "../Tip";

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The width at which the team's facts stand beside the cards, not below them (YN-86 §2.2). */
const TEAM_BESIDE = 1100;

/**
 * One Project's page on Home (YN-86 §2.2): its header and tools, its own
 * jumps, the reply to its team for now, its cards in three groups (what needs
 * you, in progress, done) and the team and its running work beside them where
 * the page is wide enough. It shows the same Brief sections as its panel on
 * Home, never a copy; every card is read on its own page and answered in
 * place.
 */
export function ProjectHome({
  projectId,
  panel,
  workspaceId,
  agents,
  needsYou,
  readOnly,
  densityWorkspace,
  refreshing,
  onRefresh,
  onNavigate,
  onChanged,
  onSeen,
  focus = null,
  onExit,
}: {
  projectId: string;
  /** The project's facts as read; null when Core no longer lists it. */
  panel: ProjectPanel | null;
  workspaceId: string;
  /** The project's open Agents, the ones a reply can go to. */
  agents: Agent[];
  /** Core's Needs you, for this project only. */
  needsYou: NeedsYouItem[];
  readOnly: boolean;
  /** Where Home keeps its density choice: "" in the preview, as on Home. */
  densityWorkspace: string;
  refreshing: boolean;
  onRefresh: () => void;
  onNavigate: (target: HomeTarget) => void;
  onChanged: () => void;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
  /** A card to show, or the top of the page: another jump is another `n`. */
  focus?: { key?: string; n: number } | null;
  /** Back to the whole of Home. */
  onExit: () => void;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const life = useStrings(lifecycleText);
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [seeingAll, setSeeingAll] = useState(false);
  const [seenError, setSeenError] = useState("");
  const lastAsk = useRef<string | null>(null);
  const id = panel?.project.id ?? projectId;
  const sections = panel?.brief.sections ?? [];
  const editorIds = panel?.contentEditors?.editorAgentIds ?? null;
  const executors = needsYou.filter((item) => item.kind === "executor");
  // Count what the page lists, from the same deck: its Needs group's cards, with its approvals and executor rows.
  const { deck } = useProjectDeck(panel);
  const needsCount = deck.counts.needs + (panel?.pending.length ?? 0) + executors.length;
  const unseen = panel ? projectUnseen(panel) : 0;
  const changed = sections.filter(changedSinceSeen).length;
  const asks = waitingAsks(needsYou);
  // The live report updated last on this project, as Home's jump goes to it.
  const latest = useMemo(() => {
    let found: { section: Section; at: number } | null = null;
    for (const section of sections) {
      if (section.kind !== "report" || section.history) continue;
      const at = Date.parse(section.updatedAt);
      if (!Number.isFinite(at) || (found && at <= found.at)) continue;
      found = { section, at };
    }
    return found?.section ?? null;
  }, [sections]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const read = () => setWide(element.clientWidth >= TEAM_BESIDE);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  /** Scrolls to `target`, opens the card or fold that holds it, and settles once it has landed. */
  function jumpTo(target: HTMLElement | null, block: ScrollLogicalPosition = "center") {
    if (!target) return;
    const smooth = !reducedMotion();
    const show = () => {
      scrollWithinHome(target, block, smooth);
      target.focus({ preventScroll: true });
      settleWhenLanded(target, "data-home-highlight", smooth);
    };
    if (unfoldAround(target)) requestAnimationFrame(show);
    else show();
  }
  const jumped = useRef(0);
  useEffect(() => {
    if (!focus || jumped.current === focus.n) return;
    jumped.current = focus.n;
    jumpTo(focus.key ? document.getElementById(sectionDomId(id, focus.key)) : root.current, focus.key ? "center" : "start");
    // The page is drawn by the time this runs, its read or its first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const toAsk = () => {
    const item = nextAsk(asks, lastAsk.current);
    if (!item?.sectionKey) return;
    lastAsk.current = askKey(item);
    jumpTo(document.getElementById(sectionDomId(id, item.sectionKey)));
  };
  const toReport = () => {
    if (latest) jumpTo(document.getElementById(sectionDomId(id, latest.key)));
  };
  async function seenAll() {
    setSeeingAll(true);
    setSeenError("");
    try {
      await onSeen(id, sections.map((section) => ({ key: section.key, version: section.version })));
    } catch (e) {
      setSeenError(errorText(e));
    } finally {
      setSeeingAll(false);
    }
  }
  if (!panel) {
    return (
      <div className="project-home" data-project-home={id}>
        <p className="home-note">{t.projectMissing}</p>
        <button type="button" className="quiet-button" onClick={onExit}>
          {t.allProjects}
        </button>
      </div>
    );
  }
  // The team's members: leads first, then the other Agents, then its executors (YN-86 §2.2).
  const members = [...agents].sort((a, b) => {
    const rank = (agent: Agent) =>
      editorIds?.includes(agent.id) ? 0 : agent.kind === "lead" ? 1 : agent.executor ? 3 : 2;
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  const taskLine = (agent: Agent) => {
    const task = agent.executor?.task;
    const name = task ? `${task.id} · ${task.shortName || task.title}` : t.noTask;
    const state = agent.executor?.state ? life.states[agent.executor.state] : "";
    return [name, state].filter(Boolean).join(" · ");
  };
  const teamFacts = (
    <>
      <ul className="project-team-members">
        {members.map((agent) => (
          <li key={agent.id}>
            <button type="button" className="project-team-member" onClick={() => onNavigate({ kind: "agent", agentId: agent.id })}>
              <span className={`status-dot ${agent.status}`} aria-hidden />
              <span className="project-team-name">{agent.name}</span>
              <span className="project-team-badge">
                {editorIds?.includes(agent.id) || agent.kind === "lead"
                  ? t.leadBadge
                  : agent.executor
                    ? t.executorBadge
                    : null}
              </span>
              {agent.executor && <small>{taskLine(agent)}</small>}
            </button>
          </li>
        ))}
      </ul>
      <ProjectFacts panel={panel} onNavigate={onNavigate} />
      <RepoBlock projectId={id} readOnly={readOnly} onManage={() => onNavigate({ kind: "projectSettings", projectId: id })} />
      {(panel.brief.teamSections?.length ?? 0) > 0 && (
        <details className="project-team-written">
          <summary>{t.teamWrote}</summary>
          <p className="home-note">{t.teamNote}</p>
          {panel.brief.teamSections?.map((section) =>
            section.kind === "ask" ? (
              <SectionCard
                key={section.key}
                section={section}
                projectId={id}
                workspaceId={workspaceId}
                agents={agents}
                readOnly={readOnly}
                onSeen={(marks) => onSeen(id, marks)}
                onChanged={onChanged}
              />
            ) : (
              <SummaryCard
                key={section.key}
                section={section}
                projectId={id}
                workspaceId={workspaceId}
                agents={agents}
                deck={false}
                readOnly={readOnly}
                onSeen={(marks) => onSeen(id, marks)}
              />
            ),
          )}
        </details>
      )}
    </>
  );
  return (
    <div className="project-home" data-project-home={id} ref={root}>
      <header className="home-header project-home-head">
        <h1>
          <span className="project-dot" style={{ background: projectColour(id) }} aria-hidden />
          {panel.project.name}
          <span className="home-panel-chips">
            {needsCount > 0 && <span className="home-chip is-attention">{t.needCount(needsCount)}</span>}
            {unseen > 0 && <span className="home-chip is-new">{t.newCount(unseen)}</span>}
          </span>
        </h1>
        <span className="home-header-tools">
          <HomeDensity workspaceId={densityWorkspace} />
          {changed > 0 && !readOnly && (
            <button type="button" className="quiet-button" disabled={seeingAll} onClick={() => void seenAll()}>
              {seeingAll ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
              {t.seenAll}
            </button>
          )}
          <Tip content={<TipText title={t.projectSettings} />} describe={false} side="bottom">
            <button
              type="button"
              className="icon-button"
              aria-label={t.projectSettings}
              onClick={() => onNavigate({ kind: "projectSettings", projectId: id })}
            >
              <Settings size={14} />
            </button>
          </Tip>
          {!readOnly && <RefreshHome busy={refreshing} onRefresh={onRefresh} />}
        </span>
      </header>
      <HomeJumps
        asks={asks.length}
        report={latest ? { title: latest.title, projectName: panel.project.name } : null}
        onAsk={toAsk}
        onReport={toReport}
      />
      {seenError && (
        <p className="inline-error" role="alert">
          {seenError}
        </p>
      )}
      <ProjectReply
        projectId={id}
        projectName={panel.project.name}
        workspaceId={workspaceId}
        agents={agents}
        readOnly={readOnly}
        onSent={onChanged}
      />
      <div className="project-home-body">
        <div className="project-home-main">
          <ProjectDeck
            panel={panel}
            workspaceId={workspaceId}
            agents={agents}
            readOnly={readOnly}
            onSeen={onSeen}
            onChanged={onChanged}
            grouped
            needs={{ pending: panel.pending, executors, onNavigate }}
          />
        </div>
        {wide ? (
          <aside className="project-team" aria-label={t.teamAndRun}>
            <h3 className="project-team-title">{t.teamAndRun}</h3>
            {teamFacts}
          </aside>
        ) : (
          <details className="project-team">
            <summary>{t.teamAndRun}</summary>
            {teamFacts}
          </details>
        )}
      </div>
    </div>
  );
}
