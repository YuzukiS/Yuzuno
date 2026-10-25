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
 * The shortcuts this device may give another key (T-189 P2): three of those
 * the help lists, each Ctrl/⌘ with one letter. Kept in this browser or app
 * only (device-storage.ts), on their own key, so restoring them leaves the
 * send key and the other preferences alone. They don't travel to other
 * devices. Return, Shift+Return and Ctrl/⌘+Return (the send key and input
 * methods), Esc, Tab, the arrows, Home, End, the composer's "/" and "$",
 * Ctrl/⌘+Z and Ctrl/⌘+, keep their keys.
 */
export const rebindable = ["find", "newAgent", "search"] as const;
export type Rebindable = (typeof rebindable)[number];
export type ShortcutKeys = Record<Rebindable, string>;
export const defaultShortcutKeys: ShortcutKeys = { find: "K", newAgent: "N", search: "F" };
/** With Ctrl/⌘, text editing's (A, C, V, X, Y, Z) and the browser's own
 * (W, T, Q, R, L): never offered. */
export const reservedLetters = ["A", "C", "V", "X", "Y", "Z", "W", "T", "Q", "R", "L"];
export const shortcutLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((letter) => !reservedLetters.includes(letter));
const STORAGE_KEY = "yuzuno.shortcuts";

/** What this device saved, and whether it can be used: an object whose
 * letters this version offers, no two shortcuts on one. */
function readSaved(): { keys: ShortcutKeys; usable: boolean } {
  const saved = readDeviceValue(STORAGE_KEY) as Partial<Record<Rebindable, unknown>> | null;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { keys: { ...defaultShortcutKeys }, usable: false };
  const keys = { ...defaultShortcutKeys };
  let usable = true;
  for (const action of rebindable) {
    const key = saved[action];
    if (key === undefined) continue;
    if (typeof key === "string" && shortcutLetters.includes(key)) keys[action] = key;
    else usable = false;
  }
  if (new Set(Object.values(keys)).size !== rebindable.length) return { keys: { ...defaultShortcutKeys }, usable: false };
  return { keys, usable };
}

/** What this device has chosen, over the defaults. A letter this version
 * doesn't offer, or two shortcuts on one letter, is not used: the defaults. */
export function readShortcutKeys(): ShortcutKeys {
  const { keys, usable } = readSaved();
  return usable ? keys : { ...defaultShortcutKeys };
}

/** The other shortcut on `key`, if one is. */
export function keyTakenBy(keys: ShortcutKeys, action: Rebindable, key: string): Rebindable | null {
  return rebindable.find((other) => other !== action && keys[other] === key) ?? null;
}

/** Whether a key press is Ctrl/⌘ with this letter, and no other modifier. */
export function pressed(event: KeyboardEvent, key: string): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key.toLowerCase();
}

// The keys in effect: read once, then again whenever chosen here or saved in
// another window (as device-preferences.ts).
const listeners = new Set<() => void>();
let current: ShortcutKeys | null = null;
export type ShortcutKeysWrite = { outcome: SaveOutcome; action: "save" | "reset"; attempt: number };
let lastWrite: ShortcutKeysWrite | null = null;
let attempts = 0;
let stopWatching: (() => void) | undefined;
const notify = () => listeners.forEach((listener) => listener());
function changed() {
  current = null;
  lastWrite = null;
  notify();
}
const subscribe = (listener: () => void) => {
  if (!listeners.size) stopWatching = onDeviceValueChange(STORAGE_KEY, changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopWatching?.();
  };
};
/** The keys in effect now, for a key handler. */
export const shortcutKeys = (): ShortcutKeys => (current ??= readShortcutKeys());
export const useShortcutKeys = (): ShortcutKeys => useSyncExternalStore(subscribe, shortcutKeys);
/** What this visit's last save or reset of them did, or null. */
export const useShortcutKeysWrite = (): ShortcutKeysWrite | null => useSyncExternalStore(subscribe, () => lastWrite);

/** What this device holds for them, read now (as preferencesStored): one it
 * can't use, as readShortcutKeys can't, is "invalid" (the defaults apply). */
export function shortcutKeysStored(): DeviceValueState {
  const state = deviceValueState(STORAGE_KEY);
  return state === "saved" && !readSaved().usable ? "invalid" : state;
}

/** Gives a shortcut another letter, at once, and saves it on this device. A
 * letter not offered, or another shortcut's, changes nothing: null. A
 * refused write is reported; the choice still applies in this window. */
export function saveShortcutKey(action: Rebindable, key: string): SaveOutcome | null {
  const keys = shortcutKeys();
  if (!shortcutLetters.includes(key) || keyTakenBy(keys, action, key)) return null;
  const next = { ...keys, [action]: key };
  const outcome = saveDeviceValue(STORAGE_KEY, next);
  current = next;
  lastWrite = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}

/** Back to the defaults on this device: its saved choices are removed. */
export function restoreDefaultShortcutKeys(): SaveOutcome {
  const outcome = clearDeviceValue(STORAGE_KEY);
  current = { ...defaultShortcutKeys };
  lastWrite = { outcome, action: "reset", attempt: ++attempts };
  notify();
  return outcome;
}

/** Tries this visit's last write again, as it was. */
export function retryShortcutKeysWrite(): SaveOutcome {
  if (lastWrite?.action === "reset") return restoreDefaultShortcutKeys();
  const keys = shortcutKeys();
  const outcome = saveDeviceValue(STORAGE_KEY, keys);
  lastWrite = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}
