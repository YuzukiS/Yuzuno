import { createContext } from "react";

/**
 * Where each Turn is being read, by input (T-6): a Turn reports the input at
 * or before its row at the reading line, as its rows place it (with the
 * heights of rows not drawn estimated, as ConversationRows does), or null
 * when none is: it starts with mail or Claude's own input.
 */
export const InputReading = createContext<((turnId: string, itemId: string | null) => void) | null>(null);
