import type { TopicGroup } from "./brief-layout.ts";
import { orderDeck, type DeckPlace } from "./deck-order.ts";
import type { Section } from "./types.ts";

/**
 * The three groups a Project page shows its cards in (YN-86 §2.2): what
 * needs the user, what is in progress, and what is done. Where a card stands
 * is fixed when its project is first shown in a visit (`card-sizes.ts`), so
 * opening a report clears its New mark without moving the card.
 */
export type DeckGroup = "needs" | "doing" | "done";
export const DECK_GROUPS = ["needs", "doing", "done"] as const;
export const groupRank = (group: DeckGroup) => DECK_GROUPS.indexOf(group);

/**
 * The group a card stands in now, from its place on the deck (`deck-order.ts`)
 * and whether the user has not read this version. A status past its validity
 * is done; a report is in progress until it has been read at its current
 * version (Seen, or opened whole on its page); an Ask put off waits in Needs
 * you at the group's end; a card that arrived during this visit is in
 * progress.
 */
export function deckGroup(place: DeckPlace, unread: boolean): DeckGroup {
  switch (place) {
    case "ask":
    case "deferred":
      return "needs";
    case "report":
      return unread ? "doing" : "done";
    case "stale":
      return "done";
    default:
      // status, late, replied
      return "doing";
  }
}

export type GroupedDeck = {
  /** What needs the user, without the Asks put off. */
  needs: TopicGroup[];
  /** The Asks put off, at the end of Needs you. */
  deferred: TopicGroup[];
  /** In progress, without the answered Asks that wait for their owner. */
  doing: TopicGroup[];
  /** Answered Asks waiting for their owner, under their own heading. */
  replied: TopicGroup[];
  /** Reports read at their current version and status past its validity. */
  done: TopicGroup[];
  /** Cards (not topics) in each list. */
  counts: { needs: number; deferred: number; doing: number; replied: number; done: number };
};

/** A topic's cards, its own section first. */
const membersOf = (group: TopicGroup): Section[] => [
  ...(group.parent ? [group.parent] : []),
  ...group.subs,
];

/**
 * A project's topics in the three groups (YN-86 §2.2). A topic enters the
 * group of its most urgent card, as it takes the place of its most urgent
 * card in `orderDeck`; an Ask put off alone goes to the end of Needs you.
 * Within a group, topics keep the deck's order (DECK_PLACES), so a group is
 * ordered by what it takes to answer or read first.
 */
export function groupDeck(
  groups: readonly TopicGroup[],
  groupOf: (section: Section) => DeckGroup,
  placeOf: (section: Section) => DeckPlace,
): GroupedDeck {
  const out: GroupedDeck = {
    needs: [],
    deferred: [],
    doing: [],
    replied: [],
    done: [],
    counts: { needs: 0, deferred: 0, doing: 0, replied: 0, done: 0 },
  };
  for (const { group, place } of orderDeck(groups, placeOf)) {
    const members = membersOf(group);
    const group_ = members.map(groupOf).reduce((most, now) => (groupRank(now) < groupRank(most) ? now : most), "done" as DeckGroup);
    if (group_ === "needs") {
      if (place === "deferred") {
        out.deferred.push(group);
        out.counts.deferred += members.length;
        continue;
      }
      out.needs.push(group);
      out.counts.needs += members.filter((section) => placeOf(section) !== "deferred").length;
    } else if (group_ === "doing") {
      if (place === "replied") {
        out.replied.push(group);
        out.counts.replied += members.filter((section) => placeOf(section) === "replied").length;
        continue;
      }
      out.doing.push(group);
      out.counts.doing += members.length;
    } else {
      out.done.push(group);
      out.counts.done += members.length;
    }
  }
  return out;
}

/** Every card in a list of topics. */
export const deckMembers = (groups: readonly TopicGroup[]): Section[] => groups.flatMap(membersOf);
