import { useEffect, useRef, useState, type RefObject } from "react";
import { RequestSummary } from "./MessageContent";
import { Bell } from "lucide-react";
import type { AgentActionHandlers } from "./agent-actions";
import { AgentActionsMenu, type AgentActionsMenuHandle, type MenuPoint } from "./AgentActionsMenu";
import type { Agent, WorkSummary } from "./types";
import { useAgentJobs } from "./live-jobs";
import { useAgentCI, waitingSummary } from "./live-ci";
import { useHandoffDrop } from "./SendToAgent";
import { strings, useLanguage, type Language } from "./i18n";
import { executorView, type ExecutorPR } from "./executor-display";
import { stateText } from "./ExecutorRowState";
import { AgentIsland, clockShort, islandText, lineText, stayText, stayTone, useIslandShell, type IslandPill } from "./AgentIsland";
import { islandView, type IslandAction, type IslandForm } from "./agent-island";
import { AgentRowCard } from "./AgentRowCard";
import { Tip, type TipSide } from "./Tip";
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
  reported: "Reported · ",
  update: "Update · ",
  drop: (name: string) => `Drop to add it to ${name}’s draft`,
  needsYou: (count: number) => `${count} needs you`,
  lead: "Lead",
  executor: "Executor",
}, {
  host: "Core 主机",
  open: (name) => `打开 ${name}`,
  description: (label, detail, machine, unread) =>
    `${label}${detail ? `（${detail}）` : ""}，位于 ${machine}${unread > 0 ? `，${unread} 条未读更新` : ""}`,
  reported: "已报告 · ",
  update: "更新 · ",
  drop: (name) => `放下即可添加到 ${name} 的草稿`,
  needsYou: (count) => `${count} 项需要你`,
  lead: "负责人",
  executor: "执行者",
});

/** How long a touch is held before it opens the actions, and how far it may
 * move first: a scroll moves further, and the browser cancels the pointer. */
export const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;
/** A touch held this long shows it is being held (T-19 SH:R13): the row
 * presses in before the actions open. */
const HOLD_CUE_MS = 150;

/** Where a touch began: its point, and the element under it. */
type Press = MenuPoint & { on: Element };

/** A touch held still opens `onPress` where it began; a move, a cancel or
 * an early lift does nothing. After a long-press (`fired`), the click that
 * follows is swallowed, so the row does not also open; any next press clears
 * it. `claim` takes a pending touch for the browser's own context menu, so
 * it opens once, and says where the touch began (null: none was pending).
 * `holding` is true from HOLD_CUE_MS into a hold until it opens or ends. */
function useLongPress(onPress: (press: Press) => void) {
  const timer = useRef<number | undefined>(undefined);
  const cue = useRef<number | undefined>(undefined);
  const start = useRef<(Press & { id: number }) | null>(null);
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
    claim: (): Press | null => {
      const at = start.current;
      if (!at) return null;
      cancel();
      fired.current = true;
      return at;
    },
    handlers: {
      onPointerDown: (event: React.PointerEvent) => {
        cancel();
        fired.current = false;
        // The open menu's own entries (its events reach the row through React).
        if ((event.target as Element).closest?.('[role="menu"]')) return;
        if (event.pointerType !== "touch" || !event.isPrimary) return;
        start.current = { x: event.clientX, y: event.clientY, id: event.pointerId, on: event.target as Element };
        cue.current = window.setTimeout(() => setHolding(true), HOLD_CUE_MS);
        timer.current = window.setTimeout(() => {
          const at = start.current;
          if (!at) return;
          start.current = null;
          fired.current = true;
          setHolding(false);
          onPress(at);
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
  asking = false,
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
  /** An executor whose gate ask waits on Home (T-43 S4): it needs you. */
  asking?: boolean;
  /** It is the open Agent and it is compacting. */
  compacting?: boolean;
  onSelect: () => void;
  /** Where its ring goes (T-43 v10.2): Home's Needs you, at its item; its task. */
  onOpenHome?: (agentId: string) => void;
  onOpenTask?: (taskId: string) => void;
  /** Its actions (T-184): a right-click, a long-press, or the context-menu key (rail v11: no "…" button). */
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
  // Its card (YN-44): one for the whole row, the ring included. A touch held
  // on the ring shows it (a phone has no pointer to rest); held anywhere
  // else on the row, the actions open as before.
  const row = useRef<HTMLElement>(null);
  const card = useRowCard(row);
  // On the ring: on its button, or within its touch area where it is no
  // button and lets a touch through to the row (an idle ring).
  const onRing = (press: Press | null) => {
    if (!press) return false;
    if (press.on.closest?.(".agent-island")) return true;
    const box = row.current?.querySelector(":scope > .agent-island .island-ringbox")?.getBoundingClientRect();
    if (!box?.width) return false;
    const pad = Math.max(0, (RING_TOUCH - box.width) / 2);
    return press.x >= box.left - pad && press.x <= box.right + pad && press.y >= box.top - pad && press.y <= box.bottom + pad;
  };
  const press = useLongPress((at) => (onRing(at) ? card.hold() : menu.current?.openAt({ x: at.x, y: at.y }, select.current)));
  // A Project's lead says so (T-33), and an executor (T-34) with its state
  // (T-36 S3); the button's label is its name only.
  const lifecycle = agent.kind === "executor" && agent.executor ? agent.executor : null;
  // An executor's one state (T-43 S2): its row's second line says it, in
  // place of a runtime status and a lifecycle badge, and says it once.
  const pr = useExecutorPR(agent.id);
  const executor = lifecycle ? executorView({ agent, lifecycle, unseen, waiting: waiting?.label ?? null, pr, waitingSince, asking }) : null;
  const shown = executor ? stateText(executor, language) : label;
  // Its template beside its state when its name doesn't already say it; one
  // made from no template (an empty id) says Executor there.
  const made = lifecycle?.template ? (lifecycle.template.id === "" ? t.executor : lifecycle.template.label || null) : null;
  const template = made && !agent.name.includes(made) ? made : null;
  const kind = agent.kind === "lead" ? t.lead : agent.kind === "executor" ? t.executor : null;
  // Updates unread are a lead's only (the user, rail v11).
  const unread = agent.kind === "lead" ? agent.unreadCount : 0;
  const description = t.description(shown, executor ? null : waiting?.detail ?? null, machine, unread);
  // Its island (T-43, rail v11, the user's answers): a ring at the row's
  // top right says one of five states; every other state is a pill beside
  // it that stays while it holds. A click on the row opens the
  // conversation; a click on the ring goes straight to its state's place
  // (Home for what it asks, its task, or the conversation). Needs you and
  // failed are row islands until handled.
  const island = islandView({ agent, executor, lifecycle, unseen, waiting: waiting?.label ?? null, statusLabel: label, compacting, waitingSince });
  const words = islandText(language);
  const now = useMinute();
  const stay: IslandPill | null = island.stay && !island.auto
    ? { text: stayText(island.stay, language), ring: null, tone: stayTone(island.stay), event: false } : null;
  const rest: IslandForm = island.auto ? "row" : stay ? "pill" : "ring";
  // A passing event takes the pill's place for a few seconds; then what stays comes back.
  const queued = island.stay?.kind === "queued" || island.stay?.kind === "starting";
  const event = usePassingEvent({ state: queued ? "queued" : island.state, pr: pr ?? null, language, quiet: island.auto });
  const pill = event ?? stay;
  const form: IslandForm = island.auto ? "row" : pill ? "pill" : rest;
  const shell = useRef<HTMLSpanElement>(null);
  useIslandShell(row, shell, form, pill?.text ?? null);
  const go = (action: IslandAction) => {
    if (action === "answer") onOpenHome?.(agent.id);
    else if (action === "turn" || action === "reply") onSelect();
    else if (island.task) onOpenTask?.(island.task);
  };
  // Line one: a standing Agent's name; an executor's task, by its short
  // name, else its title (the user, v11: what task it is doing, in words a
  // person reads at a glance; no keys or PR numbers). Line two, small: what
  // it is doing now, then its clock; for a standing Agent what it last said.
  const time = island.clock ? clockShort(island.clock, now, language) : null;
  const alert = !executor && (island.state === "waiting" || island.state === "failed");
  const progress = executor ? lineText(island.line, language) : "";
  const summaryLine = summary && (
    <div className={`agent-work-summary kind-${summary.kind}`} data-source-kind={summary.kind}>
      {summary.source === "agent" && (
        <span className="agent-report-prefix">
          {summary.kind === "result" ? t.reported : t.update}
        </span>
      )}
      <RequestSummary agentId={agent.id} summary={summary} />
    </div>
  );
  // Line two in full, for the card: an executor's progress; a standing
  // Agent's last words, as its row says them.
  const activity = executor ? progress
    : summary ? `${summary.source === "agent" ? (summary.kind === "result" ? t.reported : t.update) : ""}${summary.text}`
      : lineText(island.line, language);
  const body = (
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
          if (onRing(press.claim())) return card.hold();
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
        aria-description={kind ? `${kind} · ${description}` : description}
        aria-current={selected ? "true" : undefined}
        onKeyDown={actions ? (event) => {
          // The keyboard's way to the actions (rail v11, no "…" button): the context-menu key or Shift+F10.
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          menu.current?.openAt({ x: box.left + 12, y: box.bottom }, event.currentTarget);
        } : undefined}
      >
        {executor ? (
          <span className="agent-line-one agent-task-name" data-state={island.state}>{island.title ?? agent.name}</span>
        ) : (
          <span className="agent-line-one agent-identity">
            <span className="agent-name">{agent.name}</span>
            {kind && <span className="agent-kind-badge" data-kind={agent.kind}>{kind}</span>}
          </span>
        )}
      </button>
      {executor ? (
        <div className="agent-row-meta">
          {progress && <span className="agent-progress">{progress}</span>}
          {progress && time && words.gap}
          {time && <span className="island-clock">{time}</span>}
        </div>
      ) : alert ? (
        // A standing Agent that needs you or failed says so in words, then what it said.
        <div className="agent-row-state is-alert">
          <span className="island-word">{words.word[island.state]}</span>
          {summaryLine ?? <span className="agent-row-said">{lineText(island.line, language)}</span>}
        </div>
      ) : summary && (
        <div className="agent-row-state">{summaryLine}</div>
      )}
      <AgentIsland view={island} form={form} pill={pill} name={agent.name} onGo={go}
        data-status={label}
        data-jobs={waiting ? jobs?.active : undefined}
        data-ci={waiting && ci ? ci.running + ci.discovering + (ci.waitingForRun ?? 0) + ci.check : undefined}
        data-combined={combined || !!unseen || undefined} />
      {/* No "…" (rail v11): the menu opens at a right-click, a long-press or the context-menu key. */}
      {actions && <AgentActionsMenu ref={menu} agent={agent} handlers={actions} trigger={false} />}
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
  return (
    <Tip
      side={card.side}
      align={card.side === "right" ? "start" : "end"}
      size="wide"
      describe={false}
      open={card.open}
      onOpenChange={card.onOpenChange}
      className="agent-card"
      content={<AgentRowCard agent={agent} island={island} executor={executor} lifecycle={lifecycle} template={template}
        machine={machine} badge={agent.kind === "lead" ? t.lead : null} activity={activity} waits={executor ? null : waiting?.detail ?? null} />}
    >
      {body}
    </Tip>
  );
}

/** The ring's area for a finger, as its button's on touch (agent-island.css). */
const RING_TOUCH = 40;

/** Beside the row, the card needs this much of the window to its right;
 * with less (a phone's rail, a narrow window) it goes under the row. */
const CARD_ROOM = 240;

/**
 * The row's card (YN-44): shown after the pointer rests on the row, or at
 * once on keyboard focus (Tip), or by a touch held on the ring (`hold`). A
 * held card stays after the lift; the next tap anywhere only closes it (that
 * tap does nothing else), and a scroll or Escape closes it too.
 */
function useRowCard(row: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<TipSide>("right");
  const [held, setHeld] = useState(false);
  const holding = useRef(false);
  const place = () => {
    const box = row.current?.getBoundingClientRect();
    setSide(box && window.innerWidth - box.right >= CARD_ROOM ? "right" : "bottom");
  };
  useEffect(() => {
    if (!held) return;
    let pressed = false;
    let late: number | undefined;
    const end = () => {
      window.clearTimeout(late);
      holding.current = false;
      setHeld(false);
      setOpen(false);
    };
    const down = () => {
      pressed = true;
      setOpen(false);
    };
    // A press that ends in no click (a drag) still ends the hold.
    const up = () => {
      if (pressed) late = window.setTimeout(end, 400);
    };
    const click = (event: MouseEvent) => {
      // The hold's own lift is the row's to swallow.
      if (!pressed) return;
      event.preventDefault();
      event.stopPropagation();
      end();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") end();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", end, true);
    return () => {
      window.clearTimeout(late);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", end, true);
    };
  }, [held]);
  return {
    open,
    side,
    onOpenChange: (next: boolean) => {
      // A held card closes at the next tap, not at the lift (or the pointer
      // leaving) that ends the hold.
      if (!next && holding.current) return;
      if (next) place();
      setOpen(next);
    },
    hold: () => {
      holding.current = true;
      place();
      setOpen(true);
      setHeld(true);
    },
  };
}

/** A passing event for the pill (T-43 rail v11): what changed since the
 * row last showed, said for a few seconds in the pill's place, the latest
 * replacing one shown; then the state that stays comes back. Its PR merged,
 * its checks failed or turned green, it started after queuing. Review news
 * is the staying pill's own ("审查中", "要改", "等合并"), and new messages are
 * no event (the user, v11). Nothing on the row's first showing or a PR's
 * first reading, and nothing while the row is the island (needs you, failed). */
type Passing = "merged" | "ciFailed" | "ciGreen" | "started";
function usePassingEvent({ state, pr, language, quiet }: { state: string; pr: ExecutorPR | null; language: Language; quiet: boolean }): IslandPill | null {
  const [pill, setPill] = useState<Passing | null>(null);
  const seen = useRef<{ state: string; pr: ExecutorPR | null } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const was = seen.current;
    seen.current = { state, pr };
    if (!was || quiet) return;
    const before = was.pr && pr && was.pr.number === pr.number ? was.pr : null;
    const kind: Passing | null =
      before && pr!.state === "merged" && before.state !== "merged" ? "merged"
        : before && before.ci != null && pr!.ci !== before.ci && (pr!.ci === "failure" || pr!.ci === "success") ? (pr!.ci === "failure" ? "ciFailed" : "ciGreen")
          : state === "working" && was.state === "queued" ? "started" : null;
    if (!kind) return;
    setPill(kind);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPill(null), kind === "ciFailed" ? BAD_PILL_MS : PILL_MS);
  }, [state, pr, quiet]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!pill || quiet) return null;
  const t = islandText(language).pill;
  switch (pill) {
    case "merged": return { text: t.merged, ring: "green", tone: "ok", event: true };
    case "ciFailed": return { text: t.ciFailed, ring: "red", tone: "bad", event: true };
    case "ciGreen": return { text: t.ciGreen, ring: "green", tone: "ok", event: true };
    case "started": return { text: t.started, ring: null, tone: "working", event: true };
  }
}
/** How long a passing event's pill stays before it shrinks into the ring;
 * bad news a little longer. */
export const PILL_MS = 3000;
export const BAD_PILL_MS = 5000;
