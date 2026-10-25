import { useRef } from "react";
import { RequestSummary } from "./MessageContent";
import { Bell } from "lucide-react";
import type { AgentActionHandlers } from "./agent-actions";
import { AgentActionsMenu, type AgentActionsMenuHandle, type MenuPoint } from "./AgentActionsMenu";
import { Avatar } from "./components";
import { MachineBadge } from "./RemoteControls";
import type { Agent, WorkSummary } from "./types";
import { useAgentJobs } from "./live-jobs";
import { useAgentCI, waitingSummary } from "./live-ci";
import { useHandoffDrop } from "./SendToAgent";
import { strings, useLanguage, type Language } from "./i18n";
import "./reading.css";

export function workingFolder(cwd: string): string {
  return cwd.split(/[/\\]/).filter(Boolean).at(-1) || cwd;
}

/** Where a work summary came from, in `language` (T-189); English by default. */
export function summaryOrigin(summary: WorkSummary, language: Language = "en"): string {
  const zh = language === "zh-Hans";
  return summary.source === "agent"
    ? zh ? "Agent 报告 · 打开原始消息" : "Agent report · open original message"
    : summary.source === "user"
      ? zh ? "你的任务 · 打开原始消息" : "Your task · open original message"
      : summary.kind === "pending"
        ? zh ? "打开需要你回复的请求" : "Open the request that needs your response"
        : zh ? "运行记录 · 打开来源" : "Runtime record · open source";
}

// The row's own words (T-189); the Agent's and machine's names and what the
// Agent reported are shown as they came.
const text = strings({
  host: "Core host",
  open: (name: string) => `Open ${name}`,
  description: (label: string, detail: string | null, machine: string, unread: number) =>
    `${label}${detail ? ` (${detail})` : ""}, on ${machine}${unread > 0 ? `, ${unread} unread updates` : ""}`,
  title: (name: string, label: string, detail: string | null, unread: number) =>
    `${name} · ${label}${detail ? ` · ${detail}` : ""}${unread > 0 ? ` · ${unread} unread updates` : ""}`,
  reported: "Reported · ",
  update: "Update · ",
  drop: (name: string) => `Drop to add it to ${name}’s draft`,
  needsYou: (count: number) => `${count} needs you`,
}, {
  host: "Core 主机",
  open: (name) => `打开 ${name}`,
  description: (label, detail, machine, unread) =>
    `${label}${detail ? `（${detail}）` : ""}，位于 ${machine}${unread > 0 ? `，${unread} 条未读更新` : ""}`,
  title: (name, label, detail, unread) => `${name} · ${label}${detail ? ` · ${detail}` : ""}${unread > 0 ? ` · ${unread} 条未读更新` : ""}`,
  reported: "已报告 · ",
  update: "更新 · ",
  drop: (name) => `放下即可添加到 ${name} 的草稿`,
  needsYou: (count) => `${count} 项需要你`,
});

/** How long a touch is held before it opens the actions, and how far it may
 * move first: a scroll moves further, and the browser cancels the pointer. */
export const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** A touch held still opens `onPress` at that point; a move, a cancel or an
 * early lift does nothing. After a long-press (`fired`), the click that
 * follows is swallowed, so the row does not also open; any next press clears
 * it. `claim` takes a pending touch for the browser's own context menu, so
 * the menu opens once. */
function useLongPress(onPress: (point: MenuPoint) => void) {
  const timer = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    start.current = null;
  };
  return {
    fired,
    claim: () => {
      if (!start.current) return false;
      cancel();
      fired.current = true;
      return true;
    },
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        cancel();
        fired.current = false;
        // The open menu's own entries (its events reach the row through React).
        if ((event.target as Element).closest?.('[role="menu"]')) return;
        if (event.pointerType !== "touch" || !event.isPrimary) return;
        start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        timer.current = window.setTimeout(() => {
          const at = start.current;
          if (!at) return;
          start.current = null;
          fired.current = true;
          onPress({ x: at.x, y: at.y });
        }, LONG_PRESS_MS);
      },
      onPointerMove: (event: React.PointerEvent) => {
        const at = start.current;
        if (at && at.id === event.pointerId && Math.hypot(event.clientX - at.x, event.clientY - at.y) > LONG_PRESS_SLOP) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
  };
}

export function AgentRailRow({
  agent,
  selected,
  statusLabel,
  idle = false,
  onSelect,
  actions,
}: {
  agent: Agent;
  selected: boolean;
  statusLabel: string;
  /** Only an Agent shown as plainly idle can show its unfinished Job/CI work; any
   * other state (working, waiting for you, compacting, closed…) comes first. */
  idle?: boolean;
  onSelect: () => void;
  /** Its actions (T-184): a "…" button, a right-click or a long-press. */
  actions?: AgentActionHandlers;
}) {
  const language = useLanguage();
  const t = text(language);
  const summary = agent.workSummary;
  const machine = agent.remote?.machine.name || t.host;
  const jobs = useAgentJobs(agent.id);
  const ci = useAgentCI(agent.id);
  const waiting = idle ? waitingSummary(jobs, ci, language) : null;
  const label = waiting?.label ?? statusLabel;
  // Two waits or checks at once ("Waiting · Job / CI") take their own line
  // under the name; one ("Waiting · CI") fits beside it like any status.
  const combined = !!waiting && (label.includes("/") || label.split(" · ").length > 2);
  // Something dragged with "Send to Agent" can be dropped here (T-152).
  const drop = useHandoffDrop(agent);
  const menu = useRef<AgentActionsMenuHandle>(null);
  const select = useRef<HTMLButtonElement>(null);
  const press = useLongPress((point) => menu.current?.openAt(point, select.current));
  return (
    <article
      className={`agent-row${selected ? " selected" : ""}${drop.state ? ` handoff-${drop.state}` : ""}`}
      data-agent-id={agent.id}
      {...drop.handlers}
      {...(actions && {
        ...press.handlers,
        onContextMenu: (event: React.MouseEvent) => {
          event.preventDefault();
          // After a long-press that opened it, a touch's own context menu
          // opens nothing more; before one, it takes the press.
          if (press.fired.current) return;
          press.claim();
          menu.current?.openAt({ x: event.clientX, y: event.clientY }, select.current);
        },
        onClickCapture: (event: React.MouseEvent) => {
          if (!press.fired.current) return;
          press.fired.current = false;
          event.preventDefault();
          event.stopPropagation();
        },
      })}
    >
      <button
        ref={select}
        className="agent-select agent-row-top"
        onClick={onSelect}
        aria-label={t.open(agent.name)}
        aria-description={t.description(label, waiting?.detail ?? null, machine, agent.unreadCount)}
        aria-current={selected ? "true" : undefined}
        title={t.title(agent.name, label, waiting?.detail ?? null, agent.unreadCount)}
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
      {/* After the card's own target in focus order; drawn at its top right. */}
      {actions && <AgentActionsMenu ref={menu} agent={agent} handlers={actions} className="agent-row-menu" />}
      {/* The whole card opens the agent; nothing inside is a separate link. */}
      {summary && (
        <div
          className={`agent-work-summary kind-${summary.kind}`}
          data-source-kind={summary.kind}
          title={summary.requestParts ? undefined : summary.text}
        >
          {summary.source === "agent" && (
            <span className="agent-report-prefix">
              {summary.kind === "result" ? t.reported : t.update}
            </span>
          )}
          <RequestSummary agentId={agent.id} summary={summary} />
        </div>
      )}
      {drop.state && (
        <p className="handoff-hint" role="status">
          {drop.state === "accept" ? t.drop(agent.name) : drop.refusal}
        </p>
      )}
      {agent.pendingCount > 0 && (
        <div className="agent-row-bottom">
          <span className="needs-you">
            <Bell size={10} />
            {t.needsYou(agent.pendingCount)}
          </span>
        </div>
      )}
    </article>
  );
}
