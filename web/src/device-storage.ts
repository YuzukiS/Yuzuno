/**
 * This device's saved preferences (T-187): read, save, reset and watch a
 * value in this browser's storage, one key per preference set. Shared by
 * Appearance and the other per-device preferences, so they all report a
 * refused save the same way.
 *
 * What writing a preference on this device did. The browser can
 * refuse a write: its storage for this site is full, or blocked (some
 * private windows, a site-data setting). A refused write is never reported
 * as saved; the choice may still apply in this window until it is closed.
 */
export type SaveOutcome =
  | { saved: true }
  | { saved: false; reason: "full" | "blocked" | "unknown"; detail: string };

/** Storage this browser blocks: what a write, or a read, meets there. */
export const STORAGE_BLOCKED: SaveOutcome = {
  saved: false,
  reason: "blocked",
  detail: "this browser doesn’t let Yuzuno store settings here",
};

function refused(error: unknown): SaveOutcome {
  const name = typeof error === "object" && error && "name" in error ? String(error.name) : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED")
    return { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" };
  if (name === "SecurityError") return STORAGE_BLOCKED;
  const message = error instanceof Error && error.message ? error.message : String(error);
  return { saved: false, reason: "unknown", detail: `the browser refused it (${message})` };
}

const NOT_KEPT: SaveOutcome = { saved: false, reason: "unknown", detail: "the browser didn’t keep it" };

/** Saves `value` as JSON under `key` on this device. Never throws; read
 * back, so a write that did not stick is not called saved. */
export function saveDeviceValue(key: string, value: unknown): SaveOutcome {
  try {
    const text = JSON.stringify(value);
    localStorage.setItem(key, text);
    return localStorage.getItem(key) === text ? { saved: true } : NOT_KEPT;
  } catch (error) {
    return refused(error);
  }
}

/** Removes this device's saved value under `key`, so the defaults apply
 * again: a reset of this device's choice only. Never throws. */
export function clearDeviceValue(key: string): SaveOutcome {
  try {
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null ? { saved: true } : NOT_KEPT;
  } catch (error) {
    return refused(error);
  }
}

/** Whether this device's storage can be read at all (here, under `key`);
 * when it can't, what is shown is the defaults, not a saved choice. Reads
 * only. */
export function deviceStorageReadable(key: string): boolean {
  try {
    void localStorage.getItem(key);
    return true;
  } catch {
    return false;
  }
}

/** What this device holds under `key`, read before any save in this visit:
 * a value ("saved"), nothing ("none"), one that isn't JSON ("invalid"), or
 * storage it can't read ("unreadable"). A caller may also count a value of
 * the wrong shape as invalid. Reads only. */
export type DeviceValueState = "saved" | "none" | "invalid" | "unreadable";
export function deviceValueState(key: string): DeviceValueState {
  let text: string | null;
  try {
    text = localStorage.getItem(key);
  } catch {
    return "unreadable";
  }
  if (text === null) return "none";
  try {
    JSON.parse(text);
    return "saved";
  } catch {
    return "invalid";
  }
}

/** The value saved under `key` on this device, parsed; null when there is
 * none, it is not JSON, or storage can't be read. Callers check its shape. */
export function readDeviceValue(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** Calls `listener` when another window saves or clears `key` (or clears
 * all of this site's storage). This window's own saves don't call it. */
export function onDeviceValueChange(key: string, listener: () => void): () => void {
  const changed = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener("storage", changed);
  return () => window.removeEventListener("storage", changed);
}
