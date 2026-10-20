import { RequestSummary } from "./MessageContent";
import { Bell } from "lucide-react";
import { Avatar } from "./components";
import { MachineBadge } from "./RemoteControls";
import type { Agent, WorkSummary } from "./types";
import { useAgentJobs } from "./live-jobs";
import { useAgentCI, waitingSummary } from "./live-ci";
import "./reading.css";

export function workingFolder(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd;
}

export function summaryOrigin(summary: WorkSummary): string {
  return summary.source === "agent"
    ? "Agent report · open original message"
    : summary.source === "user"
      ? "Your task · open original message"
      : summary.kind === "pending"
        ? "Open the request that needs your response"
        : "Runtime record · open source";
}

export function AgentRailRow({
  agent,
  selected,
  statusLabel,
  idle = false,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  statusLabel: string;
  /** Only an Agent shown as plainly idle can show its unfinished Job/CI work; any
   * other state (working, waiting for you, compacting, closed…) comes first. */
  idle?: boolean;
  onSelect: () => void;
}) {
  const summary = agent.workSummary;
  const machine = agent.remote?.machine.name || "Core host";
  const jobs = useAgentJobs(agent.id);
  const ci = useAgentCI(agent.id);
  const waiting = idle ? waitingSummary(jobs, ci) : null;
  const label = waiting?.label ?? statusLabel;
  // Two waits or checks at once ("Waiting · Job / CI") take their own line
  // under the name; one ("Waiting · CI") fits beside it like any status.
  const combined = !!waiting && (label.includes("/") || label.split(" · ").length > 2);
  return (
    <article
      className={`agent-row${selected ? " selected" : ""}`}
      data-agent-id={agent.id}
    >
      <button
        className="agent-select agent-row-top"
        onClick={onSelect}
        aria-label={`Open ${agent.name}`}
        aria-description={`${label}${waiting ? ` (${waiting.detail})` : ""}, on ${machine}${agent.unreadCount > 0 ? `, ${agent.unreadCount} unread updates` : ""}`}
        aria-current={selected ? "true" : undefined}
        title={`${agent.name} · ${label}${waiting ? ` · ${waiting.detail}` : ""}${agent.unreadCount > 0 ? ` · ${agent.unreadCount} unread updates` : ""}`}
      >
        {/* Unread updates ring the avatar, never a dot: dots beside the
            status say what the Agent is doing. */}
        <span
          className={`agent-rail-avatar${agent.unreadCount > 0 ? " has-unread" : ""}`}
        >
          <Avatar agent={agent} />
        </span>
        {/* The machine heads the name, beside the avatar. */}
        <span className="agent-identity">
          <MachineBadge agent={agent} />
          <span className="agent-name">{agent.name}</span>
        </span>
        <span
          className={`agent-runtime runtime-${agent.status}`}
          data-jobs={waiting ? jobs?.active : undefined}
          data-ci={
            waiting && ci
              ? ci.running + ci.discovering + (ci.waitingForRun ?? 0) + ci.check
              : undefined
          }
          data-combined={combined || undefined}
        >
          <span className={`status-dot ${agent.status}`} aria-hidden="true" />
          {label}
        </span>
      </button>
      {/* The whole card opens the agent; nothing inside is a separate link. */}
      {summary && (
        <div
          className={`agent-work-summary kind-${summary.kind}`}
          data-source-kind={summary.kind}
          title={summary.requestParts ? undefined : summary.text}
        >
          {summary.source === "agent" && (
            <span className="agent-report-prefix">
              {summary.kind === "result" ? "Reported · " : "Update · "}
            </span>
          )}
          <RequestSummary agentId={agent.id} summary={summary} />
        </div>
      )}
      {agent.pendingCount > 0 && (
        <div className="agent-row-bottom">
          <span className="needs-you">
            <Bell size={10} />
            {agent.pendingCount} needs you
          </span>
        </div>
      )}
    </article>
  );
}
