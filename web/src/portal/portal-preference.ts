import { useSyncExternalStore } from "react";
import {
  clearDeviceValue,
  deviceValueState,
  onDeviceValueChange,
  readDeviceValue,
  saveDeviceValue,
  type DeviceValueState,
  type SaveOutcome,
} from "../device-storage";

/**
 * Where a web page or an HTML prototype opens by default on this device
 * (T-5): in Yuzuno's Portal, or in the browser (a new tab on the web; the
 * system browser in the desktop app). Kept on this device only, as the other
 * device preferences are; every entry also offers the other way, for once.
 * A choice this device refused to save still applies in this window.
 */
export type OpenWith = "inside" | "browser";
export const openWithChoices: readonly OpenWith[] = ["inside", "browser"];
const OPEN_KEY = "yuzuno.portal-open";
/** The Portal's width beside the conversation, in px, as the user dragged it. */
const WIDTH_KEY = "yuzuno.portal-width";

export function readOpenWith(): OpenWith {
  const saved = readDeviceValue(OPEN_KEY) as { open?: unknown } | null;
  return openWithChoices.includes(saved?.open as OpenWith) ? (saved!.open as OpenWith) : "inside";
}

const listeners = new Set<() => void>();
let current: OpenWith | null = null;
export type OpenWithWrite = { outcome: SaveOutcome; attempt: number };
let lastSave: OpenWithWrite | null = null;
let attempts = 0;
let stopWatching: (() => void) | undefined;
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  if (!listeners.size)
    stopWatching = onDeviceValueChange(OPEN_KEY, () => {
      // Another window saved: what applies here is what is saved now.
      current = null;
      lastSave = null;
      notify();
    });
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopWatching?.();
  };
};

/** The choice in effect on this device. */
export function useOpenWith(): OpenWith {
  return useSyncExternalStore(subscribe, () => (current ??= readOpenWith()));
}
export function openWithNow(): OpenWith {
  return (current ??= readOpenWith());
}
/** What this visit's last save did, or null before one. */
export function useOpenWithSave(): OpenWithWrite | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}
export function openWithStored(): DeviceValueState {
  return deviceValueState(OPEN_KEY);
}

/** Applies the choice now and saves it here; a refused write is reported. */
export function saveOpenWith(open: OpenWith): SaveOutcome {
  const outcome = saveDeviceValue(OPEN_KEY, { open });
  current = open;
  lastSave = { outcome, attempt: ++attempts };
  notify();
  return outcome;
}

/** The width the user last gave the Portal on this device, if any. */
export function savedPortalWidth(): number | null {
  const value = readDeviceValue(WIDTH_KEY) as { px?: unknown } | null;
  return typeof value?.px === "number" && Number.isFinite(value.px) && value.px > 0 ? value.px : null;
}
/** Keeps a dragged width; if this device refuses, it applies in this window only. */
export function savePortalWidth(px: number | null) {
  if (px === null) clearDeviceValue(WIDTH_KEY);
  else saveDeviceValue(WIDTH_KEY, { px: Math.round(px) });
}
