import { useSyncExternalStore } from "react";

/** Phones (T-170): a narrow window, or a short touch screen held sideways.
 * There the app shows one thing at a time: the Agent list, or what is open
 * (a conversation, Home or the context panel). Wider windows, and short
 * windows with a mouse, keep the side-by-side layout. */
export const PHONE = "(max-width: 520px), (max-height: 500px) and (hover: none) and (pointer: coarse)";

const canWatch = () => typeof window !== "undefined" && typeof window.matchMedia === "function";
function watch(listener: () => void) {
  if (!canWatch()) return () => {};
  const query = window.matchMedia(PHONE);
  query.addEventListener?.("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

export const usePhone = () => useSyncExternalStore(watch, () => canWatch() && window.matchMedia(PHONE).matches);
