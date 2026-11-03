import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

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
 *
 * Only a newer `key` starts a fade. A fade under way stops at once, the
 * surface fully shown, when `enabled` turns off (a phone) or reduced motion
 * turns on; turning either back does not play it again.
 *
 * `from`, a transform such as "translateX(8px)", also moves the surface in
 * from there (T-19 M8, a phone's push and pop); without it, only opacity.
 */
export function useSurfaceIn(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  duration: "micro" | "small" | "medium",
  enabled = true,
  from = "",
) {
  const fade = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof element.animate !== "function") return;
    if (window.matchMedia?.(REDUCED).matches) return;
    const ms = tokenMs(`--motion-${duration}`);
    if (!ms) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
    const frames: Keyframe[] = from
      ? [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }]
      : [{ opacity: 0 }, { opacity: 1 }];
    const played = element.animate(frames, { duration: ms, easing });
    fade.current = played;
    return () => {
      played.cancel();
      if (fade.current === played) fade.current = null;
    };
    // `ref` is stable; `duration`, `enabled` and `from` only say how the next one plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLayoutEffect(() => {
    if (!enabled) fade.current?.cancel();
  }, [enabled]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (query.matches) fade.current?.cancel();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}
