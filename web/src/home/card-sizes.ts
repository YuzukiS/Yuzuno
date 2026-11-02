/**
 * The sizes the user chose for Home's cards (T-18, Lead 2378), kept on this
 * device for each Workspace, by the card's project and key, so a newer
 * version keeps its size. Home works with none chosen: each card then has
 * its own size (card-preview.ts). Only sizes are kept here, never content.
 */
import { createContext, useCallback, useState } from "react";
import { CARD_SIZES, type CardSize } from "./card-preview.ts";

export type SizeChoices = Record<string, CardSize>;

const storageKey = (workspaceId: string) => `yuzuno.homeCardSizes.${workspaceId}`;
/** A section's key never holds a colon (brief-contract.ts), so this names one card. */
export const sizeKey = (projectId: string, key: string) => `${projectId}:${key}`;

export function readSizeChoices(workspaceId: string): SizeChoices {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter((entry): entry is [string, CardSize] => CARD_SIZES.includes(entry[1] as CardSize)),
    );
  } catch {
    return {};
  }
}

function saveSizeChoices(workspaceId: string, choices: SizeChoices) {
  try {
    if (Object.keys(choices).length) localStorage.setItem(storageKey(workspaceId), JSON.stringify(choices));
    else localStorage.removeItem(storageKey(workspaceId));
  } catch {
    // Without storage the choice still holds for this visit.
  }
}

/** What a card and Organize need to read and change the sizes; null where none can be chosen (the design preview). */
export type CardSizeControl = {
  chosen: (projectId: string, key: string) => CardSize | null;
  /** null is Auto: the user's choice cleared. */
  choose: (projectId: string, key: string, size: CardSize | null) => void;
  resetAll: () => void;
  count: number;
};
export const CardSizes = createContext<CardSizeControl | null>(null);

/**
 * One Workspace's choices, saved on every change. Until the Workspace is
 * known there are none and none can be made, as with the widget layout.
 */
export function useCardSizes(workspaceId: string): CardSizeControl | null {
  const read = (id: string) => (id ? readSizeChoices(id) : null);
  const [state, setState] = useState(() => ({ workspaceId, choices: read(workspaceId) }));
  const choices = state.workspaceId === workspaceId ? state.choices : read(workspaceId);
  if (state.workspaceId !== workspaceId) setState({ workspaceId, choices });
  const change = useCallback(
    (next: (current: SizeChoices) => SizeChoices) =>
      setState((current) => {
        if (!current.workspaceId || !current.choices) return current;
        const updated = next(current.choices);
        saveSizeChoices(current.workspaceId, updated);
        return { workspaceId: current.workspaceId, choices: updated };
      }),
    [],
  );
  const choose = useCallback(
    (projectId: string, key: string, size: CardSize | null) =>
      change((current) => {
        const { [sizeKey(projectId, key)]: _old, ...rest } = current;
        return size ? { ...rest, [sizeKey(projectId, key)]: size } : rest;
      }),
    [change],
  );
  const resetAll = useCallback(() => change(() => ({})), [change]);
  if (!choices) return null;
  return {
    chosen: (projectId, key) => choices[sizeKey(projectId, key)] ?? null,
    choose,
    resetAll,
    count: Object.keys(choices).length,
  };
}
