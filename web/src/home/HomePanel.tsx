import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { Check, ChevronRight, CircleAlert, Github, History, MessageSquareReply, Workflow } from "lucide-react";
import { openJobs } from "../Jobs";
import type { Agent } from "../types";
import { CardReply, cardReplySlot, hasCardReply } from "./CardReply";
import { absolute, relative } from "./format";
import { readLinkedRepositories, type LinkedRepositories } from "./home-api";
import { homeText } from "./home-text";
import type { HomeTarget } from "./home-navigation";
import { RepoActivity } from "./RepoActivity";
import { SectionBody } from "./SectionBody";
import { HistoryBodyState } from "./HistoryBodyState";
import type { BriefOutcome, ProjectPanel, Section } from "./types";
import "./home-editors.css";
import { Tip, TipText } from "../Tip";
import { ReplyAnswer } from "../home-reply/HomeReply";
import { withoutFormIds } from "./AskReply";
import { answerShown, optionsThen } from "./answer-card";

/*
 * A Project's facts, as its panel and its page on Home show them (YN-86
 * §2.2): its Agents and their work, its repositories and its 30-day history.
 * The page's requests are RequestBlocks.tsx's (YN-212).
 */

const missingText = (missing: ReturnType<typeof homeText>["missing"], outcome: BriefOutcome) =>
  outcome === "missing" || outcome === "reminded" || outcome === "remindFailed" ? missing[outcome] : missing.other;

export function AgentCounts({ agents }: { agents: ProjectPanel["agents"] }) {
  const t = useStrings(homeText);
  const counts: ("working" | "idle" | "waiting" | "error" | "offline")[] = [
    "working",
    "idle",
    "waiting",
    "error",
    ...(agents.offline ? (["offline"] as const) : []),
  ];
  return (
    <span className="home-agent-counts" aria-label={t.agents(agents.total)}>
      {counts.map((key) => (
        <span key={key} className={`home-count${agents[key] ? "" : " is-zero"}`} data-count={key}>
          <span className={`status-dot ${key}`} aria-hidden />
          {t.count(key, agents[key])}
        </span>
      ))}
    </span>
  );
}

/**
 * Linked repositories (T-18; the design's layout A, YN-8 S7): each one's
 * line, then its open PRs grouped by what they need, its recent commits
 * folded under them. Linking repositories, their sync and the merge queue
 * switch are in Settings › Projects, which Manage in Settings opens. A
 * project without any repository shows nothing.
 */
export function RepoBlock({ projectId, readOnly, onManage }: { projectId: string; readOnly: boolean; onManage: () => void }) {
  const t = useStrings(homeText);
  const [page, setPage] = useState<LinkedRepositories | null>(null);
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
  return (
    <div className="home-widget home-repos" role="group" aria-label={t.repositories}>
      <Github size={13} className="home-repos-icon" aria-hidden />
      <RepoActivity projectId={projectId} linked={page.repositories} line lists={false} groups />
      <button type="button" className="quiet-button home-repos-manage" onClick={onManage}>
        {t.manageRepositories}
        <ChevronRight size={13} aria-hidden />
      </button>
    </div>
  );
}

/**
 * A project's facts as Core gives them (YN-86 §2.2): how its Agents are doing,
 * their errors, its Jobs and the turns that ended without a Brief update, on
 * its page beside its cards.
 */
export function ProjectFacts({ panel, onNavigate }: { panel: ProjectPanel; onNavigate: (target: HomeTarget) => void }) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  return (
    <>
      <AgentCounts agents={panel.agents} />
      <div className="home-widgets">
        {panel.errors.length > 0 && (
          <div className="home-widget home-errors" role="list" aria-label={t.agentErrors}>
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
                <Tip content={<TipText title={absolute(item.at, time)} />}><small>{relative(item.at, language)}</small></Tip>
              </div>
            ))}
          </div>
        )}
        {panel.jobs.length > 0 && (
          <div className="home-widget home-jobs">
            <h4>
              <Workflow size={13} /> {t.jobs}
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
                    <span>{job.agentName || t.noAgent}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {panel.missing.length > 0 && (
          <ul className="home-widget home-missing" aria-label={t.briefsNotMade}>
            {panel.missing.map((item) => (
              <li key={`${item.agentId}:${item.turnId}`}>
                <button
                  type="button"
                  className="inline-link"
                  onClick={() => onNavigate({ kind: "agent", agentId: item.agentId })}
                >
                  {item.agentName}
                </button>{" "}
                {missingText(t.missing, item.outcome)}
                <Tip content={<TipText title={absolute(item.at, time)} />}><small> · {relative(item.at, language)}</small></Tip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** A History entry a reply can still refer to (T-174): its own Reply. */
function HistoryReply({ section, projectId, workspaceId, agents }: { section: Section; projectId: string; workspaceId: string; agents: Agent[] }) {
  const t = useStrings(homeText);
  const [open, setOpen] = useState(() => hasCardReply(cardReplySlot(workspaceId, projectId, section.key)));
  // Reply and the reply take each other's place: focus goes with them (T-19 HM:S7).
  const [opened, setOpened] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const closing = useRef(false);
  useLayoutEffect(() => {
    if (open || !closing.current) return;
    closing.current = false;
    button.current?.focus();
  }, [open]);
  return open ? (
    <CardReply
      section={section}
      projectId={projectId}
      workspaceId={workspaceId}
      agents={agents}
      opened={opened}
      onClose={() => {
        closing.current = true;
        setOpen(false);
      }}
    />
  ) : (
    <Tip content={<TipText title={t.replyTitle(section.owner.name)} />}>
      <button
        type="button"
        className="quiet-button"
        ref={button}
        aria-label={t.replyLabel(section.title)}
        onClick={() => {
          setOpened(true);
          setOpen(true);
        }}
      >
        <MessageSquareReply size={13} /> {t.reply}
      </button>
    </Tip>
  );
}

/** A resolved Ask's question and the user's answer, in History (YN-223). */
function HistoryAnswer({ ask }: { ask: NonNullable<Section["ask"]> }) {
  const t = useStrings(homeText);
  const text = withoutFormIds(ask.replyText ?? "").trim();
  const shown = answerShown(ask, text);
  return (
    <>
      <p className="home-question">{shown.question}</p>
      {shown.snapshot ? (
        <div className="home-reply home-answer-given home-history-answer" role="group" aria-label={t.yourAnswer}>
          <ReplyAnswer snapshot={shown.snapshot} />
          {/* The options as the user saw them, the chosen one marked, as its answer card's Options then shows them. */}
          {optionsThen(shown.snapshot).length > 0 && (
            <section className="home-answer-options" aria-label={t.optionsThenLabel}>
              <ul>
                {optionsThen(shown.snapshot).map((option) => (
                  <li key={option.id} aria-current={option.chosen || undefined}>
                    {option.chosen && <Check size={14} aria-hidden="true" />}
                    <span>{option.label}</span>
                    {option.chosen && <small>{t.chosenOption}</small>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        text && <p className="home-history-reply">{t.yourReply}{text}</p>
      )}
    </>
  );
}

export function History30({
  sections,
  projectId,
  reply,
}: {
  sections: Section[];
  projectId: string;
  /** Not in the design preview: who can be replied to, and which entries a reply may refer to. */
  reply?: { workspaceId: string; agents: Agent[]; referable: Section[] };
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (!sections.length) return null;
  return (
    <details className="home-history">
      <summary>
        <History size={13} /> {t.history} · {sections.length}
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
                  <span className={`home-kind kind-${section.kind}`}>{t.historyKind[section.kind]}</span>
                  {section.title}
                  <small>
                    {section.owner.name} · <Tip content={<TipText title={absolute(section.updatedAt, time)} />}><span>{relative(section.updatedAt, language)}</span></Tip>
                  </small>
                </summary>
                {/* Read only when opened: history never costs the live view. */}
                {open.has(id) && (
                  <>
                    {/* A resolved ask keeps its question and the user's answer: as the user gave it to that question
                        when Core kept it (YN-223), else the reply as sent, without a form's line of IDs. In Home's history
                        index both come with the entry read whole, as it is opened (YN-221 S2). */}
                    {section.ask && !section.bodyOmitted && <HistoryAnswer ask={section.ask} />}
                    {section.bodyOmitted ? (
                      <HistoryBodyState projectId={projectId} section={section} />
                    ) : (
                      <SectionBody section={section} projectId={projectId} />
                    )}
                    {reply?.referable.includes(section) && (
                      <HistoryReply section={section} projectId={projectId} workspaceId={reply.workspaceId} agents={reply.agents} />
                    )}
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
