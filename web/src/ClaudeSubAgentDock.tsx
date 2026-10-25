import { useMemo } from "react";
import { ClaudeAwayFromTurn, ClaudeSubAgentDetail, ClaudeSubAgentScope } from "./ClaudeControls";
import { StopTaskButton } from "./ClaudeBackgroundTasks";
import { claudeSubAgents } from "./claude-subagents";
import { SubAgentDock, type DockSubAgent } from "./SubAgentPanels";
import type { Agent, NativeTurn, RunningSubAgent } from "./types";
import { withRunningCalls } from "./running-calls";
import { useAppearance } from "./appearance";
import { useLanguage, type Language } from "./i18n";
import { cardWords } from "./subagent-text";

const NONE: readonly DockSubAgent[] = [];

/**
 * Claude's sub-agents as the dock shows them: those an Agent call of the
 * loaded Turns started. A nested one opens within its parent's card, unless
 * its parent's call is outside the loaded window (Core pages a Turn's Items).
 * The card shows what Claude reported, already in the Turn, and its own calls.
 */
export function claudeDockEntries(agentId: string, turns: readonly NativeTurn[], live: boolean, language: Language = "en"): DockSubAgent[] {
  // A few words under a Claude sub-agent's name on the dock.
  const t = cardWords(language);
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const all = claudeSubAgents(turns, live, language);
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
      sub: entry.status === "running" && entry.record?.background ? t.background : t.claudeSub[entry.status],
      detail: entry.sub || undefined,
      // Not yet known to have ended: still running, or its end unconfirmed.
      waiting: entry.status === "running" || entry.status === "unknown",
      details: (onNavigate) => {
        const turn = byId.get(entry.turnId);
        const detail = <ClaudeSubAgentDetail agentId={agentId} entry={entry} live={live} onNavigate={onNavigate} />;
        // Laid out as the card's Codex details are (SubAgentPanels.tsx). Its calls
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
  const language = useLanguage();
  const entries = useMemo(
    () => (agent.harness === "claude" ? claudeDockEntries(agent.id, withRunningCalls(turns, running), live, language) : NONE),
    [agent.id, agent.harness, turns, running, live, language],
  );
  // As many as Settings allows (Appearance, Conversation dock).
  const { dock } = useAppearance();
  return <SubAgentDock agentId={agent.id} turns={turns} entries={entries} onNavigate={onNavigate} limit={dock.subAgents} />;
}
