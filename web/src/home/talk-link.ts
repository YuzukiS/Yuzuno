import { createContext } from "react";
import type { ProjectRequest } from "./project-talk-api";
import type { ShowCard } from "./RoutingEvents";

/**
 * What a Project's page shares between "Talk to the project" and its cards
 * (YN-86 §4.3, §4.5): the requests it read, so a card knows the other cards
 * its request went to, and a way back to a request's words in the
 * conversation, and a way to a card on the page (its task, where it is no
 * longer there). Absent off the Project's page (the whole of Home), where a
 * card's "See words" opens the Project's page at the card instead.
 */
export type TalkLink = { requests: readonly ProjectRequest[]; reveal: (n: number) => void; showCard: ShowCard };
export const ProjectTalkLink = createContext<TalkLink | null>(null);
