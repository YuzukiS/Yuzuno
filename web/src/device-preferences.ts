import { useSyncExternalStore } from "react";

/**
 * How this device is used (T-189): kept in this browser or app only, for
 * this address. They do not travel to other devices. Unset, each one
 * behaves as Yuzuno always has.
 *
 * Saving says whether it was kept. A browser that refuses to store it (no
 * storage, or storage full) gets the choice for this visit only, and the
 * editor says so instead of "Saved".
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
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return {
      sendKey: sendKeys.includes(saved?.sendKey) ? saved.sendKey : defaultPreferences.sendKey,
    };
  } catch {
    return defaultPreferences;
  }
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

// Read once, then again whenever saved here or in another window.
const listeners = new Set<() => void>();
let current: DevicePreferences | null = null;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useDevicePreferences(): DevicePreferences {
  return useSyncExternalStore(subscribe, () => (current ??= readPreferences()));
}

/** Applies the choice now and keeps it on this device, saying whether it was
 * kept: a refused write is not reported as saved. */
export function savePreferences(preferences: DevicePreferences): SaveResult {
  current = preferences;
  notify();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof DOMException && error.name === "QuotaExceededError"
          ? "this browser's storage is full"
          : "this browser does not allow saving here",
    };
  }
}

/** Another window of this address saved a choice: read it again. */
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      current = null;
      notify();
    }
  });
