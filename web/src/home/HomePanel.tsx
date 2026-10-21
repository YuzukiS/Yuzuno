import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  Github,
  History,
  LoaderCircle,
  Workflow,
  ShieldCheck,
} from "lucide-react";
import { errorText } from "../api";
import { PendingCard } from "../components";
import { GitHubLinks, GitHubSummary } from "../GitHubLinks";
import { openJobs } from "../Jobs";
import type { Agent, PendingRequest } from "../types";
import { ProjectReply } from "./AskReply";
import { changedSinceSeen, groupSections, projectDomId, requestDomId } from "./brief-layout";
import { FoldButton, useCardFold } from "./card-fold";
import { absolute, plural, relative } from "./format";
import { readLinkedRepositories, type LinkedRepositories, type SeenMark } from "./home-api";
import type { HomeTarget } from "./home-navigation";
import { readPanelChoice, savePanelChoice } from "./panel-memory";
import { RepoActivity } from "./RepoActivity";
import { SectionBody } from "./SectionBody";
import { SectionCard } from "./SectionCard";
import type { BriefOutcome, NeedsYouItem, ProjectPanel, Section } from "./types";
import "./home-editors.css";


/** The top ranks show their whole Brief; lower ranks show about 600 px of it. */
export const FULL_RANKS = 3;

// Page-session memory of the automatic fold, per workspace and project. A
// panel folds by itself only until the user acts in it, so their own action
// (Seen all, an answer) never folds it under the pointer.
const autoFolds = new Map<string, boolean>();
const touchedPanels = new Set<string>();

const missingText: Partial<Record<BriefOutcome, string>> = {
  missing: "ended a turn without updating the Brief",
  reminded: "ended a turn without updating the Brief; Yuzuno sent one reminder",
  remindFailed: "ended a turn without updating the Brief; the reminder did not finish",
};

function AgentCounts({ agents }: { agents: ProjectPanel["agents"] }) {
  const counts: ("working" | "idle" | "waiting" | "error" | "offline")[] = [
    "working",
    "idle",
    "waiting",
    "error",
    ...(agents.offline ? (["offline"] as const) : []),
  ];
  return (
    <span className="home-agent-counts" aria-label={plural(agents.total, "Agent")}>
      {counts.map((key) => (
        <span key={key} className={`home-count${agents[key] ? "" : " is-zero"}`} data-count={key}>
          <span className={`status-dot ${key}`} aria-hidden />
          {key === "error" ? plural(agents[key], "error") : `${agents[key]} ${key}`}
        </span>
      ))}
    </span>
  );
}

/** Whether the capped body hides anything, so "Show more" appears only then. */
function useOverflow(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return setOverflowing(false);
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return [ref, overflowing] as const;
}

/** Linked repositories and their recent activity; a project without any shows nothing. */
function RepoBlock({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const [page, setPage] = useState<LinkedRepositories | null>(null);
  const [manage, setManage] = useState(false);
  const [collapsed, toggleFold] = useCardFold(`repos:${projectId}`);
  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController();
    readLinkedRepositories(projectId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && Array.isArray(value.repositories)) setPage(value);
      })
      // The block is optional: an older Core or an unreachable list hides it.
      .catch(() => {});
    return () => controller.abort();
  }, [projectId, readOnly]);
  if (!page?.repositories.length) return null;
  // Its own fold, apart from the project's (T-115). Collapsed, it reads no
  // activity (read again on expanding); GitHub, Jobs and CI go on as they
  // are. Repository details stay mounted, with anything typed in them.
  const body = `${projectDomId(projectId)}-repos`;
  return (
    <div className={`home-widget home-repos${collapsed ? " is-collapsed" : ""}`}>
      <div className="home-card-head">
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label="Repositories" controls={body} />
        <h4>
          <Github size={13} /> Repositories
        </h4>
        {collapsed && <span className="home-card-count">{page.repositories.length}</span>}
      </div>
      <div className="home-card-body" id={body} hidden={collapsed}>
        {!collapsed && <RepoActivity projectId={projectId} linked={page.repositories} />}
        <GitHubSummary links={page.links} />
        <button type="button" className="quiet-button" aria-expanded={manage} onClick={() => setManage((v) => !v)}>
          {manage ? "Hide repository details" : "Repository details…"}
        </button>
        {manage && <GitHubLinks projectId={projectId} disabled={readOnly} />}
      </div>
    </div>
  );
}

/** A project's waiting approvals; collapsed, its count still shows (T-115). */
function Approvals({ projectId, count, children }: { projectId: string; count: number; children: ReactNode }) {
  const [collapsed, toggleFold] = useCardFold(`approvals:${projectId}`);
  const body = `${projectDomId(projectId)}-approvals`;
  return (
    <div className={`home-widget home-approvals${collapsed ? " is-collapsed" : ""}`}>
      <div className="home-card-head">
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label="Waiting for approval" controls={body} />
        <h4>
          <ShieldCheck size={13} /> Waiting for approval
        </h4>
        <span className="home-card-count">{count}</span>
      </div>
      <div className="home-card-body" id={body} hidden={collapsed}>
        {children}
      </div>
    </div>
  );
}

function History30({ sections, projectId }: { sections: Section[]; projectId: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (!sections.length) return null;
  return (
    <details className="home-history">
      <summary>
        <History size={13} /> History (30 days) · {sections.length}
      </summary>
      <ul>
        {sections.map((section) => {
          const id = `${section.key}:${section.version}`;
          return (
            <li key={id}>
              <details
                onToggle={(event) => {
                  const shown = (event.currentTarget as HTMLDetailsElement).open;
                  setOpen((current) => {
                    const next = new Set(current);
                    if (shown) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
              >
                <summary>
                  <span className={`home-kind kind-${section.kind}`}>{section.kind}</span>
                  {section.title}
                  <small>
                    {section.owner.name} · <span title={absolute(section.updatedAt)}>{relative(section.updatedAt)}</span>
                  </small>
                </summary>
                {/* Read only when opened: history never costs the live view. */}
                {open.has(id) && (
                  <>
                    {/* A resolved ask keeps its question and the user's answer. */}
                    {section.ask && <p className="home-question">{section.ask.question}</p>}
                    {section.ask?.replyText && <p className="home-history-reply">Your reply: {section.ask.replyText}</p>}
                    <SectionBody section={section} projectId={projectId} />
                  </>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function HomePanel({
  panel,
  rank,
  workspaceId,
  agents,
  needsYou,
  readOnly,
  reveal,
  reorder,
  onNavigate,
  onChanged,
  onSeen,
}: {
  panel: ProjectPanel;
  /** Position in Project Priority, from 0. */
  rank: number;
  workspaceId: string;
  /** The project's open Agents, the ones a reply can go to. */
  agents: Agent[];
  needsYou: NeedsYouItem[];
  readOnly: boolean;
  /** Bumped when the needs-you row jumps here: show everything once. */
  reveal: number;
  reorder: { onUp?: () => void; onDown?: () => void; busy: boolean } | null;
  onNavigate: (target: HomeTarget) => void;
  onChanged: () => void;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
}) {
  const id = panel.project.id;
  const [choice, setChoice] = useState(() => readPanelChoice(workspaceId, id));
  const [more, setMore] = useState(false);
  // A jump from the needs-you row shows the panel whole, in the same render,
  // until the user expands, collapses or caps it again by hand.
  const [handled, setHandled] = useState({ collapse: 0, cap: 0 });
  const [seeingAll, setSeeingAll] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setChoice(readPanelChoice(workspaceId, id)), [workspaceId, id]);
  const quiet = panel.unseen === 0 && needsYou.length === 0 && panel.pending.length === 0;
  const session = JSON.stringify([workspaceId, id]);
  // Decided when the panel first shows in this page session, then follows
  // later reads only while the user has not acted in this panel.
  const [autoFold, setAutoFold] = useState(() => autoFolds.get(session) ?? quiet);
  useEffect(() => {
    if (!touchedPanels.has(session)) setAutoFold(quiet);
  }, [quiet, session]);
  useEffect(() => {
    autoFolds.set(session, autoFold);
  }, [session, autoFold]);
  const touch = () => touchedPanels.add(session);
  const collapsed =
    !(reveal > 0 && reveal !== handled.collapse) && (choice ? choice === "collapsed" : autoFold);
  const toggle = () => {
    const next = collapsed ? "expanded" : "collapsed";
    setHandled((h) => ({ ...h, collapse: reveal }));
    setChoice(next);
    savePanelChoice(workspaceId, id, next);
  };
  const sections = panel.brief.sections;
  const groups = groupSections(sections);
  const uncapped = more || (reveal > 0 && reveal !== handled.cap);
  const capped = rank >= FULL_RANKS && !uncapped;
  const toggleMore = () => {
    if (uncapped) {
      setMore(false);
      setHandled((h) => ({ ...h, cap: reveal }));
    } else setMore(true);
  };
  const [briefRef, overflowing] = useOverflow(capped && !collapsed);
  const changed = sections.filter(changedSinceSeen).length;
  async function seenAll() {
    setSeeingAll(true);
    setError("");
    try {
      // Every version on screen, exactly as shown.
      await onSeen(id, sections.map((s) => ({ key: s.key, version: s.version })));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSeeingAll(false);
    }
  }
  const seen = useCallback((marks: SeenMark[]) => onSeen(id, marks), [onSeen, id]);
  const card = (section: Section, sub = false) => (
    <SectionCard
      key={section.key}
      section={section}
      projectId={id}
      workspaceId={workspaceId}
      agents={agents}
      sub={sub}
      readOnly={readOnly}
      onSeen={seen}
      onChanged={onChanged}
    />
  );
  const viewChanges = (request: PendingRequest) => () =>
    onNavigate({
      kind: "changes",
      agentId: request.agentId,
      requestId: request.id,
      turnId: typeof request.params.turnId === "string" ? request.params.turnId : undefined,
      itemId: typeof request.params.itemId === "string" ? request.params.itemId : undefined,
    });
  return (
    <section
      className={`home-panel${collapsed ? " is-collapsed" : ""}${rank < FULL_RANKS ? " is-top" : ""}`}
      id={projectDomId(id)}
      data-home-project={id}
      aria-labelledby={`${projectDomId(id)}-name`}
      onPointerDownCapture={touch}
      onKeyDownCapture={touch}
      onClickCapture={touch}
    >
      <header className="home-panel-head">
        <button
          type="button"
          className="home-panel-toggle"
          aria-expanded={!collapsed}
          aria-controls={`${projectDomId(id)}-content`}
          onClick={toggle}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          <h2 id={`${projectDomId(id)}-name`}>{panel.project.name}</h2>
        </button>
        <span className="home-panel-chips">
          {panel.unseen > 0 && <span className="home-chip is-new">{panel.unseen} new</span>}
          {needsYou.length > 0 && (
            <span className="home-chip is-attention">{plural(needsYou.length, "needs", "need")} you</span>
          )}
          {collapsed && quiet && <span className="home-quiet">Nothing new since you looked</span>}
        </span>
        {reorder && (
          <span className="home-reorder" role="group" aria-label={`Move ${panel.project.name}`}>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${panel.project.name} up`}
              disabled={!reorder.onUp || reorder.busy}
              onClick={reorder.onUp}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Move ${panel.project.name} down`}
              disabled={!reorder.onDown || reorder.busy}
              onClick={reorder.onDown}
            >
              <ArrowDown size={14} />
            </button>
          </span>
        )}
      </header>
      {!collapsed && (
        <div className="home-panel-content" id={`${projectDomId(id)}-content`}>
          <div className="home-widgets">
            {panel.pending.length > 0 && (
              <Approvals projectId={id} count={panel.pending.length}>
                {panel.pending.map((request) => (
                  <div key={request.id} id={requestDomId(request.id)} tabIndex={-1} className="home-approval">
                    <span className="home-from">From {request.agentName}</span>
                    <PendingCard
                      request={request}
                      refresh={onChanged}
                      disabled={readOnly}
                      onViewChanges={viewChanges(request)}
                    />
                  </div>
                ))}
              </Approvals>
            )}
            <RepoBlock projectId={id} readOnly={readOnly} />
          </div>
          <div ref={briefRef} className={`home-brief${capped ? " is-capped" : ""}`}>
            {groups.length === 0 ? (
              <p className="home-note home-brief-empty">
                No current Home content. Content editors can add reports and status; everyone can add an Ask.
              </p>
            ) : (
              groups.map((group) => (
                <div className="home-topic" key={group.topic} data-topic={group.topic}>
                  {group.parent ? card(group.parent) : <h3 className="home-topic-name">{group.topic}</h3>}
                  {group.subs.length > 0 && (
                    <div className="home-subs">{group.subs.map((sub) => card(sub, true))}</div>
                  )}
                </div>
              ))
            )}
          </div>
          {rank >= FULL_RANKS && (uncapped || overflowing) && (
            <button type="button" className="quiet-button home-more" onClick={toggleMore}>
              {uncapped ? "Show less" : "Show more"}
            </button>
          )}
          <footer className="home-panel-foot">
            {changed > 0 && !readOnly && (
              <button type="button" className="secondary-button" disabled={seeingAll} onClick={() => void seenAll()}>
                {seeingAll ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
                Seen all
              </button>
            )}
            <ProjectReply
              projectId={id}
              projectName={panel.project.name}
              workspaceId={workspaceId}
              agents={agents}
              readOnly={readOnly}
              onSent={onChanged}
            />
          </footer>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <details className="home-team-details">
            <summary>Team details &amp; history</summary>
            <AgentCounts agents={panel.agents} />
            <div className="home-widgets">
            {panel.errors.length > 0 && (
              <div className="home-widget home-errors" role="list" aria-label="Agent errors">
                {panel.errors.map((item) => (
                  <div role="listitem" key={`${item.agentId}:${item.at}`} className="home-error">
                    <CircleAlert size={14} />
                    <button
                      type="button"
                      className="inline-link"
                      onClick={() => onNavigate({ kind: "error", agentId: item.agentId })}
                    >
                      {item.agentName}
                    </button>
                    <span className="home-error-message">{item.message}</span>
                    <small title={absolute(item.at)}>{relative(item.at)}</small>
                  </div>
                ))}
              </div>
            )}
            {panel.jobs.length > 0 && (
              <div className="home-widget home-jobs">
                <h4>
                  <Workflow size={13} /> Jobs
                </h4>
                <ul>
                  {panel.jobs.map((job) => (
                    <li key={job.id}>
                      <button
                        type="button"
                        className="home-job"
                        onClick={() => openJobs({ source: "local", jobId: job.id })}
                      >
                        <span className={`home-job-status status-${job.status}`}>{job.status}</span>
                        <strong>{job.name}</strong>
                        <span>{job.agentName || "No Agent"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {panel.missing.length > 0 && (
              <ul className="home-widget home-missing" aria-label="Brief updates not made">
                {panel.missing.map((item) => (
                  <li key={`${item.agentId}:${item.turnId}`}>
                    <button
                      type="button"
                      className="inline-link"
                      onClick={() => onNavigate({ kind: "agent", agentId: item.agentId })}
                    >
                      {item.agentName}
                    </button>{" "}
                    {missingText[item.outcome] || "ended a turn without a recorded Brief update"}
                    <small title={absolute(item.at)}> · {relative(item.at)}</small>
                  </li>
                ))}
              </ul>
            )}
            </div>
            {(panel.brief.teamSections?.length ?? 0) > 0 && <div className="home-team-content">
              <p className="home-note">Earlier content from other members. Hidden from the default Home view; not marked Seen.</p>
              {panel.brief.teamSections?.map(section => card(section))}
            </div>}
            <History30 sections={panel.brief.history} projectId={id} />
          </details>
        </div>
      )}
    </section>
  );
}
