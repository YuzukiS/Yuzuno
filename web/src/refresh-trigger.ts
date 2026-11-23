import { useEffect, useMemo, useRef, useState } from "react";
import { POLL_MS } from "./useWorkspaceEvents";

/** What a trigger does while the page is hidden (YN-221): `"pause"` reads
 * nothing and owes one read, made once the page is shown again; a number
 * reads at most that often. Without one it reads as when shown. */
export type WhileHidden = "pause" | number;

/** The hidden cadence of the reads a badge, the title and a system
 * notification need while away: the stream's own poll interval, at which a
 * page reads everything while its stream is down. */
export const HIDDEN_READ_MS = POLL_MS;

/** Each named trigger's reads since the page loaded (YN-221; Copy
 * diagnostics reads them): made (`fired`), owed while hidden (`owedHidden`),
 * made once shown again (`caughtUp`), held to the hidden cadence
 * (`throttledHidden`). */
export const refreshStats: Record<string, { fired: number; owedHidden: number; caughtUp: number; throttledHidden: number }> = {};

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** A revision counter for one view's reads, bumped now, soon (several
 * requests share one bump, never postponed by later ones), or at most once
 * per interval; while the page is hidden, as `whileHidden` says. */
export function useRefreshTrigger(name?: string, whileHidden?: WhileHidden) {
  const [revision, setRevision] = useState(0);
  const state = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    due: number;
    last: number;
    owed: boolean;
  }>({ due: 0, last: 0, owed: false });
  const trigger = useMemo(() => {
    const stats = name ? (refreshStats[name] ??= { fired: 0, owedHidden: 0, caughtUp: 0, throttledHidden: 0 }) : null;
    const at = (wait: number) => {
      const due = Date.now() + Math.max(0, wait);
      const pending = state.current.timer !== undefined;
      if (pending && state.current.due <= due) return;
      clearTimeout(state.current.timer);
      state.current.due = due;
      state.current.timer = setTimeout(fire, Math.max(0, wait));
    };
    function fire() {
      clearTimeout(state.current.timer);
      state.current.timer = undefined;
      if (whileHidden !== undefined && hidden()) {
        if (whileHidden === "pause") {
          if (stats) stats.owedHidden++;
          state.current.owed = true;
          return;
        }
        const wait = state.current.last + whileHidden - Date.now();
        if (wait > 0) {
          if (stats) stats.throttledHidden++;
          at(wait);
          return;
        }
      }
      if (stats) stats.fired++;
      state.current.last = Date.now();
      setRevision((n) => n + 1);
    }
    return {
      now: fire,
      soon: (ms: number) => at(ms),
      atMostEvery: (ms: number) => at(state.current.last + ms - Date.now()),
      /** Shown again: the read owed while hidden, or held to the hidden
       * cadence, now and once. */
      catchUp() {
        if (hidden()) return;
        const held = typeof whileHidden === "number" && state.current.timer !== undefined;
        if (!state.current.owed && !held) return;
        state.current.owed = false;
        if (stats) stats.caughtUp++;
        fire();
      },
    };
  }, [name, whileHidden]);
  useEffect(() => {
    if (whileHidden === undefined) return;
    document.addEventListener("visibilitychange", trigger.catchUp);
    window.addEventListener("pageshow", trigger.catchUp);
    return () => {
      document.removeEventListener("visibilitychange", trigger.catchUp);
      window.removeEventListener("pageshow", trigger.catchUp);
    };
  }, [trigger, whileHidden]);
  useEffect(() => () => clearTimeout(state.current.timer), []);
  return [revision, trigger] as const;
}
