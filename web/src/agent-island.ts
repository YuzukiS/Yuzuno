import type { ExecutorDetail, ExecutorView } from "./executor-display";
import type { ExecutorLifecycle } from "./executor-lifecycle";
import type { Agent } from "./types";

/**
 * The Agent row's island (T-43, 灵动环 v4-2 自动岛, the user's choice of
 * 2026-11-07): one shape at the row's right end that says the state, its
 * clock and the unread count. It is a ring (at most 24 px) while nothing
 * needs you, two lines while the Agent needs you or failed, and a card in
 * the row's place when opened. Pure: the words are AgentIsland.tsx's, the
 * facts the Agent listing's and, for an executor, executorView's.
 */
export type IslandState = "idle" | "working" | "handed" | "waiting" | "queued" | "offline" | "done" | "failed" | "archived";

/** live: a clock that runs; since: how long ago it stopped; total: an
 * ended executor's whole time on its task, which no longer runs. */
export type IslandClock = { kind: "live" | "since" | "total"; from: number; to: number | null };

/** What line two says after the state's word. */
export type IslandLine =
  | { kind: "detail"; detail: ExecutorDetail }
  | { kind: "text"; text: string }
  | { kind: "handed"; pr: number | null }
  | { kind: "none" };

/** The card's actions, the first the one it leads with. */
export type IslandAction = "home" | "result" | "task" | "open";

export type IslandView = {
  state: IslandState;
  clock: IslandClock | null;
  unread: number;
  line: IslandLine;
  /** Two lines by itself: it needs you, or it failed (v4-2). */
  auto: boolean;
  actions: IslandAction[];
  /** Its task's key, for the task actions. */
  task: string | null;
};

export type IslandFacts = {
  agent: Pick<Agent, "status" | "pendingCount" | "unreadCount" | "closedAt" | "disconnectedAt" | "lastTurnEnd" | "workSummary">;
  /** An executor's one state (T-43 S2), and its lifecycle. */
  executor?: ExecutorView | null;
  lifecycle?: ExecutorLifecycle | null;
  /** Its last Turn's end this device has not shown (T-42). */
  unseen?: "finished" | "failed" | null;
  /** An idle Agent's unfinished Job or CI work, as the row reads it. */
  waiting?: string | null;
  /** The status the app shows for it (closed, compacting, a Turn end not seen, its runtime). */
  statusLabel: string;
  /** It is the open Agent and it is compacting. */
  compacting?: boolean;
  /** Its oldest wait in Home's Needs you (ms). */
  waitingSince?: number | null;
};

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};
const live = (from: number | null): IslandClock | null => (from == null ? null : { kind: "live", from, to: null });
const since = (from: number | null): IslandClock | null => (from == null ? null : { kind: "since", from, to: null });

function standing(facts: IslandFacts): Pick<IslandView, "state" | "clock" | "line"> {
  const { agent } = facts;
  const ended = time(agent.lastTurnEnd?.at);
  const summary = agent.workSummary?.text?.trim() || null;
  const text = (t: string | null) => (t ? { kind: "text" as const, text: t } : { kind: "none" as const });
  if (agent.closedAt) return { state: "archived", clock: since(time(agent.closedAt)), line: text(facts.statusLabel) };
  if (agent.status === "offline" || agent.disconnectedAt) return { state: "offline", clock: since(time(agent.disconnectedAt)), line: text(facts.statusLabel) };
  if (agent.pendingCount > 0 || agent.status === "waiting") return { state: "waiting", clock: live(facts.waitingSince ?? null), line: text(summary ?? facts.statusLabel) };
  if (agent.status === "error" || facts.unseen === "failed") return { state: "failed", clock: since(ended), line: text(facts.statusLabel) };
  if (facts.compacting) return { state: "working", clock: null, line: text(facts.statusLabel) };
  // The runtime gives no start for a standing Agent's Turn: it says it works, without a clock.
  if (agent.status === "working" || agent.status === "uncertain") return { state: "working", clock: null, line: text(summary ?? facts.statusLabel) };
  if (facts.waiting) return { state: "working", clock: null, line: text(facts.waiting) };
  if (facts.unseen === "finished" || agent.unreadCount > 0) return { state: "done", clock: since(ended), line: text(summary) };
  return { state: "idle", clock: since(ended), line: text(summary) };
}

function executor(facts: IslandFacts, view: ExecutorView): Pick<IslandView, "state" | "clock" | "line"> {
  const { agent, lifecycle } = facts;
  const summary = agent.workSummary?.text?.trim() || null;
  const detail = (d: ExecutorDetail | null): IslandLine => (d ? { kind: "detail", detail: d } : summary ? { kind: "text", text: summary } : { kind: "none" });
  switch (view.shown) {
    case "queued":
      return { state: "queued", clock: live(view.started), line: detail(view.detail) };
    case "needsYou":
      // What it asks is its work summary. Its wait is Home's Needs you's;
      // until Home lists it, no clock rather than its time since dispatch.
      return { state: "waiting", clock: live(view.waitingSince ?? null), line: summary ? { kind: "text", text: summary } : { kind: "none" } };
    case "review":
      // Handed in (T-43 7224): a Turn running means it already works on its next slice.
      return agent.status === "working"
        ? { state: "working", clock: live(view.started), line: { kind: "handed", pr: view.pr?.number ?? null } }
        : { state: "handed", clock: live(time(lifecycle?.since) ?? view.started), line: view.detail?.kind === "pr" ? { kind: "detail", detail: view.detail } : { kind: "handed", pr: view.pr?.number ?? null } };
    case "failed":
      return { state: "failed", clock: since(view.ended ?? time(lifecycle?.since)), line: detail(view.detail) };
    case "done":
      // Archived says itself; what an archiving one waits for is its line.
      return { state: "archived", clock: view.started != null ? { kind: "total", from: view.started, to: view.ended } : null, line: view.detail?.kind === "released" ? { kind: "none" } : detail(view.detail) };
    case "stopped":
      return view.detail?.kind === "offline"
        ? { state: "offline", clock: since(time(agent.disconnectedAt)), line: detail(view.detail) }
        : { state: "archived", clock: view.started != null ? { kind: "total", from: view.started, to: view.ended } : null, line: detail(view.detail) };
    case "working":
      return { state: "working", clock: live(view.started), line: detail(view.detail) };
  }
}

/** The island of an Agent's row: the first rule that holds, as the row
 * shows it. A standing Agent's runtime gives no start for its Turn, so its
 * Working has no clock; an executor's clock is its time on the task. */
export function islandView(facts: IslandFacts): IslandView {
  const view = facts.executor ?? null;
  const { state, clock, line } = view ? executor(facts, view) : standing(facts);
  const task = facts.lifecycle?.task?.id ?? null;
  const asks = view != null && state === "waiting";
  const actions: IslandAction[] =
    state === "handed" && task ? ["result", "open"]
      : asks ? ["home", "open", ...(task ? ["task" as const] : [])]
        : ["open", ...(task ? ["task" as const] : [])];
  return { state, clock, unread: Math.max(0, facts.agent.unreadCount || 0), line, auto: state === "waiting" || state === "failed", actions, task };
}

/** A clock as the island writes it: "<1分", "12分", "1时20分", "2天"; in
 * English "<1m", "12m", "1h20m", "2d". `short` drops the minutes past an
 * hour, as the card's cover does: "1时", "1h". */
export function islandTime(ms: number, language: "en" | "zh-Hans", short = false): string {
  const zh = language === "zh-Hans";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return zh ? "<1分" : "<1m";
  if (minutes < 60) return zh ? `${minutes}分` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    if (short || !rest) return zh ? `${hours}时` : `${hours}h`;
    return zh ? `${hours}时${rest}分` : `${hours}h${rest}m`;
  }
  return zh ? `${Math.floor(hours / 24)}天` : `${Math.floor(hours / 24)}d`;
}

/** The milliseconds a clock reads at `now`. */
export const clockMs = (clock: IslandClock, now: number) => Math.max(0, (clock.to ?? now) - clock.from);
