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
 * How this device shows times (T-189): kept in this browser or app only, for
 * this address (device-storage.ts, as Appearance and the send key are). Only
 * how a time is written changes: the date, the time zone, relative times
 * ("5 min ago") and every time Yuzuno stores stay as they are. Unset, times
 * look as they always have. A choice this device refused to save still
 * applies in this window, and its editor says it was not saved.
 */

/** - `system`: this browser's locale decides, as before.
 * - `h12`: a 12-hour clock, written as this locale writes one (1–12 in
 *   English, 0–11 in Japanese).
 * - `h24`: a 24-hour clock, 0–23. */
export const clockFormats = ["system", "h12", "h24"] as const;
export type ClockFormat = (typeof clockFormats)[number];

export type TimePreferences = { clock: ClockFormat };
export const defaultTimePreferences: TimePreferences = { clock: "system" };
const STORAGE_KEY = "yuzuno.time";

/** What `clock` adds to a time's format; nothing for `system`, so the
 * default writes exactly what it wrote before. */
function clockOptions(clock: ClockFormat | undefined): Intl.DateTimeFormatOptions {
  return clock === "h12" ? { hour12: true } : clock === "h24" ? { hourCycle: "h23" } : {};
}

/** A formatter with `options` for each clock, each made once. Times shown
 * with a clock format pass the one in effect (useClockFormat), so a change
 * writes every shown time again. */
export function clockFormatter(options: Intl.DateTimeFormatOptions) {
  const made = new Map<ClockFormat, Intl.DateTimeFormat>();
  return (clock: ClockFormat): Intl.DateTimeFormat => {
    const key = clockFormats.includes(clock) ? clock : "system";
    let format = made.get(key);
    if (!format) made.set(key, (format = new Intl.DateTimeFormat(undefined, { ...options, ...clockOptions(key) })));
    return format;
  };
}

export function readTimePreferences(): TimePreferences {
  const saved = readDeviceValue(STORAGE_KEY) as Partial<TimePreferences> | null;
  return {
    clock: clockFormats.includes(saved?.clock as ClockFormat) ? (saved!.clock as ClockFormat) : defaultTimePreferences.clock,
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
/** The clock format in effect on this device. */
export const useClockFormat = (): ClockFormat => useTimePreferences().clock;

/** What this visit's last save or reset of these preferences did, or null. */
export function useTimePreferencesSave(): TimePreferencesWrite | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** What this device holds for these preferences, read now: saved ones, none
 * (the defaults), ones it can't read (not an object, or a clock format this
 * version doesn't have; the defaults apply), or storage it can't read. */
export function timePreferencesStored(): DeviceValueState {
  const state = deviceValueState(STORAGE_KEY);
  if (state !== "saved") return state;
  const value = readDeviceValue(STORAGE_KEY) as Partial<TimePreferences> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  return value.clock === undefined || clockFormats.includes(value.clock) ? "saved" : "invalid";
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
