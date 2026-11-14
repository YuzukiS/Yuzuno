import type { Language } from "../i18n";
import { timeFormatter, type TimeDisplay } from "../time-preferences.ts";
import { refreshText } from "./refresh-text.ts";
import type { RefreshCadence, RefreshReason, SectionRefresh } from "./types";

type Text = ReturnType<typeof refreshText>;

/** A schedule in words: "Daily 08:00", "Every 3 h", "Weekly Mon, Wed 08:00". */
export function cadenceLabel(cadence: RefreshCadence, language: Language, t: Text = refreshText(language)): string {
  const at = cadence.at ?? "00:00";
  if (cadence.every === "day") return t.scheduleDaily(at);
  if (cadence.every === "hours") return t.scheduleHours(cadence.hours ?? 24);
  const days = (cadence.days ?? []).map((day) => t.panel.weekdays[day - 1]).filter(Boolean);
  return t.scheduleWeekly(days.join(language === "zh-Hans" ? "、" : ", "), at);
}

/** The Turns a week it starts, as brief_update's refresh counts them (Core's weeklyRuns). */
export function weeklyRunsOf(cadence: RefreshCadence): number {
  if (cadence.every === "day") return 7;
  if (cadence.every === "hours") return Math.floor(168 / (cadence.hours || 24));
  return cadence.days?.length ?? 0;
}

/** Core's reason in the language shown. */
export const reasonText = (reason: RefreshReason | null | undefined, language: Language) =>
  !reason ? "" : language === "zh-Hans" ? reason.messageZh : reason.message;

export type RefreshStateKind = "refreshed" | "caughtUp" | "refreshing" | "waiting" | "failed" | "paused" | "notYet";

/** What the card's foot says of the last run, and how it reads. The schedule itself is the head's tag. */
export function refreshStatus(
  refresh: SectionRefresh,
  language: Language,
  clock: (iso: string | null | undefined) => string,
  ownerName: string,
): { kind: RefreshStateKind; text: string } {
  const t = refreshText(language);
  if (!refresh.enabled) return { kind: "paused", text: t.state.paused(reasonText(refresh.pausedReason, language) || t.state.noReason) };
  const waiting = refresh.waiting;
  if (waiting) {
    const name = waiting.agentName || ownerName;
    if (waiting.reason === "refused") return { kind: "failed", text: t.state.failed(waiting.error || t.state.noReason) };
    if (waiting.reason === "offline") return { kind: "waiting", text: t.state.waitingOffline(name) };
    if (waiting.reason === "approval") return { kind: "waiting", text: t.state.waitingApproval(name) };
    return { kind: "waiting", text: t.state.waitingBusy(name) };
  }
  const run = refresh.run;
  if (run?.state === "sent") return { kind: "refreshing", text: t.state.refreshing(run.missed) };
  if (run?.state === "refreshed") {
    const at = clock(run.endedAt ?? run.slot);
    return run.missed > 0 ? { kind: "caughtUp", text: t.state.caughtUp(at, run.missed) } : { kind: "refreshed", text: t.state.refreshed(at) };
  }
  if (run?.state === "failed" || run?.state === "skipped")
    return { kind: "failed", text: t.state.failed(reasonText(run.reason, language) || t.state.noReason) };
  return { kind: "notYet", text: t.state.notYet };
}

/** One of the last ten runs in a word, and its reason when it has one. */
export function recentLabel(run: { state: string; missed: number; reason?: RefreshReason }, language: Language): string {
  const t = refreshText(language);
  const state = run.state === "refreshed" && run.missed > 0 ? t.panel.recentState.caughtUp : t.panel.recentState[run.state as keyof typeof t.panel.recentState] ?? run.state;
  return state;
}

const clockFormat = timeFormatter({ hour: "2-digit", minute: "2-digit" });
/** "08:01": a time of day, in the reader's clock and time zone. */
export const refreshClock = (time: TimeDisplay | undefined) => (iso: string | null | undefined) =>
  !iso || !Number.isFinite(Date.parse(iso)) ? "" : clockFormat(time).format(new Date(iso));

const dateClockFormat = timeFormatter({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** "Nov 14, 08:01": a moment, in the reader's clock and time zone. */
export const refreshDateTime = (time: TimeDisplay | undefined) => (iso: string | null | undefined) =>
  !iso || !Number.isFinite(Date.parse(iso)) ? "" : dateClockFormat(time).format(new Date(iso));
