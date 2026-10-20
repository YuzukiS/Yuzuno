import { createContext, useContext } from "react";
import type { Section } from "../types";

export type BriefContextValue = {
  projectId: string;
  section: Section;
  /** Opens an Agent's conversation; without it, Agent references are plain chips. */
  onOpenAgent?: (agentId: string) => void;
  /** Opens a Machine; without it, Machine references are plain chips. */
  onOpenMachine?: (machineId: string) => void;
};
export const BriefContext = createContext<BriefContextValue | null>(null);
/** The section being drawn: where its charts and attachments are read from. */
export function useBrief(): BriefContextValue {
  const value = useContext(BriefContext);
  if (!value) throw new Error("Brief parts render inside BriefSectionBody.");
  return value;
}
