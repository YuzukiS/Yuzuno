import { createContext, useContext } from "react";
import type { Section } from "../types";

/** Opens a section's report over Home (T-18), from the control that asked:
 * Back returns focus there. Null where Home offers no report. */
export type ReportOpener = (projectId: string, section: Section, from: HTMLElement) => void;
export const ReportOpen = createContext<ReportOpener | null>(null);
export const useReportOpen = () => useContext(ReportOpen);
