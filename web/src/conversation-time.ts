import { formatElapsed } from "./activity-time.ts";
import { conversationBlocks } from "./conversation-blocks.ts";
import { timeFormatter, type TimeDisplay } from "./time-preferences.ts";
import type { BackgroundShells, NativeItem, NativeTurn } from "./types";
import type { Language } from "./i18n.ts";

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
const duration = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const clockTime = timeFormatter({ hour: "numeric", minute: "2-digit" });
const fullDate = timeFormatter({ dateStyle: "full", timeStyle: "short" });

export interface Moment {
  at: number;
  /** Hours and minutes only; the date lives in `title`. */
  label: string;
  title: string;
  dateTime: string;
}

/** `at` written with this device's clock format and time zone
 * (time-preferences.ts). */
export function moment(at: number, time: TimeDisplay): Moment {
  const date = new Date(at);
  return { at, label: clockTime(time).format(date), title: fullDate(time).format(date), dateTime: date.toISOString() };
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
 * neither show one nor break a run. Written with `time`: another clock
 * format or time zone makes them again. Every zone's minutes start at the
 * same instants, so this device's own minutes mark the same messages.
 */
// Detail snapshots are replaced, never mutated, so one result per array and
// time display holds.
const marksCache = new WeakMap<readonly NativeTurn[], { time: TimeDisplay; marks: Map<string, Moment> }>();

export function conversationTimeMarks(turns: readonly NativeTurn[], time: TimeDisplay): ReadonlyMap<string, Moment> {
  const cached = marksCache.get(turns);
  if (cached && cached.time === time) return cached.marks;
  const marks = new Map<string, Moment>();
  let previous: string | undefined;
  for (const turn of turns) {
    for (const block of conversationBlocks(turn.items)) {
      if (block.kind === "tools" || block.kind === "subagents") continue;
      const at = messageTime(turn, block.item);
      if (at === undefined) continue;
      const key = minuteKey(at);
      if (key !== previous) marks.set(timeMarkKey(turn.id, block.item.id), moment(at, time));
      previous = key;
    }
  }
  marksCache.set(turns, { time, marks });
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

// The calendar day a time falls on where it is shown (this device's zone, or
// the one chosen in time-preferences.ts), as a day number: Gregorian with
// Latin digits whatever the locale, so two days can be subtracted.
const calendarDate = timeFormatter({ year: "numeric", month: "numeric", day: "numeric", calendar: "gregory", numberingSystem: "latn" });
function calendarDay(at: number, time: TimeDisplay) {
  const parts = calendarDate(time).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { day: Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000, year: part("year") };
}

// A date in the interface language, in the zone times are shown in.
function dateIn(locale: string, options: Intl.DateTimeFormatOptions) {
  const made = new Map<string, Intl.DateTimeFormat>();
  return (time: TimeDisplay) => {
    const zone = time?.timeZone ?? "";
    let format = made.get(zone);
    if (!format) made.set(zone, (format = new Intl.DateTimeFormat(locale, { ...options, ...(zone ? { timeZone: zone } : {}) })));
    return format;
  };
}
// When a finished Turn ended, as its footer says it (T-70): the clock alone
// today, "yesterday" the day before, the date before that, with the year
// when it is not this year's. In Chinese (T-189); the clock as `time` says.
const endedOn = {
  en: {
    yesterday: (clock: string) => `yesterday ${clock}`,
    date: dateIn("en-US", { month: "short", day: "numeric" }),
    dateWithYear: dateIn("en-US", { year: "numeric", month: "short", day: "numeric" }),
    dated: (date: string, clock: string) => `${date}, ${clock}`,
  },
  zh: {
    yesterday: (clock: string) => `昨天 ${clock}`,
    date: dateIn("zh-CN", { month: "long", day: "numeric" }),
    dateWithYear: dateIn("zh-CN", { year: "numeric", month: "long", day: "numeric" }),
    dated: (date: string, clock: string) => `${date} ${clock}`,
  },
};

/**
 * `at` for a finished Turn's footer: its clock when it is today where it is
 * shown, "yesterday" and the clock the day before, the date and the clock
 * before that (with the year when it is another year). Days are calendar
 * days in the zone times are shown in, not 24-hour windows; `now` is read
 * when the footer is made, so a page left open past midnight says so on its
 * next render.
 */
export function endedLabel(at: number, time: TimeDisplay, language: Language = "en", now = Date.now()): string {
  const words = language === "zh-Hans" ? endedOn.zh : endedOn.en;
  const clock = clockTime(time).format(new Date(at));
  const [then, today] = [calendarDay(at, time), calendarDay(now, time)];
  if (then.day === today.day) return clock;
  if (then.day === today.day - 1) return words.yesterday(clock);
  const date = (then.year === today.year ? words.date : words.dateWithYear)(time).format(new Date(at));
  return words.dated(date, clock);
}

export type FooterPart =
  | { kind: "text"; text: string; title?: string }
  /** `label` is what the footer shows (endedLabel); `moment.title`, the
   * full date and time, is in `title`. */
  | { kind: "time"; prefix: string; moment: Moment; label: string; title: string };

// Only a completed turn is "done"; interrupted and failed turns say so.
const endings: Record<string, { elapsed: string; at: string; title: string }> = {
  completed: { elapsed: "Cooked for", at: "done ", title: "Finished" },
  interrupted: { elapsed: "Interrupted after", at: "Interrupted at ", title: "Interrupted" },
  failed: { elapsed: "Failed after", at: "Failed at ", title: "Failed" },
};
// In Chinese (T-189); the times are written as `time` says either way.
const endingsZh: Record<string, { elapsed: string; at: string; title: string }> = {
  completed: { elapsed: "用时", at: "完成于 ", title: "完成于" },
  interrupted: { elapsed: "中断前用时", at: "中断于 ", title: "中断于" },
  failed: { elapsed: "失败前用时", at: "失败于 ", title: "失败于" },
};

/**
 * Footer for a finished turn. Background shells are passed only for the
 * latest agent turn; older turns never show the thread's current processes.
 * Its times are written with `time`, its words in `language`; the end time
 * is dated against `now` (endedLabel).
 */
export function turnFooter(turn: NativeTurn, shells: BackgroundShells | null | undefined, time: TimeDisplay, language: Language = "en", now = Date.now()): FooterPart[] {
  const zh = language === "zh-Hans";
  const ending = (zh ? endingsZh : endings)[turn.status];
  if (!ending) return [];
  const parts: FooterPart[] = [];
  const elapsed = turnDuration(turn);
  if (elapsed !== undefined) parts.push({ kind: "text", text: `${ending.elapsed} ${formatElapsed(elapsed)}` });
  const completedAt = turnCompletedAt(turn);
  if (completedAt !== undefined) {
    const at = moment(completedAt, time);
    const prefix = turn.status === "completed" || elapsed === undefined ? ending.at : "";
    parts.push({ kind: "time", prefix, moment: at, label: endedLabel(completedAt, time, language, now), title: `${ending.title} ${at.title}` });
  }
  if (shells?.state === "known" && shells.count > 0)
    parts.push({ kind: "text", text: zh ? `${shells.count} 个 shell 仍在运行` : `${shells.count} ${shells.count === 1 ? "shell" : "shells"} still running` });
  else if (shells?.state === "unknown" && shells.lastCount > 0)
    parts.push({
      kind: "text",
      text: zh ? "shell 状态未知" : "shell status unknown",
      title: zh
        ? `${moment(shells.checkedAt, time).label} 时有 ${shells.lastCount} 个后台 shell 在运行。此后运行时连接已变化，因此当前数量未知。`
        : `${shells.lastCount} background ${shells.lastCount === 1 ? "shell was" : "shells were"} running at ${moment(shells.checkedAt, time).label}. The runtime connection has changed since, so the current count is unknown.`,
    });
  return parts;
}
