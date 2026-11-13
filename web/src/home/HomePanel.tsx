import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
import { ChevronRight, CircleAlert, Github, History, MessageSquareReply, Workflow } from "lucide-react";
import { PendingCard } from "../components";
import { openJobs } from "../Jobs";
import type { Agent, PendingRequest } from "../types";
import { CardReply, cardReplySlot, hasCardReply, referableHistory } from "./CardReply";
import { groupSections, projectDomId, requestDomId, topicName, unreadChange, type TopicGroup } from "./brief-layout";
import { DeckSizes } from "./card-sizes";
import { deckPlace, type DeckPlace } from "./deck-order";
import { deckCard, deckItems, useDeckPacking } from "./deck-packing";
import { deckGroup, groupDeck } from "./project-deck";
import { cardTask } from "./card-responsible";
import { absolute, relative } from "./format";
import { readLinkedRepositories, type LinkedRepositories, type SeenMark } from "./home-api";
import { homeText } from "./home-text";
import type { HomeTarget } from "./home-navigation";
import { RepoActivity } from "./RepoActivity";
import { SectionBody } from "./SectionBody";
import { SectionCard } from "./SectionCard";
import { SummaryCard } from "./SummaryCard";
import type { BriefOutcome, NeedsYouItem, ProjectPanel, Section } from "./types";
import "./home-editors.css";
import { Tip, TipText } from "../Tip";

/*
 * A Project's cards and facts, as its page on Home shows them (YN-86 §2.2):
 * its deck in three groups, its Agents and their work, its repositories and
 * its 30-day history.
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

function History30({
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
                    {/* A resolved ask keeps its question and the user's answer. */}
                    {section.ask && <p className="home-question">{section.ask.question}</p>}
                    {section.ask?.replyText && <p className="home-history-reply">{t.yourReply}{section.ask.replyText}</p>}
                    <SectionBody section={section} projectId={projectId} />
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

/**
 * The visit's places and groups for a Project's cards (YN-86 §2.2), and its
 * deck in the three groups. A card first shown in this visit keeps its place
 * and its group (card-sizes.ts); a Project's page counts what it lists from
 * the same deck.
 */
export function useProjectDeck(panel: ProjectPanel | null) {
  const sizes = useContext(DeckSizes);
  const now = Date.now();
  const sections = panel?.brief.sections ?? [];
  const projectId = panel?.project.id ?? "";
  const ownPlaces = sections.map((section) => [section.key, deckPlace(section, now)] as const);
  const places: Map<string, DeckPlace> = sizes ? sizes.places(projectId, ownPlaces) : new Map(ownPlaces);
  const placeOf = (section: Section) => places.get(section.key) ?? deckPlace(section, now);
  // A card bound to a task follows its task (YN-86 §2.2, §3.4).
  const groupNow = (section: Section) => deckGroup(placeOf(section), unreadChange(section), cardTask(section.card));
  const ownGroups = sections.map((section) => [section.key, groupNow(section)] as const);
  const held = sizes ? sizes.groups(projectId, ownGroups) : new Map(ownGroups);
  const groupOf = (section: Section) => held.get(section.key) ?? groupNow(section);
  const groups = groupSections(sections);
  return { groups, placeOf, deck: groupDeck(groups, groupOf, placeOf) };
}

/**
 * One Project's cards on its page (YN-86 §2.2), in three groups: what needs
 * the user, what is in progress and what is done. Where each card stands is
 * held for the visit (card-sizes.ts), so a report opened and read comes back
 * with no New mark and in the same place. An open Ask's card is the same one
 * Needs you shows on the whole of Home.
 */
export function ProjectDeck({
  panel,
  workspaceId,
  agents,
  readOnly,
  onSeen,
  onChanged,
  arrival = null,
  needs = null,
}: {
  panel: ProjectPanel;
  workspaceId: string;
  /** The project's open Agents, the ones a reply can go to. */
  agents: Agent[];
  readOnly: boolean;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
  onChanged: () => void;
  /** Where a reply's "Open on Home" landed in this project (T-9). */
  arrival?: { key: string; inCard: boolean; note: ReactNode } | null;
  /** Its approvals and its executors' matters, in Needs you. */
  needs?: {
    pending: (PendingRequest & { agentName: string })[];
    executors: NeedsYouItem[];
    onNavigate: (target: HomeTarget) => void;
  } | null;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const id = panel.project.id;
  const sections = panel.brief.sections;
  // Each group in the deck's order (YN-3, deck-order.ts); each card keeps the group and place it was first
  // shown in during this visit (card-sizes.ts).
  const { deck: groupedDeck } = useProjectDeck(panel);
  const members = (list: TopicGroup[]) => list.flatMap((g) => [...(g.parent ? [g.parent] : []), ...g.subs]);
  const live = useMemo(() => [...sections, ...(panel.brief.teamSections ?? [])], [sections, panel.brief.teamSections]);
  const referable = useMemo(() => referableHistory(panel.brief.history, live.map((s) => s.key)), [panel.brief.history, live]);
  // The grids this component lays out: each group's.
  const needsRef = useRef<HTMLDivElement>(null);
  const laterRef = useRef<HTMLDivElement>(null);
  const doingRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  useDeckPacking(needsRef, deckItems, deckCard);
  useDeckPacking(laterRef, deckItems, deckCard);
  useDeckPacking(doingRef, deckItems, deckCard);
  useDeckPacking(doneRef, deckItems, deckCard);
  const seen = useCallback((marks: SeenMark[]) => onSeen(id, marks), [onSeen, id]);
  // A report or status shows its summary; the whole body is read on its
  // page (T-18, Lead 2270). An Ask keeps its full card, answered in place.
  // A sub-topic's card says its topic in words (Dev 7, T-18): in a deck of
  // sizes it may stand anywhere, so no stripe could show what it belongs to.
  // Only the deck's cards take a size; the team's, in their details, do not.
  const card = (section: Section, topic?: string, deck = true) => section.kind !== "ask" ? (
    <SummaryCard
      key={section.key}
      section={section}
      projectId={id}
      workspaceId={workspaceId}
      agents={agents}
      topic={topic}
      deck={deck}
      readOnly={readOnly}
      onSeen={seen}
      notice={arrival?.inCard && arrival.key === section.key ? arrival.note : undefined}
    />
  ) : (
    <SectionCard
      key={section.key}
      section={section}
      projectId={id}
      workspaceId={workspaceId}
      agents={agents}
      topic={topic}
      readOnly={readOnly}
      onSeen={seen}
      onChanged={onChanged}
      notice={arrival?.inCard && arrival.key === section.key ? arrival.note : undefined}
    />
  );
  // A card archived with its task (YN-86 §3.4), in Done for its 30 days: as it was, with who did it and their
  // session, and nothing more to answer, read or mark on it.
  const archivedCard = (section: Section, topic?: string) => (
    <SummaryCard
      key={section.key}
      section={section}
      projectId={id}
      workspaceId={workspaceId}
      agents={agents}
      topic={topic}
      deck
      readOnly
      onSeen={seen}
    />
  );
  // A topic's cards together: a sub-topic whose topic has no section of its own stands as a card of its own;
  // several get a readable heading, never the bare key (T-173).
  const blockOf = (make: (section: Section, topic?: string) => ReactNode) => (group: TopicGroup) =>
    !group.parent && group.subs.length === 1 ? (
      <div className="home-topic" key={group.topic} data-topic={group.topic}>
        {make(group.subs[0])}
      </div>
    ) : (
      <div className="home-topic" key={group.topic} data-topic={group.topic}>
        {group.parent ? (
          make(group.parent)
        ) : (
          // The topic's key as Agents write it, beside the name it is shown by.
          <Tip content={<TipText value={group.topic} />} align="start">
            <h3 className="home-topic-name">
              {topicName(group.topic)}
            </h3>
          </Tip>
        )}
        {group.subs.length > 0 && (
          <div className="home-subs">{group.subs.map((sub) => make(sub, topicName(group.topic)))}</div>
        )}
      </div>
    );
  const topicBlock = blockOf(card);
  const viewChanges = (request: PendingRequest) => () =>
    needs?.onNavigate({
      kind: "changes",
      agentId: request.agentId,
      requestId: request.id,
      turnId: typeof request.params.turnId === "string" ? request.params.turnId : undefined,
      itemId: typeof request.params.itemId === "string" ? request.params.itemId : undefined,
    });
  const pending = needs?.pending ?? [];
  const executors = needs?.executors ?? [];
  const needsCount = groupedDeck.counts.needs + pending.length + executors.length;
  const doingCount = groupedDeck.counts.doing + groupedDeck.counts.replied;
  // Done also shows, as cards, what was archived with its task (YN-86 §3.4): each key's newest History entry, when
  // that is its archiving and no section under its key is live. The rest of History stays in its list.
  const liveKeys = new Set(live.map((s) => s.key));
  const newestOfKey = new Set<string>();
  const archived = panel.brief.history.filter((s) => {
    if (newestOfKey.has(s.key)) return false;
    newestOfKey.add(s.key);
    return s.historyReason === "archived" && s.kind !== "ask" && !liveKeys.has(s.key);
  });
  // An archived card joins its topic in Done, as a report still waiting to be read there keeps its own.
  const archivedTopics = new Map(groupSections(archived).map((group) => [group.topic, group]));
  const doneGroups: TopicGroup[] = groupedDeck.done.map((group) => {
    const gone = archivedTopics.get(group.topic);
    if (!gone) return group;
    archivedTopics.delete(group.topic);
    return { topic: group.topic, parent: group.parent ?? gone.parent, subs: [...group.subs, ...gone.subs] };
  });
  doneGroups.push(...archivedTopics.values());
  const doneCard = (section: Section, topic?: string) => (section.history ? archivedCard(section, topic) : card(section, topic));
  const done = members(doneGroups);
  const newestDone = done.map((s) => s.updatedAt).sort().at(-1);
  const history = panel.brief.history.filter((s) => !archived.includes(s));
  const empty = !needsCount && !groupedDeck.counts.deferred && !doingCount && !done.length && !history.length;
  return (
    <div className="project-deck">
      {empty && <p className="home-note home-brief-empty">{t.noContent}</p>}
      {(needsCount > 0 || groupedDeck.counts.deferred > 0) && (
        <section className="project-deck-group" aria-labelledby={`${projectDomId(id)}-needs`}>
          <h2 className="project-deck-title" id={`${projectDomId(id)}-needs`}>
            {t.needsYou}
            <span className="project-deck-count">{needsCount}</span>
          </h2>
          <div ref={needsRef} className="home-brief">
            {groupedDeck.needs.map(topicBlock)}
            {pending.map((request) => (
              <div key={request.id} id={requestDomId(request.id)} tabIndex={-1} className="home-approval">
                <span className="home-from">{t.from(request.agentName)}</span>
                <PendingCard
                  request={request}
                  refresh={onChanged}
                  disabled={readOnly}
                  onViewChanges={viewChanges(request)}
                />
              </div>
            ))}
            {executors.map((item) => (
              <button
                key={`${item.agentId}:${item.state}`}
                type="button"
                className="project-deck-executor"
                onClick={() => needs?.onNavigate({ kind: "agent", agentId: item.agentId })}
              >
                <span className="home-needs-source">
                  {t.from(item.agentName)} · {item.state ? t.executorNeeds[item.state] : ""}
                </span>
                <strong>{item.taskId ? `${item.taskId} · ${item.title}` : item.title}</strong>
                <small>{relative(item.since, language)}</small>
              </button>
            ))}
          </div>
          {groupedDeck.deferred.length > 0 && (
            <details className="project-deck-later">
              <summary>{t.deckLater(groupedDeck.counts.deferred)}</summary>
              <div ref={laterRef} className="home-brief">
                {groupedDeck.deferred.map(topicBlock)}
              </div>
            </details>
          )}
        </section>
      )}
      {doingCount > 0 && (
        <section className="project-deck-group" aria-labelledby={`${projectDomId(id)}-doing`}>
          <h2 className="project-deck-title" id={`${projectDomId(id)}-doing`}>
            {t.deckDoing}
            <span className="project-deck-count">{doingCount}</span>
            <span className="project-deck-note">{t.deckStaysPut}</span>
          </h2>
          <div ref={doingRef} className="home-brief">
            {groupedDeck.doing.map(topicBlock)}
            {groupedDeck.replied.length > 0 && (
              <>
                <h3 className="home-deck-heading">{t.repliedGroup(groupedDeck.counts.replied)}</h3>
                {groupedDeck.replied.map(topicBlock)}
              </>
            )}
          </div>
        </section>
      )}
      {(done.length > 0 || history.length > 0) && (
        <details className="project-deck-done">
          <summary>
            {t.deckDone(done.length, newestDone ? relative(newestDone, language) : "", history.length)}
          </summary>
          <div ref={doneRef} className="home-brief">
            {doneGroups.map(blockOf(doneCard))}
          </div>
          <History30
            sections={history}
            projectId={id}
            reply={readOnly ? undefined : { workspaceId, agents, referable }}
          />
        </details>
      )}
    </div>
  );
}
