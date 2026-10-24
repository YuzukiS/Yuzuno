import { nativeSession } from "./machine-checks";
import type { Agent } from "./types";

/** What an Agent's action menu can offer (T-184), in its order. */
export type AgentMenuAction = "reconnect" | "check" | "interrupt" | "settings" | "manage";

/** One entry of the menu: what it does and whether it can run now. */
export interface AgentMenuItem {
  action: AgentMenuAction;
  label: string;
  /** Shown but not runnable, for example while Core is already connecting. */
  disabled?: boolean;
}

/** What the menu's entries do, each for the Agent the menu was opened on. */
export interface AgentActionHandlers {
  reconnect: (id: string) => Promise<unknown>;
  interrupt: (id: string) => Promise<unknown>;
  settings: (id: string) => void;
  manage: (id: string) => void;
}

/**
 * How reconnecting is offered: "check" where the last result is unknown,
 * "reconnect" where the session is simply not connected, "connecting" while
 * Core already is. Null for a closed Agent (it reopens), one with no session
 * to reconnect to, or one that is connected. The same request either way
 * (`POST /agents/{id}/reconnect`): nothing is sent, and what the Agent is
 * doing afterwards is what Core reports.
 */
export function reconnectOffer(agent: Agent): "reconnect" | "check" | "connecting" | null {
  if (agent.closedAt) return null;
  if (!agent.remote && !nativeSession(agent)) return null;
  if (agent.connectionState === "connecting") return "connecting";
  if (agent.status === "uncertain" || agent.connectionState === "unconfirmed") return "check";
  if (agent.connectionState === "connected") return null;
  if (agent.connectionState === "disconnected" || agent.status === "offline") return "reconnect";
  return null;
}

/** Whether the Agent has a turn running to interrupt. */
export function interruptible(agent: Agent): boolean {
  return !agent.closedAt && (agent.status === "working" || agent.status === "waiting");
}

/** The menu for `agent` as it is now: few entries, only those that apply.
 * Opening the Agent is its row's own click, not an entry. */
export function agentMenuItems(agent: Agent): AgentMenuItem[] {
  const items: AgentMenuItem[] = [];
  const reconnect = reconnectOffer(agent);
  if (reconnect === "check") items.push({ action: "check", label: "Reconnect and check" });
  else if (reconnect === "reconnect") items.push({ action: "reconnect", label: "Reconnect" });
  else if (reconnect === "connecting") items.push({ action: "reconnect", label: "Reconnecting…", disabled: true });
  if (interruptible(agent)) items.push({ action: "interrupt", label: "Interrupt current turn" });
  if (!agent.closedAt && agent.harness !== "opencode") items.push({ action: "settings", label: "Agent settings…" });
  items.push({ action: "manage", label: "Manage…" });
  return items;
}
