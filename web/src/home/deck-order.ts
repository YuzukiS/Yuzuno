import type { TopicGroup } from "./brief-layout.ts";
import type { Section } from "./types";

/**
 * Where a card stands on its project's deck (YN-3), in this order:
 * - `ask`: an open Ask, what needs the user;
 * - `status`: a status whose data is still current;
 * - `report`: a report;
 * - `deferred`: an open Ask the user put off until later;
 * - `late`: a card that first appeared while this visit to Home went on: at
 *   the end, so nothing the user is reading moves; its own place at the
 *   next visit (card-sizes.ts);
 * - `replied`: an Ask the user answered, waiting for its owner, under its
 *   own heading;
 * - `stale`: a status older than it says it is valid for, in a closed
 *   "Out of date" at the deck's end.
 * Within each, Core's order: first written first.
 */
export const DECK_PLACES = ["ask", "status", "report", "deferred", "late", "replied", "stale"] as const;
export type DeckPlace = (typeof DECK_PLACES)[number];

/** A section's own place on the deck now (never `late`: that is the visit's, card-sizes.ts). */
export function deckPlace(section: Section, now = Date.now()): Exclude<DeckPlace, "late"> {
  if (section.kind === "ask") {
    if (section.ask?.state === "replied") return "replied";
    const until = section.ask?.deferredUntil;
    return until && Date.parse(until) > now ? "deferred" : "ask";
  }
  if (section.kind === "status") return section.status?.stale ? "stale" : "status";
  return "report";
}

const rank = (place: DeckPlace) => DECK_PLACES.indexOf(place);

/**
 * A project's topic groups in the deck's order: each stands where its most
 * urgent card would, so a topic's cards keep together and an open Ask in a
 * topic keeps that topic out of "Out of date". Ties keep Core's order.
 */
export function orderDeck(groups: readonly TopicGroup[], placeOf: (section: Section) => DeckPlace) {
  return groups
    .map((group, index) => {
      const members = [...(group.parent ? [group.parent] : []), ...group.subs];
      const place = members.map(placeOf).reduce((most, place) => (rank(place) < rank(most) ? place : most), "stale" as DeckPlace);
      return { group, index, place };
    })
    .sort((a, b) => rank(a.place) - rank(b.place) || a.index - b.index)
    .map(({ group, place }) => ({ group, place }));
}
