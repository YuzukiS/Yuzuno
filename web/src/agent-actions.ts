import { strings, type Language } from "./i18n";
import { nativeSession } from "./machine-checks";
import type { Agent } from "./types";

/** What an Agent's action menu can offer (T-184), in its order. */
export type AgentMenuAction = "reconnect" | "check" | "endMissing" | "interrupt" | "disconnect" | "settings" | "copyLink" | "manage";

// The menu's entries in the interface language (T-189).
const labels = strings({
  check: "Reconnect and check",
  reconnect: "Reconnect",
  reconnecting: "Reconnecting…",
  endMissing: "End unconfirmed turn…",
  interrupt: "Interrupt current turn",
  disconnect: "Disconnect…",
  settings: "Agent settings…",
  copyLink: "Copy agent link",
  manage: "Manage…",
}, {
  check: "重新连接并核对",
  reconnect: "重新连接",
  reconnecting: "正在重新连接…",
  endMissing: "结束未确认的 Turn…",
  interrupt: "中断当前 Turn",
  disconnect: "断开连接…",
  settings: "Agent 设置…",
  copyLink: "复制 Agent 链接",
  manage: "管理…",
});
/** An entry's label in `language`: a reconnect already under way says so. */
export function agentMenuLabel(action: AgentMenuAction, disabled = false, language: Language = "en"): string {
  const t = labels(language);
  return action === "reconnect" && disabled ? t.reconnecting : t[action];
}

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
  /** Opens the confirmation that ends Turns missing from the native history
   * (T-198); offered only where a check found them. */
  endMissing?: (id: string) => void;
  /** Opens the confirmation that disconnects the Agent (T-184). */
  disconnect?: (id: string) => void;
  /** Copies a link to the Agent itself (T-184), where links are offered. */
  copyLink?: (id: string) => void;
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

/** Whether to offer Disconnect (T-184): a connected local Codex or Claude
 * Agent that is idle. Core checks the rest (requests, background work,
 * the native runtime) and refuses, saying why, when it can't confirm it. */
export function disconnectable(agent: Agent): boolean {
  return (
    !agent.closedAt &&
    !agent.disconnectedAt &&
    (agent.harness === "claude" || agent.harness === "codex") &&
    agent.connectionState === "connected" &&
    agent.status === "idle"
  );
}

/** Whether the Agent has a turn running to interrupt. */
export function interruptible(agent: Agent): boolean {
  return !agent.closedAt && (agent.status === "working" || agent.status === "waiting");
}

/** The menu for `agent` as it is now: few entries, only those that apply.
 * Opening the Agent is its row's own click, not an entry. */
export function agentMenuItems(
  agent: Agent,
  {
    missingTurns = false,
    disconnect = false,
    link = false,
  }: { missingTurns?: boolean; disconnect?: boolean; link?: boolean } = {},
): AgentMenuItem[] {
  const items: AgentMenuItem[] = [];
  const reconnect = reconnectOffer(agent);
  const entry = (action: AgentMenuAction, disabled?: boolean): AgentMenuItem => ({
    action,
    label: agentMenuLabel(action, disabled),
    ...(disabled ? { disabled } : {}),
  });
  if (reconnect === "check") items.push(entry("check"));
  else if (reconnect === "reconnect") items.push(entry("reconnect"));
  else if (reconnect === "connecting") items.push(entry("reconnect", true));
  if (missingTurns && !agent.closedAt && agent.connectionState !== "connected")
    items.push(entry("endMissing"));
  if (interruptible(agent)) items.push(entry("interrupt"));
  if (disconnect && disconnectable(agent)) items.push(entry("disconnect"));
  if (!agent.closedAt) items.push(entry("settings"));
  // Any Agent can be linked, a closed one or one with no Turn yet.
  if (link) items.push(entry("copyLink"));
  items.push(entry("manage"));
  return items;
}
