/**
 * The sizes the user chose for Home's cards (T-18, Lead 2378, 2414), kept on
 * this device for each Workspace, by the card's project and Home's id for its
 * section: a newer version keeps its size, and a section removed and written
 * again under the same key is another card, which does not. Home works with
 * none chosen: each card then has its own size (card-preview.ts). Only sizes
 * are kept here, never content; the widget column's pins are not sized here.
 */
import { createContext, useCallback, useMemo, useRef, useState } from "react";
import { CARD_SIZES, type CardSize } from "./card-preview.ts";

export type SizeChoices = Record<string, CardSize>;

const storageKey = (workspaceId: string) => `yuzuno.homeCardSizes.${workspaceId}`;
/** One card: a project and Home's id for the section (types.ts Section.id). */
export const sizeKey = (projectId: string, id: number) => `${projectId}:${id}`;
/** A section Core names (an older Core does not) can be sized by the user. */
export const sizable = (section: { id?: number }): section is { id: number } => Number.isSafeInteger(section.id);

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
  chosen: (projectId: string, id: number) => CardSize | null;
  /** null is Auto: the user's choice cleared. */
  choose: (projectId: string, id: number, size: CardSize | null) => void;
  resetAll: () => void;
  count: number;
  /**
   * A card's own size as first shown in this visit to Home (Lead 2414): a
   * newer version whose figure would size it otherwise keeps it until the
   * next explicit way to Home, or until the user chooses a size, so what is
   * being read or answered never moves. Returns the size to show.
   */
  held: (projectId: string, id: number, size: CardSize) => CardSize;
  visit: number;
};
export const CardSizes = createContext<CardSizeControl | null>(null);

/**
 * One Workspace's choices, saved on every change. Until the Workspace is
 * known there are none and none can be made, as with the widget layout.
 */
export function useCardSizes(workspaceId: string, visit: number): CardSizeControl | null {
  const read = (id: string) => (id ? readSizeChoices(id) : null);
  // The sizes shown in this visit, read as cards render: a new visit or Workspace starts afresh.
  const shown = useRef({ workspaceId, visit, sizes: new Map<string, CardSize>() });
  if (shown.current.workspaceId !== workspaceId || shown.current.visit !== visit)
    shown.current = { workspaceId, visit, sizes: new Map() };
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
  // A choice the user makes takes the card's own size as it is now, should they go back to Auto.
  const choose = useCallback(
    (projectId: string, id: number, size: CardSize | null) => {
      shown.current.sizes.delete(sizeKey(projectId, id));
      change((current) => {
        const { [sizeKey(projectId, id)]: _old, ...rest } = current;
        return size ? { ...rest, [sizeKey(projectId, id)]: size } : rest;
      });
    },
    [change],
  );
  const resetAll = useCallback(() => {
    shown.current.sizes.clear();
    change(() => ({}));
  }, [change]);
  const held = useCallback((projectId: string, id: number, size: CardSize) => {
    const sizes = shown.current.sizes, key = sizeKey(projectId, id);
    if (!sizes.has(key)) sizes.set(key, size);
    return sizes.get(key)!;
  }, []);
  // A new visit is a new value, so every card reads its own size afresh.
  return useMemo(
    () =>
      choices && {
        chosen: (projectId: string, id: number) => choices[sizeKey(projectId, id)] ?? null,
        choose,
        resetAll,
        count: Object.keys(choices).length,
        held,
        visit,
      },
    [choices, choose, resetAll, held, visit],
  );
}
