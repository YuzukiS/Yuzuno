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
 * The entry being read: the input the Turn being read reported, or, before
 * its first input, the last input of an earlier Turn. Until the Turn has
 * reported, its first input.
 */
export function readingEntry(entries: NativeTurn[], turns: NativeTurn[], readingTurn: string | undefined, reported: string | null | undefined) {
  const at = new Map(turns.map((turn, index) => [turn.id, index]));
  const reading = readingTurn === undefined ? turns.length - 1 : (at.get(readingTurn) ?? turns.length - 1);
  const turnOf = (entry: NativeTurn) => at.get(entry._yuzunoInputOf!.turnId) ?? entry._yuzunoInputOf!.turn - 1;
  const passed = entries.filter(entry => turnOf(entry) < reading).at(-1)?.id;
  const here = entries.filter(entry => turnOf(entry) === reading);
  if (reported === null) return passed;
  return here.find(entry => entry._yuzunoInputOf!.itemId === reported)?.id ?? here[0]?.id ?? passed;
}
