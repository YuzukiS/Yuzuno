import type { ExecutorDetail, ExecutorView } from "./executor-display";
import type { ExecutorLifecycle } from "./executor-lifecycle";
import type { Agent } from "./types";

/**
 * The Agent row's island (T-43, 灵动环 v10.1, the user's design of
 * 2026-11-07): a ring at the row's top right that is the state itself (its
 * turning, fill, colour, stroke and a mark for done, failed and archived),
 * which grows into the row and back into itself. A click on the row opens
 * the conversation; only the ring steps the island (ring → row island →
 * card). Needs you and failed are row islands until handled. Pure: the
 * words are AgentIsland.tsx's, the facts the Agent listing's and, for an
 * executor, executorView's.
 */
export type IslandState = "idle" | "working" | "handed" | "waiting" | "queued" | "offline" | "done" | "failed" | "archived";

/** live: a clock that runs; since: how long ago it stopped; total: an
 * ended executor's whole time on its task, which no longer runs. */
export type IslandClock = { kind: "live" | "since" | "total"; from: number; to: number | null };

/** What a line says. An executor's line one is what it is doing, after the
 * state's word; the card's detail line says one fact more. */
export type IslandLine =
  | { kind: "detail"; detail: ExecutorDetail }
  | { kind: "text"; text: string }
  /** Handed in, waiting for the lead; or, with a Turn running, on its next slice. */
  | { kind: "handed"; pr: number | null }
  /** Its task's title. */
  | { kind: "task"; title: string }
  /** Its PR and what the PR is at. */
  | { kind: "pr"; number: number; detail: ExecutorDetail | null }
  | { kind: "none" };

/** The card's buttons, each to a place the row's own click doesn't go:
 * Home, to answer what it asks; its result or why it failed, on its task;
 * its task. The conversation is the row's (the user, v10.1). */
export type IslandAction = "home" | "result" | "why" | "task";

export type IslandView = {
  state: IslandState;
  clock: IslandClock | null;
  unread: number;
  /** An executor's line one, after the state's word. */
  line: IslandLine;
  /** The card's detail line. */
  more: IslandLine;
  /** The ring's fill: working's arc (null: a fixed quarter until templates
   * carry their steps), handed in's review rounds. */
  progress: number | null;
  /** A row island by itself: it needs you, or it failed, until handled. */
  auto: boolean;
  actions: IslandAction[];
  /** Its task's key, for the task's buttons. */
  task: string | null;
  /** The PR it handed in, for the word "Handed in #688". */
  pr: number | null;
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
const NONE: IslandLine = { kind: "none" };

type Standing = Pick<IslandView, "state" | "clock" | "line">;

function standing(facts: IslandFacts): Standing {
  const { agent } = facts;
  const ended = time(agent.lastTurnEnd?.at);
  const summary = agent.workSummary?.text?.trim() || null;
  const text = (t: string | null): IslandLine => (t ? { kind: "text", text: t } : NONE);
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

/** An executor's state, clock, line one and detail line. Line one is what
 * it is doing: its blocker, else what it last said (its work summary), else
 * what its state is at, else its task's title. The detail line is its PR,
 * else its task's title, whichever line one doesn't say. */
function executor(facts: IslandFacts, view: ExecutorView): Standing & { more: IslandLine } {
  const { agent, lifecycle } = facts;
  const summary = agent.workSummary?.text?.trim() || null;
  const title = lifecycle?.task?.title?.trim() || null;
  const task: IslandLine = title ? { kind: "task", title } : NONE;
  const said = (d: ExecutorDetail | null): IslandLine => (d ? { kind: "detail", detail: d } : NONE);
  const first = (...lines: IslandLine[]) => lines.find((l) => l.kind !== "none") ?? NONE;
  const pr: IslandLine = view.pr ? { kind: "pr", number: view.pr.number, detail: view.detail?.kind === "pr" ? view.detail : { kind: "pr", status: view.pr.status } } : NONE;
  // The detail line: its PR, else its task, else nothing; never what line one says.
  const more = (line: IslandLine) => first(...[pr, task].filter((l) => l.kind !== line.kind));
  const out = (state: IslandState, clock: IslandClock | null, line: IslandLine) => ({ state, clock, line, more: more(line) });
  const ended = view.ended ?? time(lifecycle?.since);
  switch (view.shown) {
    case "queued":
      return out("queued", live(view.started), first(said(view.detail), task));
    case "needsYou":
      // What it asks is its work summary. Its wait is Home's Needs you's;
      // until Home lists it, no clock rather than its time since dispatch.
      return out("waiting", live(view.waitingSince ?? null), first(summary ? { kind: "text", text: summary } : NONE, task));
    case "review":
      // Handed in (T-43 7224): a Turn running means it already works on its next slice.
      return agent.status === "working"
        ? out("working", live(view.started), first(summary ? { kind: "text", text: summary } : NONE, { kind: "handed", pr: view.pr?.number ?? null }))
        : out("handed", live(time(lifecycle?.since) ?? view.started), { kind: "handed", pr: view.pr?.number ?? null });
    case "failed":
      return out("failed", since(ended), first(said(view.detail), summary ? { kind: "text", text: summary } : NONE, task));
    case "done":
      // Archived says itself; what an archiving one waits for is its line.
      return out("archived", view.started != null ? { kind: "total", from: view.started, to: view.ended } : null,
        first(view.detail?.kind === "released" ? NONE : said(view.detail), task));
    case "stopped":
      return view.detail?.kind === "offline"
        ? out("offline", since(time(agent.disconnectedAt)), first(summary ? { kind: "text", text: summary } : NONE, task))
        : out("archived", view.started != null ? { kind: "total", from: view.started, to: view.ended } : null, first(said(view.detail), task));
    case "working": {
      const blocked = view.detail?.kind === "blocked" ? said(view.detail) : NONE;
      // Its PR is the detail line's, not line one's.
      const at = view.detail && view.detail.kind !== "pr" ? said(view.detail) : NONE;
      return out("working", live(view.started), first(blocked, summary ? { kind: "text", text: summary } : NONE, at, task));
    }
  }
}

/** The ring's fill for handed in: its PR's review rounds, k of n. */
function rounds(view: ExecutorView | null): number | null {
  const status = view?.pr?.status;
  if (!status) return null;
  if (status.kind === "approved" || status.kind === "merged") return 1;
  if (status.kind === "rounds") return status.of > 0 ? status.approved / status.of : 0;
  return 0;
}

/** The island of an Agent's row: the first rule that holds, as the row
 * shows it. A standing Agent's runtime gives no start for its Turn, so its
 * Working has no clock; an executor's clock is its time on the task. */
export function islandView(facts: IslandFacts): IslandView {
  const view = facts.executor ?? null;
  const { state, clock, line, more } = view ? executor(facts, view) : { ...standing(facts), more: NONE };
  const task = facts.lifecycle?.task?.id ?? null;
  // Each button goes where the row doesn't: the row opens the conversation.
  const actions: IslandAction[] = !view || !task ? []
    : state === "waiting" ? ["home", "task"]
      : state === "handed" ? ["result"]
        : state === "failed" && view.shown === "failed" && view.detail?.kind !== "turnFailed" ? ["why"]
          : ["task"];
  return {
    state, clock, line, more,
    unread: Math.max(0, facts.agent.unreadCount || 0),
    progress: state === "handed" ? rounds(view) : null,
    auto: state === "waiting" || state === "failed",
    actions, task,
    pr: view?.pr?.number ?? null,
  };
}

/** A clock as the island writes it: "<1分", "12分", "1时20分", "2天"; in
 * English "<1m", "12m", "1h20m", "2d". `short` drops the minutes past an
 * hour: "1时", "1h". */
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

/** The forms an island takes: its ring; a short pill grown left out of it
 * for a passing event; the row as the island; the card, the row island one
 * detail line and its buttons taller. */
export type IslandForm = "ring" | "pill" | "row" | "card";

/** Where a click on the ring goes from each form; null: back to rest. */
export function nextForm(form: IslandForm): IslandForm | null {
  return form === "ring" || form === "pill" ? "row" : form === "row" ? "card" : null;
}
