/**
 * What writing a preference on this device did (T-187). The browser can
 * refuse a write: its storage for this site is full, or blocked (some
 * private windows, a site-data setting). A refused write is never reported
 * as saved; the choice may still apply in this window until it is closed.
 */
export type SaveOutcome =
  | { saved: true }
  | { saved: false; reason: "full" | "blocked" | "unknown"; detail: string };

function refused(error: unknown): SaveOutcome {
  const name = typeof error === "object" && error && "name" in error ? String(error.name) : "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED")
    return { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" };
  if (name === "SecurityError")
    return { saved: false, reason: "blocked", detail: "this browser doesn’t let Yuzuno store settings here" };
  const message = error instanceof Error && error.message ? error.message : String(error);
  return { saved: false, reason: "unknown", detail: `the browser refused it (${message})` };
}

const NOT_KEPT: SaveOutcome = { saved: false, reason: "unknown", detail: "the browser didn’t keep it" };

/** Saves `value` as JSON under `key` on this device. Never throws; read
 * back, so a write that did not stick is not called saved. */
export function saveLocal(key: string, value: unknown): SaveOutcome {
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
export function clearLocal(key: string): SaveOutcome {
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
export function storageReadable(key: string): boolean {
  try {
    void localStorage.getItem(key);
    return true;
  } catch {
    return false;
  }
}
