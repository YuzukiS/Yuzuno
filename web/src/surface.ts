import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** A token such as `--motion-small` ("180ms", or ".18s" once built), in milliseconds. */
function tokenMs(name: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Fades `element` in once, opacity only, over the `duration` token, for what
 * is not drawn by React (T-19 CV:CO-09, the slash menu CodeMirror draws).
 * Under reduced motion, or without the Web Animations API, nothing plays.
 */
export function fadeIn(element: HTMLElement, duration: "micro" | "small" | "medium"): Animation | null {
  if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return null;
  const ms = tokenMs(`--motion-${duration}`);
  if (!ms) return null;
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
  return element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
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
 * from there (T-19 M8, a phone's push and pop; M7, a side panel shown again);
 * without it, only opacity.
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

/**
 * What arrives while its view is open fades in, once each (T-19 M9; CV:Q-01, a
 * request card arriving in its conversation). Opacity only, so nothing in it
 * moves under the pointer and it works from its first frame. `arrivals` names
 * what has arrived since the view opened; each fades the first time it is
 * named, found by `find` after the commit. Under reduced motion, or without
 * the Web Animations API, nothing plays; a fade under way stops, fully shown,
 * when `enabled` turns off or reduced motion turns on, and none plays again.
 */
export function useArrivalsIn(
  arrivals: readonly string[],
  find: (key: string) => HTMLElement | null,
  duration: "micro" | "small" | "medium",
  enabled = true,
) {
  const fades = useRef(new Map<string, Animation>());
  const named = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const key of arrivals) {
      if (named.current.has(key)) continue;
      named.current.add(key);
      const element = find(key);
      if (!enabled || !element || typeof element.animate !== "function") continue;
      if (window.matchMedia?.(REDUCED).matches) continue;
      const ms = tokenMs(`--motion-${duration}`);
      if (!ms) continue;
      const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
      const fade = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
      fades.current.set(key, fade);
      const forget = () => {
        if (fades.current.get(key) === fade) fades.current.delete(key);
      };
      fade.finished.then(forget, forget);
    }
    // `find` and `duration` only say how the next one plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals.join("\n"), enabled]);
  useLayoutEffect(() => {
    if (enabled) return;
    for (const fade of fades.current.values()) fade.cancel();
    fades.current.clear();
  }, [enabled]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (!query.matches) return;
      for (const fade of fades.current.values()) fade.cancel();
      fades.current.clear();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}

/**
 * An inline panel the user opened (a confirm, a preview) reveals (T-19 M9):
 * as it mounts, the box it is in opens from nothing to its height and fades
 * in over small, pushing what is below down; it is brought into view first
 * (nearest, at once) if it would not be. `ref` is that box, a `.reveal` with
 * the panel inside: only its height and opacity move, and the panel keeps
 * its own padding and margins, so nothing in it moves as it opens. A newer
 * `key` reveals the panel shown then; a falsy one, or no panel, reveals
 * nothing. What it holds is clipped only while it opens. Under reduced
 * motion, or without the Web Animations API, it is there at once; reduced
 * motion turned on meanwhile shows it whole.
 */
export function useRevealIn(ref: RefObject<HTMLElement | null>, key: unknown) {
  const reveal = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!key || !element) return;
    element.scrollIntoView?.({ block: "nearest" });
    if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return;
    const ms = tokenMs("--motion-small");
    if (!ms) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
    const open = { height: `${element.getBoundingClientRect().height}px`, opacity: 1 };
    const shut = { height: "0px", opacity: 0 };
    const overflow = element.style.overflow;
    element.style.overflow = "hidden";
    const played = element.animate([shut, open], { duration: ms, easing });
    reveal.current = played;
    const done = () => {
      element.style.overflow = overflow;
      if (reveal.current === played) reveal.current = null;
    };
    played.addEventListener("finish", done);
    played.addEventListener("cancel", done);
    return () => played.cancel();
    // `ref` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED);
    if (!query?.addEventListener) return;
    const change = () => {
      if (query.matches) reveal.current?.cancel();
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
}

/**
 * A box that just became shorter because of what the user did (YN-21, a card
 * turning into its answer card) collapses from the height it had, `from`, to
 * its own, over small: its bottom edge rises and what is below follows. Call
 * it with the new layout in place, before it is painted. Under reduced
 * motion, without the Web Animations API, or if the box did not get shorter,
 * it is at its height at once.
 */
export function collapseFrom(element: HTMLElement, from: number): Animation | null {
  if (typeof element.animate !== "function" || window.matchMedia?.(REDUCED).matches) return null;
  const to = element.getBoundingClientRect().height;
  const ms = tokenMs("--motion-small");
  if (!ms || !(from > to + 1)) return null;
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-standard").trim() || "ease";
  return element.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms, easing });
}

/**
 * A banner that a brief flap should not flash (T-19 M15: SH:M04, SH:M06): `shown` once `want` has held
 * for `delay` ms. Once shown and no longer wanted, it is `leaving` for exit-small (the banner's own CSS
 * plays its exit meanwhile), then gone; under reduced motion it goes at once. Wanted again while
 * leaving, it stays.
 */
export function useDelayedPresence(want: boolean, delay: number): { shown: boolean; leaving: boolean } {
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (want) {
      setLeaving(false);
      if (shown) return;
      const timer = setTimeout(() => setShown(true), delay);
      return () => clearTimeout(timer);
    }
    if (!shown) return;
    const ms = window.matchMedia?.(REDUCED).matches ? 0 : tokenMs("--motion-exit-small");
    if (!ms) {
      setShown(false);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, ms);
    return () => clearTimeout(timer);
  }, [want, shown, delay]);
  return { shown, leaving };
}
