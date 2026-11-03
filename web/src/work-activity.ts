/**
 * What the conversation's work comes to, as a line rather than a column
 * (T-15). Jobs, CI runs and sub-agents are three different kinds of work and
 * are counted apart: a tool that returned, a process that succeeded and a
 * check that passed are not the same fact, and adding them up would say
 * something none of them says.
 *
 * Three states, and only three: what is still going, what ended well, and
 * what went wrong. What went wrong is never folded into the others, since it
 * is the reason to look.
 */
export type WorkKind = "job" | "run" | "subAgent";
/**
 * `unrecognized` is work this build has no word for -- a Core older or newer
 * than it. It is counted and shown apart rather than dropped: Work activity
 * is where someone looks for what needs a look, and a count that reads clean
 * while something sits unclassified elsewhere is the gap worth avoiding. It
 * is never folded into done.
 */
export type WorkState = "current" | "done" | "exception" | "unrecognized";

export type WorkItem = {
  /** Unique within its kind. The same id twice is the same work. */
  id: string;
  kind: WorkKind;
  state: WorkState;
  /**
   * Stopped where it can be taken up again -- a Job held at a checkpoint.
   * It is an exception because it needs a decision, not because anything
   * went wrong, so it is worded apart and never called failed.
   */
  resumable?: boolean;
};

export type KindCount = { current: number; done: number; exception: number; unrecognized: number };
export type WorkActivity = {
  /** Each kind on its own, for a reader who asked what happened. */
  byKind: Record<WorkKind, KindCount>;
  /** Still going, and gone wrong, across the kinds: what a glance needs. */
  current: number;
  exception: number;
  /** Work no word here covers, kept visible so it is not lost quietly. */
  unrecognized: number;
  /** Whether there is anything at all to show an entry for. */
  any: boolean;
};

const empty = (): KindCount => ({ current: 0, done: 0, exception: 0, unrecognized: 0 });

/**
 * Counts work once per kind and id. Core and the conversation can both
 * report the same Job -- a live one also sits in the page behind it -- and
 * counting it twice would show work that is not there.
 */
export function workActivity(items: readonly WorkItem[]): WorkActivity {
  const byKind: Record<WorkKind, KindCount> = { job: empty(), run: empty(), subAgent: empty() };
  const seen = new Set<string>();
  for (const item of items) {
    if (!item?.id || !byKind[item.kind]) continue;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    byKind[item.kind][item.state] += 1;
  }
  const total = (state: WorkState) =>
    byKind.job[state] + byKind.run[state] + byKind.subAgent[state];
  const current = total("current");
  const exception = total("exception");
  const unrecognized = total("unrecognized");
  return { byKind, current, exception, unrecognized,
    any: current + exception + unrecognized + total("done") > 0 };
}

/**
 * Whether a piece of work is counted at all, and as what. Classifying is
 * where this can go wrong quietly, so each kind reads its own vocabulary
 * here rather than at the call sites.
 *
 * An ending nobody can vouch for is not a normal ending: Core keeps
 * `unknown` for a Job whose outcome it lost, and calling that done would
 * report a success that was never observed.
 */
export type Counted = WorkState | "uncounted";

/** A Job, by the status Core gives it. */
export function jobWork(status: string): Counted {
  switch (status) {
    case "waiting": case "queued": case "starting": case "running": case "cancelling":
      return "current";
    // Core's own word for exit 0 with its artifacts checked, not our verdict.
    case "succeeded":
      return "done";
    case "failed": case "cancelled": case "rejected": case "interrupted": case "unknown":
      return "exception";
    default:
      // Said as its own thing rather than guessed at or dropped. The test
      // below walks Core's own table, so a status added there without a word
      // here fails before anyone sees it; this branch is for a Core of
      // another age.
      return "unrecognized";
  }
}

/** A CI run, by what GitHub concluded for it. */
export function runWork(status: string, conclusion: string | null | undefined): Counted {
  if (status === "running" || status === "pending") return "current";
  switch (conclusion) {
    case "success":
      return "done";
    case "failure": case "cancelled": case "timed_out": case "action_required":
      return "exception";
    // Neither: a run that was not asked to decide anything. It is only worth
    // a number if the line says that word itself.
    case "skipped": case "neutral":
      return "uncounted";
    case null: case undefined: case "":
      return "uncounted";
    default:
      return "unrecognized";
  }
}

/** A sub-agent, by the status its harness reports (claude-subagents.ts). */
export function subAgentWork(status: string): Counted {
  switch (status) {
    // Starting, paused and running in the background are all still going.
    case "running": case "pending": case "paused":
      return "current";
    case "succeeded": case "completed": case "ended":
      return "done";
    case "failed": case "cancelled": case "unknown":
      return "exception";
    default:
      return "unrecognized";
  }
}

/**
 * What to look at first among the exceptions. Something that failed outright
 * comes before something only waiting to be taken up again: a Job held at a
 * checkpoint is a reason to look, but not ahead of a CI run that failed.
 *
 * Sorts exceptions first, then what is still going, then work with no word
 * here, then what ended well.
 */
const rank = (item: WorkItem): number => {
  if (item.state === "exception") return item.resumable ? 1 : 0;
  if (item.state === "current") return 2;
  if (item.state === "unrecognized") return 3;
  return 4;
};

/** A stable order: equal ranks stay as they came. */
export function byAttention(items: readonly WorkItem[]): WorkItem[] {
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.order - b.order)
    .map(({ item }) => item);
}
