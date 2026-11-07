/**
 * The sizes Home's cards are shown at in one visit to Home (T-18, Lead 2414):
 * a card keeps the size it was first shown at, so a newer version whose
 * author gives it another size takes it at the next explicit way to Home (or
 * a reload), and nothing being read or answered moves. A new visit or
 * Workspace starts afresh. Sizes are the authors' (card-preview.ts); nothing
 * is kept here across visits, and nothing the user chooses.
 *
 * So too whether a replied Ask is its answer card (YN-3): one that was
 * replied when first shown in this visit, at that version, or one the user
 * answered from this Home at that version (YN-21: the user acted, so it
 * becomes the answer card as soon as Core has the reply). One answered
 * elsewhere (another device or tab) keeps its card until the next visit.
 *
 * And where each card stands on its deck (deck-order.ts): where it stood
 * when its project was first shown in this visit. One that first appears
 * later in the visit stands at the end (`late`), so nothing being read moves;
 * a status that goes out of date, or an Ask the user answers, keeps its
 * place until the next visit too.
 */
import { createContext, useCallback, useMemo, useRef } from "react";
import type { CardSize } from "./card-preview.ts";
import type { DeckPlace } from "./deck-order.ts";

/** One card: a project and Home's id for the section (types.ts Section.id). */
export const sizeKey = (projectId: string, id: number) => `${projectId}:${id}`;
/** A section Core names (an older Core does not) keeps its size through the visit. */
export const sizable = (section: { id?: number }): section is { id: number } => Number.isSafeInteger(section.id);

export type HeldSizes = {
  /** The size to show: the one this card was first shown at in this visit. */
  held: (projectId: string, id: number, size: CardSize) => CardSize;
  /** Whether a replied Ask is shown in short: replied now, and when first shown in this visit at this version, or answered here at it. */
  short: (projectId: string, key: string, version: number, replied: boolean) => boolean;
  /** Core accepted the user's reply, sent from this Home, to this version of an Ask. */
  answered: (projectId: string, key: string, version: number) => void;
  /** Each section's place on its project's deck in this visit, by key, from the places they have now. */
  places: (projectId: string, now: readonly (readonly [key: string, place: DeckPlace])[]) => Map<string, DeckPlace>;
  visit: number;
};
export const DeckSizes = createContext<HeldSizes | null>(null);

export function useHeldSizes(workspaceId: string, visit: number): HeldSizes {
  const shown = useRef({ workspaceId, visit, sizes: new Map<string, CardSize>(), replied: new Map<string, boolean>(), answered: new Set<string>(), places: new Map<string, Map<string, DeckPlace>>() });
  if (shown.current.workspaceId !== workspaceId || shown.current.visit !== visit)
    shown.current = { workspaceId, visit, sizes: new Map(), replied: new Map(), answered: new Set(), places: new Map() };
  const held = useCallback((projectId: string, id: number, size: CardSize) => {
    const sizes = shown.current.sizes, key = sizeKey(projectId, id);
    if (!sizes.has(key)) sizes.set(key, size);
    return sizes.get(key)!;
  }, []);
  const short = useCallback((projectId: string, key: string, version: number, replied: boolean) => {
    const first = shown.current.replied, at = JSON.stringify([projectId, key, version]);
    if (!first.has(at)) first.set(at, replied);
    return replied && (first.get(at)! || shown.current.answered.has(at));
  }, []);
  const answered = useCallback((projectId: string, key: string, version: number) => {
    shown.current.answered.add(JSON.stringify([projectId, key, version]));
  }, []);
  const places = useCallback((projectId: string, now: readonly (readonly [string, DeckPlace])[]) => {
    const all = shown.current.places;
    let held = all.get(projectId);
    // The project's first showing in this visit sets every place; a card after it comes late.
    const first = !held;
    if (!held) all.set(projectId, (held = new Map()));
    for (const [key, place] of now) if (!held.has(key)) held.set(key, first ? place : "late");
    return new Map(now.map(([key]) => [key, held!.get(key)!]));
  }, []);
  // A new visit is a new value, so every card reads its size afresh.
  return useMemo(() => ({ held, short, answered, places, visit }), [held, short, answered, places, visit]);
}
