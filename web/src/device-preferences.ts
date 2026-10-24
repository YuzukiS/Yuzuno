import { useSyncExternalStore } from "react";
import { clearDeviceValue, deviceStorageReadable, onDeviceValueChange, readDeviceValue, saveDeviceValue, type SaveOutcome } from "./device-storage";

/**
 * How this device is used (T-189): kept in this browser or app only, for
 * this address (device-storage.ts, as Appearance is). They do not travel to
 * other devices. Unset, each one behaves as Yuzuno always has. A choice this
 * device refused to save still applies in this window, and its editor says
 * it was not saved.
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
// What this visit's last save or reset did; null before one.
let lastSave: SaveOutcome | null = null;
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
export function useDevicePreferencesSave(): SaveOutcome | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** Whether this device can read its saved preferences at all. */
export function preferencesReadable(): boolean {
  return deviceStorageReadable(STORAGE_KEY);
}

/** Applies the choice now and saves it on this device. A refused write is
 * reported, not hidden: the choice still applies in this window. */
export function savePreferences(preferences: DevicePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  current = preferences;
  lastSave = outcome;
  notify();
  return outcome;
}

/** Back to the defaults on this device: its saved choice is removed. */
export function restoreDefaultPreferences(): SaveOutcome {
  const outcome = clearDeviceValue(STORAGE_KEY);
  current = defaultPreferences;
  lastSave = outcome;
  notify();
  return outcome;
}
