import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLanguage, useStrings } from "../i18n";
import { useTimeDisplay } from "../time-preferences";
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
  MessageSquareReply,
  Workflow,
  ShieldCheck,
} from "lucide-react";
import { errorText } from "../api";
import { PendingCard } from "../components";
import { openJobs } from "../Jobs";
import type { Agent, PendingRequest } from "../types";
import { ProjectReply } from "./AskReply";
import { CardReply, cardReplySlot, hasCardReply, KeptCardReplies, referableHistory } from "./CardReply";
import { changedSinceSeen, groupSections, projectDomId, requestDomId, topicName, unreadChange, type TopicGroup } from "./brief-layout";
import { DeckSizes } from "./card-sizes";
import { deckPlace, orderDeck, type DeckPlace } from "./deck-order";
import { deckCard, deckItems, useDeckPacking } from "./deck-packing";
import { deckGroup, groupDeck } from "./project-deck";
import { projectUnseen } from "./unseen";
import { FoldButton, useCardFold } from "./card-fold";
import { absolute, relative } from "./format";
import { readLinkedRepositories, type LinkedRepositories, type SeenMark } from "./home-api";
import { homeText } from "./home-text";
import type { HomeTarget } from "./home-navigation";
import { readPanelChoice, savePanelChoice } from "./panel-memory";
import { RepoActivity } from "./RepoActivity";
import { SectionBody } from "./SectionBody";
import { SectionCard } from "./SectionCard";
import { SummaryCard } from "./SummaryCard";
import type { BriefOutcome, NeedsYouItem, ProjectPanel, Section } from "./types";
import "./home-editors.css";
import { Tip, TipText } from "../Tip";


/** The top ranks show their whole Brief; lower ranks show about 600 px of it. */
export const FULL_RANKS = 3;

// Page-session memory of the automatic fold, per workspace and project. A
// panel folds by itself only until the user acts in it, so their own action
// (Seen all, an answer) never folds it under the pointer.
const autoFolds = new Map<string, boolean>();
const touchedPanels = new Set<string>();

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

/** Whether the capped body hides anything, so "Show more" appears only then. */
function useOverflow(ref: RefObject<HTMLElement | null>, active: boolean) {
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
  return overflowing;
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
 * their errors, its Jobs and the turns that ended without a Brief update. The
 * same block stands in a project's panel and on its own page.
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

/** A project's waiting approvals; collapsed, its count still shows (T-115). */
function Approvals({ projectId, count, children }: { projectId: string; count: number; children: ReactNode }) {
  const t = useStrings(homeText);
  const [collapsed, toggleFold] = useCardFold(`approvals:${projectId}`);
  const body = `${projectDomId(projectId)}-approvals`;
  return (
    <div className={`home-widget home-approvals${collapsed ? " is-collapsed" : ""}`}>
      <div className="home-card-head">
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label={t.waitingForApproval} controls={body} />
        <h4>
          <ShieldCheck size={13} /> {t.waitingForApproval}
        </h4>
        <span className="home-card-count">{count}</span>
      </div>
      <div className="home-card-body" id={body} hidden={collapsed}>
        {children}
      </div>
    </div>
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
  const ownGroups = sections.map((section) => [section.key, deckGroup(placeOf(section), unreadChange(section))] as const);
  const held = sizes ? sizes.groups(projectId, ownGroups) : new Map(ownGroups);
  const groupOf = (section: Section) => held.get(section.key) ?? deckGroup(placeOf(section), unreadChange(section));
  const groups = groupSections(sections);
  return { groups, ordered: orderDeck(groups, placeOf), placeOf, deck: groupDeck(groups, groupOf, placeOf) };
}

/**
 * One Project's cards (YN-86 §2.2): the whole deck as a project's panel on
 * Home shows it, or, with `grouped`, the three groups of its own page: what
 * needs the user, what is in progress and what is done. Both draw the same
 * cards from the same sections; where each card stands is held for the visit
 * (card-sizes.ts), so a report opened and read comes back with no New mark
 * and in the same place.
 */
export function ProjectDeck({
  panel,
  workspaceId,
  agents,
  readOnly,
  onSeen,
  onChanged,
  arrival = null,
  grouped = false,
  needs = null,
  capped = false,
  onOverflow,
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
  /** The three groups a Project's page shows, instead of the panel's one deck. */
  grouped?: boolean;
  /** On a Project's page: its approvals and its executors' matters, in Needs you. */
  needs?: {
    pending: (PendingRequest & { agentName: string })[];
    executors: NeedsYouItem[];
    onNavigate: (target: HomeTarget) => void;
  } | null;
  /** A panel below the top ranks shows about 600 px; "Show more" lifts it. */
  capped?: boolean;
  onOverflow?: (overflowing: boolean) => void;
}) {
  const language = useLanguage();
  const time = useTimeDisplay();
  const t = homeText(language);
  const id = panel.project.id;
  const sections = panel.brief.sections;
  // The deck's order (YN-3, deck-order.ts): what needs the user, then current status, reports, Asks put off and
  // what came in during this visit; then the Asks the user answered, under their heading; last, status out of
  // date, closed. Each card keeps the place it was first shown in during this visit (card-sizes.ts).
  const { groups, ordered, placeOf, deck } = useProjectDeck(panel);
  const inGroup = (place: DeckPlace) => ordered.filter((o) => o.place === place).map((o) => o.group);
  const members = (list: TopicGroup[]) => list.flatMap((g) => [...(g.parent ? [g.parent] : []), ...g.subs]);
  const deckMain = ordered.filter((o) => o.place !== "replied" && o.place !== "stale").map((o) => o.group);
  const deckReplied = inGroup("replied");
  const deckStale = inGroup("stale");
  const repliedCount = members(deckReplied).filter((s) => placeOf(s) === "replied").length;
  const staleStatus = members(deckStale).filter((s) => placeOf(s) === "stale" && s.status);
  const newestStale = staleStatus.map((s) => s.status!.asOf).sort().at(-1) ?? null;
  const groupedDeck = grouped ? deck : null;
  const live = useMemo(() => [...sections, ...(panel.brief.teamSections ?? [])], [sections, panel.brief.teamSections]);
  const referable = useMemo(() => referableHistory(panel.brief.history, live.map((s) => s.key)), [panel.brief.history, live]);
  // The grids this component lays out: the panel's one deck, or a Project page's groups.
  const deckRef = useRef<HTMLDivElement>(null);
  const staleRef = useRef<HTMLDivElement>(null);
  const needsRef = useRef<HTMLDivElement>(null);
  const laterRef = useRef<HTMLDivElement>(null);
  const doingRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  useDeckPacking(deckRef, deckItems, deckCard);
  useDeckPacking(staleRef, deckItems, deckCard);
  useDeckPacking(needsRef, deckItems, deckCard);
  useDeckPacking(laterRef, deckItems, deckCard);
  useDeckPacking(doingRef, deckItems, deckCard);
  useDeckPacking(doneRef, deckItems, deckCard);
  const overflowing = useOverflow(deckRef, capped && !grouped);
  useEffect(() => {
    onOverflow?.(overflowing);
  }, [overflowing, onOverflow]);
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
  // A topic's cards together: a sub-topic whose topic has no section of its own stands as a card of its own;
  // several get a readable heading, never the bare key (T-173).
  const topicBlock = (group: TopicGroup) =>
    !group.parent && group.subs.length === 1 ? (
      <div className="home-topic" key={group.topic} data-topic={group.topic}>
        {card(group.subs[0])}
      </div>
    ) : (
      <div className="home-topic" key={group.topic} data-topic={group.topic}>
        {group.parent ? (
          card(group.parent)
        ) : (
          // The topic's key as Agents write it, beside the name it is shown by.
          <Tip content={<TipText value={group.topic} />} align="start">
            <h3 className="home-topic-name">
              {topicName(group.topic)}
            </h3>
          </Tip>
        )}
        {group.subs.length > 0 && (
          <div className="home-subs">{group.subs.map((sub) => card(sub, topicName(group.topic)))}</div>
        )}
      </div>
    );
  const viewChanges = (request: PendingRequest) => () =>
    needs?.onNavigate({
      kind: "changes",
      agentId: request.agentId,
      requestId: request.id,
      turnId: typeof request.params.turnId === "string" ? request.params.turnId : undefined,
      itemId: typeof request.params.itemId === "string" ? request.params.itemId : undefined,
    });
  if (!grouped || !groupedDeck) {
    return (
      <div ref={deckRef} className={`home-brief${capped ? " is-capped" : ""}`}>
        {groups.length === 0 ? (
          <p className="home-note home-brief-empty">{t.noContent}</p>
        ) : (
          <>
            {deckMain.map(topicBlock)}
            {deckReplied.length > 0 && (
              <>
                <h3 className="home-deck-heading">{t.repliedGroup(repliedCount)}</h3>
                {deckReplied.map(topicBlock)}
              </>
            )}
            {deckStale.length > 0 && (
              // Closed at each visit; a jump to a card in it opens it (card-fold.tsx unfoldAround).
              <details className="home-out-of-date">
                <summary>{t.outOfDate(staleStatus.length, newestStale ? absolute(newestStale, time) : "")}</summary>
                <div ref={staleRef} className="home-brief-sub">
                  {deckStale.map(topicBlock)}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    );
  }
  const pending = needs?.pending ?? [];
  const executors = needs?.executors ?? [];
  const needsCount = groupedDeck.counts.needs + pending.length + executors.length;
  const doingCount = groupedDeck.counts.doing + groupedDeck.counts.replied;
  const done = members(groupedDeck.done);
  const newestDone = done.map((s) => s.updatedAt).sort().at(-1);
  const history = panel.brief.history;
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
            {groupedDeck.done.map(topicBlock)}
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
  arrival = null,
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
  /** Where a reply's "Open on Home" landed in this project (T-9): the note
   * in the card it answered, or above the cards when that card is gone. */
  arrival?: { key: string; inCard: boolean; note: ReactNode } | null;
}) {
  const language = useLanguage();
  const t = homeText(language);
  const id = panel.project.id;
  const [choice, setChoice] = useState(() => readPanelChoice(workspaceId, id));
  const [more, setMore] = useState(false);
  // A jump from the needs-you row shows the panel whole, in the same render,
  // until the user expands, collapses or caps it again by hand.
  const [handled, setHandled] = useState({ collapse: 0, cap: 0 });
  const [seeingAll, setSeeingAll] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setChoice(readPanelChoice(workspaceId, id)), [workspaceId, id]);
  // Core's count of what changed since the user last read it, less the Asks they answered that their owner has
  // not changed since (unseen.ts, shared with a Project's page).
  const unseen = projectUnseen(panel);
  // Whether a panel starts folded is decided as before, by what the user has not marked seen: a report opened
  // elsewhere, or here from a link or a widget, never folds its project (YN-86).
  const quiet = panel.brief.sections.filter(changedSinceSeen).length === 0 && needsYou.length === 0 && panel.pending.length === 0;
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
  // Live sections, shown or kept out of view, and the History entries a
  // reply may still refer to (T-174).
  const live = useMemo(() => [...sections, ...(panel.brief.teamSections ?? [])], [sections, panel.brief.teamSections]);
  const referable = useMemo(
    () => referableHistory(panel.brief.history, live.map((s) => s.key)),
    [panel.brief.history, live],
  );
  const seen = useCallback((marks: SeenMark[]) => onSeen(id, marks), [onSeen, id]);
  // A card the team wrote, kept out of the deck: its whole body, or its summary, as the deck shows it.
  const teamCard = (section: Section) => section.kind === "ask" ? (
    <SectionCard
      key={section.key}
      section={section}
      projectId={id}
      workspaceId={workspaceId}
      agents={agents}
      readOnly={readOnly}
      onSeen={seen}
      onChanged={onChanged}
      notice={arrival?.inCard && arrival.key === section.key ? arrival.note : undefined}
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
      onSeen={seen}
      notice={arrival?.inCard && arrival.key === section.key ? arrival.note : undefined}
    />
  );
  const uncapped = more || (reveal > 0 && reveal !== handled.cap);
  const capped = rank >= FULL_RANKS && !uncapped;
  const toggleMore = () => {
    if (uncapped) {
      setMore(false);
      setHandled((h) => ({ ...h, cap: reveal }));
    } else setMore(true);
  };
  // Whether the capped deck hides anything (ProjectDeck measures its own deck).
  const [overflowing, setOverflowing] = useState(false);
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
          {unseen > 0 && <span className="home-chip is-new">{t.newCount(unseen)}</span>}
          {needsYou.length > 0 && <span className="home-chip is-attention">{t.needCount(needsYou.length)}</span>}
          {collapsed && quiet && <span className="home-quiet">{t.quiet}</span>}
        </span>
        {reorder && (
          // Unavailable while the order saves, or at the end it would move past, an arrow says so but stays
          // focusable, so the one just pressed keeps the focus (T-19 HM:H7).
          <span className="home-reorder" role="group" aria-label={t.move(panel.project.name)}>
            <button
              type="button"
              className="icon-button"
              data-move="up"
              aria-label={t.moveUp(panel.project.name)}
              aria-disabled={!reorder.onUp || reorder.busy || undefined}
              onClick={() => { if (!reorder.busy) reorder.onUp?.(); }}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="icon-button"
              data-move="down"
              aria-label={t.moveDown(panel.project.name)}
              aria-disabled={!reorder.onDown || reorder.busy || undefined}
              onClick={() => { if (!reorder.busy) reorder.onDown?.(); }}
            >
              <ArrowDown size={14} />
            </button>
          </span>
        )}
      </header>
      {!collapsed && (
        <div className="home-panel-content" id={`${projectDomId(id)}-content`}>
          {arrival && !arrival.inCard && arrival.note}
          <div className="home-widgets">
            {panel.pending.length > 0 && (
              <Approvals projectId={id} count={panel.pending.length}>
                {panel.pending.map((request) => (
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
              </Approvals>
            )}
            <RepoBlock projectId={id} readOnly={readOnly} onManage={() => onNavigate({ kind: "projectSettings", projectId: id })} />
          </div>
          <ProjectDeck
            panel={panel}
            workspaceId={workspaceId}
            agents={agents}
            readOnly={readOnly}
            onSeen={onSeen}
            onChanged={onChanged}
            arrival={arrival}
            capped={capped}
            onOverflow={setOverflowing}
          />
          {rank >= FULL_RANKS && (uncapped || overflowing) && (
            <button type="button" className="quiet-button home-more" onClick={toggleMore}>
              {uncapped ? t.showLess : t.showMore}
            </button>
          )}
          {!readOnly && (
            <KeptCardReplies
              projectId={id}
              workspaceId={workspaceId}
              agents={agents}
              cardKeys={live.filter((s) => s.kind !== "ask").map((s) => s.key)}
              referable={referable}
            />
          )}
          <footer className="home-panel-foot">
            {changed > 0 && !readOnly && (
              <button type="button" className="secondary-button" disabled={seeingAll} onClick={() => void seenAll()}>
                {seeingAll ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
                {t.seenAll}
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
            <summary>{t.teamDetails}</summary>
            <ProjectFacts panel={panel} onNavigate={onNavigate} />
            {(panel.brief.teamSections?.length ?? 0) > 0 && <div className="home-team-content">
              <p className="home-note">{t.teamNote}</p>
              {panel.brief.teamSections?.map(teamCard)}
            </div>}
            <History30
              sections={panel.brief.history}
              projectId={id}
              reply={readOnly ? undefined : { workspaceId, agents, referable }}
            />
          </details>
        </div>
      )}
    </section>
  );
}
