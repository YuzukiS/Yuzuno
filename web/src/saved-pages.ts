import type { AgentDetail, NativeTurn } from "./types";

/** How many saved-body windows are shown together: the live one and the
 * earlier ones read in front of it. Core bounds each (96 Items, 256 KiB) and
 * rows mount only where visible (T-77), so this bounds what is kept, not the
 * DOM. Beyond it, paging back replaces the windows as before. */
export const SAVED_WINDOWS = 3;

/** One window's Turns after another's. A Turn split between them keeps the
 * earlier window's Items and slice start, then the later window's Items and
 * fields, which are the newer copy. */
export function join(windows: AgentDetail[]): NativeTurn[] {
  const turns: NativeTurn[] = [];
  const at = new Map<string, number>();
  for (const window of windows) {
    for (const turn of window.turns) {
      const index = at.get(turn.id);
      if (index === undefined) {
        at.set(turn.id, turns.length);
        turns.push(turn);
        continue;
      }
      const earlier = turns[index];
      const seen = new Set(earlier.items.map((item) => item.id));
      turns[index] = {
        ...turn,
        items: [...earlier.items, ...turn.items.filter((item) => !seen.has(item.id))],
        ...(earlier._yuzunoSlice && turn._yuzunoSlice
          ? { _yuzunoSlice: { ...turn._yuzunoSlice, start: earlier._yuzunoSlice.start } }
          : {}),
      };
    }
  }
  return turns;
}
