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
 * The entry being read: the last input at or before the reading line, in the
 * Turn being read or one before it. Inputs of the Turn being read are placed
 * by where they are drawn, so a Turn with several reads as the one in view.
 */
export function readingEntry(entries: NativeTurn[], turns: NativeTurn[], readingTurn: string | undefined, line: number | null) {
  const at = new Map(turns.map((turn, index) => [turn.id, index]));
  const reading = readingTurn === undefined ? turns.length - 1 : (at.get(readingTurn) ?? turns.length - 1);
  let found: string | undefined;
  for (const entry of entries) {
    const of = entry._yuzunoInputOf!;
    const turn = at.get(of.turnId) ?? of.turn - 1;
    if (turn > reading) break;
    if (turn === reading && line !== null && found) {
      const drawn = document.querySelector<HTMLElement>(`#turn-${CSS.escape(of.turnId)} [data-item-id="${CSS.escape(of.itemId)}"]`);
      if (drawn && drawn.getBoundingClientRect().top > line) break;
    }
    found = entry.id;
  }
  return found;
}
