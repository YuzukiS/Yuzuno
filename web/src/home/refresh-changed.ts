import { createContext, useContext } from "react";

/**
 * Reads Home again after the user changed a card's refresh schedule (YN-113
 * R3): the card, the report page and Settings all show Core's answer, so the
 * schedule's version, state and next time are Core's, never the page's guess.
 * Null outside Home (a preview), which writes nothing either.
 */
export const RefreshChangedContext = createContext<(() => void) | null>(null);
export const useRefreshChanged = () => useContext(RefreshChangedContext);
