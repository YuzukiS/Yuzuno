import { useLayoutEffect, useMemo, useRef } from "react";
import { BadgeCheck, Bell, CircleAlert, MessageCircleQuestionMark, MessagesSquare, OctagonPause, ShieldCheck } from "lucide-react";
import { PendingCard } from "../components";
import { useLanguage } from "../i18n";
import { projectColour } from "../project-groups";
import { useTimeDisplay } from "../time-preferences";
import type { Agent, PendingRequest } from "../types";
import { requestDomId } from "./brief-layout";
import { absolute, relative } from "./format";
import type { SeenMark } from "./home-api";
import type { HomeTarget } from "./home-navigation";
import { SectionCard } from "./SectionCard";
import type { HomeData, NeedsYouItem, Section } from "./types";
import { FoldButton, useCardFold } from "./card-fold";
import { homeText } from "./home-text";
import { Tip, TipText } from "../Tip";

export const needsYouKey = (item: NeedsYouItem) =>
  item.kind === "approval"
    ? `approval:${item.requestId}`
    : item.kind === "question"
      ? `question:${item.agentId}:${item.turnId}:${item.itemId}`
      : item.kind === "executor"
          ? `executor:${item.agentId}:${item.state}`
          : `ask:${item.projectId}:${item.sectionKey}`;

/**
 * The keys Needs you shows, in order: Core's now, and, each where it stood,
 * the ones it showed earlier in this visit that `keep` still holds. A card
 * answered here stays where it was until the next visit, as the project's
 * page holds its cards (YN-86 §2.2), rather than going from under the reader.
 */
export function heldOrder(previous: readonly string[], now: readonly string[], keep: (key: string) => boolean): string[] {
  const current = new Set(now);
  const out: string[] = [];
  let next = 0;
  const flush = (to: number) => {
    for (; next < to; next++) if (!current.has(previous[next]) && keep(previous[next])) out.push(previous[next]);
  };
  for (const key of now) {
    const at = previous.indexOf(key, next);
    if (at >= 0) {
      flush(at);
      next = at + 1;
    }
    out.push(key);
  }
  flush(previous.length);
  return out;
}

type Shown =
  | { kind: "ask"; key: string; item: NeedsYouItem; projectId: string; section: Section }
  | { kind: "approval"; key: string; item: NeedsYouItem; projectId: string; request: PendingRequest & { agentName: string } }
  | { kind: "row"; key: string; item: NeedsYouItem };

/**
 * What waits for the user's decision across projects (YN-86 §2.1, the
 * user's A), in Core's order (Project Priority, then wait time): each open
 * Ask as its own card and each approval as its own request, answered here,
 * named by its project; the same section its project's page shows, never a
 * copy. A question is answered in its conversation and an executor's matter
 * in its session, so each stays a row that goes there. An Ask answered here
 * keeps its card in its place until the next visit. Only what waits for the
 * user (YN-3): a Turn that ended unseen, a CI run or a Job that finished, is
 * its Agent's to follow, marked on the Agent list (unseenEnd), not here.
 */
export function NeedsYou({
  items,
  data,
  workspaceId,
  visit,
  agentsOf,
  readOnly,
  projectName,
  onJump,
  onSeen,
  onChanged,
  onNavigate,
}: {
  items: NeedsYouItem[];
  /** Home's read: where each Ask's section and each approval's request is. */
  data: HomeData;
  workspaceId: string;
  /** Each explicit way to Home: a card held for the visit goes at the next. */
  visit: number;
  /** A project's open Agents, the ones a reply can go to. */
  agentsOf: (projectId: string) => Agent[];
  readOnly: boolean;
  projectName: (id: string | null) => string;
  /** A row's way to where it is answered. */
  onJump: (item: NeedsYouItem) => void;
  onSeen: (projectId: string, marks: SeenMark[]) => Promise<void>;
  onChanged: () => void;
  onNavigate: (target: HomeTarget) => void;
}) {
  const time = useTimeDisplay();
  const language = useLanguage();
  const t = homeText(language);
  // Collapsed, the count still shows (T-115); nothing is answered by it.
  const [collapsed, toggleFold] = useCardFold("needs-you");
  // Each project's Seen, the same function from read to read, so its cards are not drawn again for nothing.
  const seenOf = useMemo(() => {
    const made = new Map<string, (marks: SeenMark[]) => Promise<void>>();
    return (projectId: string) => {
      let seen = made.get(projectId);
      if (!seen) made.set(projectId, (seen = (marks) => onSeen(projectId, marks)));
      return seen;
    };
  }, [onSeen]);
  const panelOf = (projectId: string | null) => (projectId ? data.projects.find((panel) => panel.project.id === projectId) : undefined);
  const askOf = (item: NeedsYouItem) =>
    item.kind === "ask" && item.sectionKey ? panelOf(item.projectId)?.brief.sections.find((s) => s.key === item.sectionKey && s.kind === "ask") : undefined;
  // What this visit has shown, so a card answered here keeps its place until the next visit.
  const visitKey = `${workspaceId}\n${visit}`;
  const held = useRef<{ visit: string; order: string[]; items: Map<string, NeedsYouItem> }>({ visit: visitKey, order: [], items: new Map() });
  const before = held.current.visit === visitKey ? held.current : { visit: visitKey, order: [], items: new Map<string, NeedsYouItem>() };
  const byKey = new Map(items.map((item) => [needsYouKey(item), item] as const));
  const kept = (key: string) => {
    const item = before.items.get(key);
    return !!item && askOf(item)?.ask?.state === "replied";
  };
  const order = heldOrder(before.order, [...byKey.keys()], kept);
  const shown: Shown[] = order.map((key) => {
    const item = byKey.get(key) ?? before.items.get(key)!;
    const section = askOf(item);
    if (section && item.projectId) return { kind: "ask", key, item, projectId: item.projectId, section };
    const request = item.kind === "approval" ? panelOf(item.projectId)?.pending.find((r) => r.id === item.requestId) : undefined;
    if (request && item.projectId) return { kind: "approval", key, item, projectId: item.projectId, request };
    return { kind: "row", key, item };
  });
  useLayoutEffect(() => {
    held.current = { visit: visitKey, order, items: new Map(order.map((key) => [key, byKey.get(key) ?? before.items.get(key)!])) };
  });
  const cards = shown.filter((entry) => entry.kind !== "row");
  const rows = shown.filter((entry): entry is Extract<Shown, { kind: "row" }> => entry.kind === "row");
  const from = (entry: Exclude<Shown, { kind: "row" }>) => (
    <span className="home-needs-from">
      <span className="project-dot" style={{ background: projectColour(entry.projectId) }} aria-hidden />
      {projectName(entry.projectId)} · {entry.item.agentName}
    </span>
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
    <section className={`home-needs-you${collapsed ? " is-collapsed" : ""}`} aria-labelledby="home-needs-title">
      <h2 id="home-needs-title">
        <FoldButton collapsed={collapsed} onToggle={toggleFold} label={t.needsYou} controls="home-needs-you-body" />
        <Bell size={14} />
        {t.needsYou}
        <span className={`nav-count${items.length ? " attention" : ""}`}>{items.length}</span>
        {cards.length > 0 && <span className="home-needs-note">{t.needsAnswerHere}</span>}
      </h2>
      <div className="home-card-body" id="home-needs-you-body" hidden={collapsed}>
        {cards.length > 0 && (
          <div className="home-needs-cards">
            {cards.map((entry) =>
              entry.kind === "ask" ? (
                <div key={entry.key} className="home-needs-card" data-needs-you={entry.key} tabIndex={-1}>
                  {from(entry)}
                  <SectionCard
                    section={entry.section}
                    projectId={entry.projectId}
                    workspaceId={workspaceId}
                    agents={agentsOf(entry.projectId)}
                    readOnly={readOnly}
                    onSeen={seenOf(entry.projectId)}
                    onChanged={onChanged}
                  />
                </div>
              ) : (
                <div
                  key={entry.key}
                  className="home-needs-card home-approval"
                  id={requestDomId(entry.request.id)}
                  data-needs-you={entry.key}
                  tabIndex={-1}
                >
                  {from(entry)}
                  <PendingCard request={entry.request} refresh={onChanged} disabled={readOnly} onViewChanges={viewChanges(entry.request)} />
                </div>
              ),
            )}
          </div>
        )}
        {rows.length > 0 && (
          <ol className="home-needs-list">
            {rows.map(({ key, item }) => (
              <li key={key}>
                <Tip content={<TipText title={t.waitingSince(item.kind === "executor" ? [item.agentName, item.title, item.reason].filter(Boolean).join(" · ") : item.title, absolute(item.since, time))} />} size="wide">
                  <button
                    type="button"
                    className={`home-needs-item kind-${item.kind}`}
                    data-needs-you={key}
                    onClick={() => onJump(item)}
                  >
                    {item.kind === "approval" ? (
                      <ShieldCheck size={14} />
                    ) : item.kind === "question" ? (
                      <MessagesSquare size={14} />
                    ) : item.kind === "executor" ? (
                      item.state === "delivering" ? <BadgeCheck size={14} /> : item.state === "failed" ? <CircleAlert size={14} /> : <OctagonPause size={14} />
                    ) : (
                      <MessageCircleQuestionMark size={14} />
                    )}
                    <span className="home-needs-text">
                      {/* An executor you dispatched (T-36 S3): what it waits for,
                          then its task; its name repeats its task's number. */}
                      <span className="home-needs-source">
                        {projectName(item.projectId)} · {item.kind === "executor" && item.state ? t.executorNeeds[item.state] : item.agentName}
                      </span>
                      <strong>{item.kind === "executor" && item.taskId ? `${item.taskId} · ${item.title}` : item.title}</strong>
                      {/* Why (T-43 S4a): why its start failed, what blocks its task. */}
                      {item.kind === "executor" && item.reason && <span className="home-needs-reason">{item.reason}</span>}
                    </span>
                    <span className="home-needs-since">{relative(item.since, language)}</span>
                  </button>
                </Tip>
              </li>
            ))}
          </ol>
        )}
        {shown.length === 0 && <p className="home-needs-empty">{t.nothingNeedsYou}</p>}
      </div>
    </section>
  );
}
