/** Small display helpers for Home. Unknown values stay "unknown", never 0. */

import { timeFormatter, type TimeDisplay } from "../time-preferences.ts";

export const UNKNOWN = "unknown";

/** "1 job", "2 jobs"; `many` for irregular plurals. */
export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function known(value: number | null | undefined, format: (n: number) => string) {
  return value == null || !Number.isFinite(value) ? UNKNOWN : format(value);
}

export const percent = (value: number | null | undefined) =>
  known(value, (n) => `${Math.round(n)}%`);

export const mebibytes = (value: number | null | undefined) =>
  known(value, (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GiB` : `${Math.round(n)} MiB`));

/** "5 min ago", "in 2 h": relative to now, coarse on purpose. */
export function relative(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  const future = diff > 0;
  const seconds = Math.abs(diff) / 1000;
  const text =
    seconds < 45
      ? "just now"
      : seconds < 3600
        ? `${Math.round(seconds / 60)} min`
        : seconds < 86_400
          ? `${Math.round(seconds / 3600)} h`
          : `${Math.round(seconds / 86_400)} d`;
  return text === "just now" ? text : future ? `in ${text}` : `${text} ago`;
}

const absoluteTime = timeFormatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** "Oct 24, 09:05 PM": written with this device's clock format and time zone. */
export function absolute(iso: string | null | undefined, time: TimeDisplay) {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? absoluteTime(time).format(at) : "";
}

export function duration(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

/** The deferral choices: an hour from now, tomorrow 9:00, next Monday 9:00. */
export function deferChoices(now = new Date()) {
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(now);
  week.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  week.setHours(9, 0, 0, 0);
  return [
    { id: "hour", label: "1 hour", until: hour.toISOString() },
    { id: "tomorrow", label: "Tomorrow", until: tomorrow.toISOString() },
    { id: "week", label: "Next week", until: week.toISOString() },
  ];
}
