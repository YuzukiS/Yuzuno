import { createContext, useContext } from "react";

/**
 * Home's last read of Core (T-9): when it last succeeded and whether the
 * newest attempt failed. What Home shows stays on screen while a read fails;
 * a live list says it is not current then, rather than passing an old read
 * off as now. Outside Home (a preview) there is none.
 */
export type HomeRead = { at: string | null; failed: boolean };
export const HomeReadContext = createContext<HomeRead | null>(null);
export const useHomeRead = () => useContext(HomeReadContext);
