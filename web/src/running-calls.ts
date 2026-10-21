import type { NativeItem, NativeTurn, RunningCall } from "./types";

/**
 * The loaded Turns with the calls Core lists from outside the window while
 * their tasks run (a Claude sub-agent's, or a background shell's or
 * monitor's), each in its place: such a task outlives the Items after its
 * call, and the window holds the newest of those only. A call loaded already
 * (an earlier page joined) is kept as loaded. A Turn none of whose Items is
 * loaded is a shell of its id.
 */
export function withRunningCalls(turns: readonly NativeTurn[], running: readonly RunningCall[] | undefined): readonly NativeTurn[] {
  const loaded = new Set(turns.flatMap((turn) => turn.items.map((item) => `${turn.id}\n${item.id}`)));
  const listed = (running ?? []).filter((entry) => !loaded.has(`${entry.turnId}\n${entry.item.id}`));
  if (!listed.length) return turns;
  // Every Item at its position in the record: its Turn's, then its own.
  const rows = [
    ...turns.flatMap((turn, n) => turn.items.map((item, k) =>
      ({ turn: turn._yuzunoSlice?.index ?? n, at: (turn._yuzunoSlice?.start ?? 0) + k, turnId: turn.id, item }))),
    ...listed.map(({ turnId, position: [turn, at], item }) => ({ turn, at, turnId, item })),
  ].sort((a, b) => a.turn - b.turn || a.at - b.at);
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const out: NativeTurn[] = [];
  let items: NativeItem[] = [];
  rows.forEach((row, n) => {
    if (n === 0 || rows[n - 1].turnId !== row.turnId) {
      items = [];
      // Not loaded: its status is not known here, and the dock does not read it.
      out.push({ ...(byId.get(row.turnId) ?? { id: row.turnId, status: "" }), items });
    }
    items.push(row.item);
  });
  return out;
}
