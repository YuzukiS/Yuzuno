import { useSyncExternalStore } from "react";
import {
  clearDeviceValue,
  deviceValueState,
  onDeviceValueChange,
  readDeviceValue,
  saveDeviceValue,
  type DeviceValueState,
  type SaveOutcome,
} from "./device-storage";

/**
 * How this device is used (T-189): kept in this browser or app only, for
 * this address (device-storage.ts, as Appearance is). They do not travel to
 * other devices. Unset, each one behaves as Yuzuno always has. A choice this
 * device refused to save still applies in this window, and its editor says
 * it was not saved: what applies a preference reads the choice in effect
 * (useDevicePreferences), not what is stored.
 */

/** Which key sends from the conversation's composer.
 * - `auto`: Return sends from a keyboard; on a touch screen's own keyboard,
 *   which has no Shift+Return, it makes a new line (T-170).
 * - `enter`: Return sends and Shift+Return makes a new line, everywhere.
 * - `modEnter`: Return makes a new line and Ctrl/⌘+Return sends.
 * Ctrl/⌘+Return always sends and Shift+Return always makes a new line; while
 * an input method is composing, Return is the input method's. */
export const sendKeys = ["auto", "enter", "modEnter"] as const;
export type SendKey = (typeof sendKeys)[number];

export type DevicePreferences = { sendKey: SendKey };
export const defaultPreferences: DevicePreferences = { sendKey: "auto" };
const STORAGE_KEY = "yuzuno.preferences";

/** Whether Return alone sends, with this preference on this device. */
export function returnSends(sendKey: SendKey, touch: boolean): boolean {
  return sendKey === "enter" || (sendKey === "auto" && !touch);
}

export function readPreferences(): DevicePreferences {
  const saved = readDeviceValue(STORAGE_KEY) as Partial<DevicePreferences> | null;
  return {
    sendKey: sendKeys.includes(saved?.sendKey as SendKey) ? (saved!.sendKey as SendKey) : defaultPreferences.sendKey,
  };
}

// The choice in effect: read once, then again whenever chosen here or saved
// in another window.
const listeners = new Set<() => void>();
let current: DevicePreferences | null = null;
/** What this visit's last write of these preferences did: a save or a reset,
 * and which write it was (a new number each time, also when the outcome is
 * the same as the last one's). */
export type PreferencesWrite = { outcome: SaveOutcome; action: "save" | "reset"; attempt: number };
// Null before one.
let lastSave: PreferencesWrite | null = null;
let attempts = 0;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  if (!listeners.size) stopWatching = onDeviceValueChange(STORAGE_KEY, changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopWatching?.();
  };
};
let stopWatching: (() => void) | undefined;
// Another window saved: what is in effect here is what is saved now.
function changed() {
  current = null;
  lastSave = null;
  notify();
}
export function useDevicePreferences(): DevicePreferences {
  return useSyncExternalStore(subscribe, () => (current ??= readPreferences()));
}

/** What this visit's last save or reset of these preferences did, or null. */
export function useDevicePreferencesSave(): PreferencesWrite | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** What this device holds for these preferences, read now: saved ones, none
 * (the defaults), ones it can't read (not an object, or a send key this
 * version doesn't have; the defaults apply), or storage it can't read at
 * all. An object without a send key is saved: it may hold another of these
 * preferences only. */
export function preferencesStored(): DeviceValueState {
  const state = deviceValueState(STORAGE_KEY);
  if (state !== "saved") return state;
  const value = readDeviceValue(STORAGE_KEY) as Partial<DevicePreferences> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  return value.sendKey === undefined || sendKeys.includes(value.sendKey) ? "saved" : "invalid";
}

/** Applies the choice now and saves it on this device. A refused write is
 * reported, not hidden: the choice still applies in this window. */
export function savePreferences(preferences: DevicePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  current = preferences;
  lastSave = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}

/** Tries this visit's last write again, as it was: a save of the choice in
 * effect, or a reset that removes this device's choice (not a save of the
 * defaults). */
export function retryPreferencesWrite(): SaveOutcome {
  return lastSave?.action === "reset" ? restoreDefaultPreferences() : savePreferences(current ?? readPreferences());
}

/** Back to the defaults on this device: its saved choice is removed. */
export function restoreDefaultPreferences(): SaveOutcome {
  const outcome = clearDeviceValue(STORAGE_KEY);
  current = defaultPreferences;
  lastSave = { outcome, action: "reset", attempt: ++attempts };
  notify();
  return outcome;
}

/** Saves imported preferences on this device and only then applies them
 * (T-194): unlike a choice made here, a refused write changes nothing, in
 * storage or in what is in effect. */
export function importPreferences(preferences: DevicePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  if (!outcome.saved) return outcome;
  current = preferences;
  lastSave = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}
