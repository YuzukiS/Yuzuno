import { useSyncExternalStore } from "react";

/** A phone or tablet used by touch: its on-screen keyboard has no Shift for
 * Return, so there Return makes a new line and the Send button sends (T-170).
 * A tablet with a trackpad or mouse matches neither and keeps Return to send. */
const TOUCH = "(hover: none) and (pointer: coarse)";

export function touchKeyboard() {
  return typeof window.matchMedia === "function" && window.matchMedia(TOUCH).matches;
}

const canWatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
function watch(listener: () => void) {
  if (!canWatch()) return () => {};
  const query = window.matchMedia(TOUCH);
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

/** Whether a finger is what reaches the screen, wide window or not: a folding
 * phone unfolded is far wider than a phone and still has nothing but touch,
 * while the same width with a mouse wants the smaller rows (T-15). */
export const useTouchInput = () =>
  useSyncExternalStore(watch, () => canWatch() && window.matchMedia(TOUCH).matches);
