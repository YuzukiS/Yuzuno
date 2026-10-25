import { formatElapsed } from "./activity-time.ts";
import { conversationBlocks } from "./conversation-blocks.ts";
import { clockFormatter, type ClockFormat } from "./time-preferences.ts";
import type { BackgroundShells, NativeItem, NativeTurn } from "./types";

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
const duration = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const clockTime = clockFormatter({ hour: "numeric", minute: "2-digit" });
const fullDate = clockFormatter({ dateStyle: "full", timeStyle: "short" });

export interface Moment {
  at: number;
  /** Hours and minutes only; the date lives in `title`. */
  label: string;
  title: string;
  dateTime: string;
}

/** `at` written with this device's clock format (time-preferences.ts). */
export function moment(at: number, clock: ClockFormat): Moment {
  const date = new Date(at);
  return { at, label: clockTime(clock).format(date), title: fullDate(clock).format(date), dateTime: date.toISOString() };
}

/**
 * When a message first appeared, in Unix ms. History items carry no time of
 * their own, but a turn starts with its first input, so that one message may
 * use the native turn start. Anything else without evidence stays unknown.
 */
export function messageTime(turn: NativeTurn, item: NativeItem): number | undefined {
  const recorded = positive(item._yuzunoTime?.at);
  if (recorded) return recorded;
  const start = positive(turn.startedAt);
  if (start && item === turn.items.find((i) => i.type === "userMessage"))
    return start * 1000;
  return undefined;
}

/** Local calendar minute, including the date and UTC offset. */
function minuteKey(at: number) {
  const d = new Date(at);
  return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getTimezoneOffset()].join("-");
}

export const timeMarkKey = (turnId: string, itemId: string) => `${turnId}\n${itemId}`;

/**
 * Minute marks for the whole loaded conversation, in display order. A message
 * is marked when its minute differs from the previous timed message, so only
 * the earliest of a run in one minute shows its time. Messages without a time
 * neither show one nor break a run. Written with `clock`: another clock
 * format makes them again.
 */
// Detail snapshots are replaced, never mutated, so one result per array and
// clock format holds.
const marksCache = new WeakMap<readonly NativeTurn[], { clock: ClockFormat; marks: Map<string, Moment> }>();

export function conversationTimeMarks(turns: readonly NativeTurn[], clock: ClockFormat): ReadonlyMap<string, Moment> {
  const cached = marksCache.get(turns);
  if (cached?.clock === clock) return cached.marks;
  const marks = new Map<string, Moment>();
  let previous: string | undefined;
  for (const turn of turns) {
    for (const block of conversationBlocks(turn.items)) {
      if (block.kind === "tools" || block.kind === "subagents") continue;
      const at = messageTime(turn, block.item);
      if (at === undefined) continue;
      const key = minuteKey(at);
      if (key !== previous) marks.set(timeMarkKey(turn.id, block.item.id), moment(at, clock));
      previous = key;
    }
  }
  marksCache.set(turns, { clock, marks });
  return marks;
}

/** Elapsed time of a finished turn; never measured against the current clock. */
export function turnDuration(turn: NativeTurn): number | undefined {
  const native = duration(turn.durationMs) ?? duration(turn._yuzunoDurationMs);
  if (native !== undefined) return native;
  const [start, end] = [positive(turn.startedAt), positive(turn.completedAt)];
  if (start && end && end >= start) return (end - start) * 1000;
  const [localStart, localEnd] = [positive(turn._yuzunoStartedAt), positive(turn._yuzunoCompletedAt)];
  if (localStart && localEnd && localEnd >= localStart) return localEnd - localStart;
  return undefined;
}

export function turnCompletedAt(turn: NativeTurn): number | undefined {
  const native = positive(turn.completedAt);
  return native ? native * 1000 : positive(turn._yuzunoCompletedAt);
}

export type FooterPart =
  | { kind: "text"; text: string; title?: string }
  | { kind: "time"; prefix: string; moment: Moment; title: string };

// Only a completed turn is "done"; interrupted and failed turns say so.
const endings: Record<string, { elapsed: string; at: string; title: string }> = {
  completed: { elapsed: "Cooked for", at: "done ", title: "Finished" },
  interrupted: { elapsed: "Interrupted after", at: "Interrupted at ", title: "Interrupted" },
  failed: { elapsed: "Failed after", at: "Failed at ", title: "Failed" },
};

/**
 * Footer for a finished turn. Background shells are passed only for the
 * latest agent turn; older turns never show the thread's current processes.
 * Its times are written with `clock`.
 */
export function turnFooter(turn: NativeTurn, shells: BackgroundShells | null | undefined, clock: ClockFormat): FooterPart[] {
  const ending = endings[turn.status];
  if (!ending) return [];
  const parts: FooterPart[] = [];
  const elapsed = turnDuration(turn);
  if (elapsed !== undefined) parts.push({ kind: "text", text: `${ending.elapsed} ${formatElapsed(elapsed)}` });
  const completedAt = turnCompletedAt(turn);
  if (completedAt !== undefined) {
    const at = moment(completedAt, clock);
    const prefix = turn.status === "completed" || elapsed === undefined ? ending.at : "";
    parts.push({ kind: "time", prefix, moment: at, title: `${ending.title} ${at.title}` });
  }
  if (shells?.state === "known" && shells.count > 0)
    parts.push({ kind: "text", text: `${shells.count} ${shells.count === 1 ? "shell" : "shells"} still running` });
  else if (shells?.state === "unknown" && shells.lastCount > 0)
    parts.push({
      kind: "text",
      text: "shell status unknown",
      title: `${shells.lastCount} background ${shells.lastCount === 1 ? "shell was" : "shells were"} running at ${moment(shells.checkedAt, clock).label}. The runtime connection has changed since, so the current count is unknown.`,
    });
  return parts;
}
