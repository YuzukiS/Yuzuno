import { useEffect, useRef, useState } from "react";
import { RequestSummary } from "./MessageContent";
import { Bell } from "lucide-react";
import type { AgentActionHandlers } from "./agent-actions";
import { AgentActionsMenu, type AgentActionsMenuHandle, type MenuPoint } from "./AgentActionsMenu";
import type { Agent, WorkSummary } from "./types";
import { useAgentJobs } from "./live-jobs";
import { useAgentCI, waitingSummary } from "./live-ci";
import { useHandoffDrop } from "./SendToAgent";
import { strings, useLanguage, type Language } from "./i18n";
import { lifecycleText, stateDetail } from "./executor-lifecycle";
import { REVIEW_ROUNDS, executorView, type ExecutorPR } from "./executor-display";
import { executorRowText, rowFactsLabel, stateText } from "./ExecutorRowState";
import { AgentIsland, clockShort, islandActivity, islandText, lineText, useIslandShell, type IslandPill } from "./AgentIsland";
import { islandView, type IslandAction, type IslandForm, type IslandState } from "./agent-island";
import { useExecutorPR, useMinute } from "./live-executors";
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
  lead: "Lead",
  leadTitle: "A lead of this Project, as set in its settings",
  executor: "Executor",
  executorTitle: "Made by Core for one task, from an executor template",
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
  lead: "负责人",
  leadTitle: "此 Project 的负责人（在 Project 设置中指定）",
  executor: "执行者",
  executorTitle: "由 Core 按执行者模板为一个任务创建",
});

/** How long a touch is held before it opens the actions, and how far it may
 * move first: a scroll moves further, and the browser cancels the pointer. */
export const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** A touch held this long shows it is being held (T-19 SH:R13): the row
 * presses in before the actions open. */
const HOLD_CUE_MS = 150;

/** A touch held still opens `onPress` at that point; a move, a cancel or an
 * early lift does nothing. After a long-press (`fired`), the click that
 * follows is swallowed, so the row does not also open; any next press clears
 * it. `claim` takes a pending touch for the browser's own context menu, so
 * the menu opens once. `holding` is true from HOLD_CUE_MS into a hold until
 * it opens or ends. */
function useLongPress(onPress: (point: MenuPoint) => void) {
  const timer = useRef<number | undefined>(undefined);
  const cue = useRef<number | undefined>(undefined);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const fired = useRef(false);
  const [holding, setHolding] = useState(false);
  const cancel = () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(cue.current);
    start.current = null;
    setHolding(false);
  };
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(cue.current);
  }, []);
  return {
    fired,
    holding,
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
        cue.current = window.setTimeout(() => setHolding(true), HOLD_CUE_MS);
        timer.current = window.setTimeout(() => {
          const at = start.current;
          if (!at) return;
          start.current = null;
          fired.current = true;
          setHolding(false);
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
  unseen = null,
  waitingSince = null,
  compacting = false,
  onSelect,
  onOpenHome,
  onOpenTask,
  actions,
}: {
  agent: Agent;
  selected: boolean;
  statusLabel: string;
  /** Its last Turn ended this way and this device hasn't shown it (T-42). */
  unseen?: "finished" | "failed" | null;
  /** Only an Agent shown as plainly idle can show its unfinished Job/CI work; any
   * other state (working, waiting for you, compacting, closed…) comes first. */
  idle?: boolean;
  /** Its oldest wait in Home's Needs you (ms): how long it has waited for you. */
  waitingSince?: number | null;
  /** It is the open Agent and it is compacting. */
  compacting?: boolean;
  onSelect: () => void;
  /** Where its ring goes (T-43 v10.2): Home's Needs you, at its item; its task. */
  onOpenHome?: (agentId: string) => void;
  onOpenTask?: (taskId: string) => void;
  /** Its actions (T-184): a "…" button, a right-click or a long-press. */
  actions?: AgentActionHandlers;
}) {
  const language = useLanguage();
  const t = text(language);
  const summary = agent.workSummary;
  const machine = agent.remote?.machine.name || t.host;
  const jobs = useAgentJobs(agent.id);
  const ci = useAgentCI(agent.id);
  // Unfinished Job/CI work shows on a plainly idle Agent, not over a Turn end not seen yet.
  const waiting = idle && !unseen ? waitingSummary(jobs, ci, language) : null;
  const label = waiting?.label ?? statusLabel;
  // Two waits or checks at once ("Waiting · Job / CI") take their own line
  // under the name; one ("Waiting · CI") fits beside it like any status.
  const combined = !!waiting && (label.includes("/") || label.split(" · ").length > 2);
  // Something dragged with "Send to Agent" can be dropped here (T-152).
  const drop = useHandoffDrop(agent);
  const menu = useRef<AgentActionsMenuHandle>(null);
  const select = useRef<HTMLButtonElement>(null);
  const press = useLongPress((point) => menu.current?.openAt(point, select.current));
  // A Project's lead says so (T-33), and an executor (T-34) with its state
  // (T-36 S3); the button's label is its name only.
  const lifecycle = agent.kind === "executor" && agent.executor ? agent.executor : null;
  const states = lifecycleText(language);
  // An executor's one state (T-43 S2): its row's second line says it, in
  // place of a runtime status and a lifecycle badge, and says it once.
  const pr = useExecutorPR(agent.id);
  const executor = lifecycle ? executorView({ agent, lifecycle, unseen, waiting: waiting?.label ?? null, pr, waitingSince }) : null;
  const shown = executor ? stateText(executor, language) : label;
  // Its template beside its state when its name doesn't already say it; one
  // made from no template (an empty id) says Executor there.
  const made = lifecycle?.template ? (lifecycle.template.id === "" ? t.executor : lifecycle.template.label || null) : null;
  const template = made && !agent.name.includes(made) ? made : null;
  const kind = agent.kind === "lead" ? { name: t.lead, title: t.leadTitle }
    : agent.kind === "executor"
      ? {
          name: t.executor,
          title: [t.executorTitle, ...(lifecycle?.task ? [`${lifecycle.task.id} · ${lifecycle.task.title}`] : []),
            ...(lifecycle ? stateDetail(lifecycle, states) : [])].join("\n"),
        }
      : null;
  const description = t.description(shown, executor ? null : waiting?.detail ?? null, machine, agent.unreadCount);
  // Its island (T-43, 灵动环 v10.2, the user's design): a ring at the row's
  // top right that is the state itself. A click on the row opens the
  // conversation; a click on the ring goes straight to its state's place
  // (Home for what it asks, its task, or the conversation). Needs you and
  // failed are row islands until handled; a passing event grows a pill.
  const island = islandView({ agent, executor, lifecycle, unseen, waiting: waiting?.label ?? null, statusLabel: label, compacting, waitingSince });
  const words = islandText(language);
  const now = useMinute();
  const rest: IslandForm = island.auto ? "row" : "ring";
  const pill = usePassingEvent({ unread: agent.unreadCount, state: island.state, pr: pr ?? null, language, quiet: rest !== "ring" });
  const form: IslandForm = pill ? "pill" : rest;
  const row = useRef<HTMLElement>(null);
  const shell = useRef<HTMLSpanElement>(null);
  useIslandShell(row, shell, form);
  // An executor's template, PR and task, for its ring's title.
  const factsLabel = executor ? rowFactsLabel(executor, template, executorRowText(language)) : null;
  const go = (action: IslandAction) => {
    if (action === "answer") onOpenHome?.(agent.id);
    else if (action === "turn" || action === "unread") onSelect();
    else if (island.task) onOpenTask?.(island.task);
  };
  // Line one: a standing Agent's name, an executor's activity (the user,
  // v7: what it is doing matters, not its name). Line two: what a standing
  // Agent last said; an executor's task key and its clock.
  const activity = executor ? islandActivity(island, language) : null;
  const time = island.clock ? clockShort(island.clock, now, language) : null;
  const alert = !executor && (island.state === "waiting" || island.state === "failed");
  // An executor's line two: its task's key, then its clock.
  const taskKey = lifecycle?.task?.id ?? null;
  const summaryLine = summary && (
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
  );
  return (
    <article
      ref={row}
      className={`agent-row${selected ? " selected" : ""}${drop.state ? ` handoff-${drop.state}` : ""}${press.holding ? " is-holding" : ""}`}
      data-agent-id={agent.id}
      data-island={island.state}
      data-form={form}
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
      {/* The island's outline: grown out of the ring and back into it. */}
      <span ref={shell} className="island-shell" aria-hidden="true" />
      {/* The row is the link to the conversation, its whole box (its ::after),
          the text of a row island included; the ring has its own place. */}
      <button
        ref={select}
        className="agent-select agent-row-top"
        onClick={onSelect}
        aria-label={t.open(agent.name)}
        aria-description={kind ? `${kind.name} · ${description}` : description}
        aria-current={selected ? "true" : undefined}
        title={`${t.title(agent.name, shown, executor ? null : waiting?.detail ?? null, agent.unreadCount)}${kind ? ` · ${kind.name}` : ""}`}
      >
        {activity ? (
          <span className="agent-line-one agent-activity" data-state={island.state}>
            {activity.word && <span className="island-word">{activity.word}</span>}
            {activity.sep}
            {activity.text}
          </span>
        ) : (
          <span className="agent-line-one agent-identity">
            <span className="agent-name">{agent.name}</span>
            {kind && <span className="agent-kind-badge" data-kind={agent.kind} title={kind.title}>{kind.name}</span>}
          </span>
        )}
      </button>
      {executor ? (
        <div className="agent-row-meta">
          <span className="agent-task-key">{taskKey ?? agent.name}</span>
          {time && <>{words.gap}<span className="island-clock">{time}</span></>}
        </div>
      ) : alert ? (
        // A standing Agent that needs you or failed says so in words, then what it said.
        <div className="agent-row-state is-alert">
          <span className="island-word">{words.word[island.state]}</span>
          {summaryLine ?? <span className="agent-row-said">{lineText(island.line, island.state, language)}</span>}
        </div>
      ) : summary && (
        <div className="agent-row-state">{summaryLine}</div>
      )}
      <AgentIsland view={island} form={form} pill={pill} name={agent.name} onGo={go}
        detail={executor ? [kind?.title, factsLabel].filter(Boolean).join("\n") : undefined}
        data-status={label}
        data-jobs={waiting ? jobs?.active : undefined}
        data-ci={waiting && ci ? ci.running + ci.discovering + (ci.waitingForRun ?? 0) + ci.check : undefined}
        data-combined={combined || !!unseen || undefined} />
      {/* After the island in focus order; beside the ring, where the reader is (T-15). */}
      {actions && <AgentActionsMenu ref={menu} agent={agent} handlers={actions} className="agent-row-menu" />}
      {drop.state && (
        <p className="handoff-hint" role="status">
          {drop.state === "accept" ? t.drop(agent.name) : drop.refusal}
        </p>
      )}
      {agent.pendingCount > 0 && island.state !== "waiting" && (
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

/** A passing event for the ring's pill (T-43 v10.2): what changed since the
 * row last showed, said for a few seconds in a pill grown left out of the
 * ring, the latest replacing one shown. Its PR merged, a review asked for
 * changes or passed, its checks failed or turned green; it handed in, or
 * started after queuing; new messages came. Nothing on the row's first
 * showing or a PR's first reading (where things stand is not news), and
 * nothing while the row is the island (needs you, failed): it says more. */
type Passing = "merged" | "reviewChanges" | "reviewOk" | "ciFailed" | "ciGreen" | "handedIn" | "started" | "messages";
function usePassingEvent({ unread, state, pr, language, quiet }: { unread: number; state: IslandState; pr: ExecutorPR | null; language: Language; quiet: boolean }): IslandPill | null {
  const [pill, setPill] = useState<{ kind: Passing; n: number; pr: number | null } | null>(null);
  const seen = useRef<{ unread: number; state: IslandState; pr: ExecutorPR | null } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const was = seen.current;
    seen.current = { unread, state, pr };
    if (!was || quiet) return;
    const before = was.pr && pr && was.pr.number === pr.number ? was.pr : null;
    const reviews = (p: ExecutorPR | null) => p?.reviews ?? { approved: 0, changesRequested: false, running: false };
    const kind: Passing | null =
      before && pr!.state === "merged" && before.state !== "merged" ? "merged"
        : before && reviews(pr).changesRequested && !reviews(before).changesRequested ? "reviewChanges"
          : before && reviews(pr).approved >= REVIEW_ROUNDS && reviews(before).approved < REVIEW_ROUNDS ? "reviewOk"
            : before && before.ci != null && pr!.ci !== before.ci && (pr!.ci === "failure" || pr!.ci === "success") ? (pr!.ci === "failure" ? "ciFailed" : "ciGreen")
              : state === "handed" && was.state === "working" ? "handedIn"
                : state === "working" && was.state === "queued" ? "started"
                  : unread > was.unread ? "messages" : null;
    if (!kind) return;
    setPill({ kind, n: unread - was.unread, pr: pr?.number ?? null });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPill(null), kind === "reviewChanges" || kind === "ciFailed" ? BAD_PILL_MS : PILL_MS);
  }, [unread, state, pr, quiet]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!pill || quiet) return null;
  const t = islandText(language).pill;
  switch (pill.kind) {
    case "merged": return { text: t.merged(pill.pr), ring: "green", tone: "ok" };
    case "reviewChanges": return { text: t.reviewChanges, ring: null, tone: "bad" };
    case "reviewOk": return { text: t.reviewOk, ring: "green", tone: "ok" };
    case "ciFailed": return { text: t.ciFailed, ring: "red", tone: "bad" };
    case "ciGreen": return { text: t.ciGreen, ring: "green", tone: "ok" };
    case "handedIn": return { text: t.handedIn(pill.pr), ring: null, tone: "ok" };
    case "started": return { text: t.started, ring: null, tone: "working" };
    case "messages": return { text: t.messages(Math.max(1, pill.n)), ring: null, tone: "info" };
  }
}
/** How long a passing event's pill stays before it shrinks into the ring;
 * bad news a little longer. */
export const PILL_MS = 3000;
export const BAD_PILL_MS = 5000;
