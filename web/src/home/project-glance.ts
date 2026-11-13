import { groupSections, unreadChange } from "./brief-layout.ts";
import { cardContent } from "./card-preview.ts";
import { deckPlace } from "./deck-order.ts";
import { deckGroup, groupDeck } from "./project-deck.ts";
import { projectUnseen } from "./unseen.ts";
import type { NeedsYouItem, ProjectPanel, Section } from "./types";

/** The executors' states a glance counts, as the rail's executor group counts them (ExecutorRail.tsx). */
type ExecutorLike = { executor?: { state?: string } | null };
/** Whether a card's task goes on or is over, as a Project's page groups it (card-responsible.ts `cardTask`). */
type TaskOf = (section: Section) => "open" | "ended" | null;

/**
 * One project at a glance on the whole of Home (YN-86 §2.1): every value is
 * read from Home's read of Core and the Workspace's Agents, never written by
 * an Agent for it and never kept here.
 */
export type Glance = {
  /** Core's Needs you for this project: open Asks, approvals, questions and the executors the user dispatched. */
  needs: number;
  /** The cards the user has not read, as the project's page counts them (unseen.ts). */
  unseen: number;
  /**
   * What the project says now: the newest current status a lead wrote (its
   * card's lead), else the latest report's title, else none.
   */
  line: { kind: "status"; section: Section; text: string | null } | { kind: "report"; section: Section } | null;
  facts: {
    /** Cards the project's page puts in In progress, the Asks waiting on their owners among them. */
    doing: number;
    running: number;
    queued: number;
    /** The project's Jobs running now (Core's live Jobs whose status is running). */
    jobs: number;
    errors: number;
  };
  /** Up to two cards that changed last, newest first, each with whether the user has not read that version. */
  recent: { section: Section; unread: boolean }[];
  /** When a card of the project last changed, or null with none. */
  updatedAt: string | null;
  /** Nothing needs the user, nothing is new to them, no executor or Job is at work. */
  quiet: boolean;
};

/** How many recent cards a glance names. */
export const GLANCE_RECENT = 2;

const time = (at: string) => {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : -Infinity;
};
const newestFirst = (a: Section, b: Section) => time(b.updatedAt) - time(a.updatedAt);

/**
 * A project's glance from its panel in Home's read, Core's Needs you for it
 * and its open Agents. The counts are the ones a project's panel showed
 * (Core's Needs you for the project, projectUnseen) and its page shows; its
 * cards in progress are grouped as the page groups them, a card bound to a
 * task by its task (`taskOf`).
 */
export function projectGlance(
  panel: ProjectPanel,
  needsYou: readonly NeedsYouItem[],
  agents: readonly ExecutorLike[],
  taskOf: TaskOf = () => null,
  now = Date.now(),
): Glance {
  const sections = panel.brief.sections;
  const needs = needsYou.filter((item) => item.projectId === panel.project.id).length;
  const unseen = projectUnseen(panel);
  // Core keeps cards from members who don't edit Home in teamSections; a lead's are these, or any when the
  // project names no leads (contentEditors absent, or every member may edit).
  const editors = panel.contentEditors?.editorAgentIds ?? null;
  const byLead = (section: Section) => !editors || editors.includes(section.owner.agentId);
  const status = sections
    .filter((section) => section.kind === "status" && !section.history && !section.status?.stale && byLead(section))
    .sort(newestFirst)[0];
  const report = sections.filter((section) => section.kind === "report" && !section.history).sort(newestFirst)[0];
  const line: Glance["line"] = status
    ? { kind: "status", section: status, text: cardContent(status).lead }
    : report
      ? { kind: "report", section: report }
      : null;
  const places = new Map(sections.map((section) => [section.key, deckPlace(section, now)] as const));
  const placeOf = (section: Section) => places.get(section.key) ?? deckPlace(section, now);
  const deck = groupDeck(groupSections(sections), (section) => deckGroup(placeOf(section), unreadChange(section), taskOf(section)), placeOf);
  const states = agents.map((agent) => agent.executor?.state);
  const running = states.filter((state) => state === "running" || state === "delivering").length;
  const queued = states.filter((state) => state === "queued" || state === "starting").length;
  const jobs = panel.jobs.filter((job) => job.status === "running").length;
  const recentCards = sections.filter((section) => !section.history).sort(newestFirst);
  const recent = recentCards.slice(0, GLANCE_RECENT).map((section) => ({ section, unread: unreadChange(section) }));
  return {
    needs,
    unseen,
    line,
    facts: { doing: deck.counts.doing + deck.counts.replied, running, queued, jobs, errors: panel.errors.length },
    recent,
    updatedAt: recentCards[0]?.updatedAt ?? null,
    quiet: needs === 0 && unseen === 0 && running === 0 && queued === 0 && panel.jobs.length === 0,
  };
}
