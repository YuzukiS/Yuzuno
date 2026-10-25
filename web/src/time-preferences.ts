import { useSyncExternalStore } from "react";
import {
  clearDeviceValue,
  deviceValueState,
  onDeviceValueChange,
  readDeviceValue,
  saveDeviceValue,
  type DeviceValueState,
  type SaveOutcome,
} from "./device-storage.ts";

/**
 * How this device shows times (T-189): its clock format and time zone, kept
 * in this browser or app only, for this address (device-storage.ts, as
 * Appearance and the send key are). Only how a time is written changes:
 * relative times ("5 min ago"), business times (Defer's "Tomorrow 9:00" is
 * this device's own 9:00) and every time Yuzuno stores stay as they are.
 * Unset, times look as they always have. A choice this device refused to
 * save still applies in this window, and its editor says it was not saved.
 */

/** - `system`: this browser's locale decides, as before.
 * - `h12`: a 12-hour clock, written as this locale writes one (1–12 in
 *   English, 0–11 in Japanese).
 * - `h24`: a 24-hour clock, 0–23. */
export const clockFormats = ["system", "h12", "h24"] as const;
export type ClockFormat = (typeof clockFormats)[number];

/** `timeZone`: an IANA time zone that times are shown in, or null for this
 * device's own. A time shown in another zone may fall on another day there:
 * its date is that zone's too. */
export type TimePreferences = { clock: ClockFormat; timeZone: string | null };
export const defaultTimePreferences: TimePreferences = { clock: "system", timeZone: null };
/** What writes a time takes: the preferences in effect, as one value, so a
 * change of either is a change of it. */
export type TimeDisplay = TimePreferences;
const STORAGE_KEY = "yuzuno.time";

/** This device's own time zone, as the browser names it. */
export const systemTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Whether this browser can show times in `zone`. */
export function knownTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The time zones this browser can show times in; empty when it can't list
 * them (then only this device's own is offered). */
export function timeZones(): string[] {
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return list.length && !list.includes("UTC") ? [...list, "UTC"] : list;
}

/** What `time` adds to a time's format; nothing for the defaults, so they
 * write exactly what they wrote before. */
function displayOptions(clock: ClockFormat, timeZone: string | null): Intl.DateTimeFormatOptions {
  return {
    ...(clock === "h12" ? { hour12: true } : clock === "h24" ? { hourCycle: "h23" } : {}),
    ...(timeZone ? { timeZone } : {}),
  };
}

/** A formatter with `options` for each clock format and time zone, each made
 * once. Times shown with these preferences pass the ones in effect
 * (useTimeDisplay), so a change writes every shown time again. */
export function timeFormatter(options: Intl.DateTimeFormatOptions) {
  const made = new Map<string, Intl.DateTimeFormat>();
  return (time: TimeDisplay | undefined): Intl.DateTimeFormat => {
    const clock = time && clockFormats.includes(time.clock) ? time.clock : "system";
    const timeZone = time?.timeZone ?? null;
    const key = `${clock} ${timeZone ?? ""}`;
    let format = made.get(key);
    if (!format) made.set(key, (format = new Intl.DateTimeFormat(undefined, { ...options, ...displayOptions(clock, timeZone) })));
    return format;
  };
}

export function readTimePreferences(): TimePreferences {
  const saved = readDeviceValue(STORAGE_KEY) as Partial<TimePreferences> | null;
  return {
    clock: clockFormats.includes(saved?.clock as ClockFormat) ? (saved!.clock as ClockFormat) : defaultTimePreferences.clock,
    timeZone: knownTimeZone(saved?.timeZone) ? saved!.timeZone! : defaultTimePreferences.timeZone,
  };
}

// The choice in effect: read once, then again whenever chosen here or saved
// in another window.
const listeners = new Set<() => void>();
let current: TimePreferences | null = null;
/** What this visit's last write of these preferences did: a save or a reset,
 * and which write it was (a new number each time). */
export type TimePreferencesWrite = { outcome: SaveOutcome; action: "save" | "reset"; attempt: number };
// Null before one.
let lastSave: TimePreferencesWrite | null = null;
let attempts = 0;
const notify = () => listeners.forEach((listener) => listener());
let stopWatching: (() => void) | undefined;
const subscribe = (listener: () => void) => {
  if (!listeners.size) stopWatching = onDeviceValueChange(STORAGE_KEY, changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopWatching?.();
  };
};
// Another window saved: what is in effect here is what is saved now.
function changed() {
  current = null;
  lastSave = null;
  notify();
}
export function useTimePreferences(): TimePreferences {
  return useSyncExternalStore(subscribe, () => (current ??= readTimePreferences()));
}
/** How times are written on this device now. */
export const useTimeDisplay = (): TimeDisplay => useTimePreferences();

/** What this visit's last save or reset of these preferences did, or null. */
export function useTimePreferencesSave(): TimePreferencesWrite | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** What this device holds for these preferences, read now: saved ones, none
 * (the defaults), ones it can't read (not an object, or a clock format or
 * time zone this version or browser doesn't have; the defaults apply), or
 * storage it can't read. */
export function timePreferencesStored(): DeviceValueState {
  const state = deviceValueState(STORAGE_KEY);
  if (state !== "saved") return state;
  const value = readDeviceValue(STORAGE_KEY) as Partial<TimePreferences> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const clock = value.clock === undefined || clockFormats.includes(value.clock);
  const zone = value.timeZone === undefined || value.timeZone === null || knownTimeZone(value.timeZone);
  return clock && zone ? "saved" : "invalid";
}

/** Applies the choice now and saves it on this device. A refused write is
 * reported, not hidden: the choice still applies in this window. */
export function saveTimePreferences(preferences: TimePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  current = preferences;
  lastSave = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}

/** Tries this visit's last write again, as it was. */
export function retryTimePreferencesWrite(): SaveOutcome {
  return lastSave?.action === "reset"
    ? restoreDefaultTimePreferences()
    : saveTimePreferences(current ?? readTimePreferences());
}

/** Back to the defaults on this device: its saved choice is removed. */
export function restoreDefaultTimePreferences(): SaveOutcome {
  const outcome = clearDeviceValue(STORAGE_KEY);
  current = defaultTimePreferences;
  lastSave = { outcome, action: "reset", attempt: ++attempts };
  notify();
  return outcome;
}
