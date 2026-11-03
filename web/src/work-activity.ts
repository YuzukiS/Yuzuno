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
export type WorkState = "current" | "done" | "exception";

export type WorkItem = {
  /** Unique within its kind. The same id twice is the same work. */
  id: string;
  kind: WorkKind;
  state: WorkState;
};

export type KindCount = { current: number; done: number; exception: number };
export type WorkActivity = {
  /** Each kind on its own, for a reader who asked what happened. */
  byKind: Record<WorkKind, KindCount>;
  /** Still going, and gone wrong, across the kinds: what a glance needs. */
  current: number;
  exception: number;
  /** Whether there is anything at all to show an entry for. */
  any: boolean;
};

const empty = (): KindCount => ({ current: 0, done: 0, exception: 0 });

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
  return { byKind, current, exception, any: current + exception + total("done") > 0 };
}
