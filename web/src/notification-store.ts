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
import { NOTIFICATION_PREFS_KEY, defaultNotificationPrefs, parseNotificationPrefs, type NotificationPrefs } from "./notification-prefs";

// This device's notification choices in effect (T-188): read once, then
// again when another window saves them. A choice this device refused to save
// is still the one in effect here until this window closes, as for
// Appearance (T-187).
const listeners = new Set<() => void>();
let current: NotificationPrefs | null = null;
/** What this visit's last write did: a save or a reset; null before one.
 * Each write is numbered, so the same refusal twice is shown twice (T-189). */
export type NotificationPrefsWrite = { outcome: SaveOutcome; action: "save" | "reset"; attempt: number };
let lastWrite: NotificationPrefsWrite | null = null;
let attempts = 0;
let stopWatching: (() => void) | null = null;
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  stopWatching ??= onDeviceValueChange(NOTIFICATION_PREFS_KEY, () => {
    // Another window saved: what is in effect here is what is saved now.
    current = null;
    lastWrite = null;
    changed();
  });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopWatching?.();
      stopWatching = null;
    }
  };
};
const read = () => parseNotificationPrefs(readDeviceValue(NOTIFICATION_PREFS_KEY));

export const useNotificationPrefs = (): NotificationPrefs => useSyncExternalStore(subscribe, () => (current ??= read()));
export const useNotificationPrefsWrite = (): NotificationPrefsWrite | null => useSyncExternalStore(subscribe, () => lastWrite);

/** What this device holds, read now: a saved choice, none (the defaults), one
 * it can't read (not an object; the defaults apply), or unreadable storage. */
export function notificationPrefsStored(): DeviceValueState {
  const state = deviceValueState(NOTIFICATION_PREFS_KEY);
  if (state !== "saved") return state;
  const value = readDeviceValue(NOTIFICATION_PREFS_KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? "saved" : "invalid";
}

/** Saves `prefs` on this device; a refused write is reported, and the choice
 * still applies in this window. */
export function saveNotificationPrefs(prefs: NotificationPrefs): SaveOutcome {
  const outcome = saveDeviceValue(NOTIFICATION_PREFS_KEY, prefs);
  current = prefs;
  lastWrite = { outcome, action: "save", attempt: ++attempts };
  changed();
  return outcome;
}

/** Changes the choice in effect (not the one a render saw, which a quick
 * second change could undo) and saves the result. */
export const changeNotificationPrefs = (change: (prefs: NotificationPrefs) => NotificationPrefs): SaveOutcome =>
  saveNotificationPrefs(change(current ?? read()));

/** Back to the defaults on this device (notifications off): its saved choice
 * is removed. */
export function restoreDefaultNotificationPrefs(): SaveOutcome {
  const outcome = clearDeviceValue(NOTIFICATION_PREFS_KEY);
  current = defaultNotificationPrefs;
  lastWrite = { outcome, action: "reset", attempt: ++attempts };
  changed();
  return outcome;
}

/** This visit's last write again, as it was: a save of the choice in effect,
 * or a reset. */
export function retryNotificationPrefsWrite(): SaveOutcome {
  return lastWrite?.action === "reset" ? restoreDefaultNotificationPrefs() : saveNotificationPrefs(current ?? read());
}
