import type { ConversationInput, NativeTurn } from "./types";

/** How the turn dock reads the conversation (T-6): by the person's inputs, or
 * by Turn as it always has. */
export type ReadBy = "inputs" | "turns";

/** The dock's inputs: the entries are the newest of all of them. */
export interface InputDock {
  /** How many inputs come before the first entry. */
  offset: number;
  total: number;
  hasBefore: boolean;
  loading: boolean;
  onEarlier: () => void;
}

/** The dock entry of one input: a Turn-shaped record the dock numbers and
 * previews, with the input it stands for in `_yuzunoInputOf`. */
export function inputEntries(inputs: ConversationInput[], turns: NativeTurn[]): NativeTurn[] {
  const at = new Map(turns.map((turn, index) => [turn.id, index]));
  return inputs.map(input => {
    const turn = at.get(input.turnId);
    return {
      // As a cursor names it.
      id: JSON.stringify([input.turnId, input.itemId]),
      status: turn === undefined ? "completed" : turns[turn].status,
      items: [{ id: input.itemId, type: "userMessage", content: [{ type: "text", text: input.preview }] }],
      _yuzunoInputOf: { turnId: input.turnId, itemId: input.itemId, turn: (turn ?? input.position[0]) + 1, by: input.by },
    };
  });
}

/** The input an entry stands for. */
export function entryInput(id: string) {
  const [turnId, itemId] = JSON.parse(id) as [string, string];
  return { turnId, itemId };
}

/**
 * The entry being read: the last input at or before the reading line. Inputs
 * of Turns before the one being read are passed. Those of the Turn being read
 * are placed by where they are drawn. ConversationRows draws the rows around
 * what is on screen, so an input not drawn comes before the first one drawn
 * or after the last: passed, or not reached.
 */
export function readingEntry(entries: NativeTurn[], turns: NativeTurn[], readingTurn: string | undefined, line: number | null) {
  const at = new Map(turns.map((turn, index) => [turn.id, index]));
  const reading = readingTurn === undefined ? turns.length - 1 : (at.get(readingTurn) ?? turns.length - 1);
  const turnOf = (entry: NativeTurn) => at.get(entry._yuzunoInputOf!.turnId) ?? entry._yuzunoInputOf!.turn - 1;
  const passed = entries.filter(entry => turnOf(entry) < reading).at(-1)?.id;
  const here = entries.filter(entry => turnOf(entry) === reading);
  if (!here.length) return passed;
  if (line === null) return here[0].id;
  const drawn = Array.from(document.getElementById(`turn-${here[0]._yuzunoInputOf!.turnId}`)?.querySelectorAll<HTMLElement>("[data-item-id]") ?? []);
  const tops = here.map(entry => drawn.find(element => element.dataset.itemId === entry._yuzunoInputOf!.itemId)?.getBoundingClientRect().top);
  let above = -1;
  tops.forEach((top, index) => { if (top !== undefined && top <= line) above = index; });
  if (above >= 0) return here[above].id;
  const below = tops.findIndex(top => top !== undefined);
  // The first drawn input is below the line: the one before it is passed,
  // or, before the Turn's first input, the previous Turn's last.
  if (below > 0) return here[below - 1].id;
  if (below === 0) return passed ?? here[0].id;
  // None drawn while this Turn is read: its first input is passed.
  return here[0].id;
}
