/**
 * The sizes Home's cards are shown at in one visit to Home (T-18, Lead 2414):
 * a card keeps the size it was first shown at, so a newer version whose
 * author gives it another size takes it at the next explicit way to Home (or
 * a reload), and nothing being read or answered moves. A new visit or
 * Workspace starts afresh. Sizes are the authors' (card-preview.ts); nothing
 * is kept here across visits, and nothing the user chooses.
 *
 * So too whether a replied Ask is one line (YN-3): only one that was replied
 * when first shown in this visit, at that version. One the user answers
 * here keeps its card until the next visit.
 */
import { createContext, useCallback, useMemo, useRef } from "react";
import type { CardSize } from "./card-preview.ts";

/** One card: a project and Home's id for the section (types.ts Section.id). */
export const sizeKey = (projectId: string, id: number) => `${projectId}:${id}`;
/** A section Core names (an older Core does not) keeps its size through the visit. */
export const sizable = (section: { id?: number }): section is { id: number } => Number.isSafeInteger(section.id);

export type HeldSizes = {
  /** The size to show: the one this card was first shown at in this visit. */
  held: (projectId: string, id: number, size: CardSize) => CardSize;
  /** Whether a replied Ask is shown in short: replied now, and when first shown in this visit at this version. */
  short: (projectId: string, key: string, version: number, replied: boolean) => boolean;
  visit: number;
};
export const DeckSizes = createContext<HeldSizes | null>(null);

export function useHeldSizes(workspaceId: string, visit: number): HeldSizes {
  const shown = useRef({ workspaceId, visit, sizes: new Map<string, CardSize>(), replied: new Map<string, boolean>() });
  if (shown.current.workspaceId !== workspaceId || shown.current.visit !== visit)
    shown.current = { workspaceId, visit, sizes: new Map(), replied: new Map() };
  const held = useCallback((projectId: string, id: number, size: CardSize) => {
    const sizes = shown.current.sizes, key = sizeKey(projectId, id);
    if (!sizes.has(key)) sizes.set(key, size);
    return sizes.get(key)!;
  }, []);
  const short = useCallback((projectId: string, key: string, version: number, replied: boolean) => {
    const first = shown.current.replied, at = JSON.stringify([projectId, key, version]);
    if (!first.has(at)) first.set(at, replied);
    return replied && first.get(at)!;
  }, []);
  // A new visit is a new value, so every card reads its size afresh.
  return useMemo(() => ({ held, short, visit }), [held, short, visit]);
}
