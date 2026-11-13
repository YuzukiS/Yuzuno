import { createContext, useContext } from "react";

/** Where Home sends the user when something lives elsewhere in the app. */
export type HomeTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "request"; agentId: string; requestId: string }
  | { kind: "changes"; agentId: string; requestId: string; turnId?: string; itemId?: string }
  | { kind: "error"; agentId: string }
  | { kind: "machine"; machineId: string }
  /** A Project's page on Home (YN-86), at one of its cards when named. */
  | { kind: "project"; projectId: string; sectionKey?: string }
  /** A project's page in Settings, where its repositories are linked (YN-8 S7). */
  | { kind: "projectSettings"; projectId: string };

export const HomeNavigation = createContext<(target: HomeTarget) => void>(() => {});
export const useHomeNavigation = () => useContext(HomeNavigation);
