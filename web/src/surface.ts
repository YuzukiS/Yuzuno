import { useLayoutEffect, type RefObject } from "react";

/** A token such as `--motion-small` ("180ms", or ".18s" once built), in milliseconds. */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A surface coming in fades in (T-19 M6): Home as it opens, a conversation as
 * it opens or another Agent's takes its place. Opacity only, from before the
 * first paint, so nothing in it moves: a conversation's rows, where it is read
 * and what reads it keep their places. The surface it replaces is gone at
 * once, as before. A newer `key` starts the fade again on the newest surface;
 * under reduced motion, or without the Web Animations API, nothing plays.
 */
export function useSurfaceIn(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  duration: "small" | "medium",
  enabled = true,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof element.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const ms = tokenMs(`--motion-${duration}`);
    if (!ms) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
    const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
    return () => fade.cancel();
    // `ref` is stable; `duration` and `enabled` only say how the next one plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
