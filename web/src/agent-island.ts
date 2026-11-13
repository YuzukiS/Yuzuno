import type { ExecutorDetail, ExecutorView } from "./executor-display";
import type { ExecutorLifecycle } from "./executor-lifecycle";
import type { AgentCI } from "./live-ci";
import type { AgentJobs } from "./live-jobs";
import type { AgentWaits } from "./live-waits";
import type { Agent, TurnWait } from "./types";

/**
 * The Agent row's island (T-43, rail v11, the user's answers of 2026-11-07
 * to design/ask-rail-readability): a ring at the row's right that says
 * one of five states at a glance (working turns, needs you breathes orange,
 * done ✓, failed ✕, idle grey), and for every other state a pill beside it
 * with a short phrase that stays while the state holds ("等负责人", "审查中",
 * "排队 · 第 2 位"). A passing event (CI, a merge, a start) takes the pill's
 * place for a few seconds. Needs you and failed make the row the island
 * until handled. A click on the row opens the conversation; a click on the
 * ring goes straight to its state's place. Only a running Turn turns the
 * ring (YN-92): once its Turn ends, an Agent is at rest, its ring the grey
 * idle one, and a pill says what holds it ("在等 Job", "等下一轮").
 * Pure: the words are AgentIsland.tsx's, the facts the Agent listing's and,
 * for an executor, executorView's.
 */
export type IslandState = "idle" | "working" | "waiting" | "done" | "failed";

/** A state that isn't one of the ring's five: said by a pill that stays
 * while it holds. */
export type IslandStay =
  | { kind: "queued"; position: number | null }
  /** Waiting for a routing candidate (YN-57), not for a slot: from when one's reason ends, when Core says. */
  | { kind: "candidate"; earliest: number | null }
  | { kind: "starting" }
  /** Handed in, its review not under way: the lead's turn. */
  | { kind: "lead" }
  /** A review round under way. */
  | { kind: "review" }
  | { kind: "changes" }
  | { kind: "ciFailed" }
  /** Approved, its checks green or pending: ready to merge. */
  | { kind: "ready" }
  | { kind: "merged" }
  | { kind: "offline" }
  /** Its Turn has ended and these say why it still holds (YN-92: only a running
   * Turn turns the ring): the ring rests, grey, and the pill stays until the
   * state changes or a new Turn starts. What it started and left running, its
   * wait's icon in the ring; */
  | { kind: "waits"; on: WaitKind }
  /** only a Job or CI whose outcome is to check (a standing Agent's); */
  | { kind: "check"; label: string }
  /** an executor at work on a blocked task; one that handed in a result its
   * task doesn't review yet; or one between Turns, nothing running. */
  | { kind: "blocked" }
  | { kind: "resultIn" }
  | { kind: "between" };

/** live: a clock that runs; since: how long ago it stopped; total: an
 * ended executor's whole time on its task, which no longer runs. */
export type IslandClock = { kind: "live" | "since" | "total"; from: number; to: number | null };

/** What line two says: what it is doing, its blocker, what it asks or
 * said; for a standing Agent what it last said. */
export type IslandLine =
  | { kind: "detail"; detail: ExecutorDetail }
  | { kind: "text"; text: string }
  | { kind: "none" };

/** Where a click on the ring goes (the state's action, at once): Home's
 * Needs you, to answer what it asks; its task, for why its start failed,
 * its result, its place in the queue or the task itself; the conversation,
 * for a Turn that failed or one that ended unseen. */
export type IslandAction = "answer" | "why" | "result" | "queue" | "task" | "turn" | "reply";

/** What a turning ring waits on (YN-51), in the user's order of which one
 * shows when it waits on several. */
export const WAIT_ORDER = ["review", "ci", "job", "subAgent", "shell"] as const;
export type WaitKind = (typeof WAIT_ORDER)[number];
/** The wait its ring shows, and what its card says of it: a review's PR and
 * round; CI's PR (an executor's) or its runs; a Job's name or how many; the
 * call a Turn waits for, or how many run in the background; and the others
 * it waits on too. */
export type IslandWait = {
  kind: WaitKind;
  count: number;
  pr?: number | null;
  round?: number | null;
  name?: string | null;
  label?: string;
  background?: boolean;
  /** No Turn runs: it waits on what it left running (YN-92); false: on the
   * call a running Turn is stopped on. */
  left: boolean;
  also: { kind: WaitKind; count: number }[];
};

/** What an Agent waits on, as its row reads it (YN-51). */
export type WaitFacts = {
  /** A Turn runs: only the call it is stopped on counts. */
  turn: boolean;
  /** That call, once it has held the Turn a moment (the row's to time). */
  call: TurnWait | null;
  jobs?: AgentJobs;
  ci?: AgentCI;
  waits?: AgentWaits;
  /** An executor's PR, which its CI runs on. */
  pr?: number | null;
};

/**
 * The one wait its ring shows, by WAIT_ORDER (YN-51): while a Turn runs, the
 * call it is stopped on (a sub-agent or a shell command), and nothing while
 * it thinks or writes; while none runs (`left`: its ring rests, YN-92), what
 * the Agent started that hasn't ended: reviews mailed to it, CI it watches
 * (running, being found, or awaiting its first run), Jobs (not those whose
 * outcome is unknown: a thing to check is no wait), background sub-agents
 * and shells.
 */
export function waitOn(f: WaitFacts): IslandWait | null {
  type Found = Omit<IslandWait, "kind" | "also">;
  const found: Partial<Record<WaitKind, Found>> = {};
  if (f.turn) {
    if (f.call) found[f.call.kind] = { count: 1, label: f.call.label };
  } else {
    const review = f.waits?.reviews;
    if (review?.running) found.review = { count: review.running, pr: review.pr, round: review.round };
    const runs = f.ci ? f.ci.running + f.ci.discovering + (f.ci.waitingForRun ?? 0) : 0;
    if (runs > 0) found.ci = { count: runs, pr: f.pr ?? null };
    const jobs = f.jobs ? f.jobs.active - f.jobs.unknown : 0;
    if (jobs > 0) found.job = { count: jobs, name: jobs === 1 ? f.jobs?.name ?? null : null };
    if (f.waits?.subAgents) found.subAgent = { count: f.waits.subAgents, background: true };
    if (f.waits?.shells) found.shell = { count: f.waits.shells, background: true };
  }
  const [kind, ...rest] = WAIT_ORDER.filter((k) => found[k]);
  if (!kind) return null;
  return { kind, ...found[kind]!, left: !f.turn, also: rest.map((k) => ({ kind: k, count: found[k]!.count })) };
}

export type IslandView = {
  /** The ring: one of five. */
  state: IslandState;
  /** What a turning ring waits on (YN-51), or a ring at rest whose Agent
   * waits only on what it left running (YN-92); null for every other ring. */
  wait: IslandWait | null;
  /** The pill that stays while a state other than the ring's holds. */
  stay: IslandStay | null;
  clock: IslandClock | null;
  /** An executor's line one: its task's short name, else its title; null for a standing Agent (its name). */
  title: string | null;
  /** Line two. */
  line: IslandLine;
  /** A small dot for a lead with updates unread; no count, and no dot for any other Agent. */
  dot: boolean;
  /** A row island by itself: it needs you, or it failed, until handled. */
  auto: boolean;
  /** Where its ring goes; null: nowhere of its own, and the ring is no button. */
  go: IslandAction | null;
  /** Its task's key, where its ring goes to its task. */
  task: string | null;
  pr: number | null;
};

export type IslandFacts = {
  agent: Pick<Agent, "status" | "pendingCount" | "unreadCount" | "closedAt" | "disconnectedAt" | "lastTurnEnd" | "workSummary"> & { kind?: Agent["kind"] };
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
  /** What it waits on (`waitOn`, YN-51): a turning ring shows it, and a ring
   * at rest that waits only on what it left running (YN-92). */
  wait?: IslandWait | null;
};

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};
const live = (from: number | null): IslandClock | null => (from == null ? null : { kind: "live", from, to: null });
const since = (from: number | null): IslandClock | null => (from == null ? null : { kind: "since", from, to: null });
const NONE: IslandLine = { kind: "none" };
const text = (t: string | null | undefined): IslandLine => (t?.trim() ? { kind: "text", text: t.trim() } : NONE);
const said = (d: ExecutorDetail | null): IslandLine => (d ? { kind: "detail", detail: d } : NONE);
const first = (...lines: IslandLine[]) => lines.find((l) => l.kind !== "none") ?? NONE;

type Read = Pick<IslandView, "state" | "stay" | "clock" | "line">;

function standing(facts: IslandFacts): Read {
  const { agent } = facts;
  const ended = time(agent.lastTurnEnd?.at);
  const summary = text(agent.workSummary?.text);
  const out = (state: IslandState, clock: IslandClock | null, line: IslandLine, stay: IslandStay | null = null): Read => ({ state, stay, clock, line });
  if (agent.closedAt) return out("idle", since(time(agent.closedAt)), text(facts.statusLabel));
  if (agent.status === "offline" || agent.disconnectedAt) return out("idle", since(time(agent.disconnectedAt)), summary, { kind: "offline" });
  if (agent.pendingCount > 0 || agent.status === "waiting") return out("waiting", live(facts.waitingSince ?? null), first(summary, text(facts.statusLabel)));
  if (agent.status === "error" || facts.unseen === "failed") return out("failed", since(ended), first(summary, text(facts.statusLabel)));
  if (facts.compacting) return out("working", null, text(facts.statusLabel));
  // The runtime gives no start for a standing Agent's Turn: it says it works, without a clock.
  if (agent.status === "working" || agent.status === "uncertain") return out("working", null, first(summary, text(facts.statusLabel)));
  // Its Turn has ended (YN-92: only a running Turn turns the ring). What it
  // started and left running (its Jobs, CI, reviews, background work): the
  // ring rests with the wait's icon, its pill says it; a Turn's end not seen
  // yet is said first (done). Only a Job or CI to check: the pill says so.
  if (facts.wait?.left && !facts.unseen) return out("idle", null, text(facts.waiting), { kind: "waits", on: facts.wait.kind });
  if (facts.waiting) return out("idle", null, text(facts.waiting), { kind: "check", label: facts.waiting });
  // Done is a Turn it ended that this device hasn't shown; updates unread are no state (the user, v11).
  if (facts.unseen === "finished") return out("done", since(ended), summary);
  return out("idle", since(ended), summary);
}

/** A handed-in executor's pill, as its PR stands. */
function handed(view: ExecutorView): IslandStay {
  const status = view.pr?.status;
  switch (status?.kind) {
    case "merged": return { kind: "merged" };
    case "changes": return { kind: "changes" };
    case "ciFailed": return { kind: "ciFailed" };
    case "approved": return { kind: "ready" };
    case "rounds": return status.running ? { kind: "review" } : { kind: "lead" };
    default: return { kind: "lead" };
  }
}

/** An executor's ring, pill, clock and line two: what it is doing, its
 * blocker, else what it last said (its work summary), else its detail. */
function executor(facts: IslandFacts, view: ExecutorView): Read {
  const { agent, lifecycle } = facts;
  const summary = text(agent.workSummary?.text);
  const ended = view.ended ?? time(lifecycle?.since);
  const out = (state: IslandState, clock: IslandClock | null, line: IslandLine, stay: IslandStay | null = null): Read => ({ state, stay, clock, line });
  switch (view.shown) {
    case "queued":
      // Waiting for a routing candidate is not waiting for a slot (YN-57): its place in the slot queue doesn't apply.
      return out("idle", live(view.started), NONE,
        view.detail?.kind === "starting" ? { kind: "starting" }
          : lifecycle?.route?.kind === "waiting" ? { kind: "candidate", earliest: time(lifecycle.route.earliest) }
            : { kind: "queued", position: view.detail?.kind === "position" ? view.detail.position : null });
    case "needsYou":
      // What it asks is its work summary. Its wait is Home's Needs you's;
      // until Home lists it, no clock rather than its time since dispatch.
      return out("waiting", live(view.waitingSince ?? null), summary);
    case "review":
      // Handed in (T-43 7224): a Turn running means it already works on its
      // next slice; its PR's pill stays either way.
      return agent.status === "working"
        ? out("working", live(view.started), summary, handed(view))
        : out("idle", live(time(lifecycle?.since) ?? view.started), summary, handed(view));
    case "failed":
      return out("failed", since(ended), first(said(view.detail), summary));
    case "done":
      // Archived (the fold says so): ✓, its whole time; what an archiving one waits for is line two.
      return out("done", view.started != null ? { kind: "total", from: view.started, to: view.ended } : null,
        view.detail?.kind === "released" ? NONE : said(view.detail));
    case "stopped":
      return view.detail?.kind === "offline"
        ? out("idle", since(time(agent.disconnectedAt)), summary, { kind: "offline" })
        : out("idle", view.started != null ? { kind: "total", from: view.started, to: view.ended } : null, said(view.detail));
    case "working": {
      const blocked = view.detail?.kind === "blocked" ? said(view.detail) : NONE;
      // Its PR is its pill's when handed in, not line two's.
      const at = view.detail && view.detail.kind !== "pr" ? said(view.detail) : NONE;
      const line = first(blocked, summary, at);
      // Only a running Turn turns the ring (YN-92). Its Turn ended: at rest,
      // and the pill says why, first that holds: what it left running, its
      // PR, its task's blocker, a result it handed in, else between Turns.
      const turn = agent.status === "working" || agent.status === "uncertain" || !!facts.compacting;
      if (!turn) {
        const stay: IslandStay = facts.wait?.left ? { kind: "waits", on: facts.wait.kind }
          : view.pr ? handed(view)
            : view.detail?.kind === "blocked" ? { kind: "blocked" }
              : lifecycle?.resultAt ? { kind: "resultIn" }
                : { kind: "between" };
        return out("idle", live(view.started), line, stay);
      }
      return out("working", live(view.started), line);
    }
  }
}

/** The island of an Agent's row: the first rule that holds, as the row
 * shows it. A standing Agent's runtime gives no start for its Turn, so its
 * Working has no clock; an executor's clock is its time on the task. */
export function islandView(facts: IslandFacts): IslandView {
  const view = facts.executor ?? null;
  const { state, stay, clock, line } = view ? executor(facts, view) : standing(facts);
  const task = facts.lifecycle?.task ?? null;
  const name = task?.shortName?.trim() || task?.title?.trim() || null;
  return {
    state, stay, clock, line,
    // A turning ring, and a ring at rest whose Agent waits only on what it
    // left running (YN-92), hold what it waits on.
    wait: state === "working" || stay?.kind === "waits" ? facts.wait ?? null : null,
    title: view ? name : null,
    dot: facts.agent.kind === "lead" && (facts.agent.unreadCount || 0) > 0,
    auto: state === "waiting" || state === "failed",
    go: goOf(state, view, task?.id ?? null),
    task: task?.id ?? null,
    pr: view?.pr?.number ?? null,
  };
}

/** Where the ring goes, by state. Needs you: Home's Needs you. An
 * executor's: its task (why its start failed, its result, its place in the
 * queue, or the task), and for a Turn that failed, the conversation. A
 * standing Agent's: the conversation, for a failed Turn or one that ended
 * unseen. Idle and a standing Agent at work have nowhere of their own. */
function goOf(state: IslandState, view: ExecutorView | null, task: string | null): IslandAction | null {
  if (state === "waiting") return "answer";
  if (state === "failed") return view && task && view.detail?.kind !== "turnFailed" ? "why" : "turn";
  if (!view) return state === "done" ? "reply" : null;
  if (!task) return null;
  if (view.shown === "review") return "result";
  if (view.shown === "queued") return "queue";
  return "task";
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

/** The forms an island takes: its ring; a pill beside it (a state that
 * stays, or a passing event); the row as the island (needs you, failed). */
export type IslandForm = "ring" | "pill" | "row";
