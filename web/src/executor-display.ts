import type { ExecutorLifecycle } from "./executor-lifecycle";
import type { Agent } from "./types";

/**
 * An executor's row in the sidebar says one state (T-43 S2, g2): what its
 * runtime and its lifecycle each say, in one word, with what it is at.
 * Pure: the words are ExecutorRowState.tsx's, the facts Core's (the
 * lifecycle in the Agent listing, its PR from /api/executors/live).
 */
export type ExecutorShown = "queued" | "working" | "needsYou" | "review" | "done" | "failed" | "stopped";

/** An open executor's PR as /api/executors/live gives it. */
export type ExecutorPR = {
  number: number;
  url?: string | null;
  /** open, draft, merged or closed, as Core last read it from GitHub. */
  state?: string | null;
  /** The checks on its head: success, failure, pending, cancelled, none,
   * neutral or unknown (unknown when Core last saw them for another commit). */
  ci?: string | null;
  /** The rounds on its head: approvals since the newest request for changes. */
  reviews?: { approved: number; changesRequested: boolean; running: boolean } | null;
};

/** The rounds a PR has before it counts as approved: two full rounds, the
 * standard flow and the default steps of a PR template until a template
 * carries its own (T-43 S1a). */
export const REVIEW_ROUNDS = 2;

export type PRStatus =
  | { kind: "merged" }
  | { kind: "closed" }
  | { kind: "changes" }
  | { kind: "ciFailed" }
  | { kind: "rounds"; approved: number; of: number; running: boolean }
  | { kind: "approved"; ciPending: boolean }
  | { kind: "draft" };
export type PRTone = "ok" | "wait" | "bad";

/** What a PR is at, in the order that decides it: merged or closed; a
 * request for changes; failed checks; its rounds; a draft not yet reviewed. */
export function prStatus(pr: ExecutorPR): { status: PRStatus; tone: PRTone } {
  const reviews = pr.reviews ?? { approved: 0, changesRequested: false, running: false };
  if (pr.state === "merged") return { status: { kind: "merged" }, tone: "ok" };
  if (pr.state === "closed") return { status: { kind: "closed" }, tone: "bad" };
  if (reviews.changesRequested && !reviews.running) return { status: { kind: "changes" }, tone: "bad" };
  if (pr.ci === "failure" || pr.ci === "cancelled") return { status: { kind: "ciFailed" }, tone: "bad" };
  if (reviews.approved >= REVIEW_ROUNDS && !reviews.running)
    return { status: { kind: "approved", ciPending: pr.ci !== "success" }, tone: pr.ci === "success" ? "ok" : "wait" };
  if (pr.state === "draft" && !reviews.approved && !reviews.running) return { status: { kind: "draft" }, tone: "wait" };
  return { status: { kind: "rounds", approved: Math.min(reviews.approved, REVIEW_ROUNDS), of: REVIEW_ROUNDS, running: reviews.running }, tone: "wait" };
}

/** What the state's word is followed by. */
export type ExecutorDetail =
  | { kind: "position"; position: number }
  /** Queued for a routing candidate, not a slot (YN-57). */
  | { kind: "candidate" }
  | { kind: "starting" }
  | { kind: "awaitingRelease" }
  | { kind: "pr"; status: PRStatus }
  | { kind: "blocked"; text: string }
  | { kind: "check" }
  | { kind: "waiting"; label: string }
  | { kind: "released" }
  | { kind: "archiving"; text: string | null }
  | { kind: "reason"; text: string }
  | { kind: "turnFailed" }
  | { kind: "closed" }
  | { kind: "offline" };

export type ExecutorView = {
  shown: ExecutorShown;
  detail: ExecutorDetail | null;
  /** Since when (ms) it has waited for you, while it does. */
  waitingSince: number | null;
  /** Its time on the task (ms): from its dispatch, and once it is over, to its end. */
  started: number | null;
  ended: number | null;
  pr: { number: number; url: string | null; tone: PRTone; status: PRStatus } | null;
};

export type ExecutorFacts = {
  agent: Pick<Agent, "status" | "pendingCount" | "closedAt" | "disconnectedAt">;
  lifecycle: ExecutorLifecycle;
  /** Its last Turn's end this device has not shown (T-42). */
  unseen?: "finished" | "failed" | null;
  /** The label of an idle Agent's unfinished Job or CI work, as the row reads it. */
  waiting?: string | null;
  pr?: ExecutorPR | null;
  /** Its oldest wait in Home's Needs you (ms). */
  waitingSince?: number | null;
  /** It asked you on Home to approve a gate step and waits for the answer (T-43 S4). */
  asking?: boolean;
};

const time = (iso: string | null | undefined) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
};

/**
 * The one state, the first of these that holds:
 * 1. archived: done, released; 2. archiving: done, with what it waits for;
 * 3. failed (its start, or closed while its task is blocked on it): failed,
 * with why; 4. closed: stopped; 5. queued or starting: queued;
 * 6. requests or questions waiting, a gate's ask on Home (T-43 S4), or a
 * runtime waiting: needs you, for how long (what it asks is its work summary);
 * 7. its Turn failed: failed; 8. offline or disconnected: stopped;
 * 9. delivering (its result in, its task in review): review, at its PR, else
 * awaiting release; 10. otherwise working: its task's blocker, a result to
 * check, its PR, or its unfinished Jobs and CI.
 */
export function executorView(facts: ExecutorFacts): ExecutorView {
  const { agent, lifecycle } = facts;
  const pr = facts.pr && Number.isSafeInteger(facts.pr.number) ? { number: facts.pr.number, url: facts.pr.url ?? null, ...prStatus(facts.pr) } : null;
  const started = time(lifecycle.dispatchedAt);
  const view = (shown: ExecutorShown, detail: ExecutorDetail | null, ended: number | null = null, waitingSince: number | null = null): ExecutorView =>
    ({ shown, detail, waitingSince, started, ended, pr });
  const closed = time(agent.closedAt);
  switch (lifecycle.state) {
    case "archived":
      return view("done", { kind: "released" }, time(lifecycle.since) ?? closed);
    case "archiving":
      return view("done", { kind: "archiving", text: lifecycle.reason || null });
    case "failed":
      return view("failed", lifecycle.reason ? { kind: "reason", text: lifecycle.reason } : null, closed ?? time(lifecycle.since));
    case "closed":
      return view("stopped", { kind: "closed" }, closed);
    case "queued":
      // Waiting for a routing candidate is not a place in the slot queue (YN-57).
      return view("queued", lifecycle.route?.kind === "waiting" ? { kind: "candidate" }
        : lifecycle.position ? { kind: "position", position: lifecycle.position } : null);
    case "starting":
      return view("queued", { kind: "starting" });
  }
  // What it asks is the row's work summary, under this line: said once.
  if (agent.pendingCount > 0 || agent.status === "waiting" || facts.asking) return view("needsYou", null, null, facts.waitingSince ?? null);
  if (agent.status === "error" || facts.unseen === "failed") return view("failed", { kind: "turnFailed" });
  if (agent.status === "offline" || agent.disconnectedAt) return view("stopped", { kind: "offline" });
  if (lifecycle.state === "delivering") return view("review", pr ? { kind: "pr", status: pr.status } : { kind: "awaitingRelease" });
  if (lifecycle.blocked) return view("working", { kind: "blocked", text: lifecycle.blocked });
  if (agent.status === "uncertain") return view("working", { kind: "check" });
  if (pr) return view("working", { kind: "pr", status: pr.status });
  return view("working", facts.waiting ? { kind: "waiting", label: facts.waiting } : null);
}

/** Its time on the task, as the row shows it: "38 min", "1 h 05 min",
 * "2 d 4 h"; under a minute, "<1 min". */
export function elapsedText(ms: number, language: "en" | "zh-Hans"): string {
  const zh = language === "zh-Hans";
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return zh ? "<1 分钟" : "<1 min";
  if (minutes < 60) return zh ? `${minutes} 分钟` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = String(minutes % 60).padStart(2, "0");
    return zh ? `${hours} 小时 ${rest} 分` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天 ${hours % 24} 小时` : `${days} d ${hours % 24} h`;
}
