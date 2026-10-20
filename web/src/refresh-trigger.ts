import { useEffect, useMemo, useRef, useState } from "react";

/** A revision counter for one view's reads, bumped now, soon (several
 * requests share one bump, never postponed by later ones), or at most once
 * per interval. */
export function useRefreshTrigger() {
  const [revision, setRevision] = useState(0);
  const state = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    due: number;
    last: number;
  }>({ due: 0, last: 0 });
  const trigger = useMemo(() => {
    const fire = () => {
      clearTimeout(state.current.timer);
      state.current.timer = undefined;
      state.current.last = Date.now();
      setRevision((n) => n + 1);
    };
    const at = (wait: number) => {
      const due = Date.now() + Math.max(0, wait);
      const pending = state.current.timer !== undefined;
      if (pending && state.current.due <= due) return;
      clearTimeout(state.current.timer);
      state.current.due = due;
      state.current.timer = setTimeout(fire, Math.max(0, wait));
    };
    return {
      now: fire,
      soon: (ms: number) => at(ms),
      atMostEvery: (ms: number) => at(state.current.last + ms - Date.now()),
    };
  }, []);
  useEffect(() => () => clearTimeout(state.current.timer), []);
  return [revision, trigger] as const;
}
