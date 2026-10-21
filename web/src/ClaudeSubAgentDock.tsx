import { useMemo } from "react";
import { ClaudeAwayFromTurn, ClaudeSubAgentDetail, ClaudeSubAgentScope } from "./ClaudeControls";
import { StopTaskButton } from "./ClaudeBackgroundTasks";
import { claudeSubAgents, type ClaudeSubAgentEntry } from "./claude-subagents";
import { SubAgentDock, type DockSubAgent } from "./SubAgents";
import type { Agent, NativeItem, NativeTurn, RunningSubAgent } from "./types";
import { useAppearance } from "./appearance";

/** A few words under a Claude sub-agent's name on the dock. */
const dockSub: Record<ClaudeSubAgentEntry["status"], string> = {
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  unknown: "Unconfirmed",
};

const NONE: readonly DockSubAgent[] = [];

/**
 * Claude's sub-agents as the dock shows them: those an Agent call of the
 * loaded Turns started. A nested one opens within its parent's card, unless
 * its parent's call is outside the loaded window (Core pages a Turn's Items).
 * The card shows what Claude reported, already in the Turn, and its own calls.
 */
export function claudeDockEntries(agentId: string, turns: readonly NativeTurn[], live: boolean): DockSubAgent[] {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const all = claudeSubAgents(turns, live);
  const loaded = new Set(all.map((entry) => `${entry.turnId}\n${entry.key}`));
  return all
    .filter((entry) => !entry.parentKey || !loaded.has(`${entry.turnId}\n${entry.parentKey}`))
    .map((entry) => ({
      key: entry.key,
      turnId: entry.turnId,
      label: entry.label,
      // An outcome not confirmed is the dock's neutral "unconfirmed" node, as
      // a Codex child's is; the dock's "unknown" is a run that went missing.
      status: entry.status === "unknown" ? "unconfirmed" : entry.status,
      state: entry.state,
      sub: entry.status === "running" && entry.record?.background ? "Background" : dockSub[entry.status],
      detail: entry.sub || undefined,
      // Not yet known to have ended: still running, or its end unconfirmed.
      waiting: entry.status === "running" || entry.status === "unknown",
      details: (onNavigate) => {
        const turn = byId.get(entry.turnId);
        const detail = <ClaudeSubAgentDetail agentId={agentId} entry={entry} live={live} onNavigate={onNavigate} />;
        // Laid out as the card's Codex details are (SubAgents.tsx). Its calls
        // are shown away from their Turn: no anchors a source link could find.
        return <div key={entry.key} className="subagent-detail">
          {/* A sub-agent in the background is one of Claude's tasks: it can be stopped on its own. */}
          {entry.record?.background && entry.status === "running" && (
            <StopTaskButton agentId={agentId} record={entry.record} live={live} label={entry.label} />
          )}
          <ClaudeAwayFromTurn>
            {turn ? <ClaudeSubAgentScope agentId={agentId} turn={turn} live={live}>{detail}</ClaudeSubAgentScope> : detail}
          </ClaudeAwayFromTurn>
        </div>;
      },
    }));
}

/**
 * The loaded Turns with the calls of Claude sub-agents still running that
 * Core lists from outside the window, each in its place: one in the
 * background outlives the Items after its call, and the window holds the
 * newest of those only. A call loaded already (an earlier page joined) is
 * kept as loaded. A Turn none of whose Items is loaded is a shell of its id.
 */
export function withRunningSubAgents(turns: readonly NativeTurn[], running: readonly RunningSubAgent[] | undefined): readonly NativeTurn[] {
  const loaded = new Set(turns.flatMap((turn) => turn.items.map((item) => `${turn.id}\n${item.id}`)));
  const listed = (running ?? []).filter((entry) => !loaded.has(`${entry.turnId}\n${entry.item.id}`));
  if (!listed.length) return turns;
  // Every Item at its position in the record: its Turn's, then its own.
  const rows = [
    ...turns.flatMap((turn, n) => turn.items.map((item, k) =>
      ({ turn: turn._yuzunoSlice?.index ?? n, at: (turn._yuzunoSlice?.start ?? 0) + k, turnId: turn.id, item }))),
    ...listed.map(({ turnId, position: [turn, at], item }) => ({ turn, at, turnId, item })),
  ].sort((a, b) => a.turn - b.turn || a.at - b.at);
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const out: NativeTurn[] = [];
  let items: NativeItem[] = [];
  rows.forEach((row, n) => {
    if (n === 0 || rows[n - 1].turnId !== row.turnId) {
      items = [];
      // Not loaded: its status is not known here, and the dock does not read it.
      out.push({ ...(byId.get(row.turnId) ?? { id: row.turnId, status: "" }), items });
    }
    items.push(row.item);
  });
  return out;
}

/**
 * The conversation's sub-agents on the dock: Codex's from its Turns
 * (SubAgentDock), and a Claude Agent's from its Agent calls, as entries.
 * `running`: those Core lists from outside the loaded window.
 */
export function ConversationSubAgentDock({ agent, turns, running, onNavigate }: {
  agent: Agent;
  turns: readonly NativeTurn[];
  running?: readonly RunningSubAgent[];
  onNavigate: (turnId: string) => void;
}) {
  const live = agent.connectionState === "connected";
  const entries = useMemo(
    () => (agent.harness === "claude" ? claudeDockEntries(agent.id, withRunningSubAgents(turns, running), live) : NONE),
    [agent.id, agent.harness, turns, running, live],
  );
  // As many as Settings allows (Appearance, Conversation dock).
  const { dock } = useAppearance();
  return <SubAgentDock agentId={agent.id} turns={turns} entries={entries} onNavigate={onNavigate} limit={dock.subAgents} />;
}
