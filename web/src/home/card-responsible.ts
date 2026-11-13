import { createContext } from "react";
import type { ExecutorLifecycle, ExecutorState } from "../executor-lifecycle";
import { executorView, type ExecutorShown } from "../executor-display";
import { stateText } from "../ExecutorRowState";
import type { Language } from "../i18n";
import { shellText } from "../shell-text";
import type { Agent } from "../types";
import type { CardBinding, Section } from "./types";

/**
 * Who answers for a card bound to a task (YN-86 §3.2–3.4), as its foot
 * shows them: Core's `card.responsible` (the task's newest executor not yet
 * released, else its assignee), with that Agent's state in the rail's own
 * words. Pure; the words are the rail's (ExecutorRowState.tsx for an
 * executor, the Agent list's status words for any other Agent).
 */

/** Every Agent of the Workspace by id, closed and archived ones too, as the Agent list reads them: what a card's
 * responsible Agent is shown with, and where an archived card finds the executor that did its task (Home.tsx). */
export const CardAgents = createContext<ReadonlyMap<string, Agent>>(new Map());

/** A card's task is over for it: done, cancelled or archived (Core's cards.rs `ended`). */
export const taskEnded = (card: CardBinding | null | undefined) =>
  !!card && (card.task.archived || card.task.status === "done" || card.task.status === "cancelled");

/** Whether a card's task goes on or is over, for its group on a Project's page (project-deck.ts); null unbound. */
export const cardTask = (card: CardBinding | null | undefined): "open" | "ended" | null =>
  !card ? null : taskEnded(card) ? "ended" : "open";

export type ShownResponsible = {
  agentId: string;
  name: string;
  kind: "executor" | "lead" | "agent";
  /** The rail's words for its state now. */
  state: string;
  /** Its dot, as status-dot classes have it: working, waiting, error, offline; "" at rest. */
  dot: string;
  /** Not Core's responsible Agent: the executor that did the task of a card whose task is over, released since. */
  former: boolean;
};

const SHOWN_DOT: Record<ExecutorShown, string> = {
  working: "working",
  needsYou: "waiting",
  failed: "error",
  stopped: "offline",
  queued: "",
  review: "",
  done: "",
};

/** The newest executor of a task, by its dispatch, among the Workspace's Agents. */
function executorOf(task: string, agents: ReadonlyMap<string, Agent>): Agent | null {
  let found: Agent | null = null;
  for (const agent of agents.values()) {
    if (agent.kind !== "executor" || agent.executor?.task?.id !== task) continue;
    const at = (a: Agent) => a.executor?.dispatchedAt ?? a.createdAt ?? "";
    if (!found || at(agent) > at(found)) found = agent;
  }
  return found;
}

/**
 * The card's responsible Agent as its foot shows it, or null for "No one yet".
 *
 * Once its task is over, Core no longer counts the released executor
 * (cards.rs), yet the card shows who did it and opens that session to read
 * (§3.4): with no executor from Core, the task's newest executor in the
 * Agent list stands in, archived.
 */
export function shownResponsible(card: CardBinding, agents: ReadonlyMap<string, Agent>, language: Language): ShownResponsible | null {
  let who = card.responsible;
  let former = false;
  if (taskEnded(card) && who?.kind !== "executor") {
    const executor = executorOf(card.task.id, agents);
    if (executor) {
      who = { agentId: executor.id, name: executor.name, kind: "executor", state: executor.executor?.state ?? "archived" };
      former = true;
    }
  }
  if (!who) return null;
  const agent = agents.get(who.agentId) ?? null;
  const name = agent?.name || who.name;
  if (who.kind === "executor") {
    // The rail's row for an executor (AgentRailRow.tsx): its one state from its runtime and lifecycle, with what
    // it is at. Without its Agent in the list, Core's lifecycle state alone.
    const lifecycle: ExecutorLifecycle = agent?.executor ?? { state: who.state as ExecutorState, agentId: who.agentId };
    const facts = agent ?? { status: "idle" as const, pendingCount: 0, closedAt: undefined, disconnectedAt: undefined };
    const view = executorView({ agent: facts, lifecycle });
    return { agentId: who.agentId, name, kind: who.kind, state: stateText(view, language), dot: SHOWN_DOT[view.shown], former };
  }
  // Any other Agent, as the Agent list says its status: closed, or its runtime's state.
  const shell = shellText(language);
  const closed = agent ? !!agent.closedAt : who.state === "closed";
  const status = (agent?.status ?? who.state) as Agent["status"];
  return {
    agentId: who.agentId,
    name,
    kind: who.kind,
    state: closed ? shell.closed : shell.status[status] ?? who.state,
    dot: closed ? "offline" : status,
    former,
  };
}

/**
 * Whom a reply to a card or an Ask on it goes to by default (YN-86 §3.3):
 * whoever answers for the card, while they are open in the Project; else its
 * author, while open there; else nobody yet (the user picks). `agents` are
 * the Project's open Agents. The card's Reply and its tip say the same one.
 */
export function replyRecipient(section: Section, agents: readonly Agent[]): string {
  const responsible = section.card?.responsible?.agentId;
  if (responsible && agents.some((agent) => agent.id === responsible)) return responsible;
  const owner = section.owner;
  return owner.state === "active" && agents.some((agent) => agent.id === owner.agentId) ? owner.agentId : "";
}
