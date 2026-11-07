import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createStateStore, type StateStore } from "@json-render/core";
import { startingValues } from "../../intelligent-ui/brief-inputs.ts";
import type { Section } from "../types";

/**
 * Where a section's variables live while it is shown (YN-16): one store per
 * place that shows it, its card on Home or its report page. A place draws
 * a section in several parts (a card its figure and conditions, a page each
 * block in its own frame), so every part reads the same store, and an input
 * in one part shows or hides a block in another. Two places never share
 * one: what the reader sets on a card is not what the page starts with.
 *
 * The store starts from the values the section's inputs give and is never
 * saved or sent anywhere; another version of the section, or a reload,
 * starts again from its own inputs.
 */
type Scope = { identity: string; store: StateStore };
const BriefStateContext = createContext<Scope | null>(null);

/** A section's version, as one place shows it: its key, its id where Core gave one, and its version. */
const identityOf = (section: Section) => `${section.key}\n${section.id ?? ""}\n${section.version}`;

const storeFor = (section: Section) =>
  createStateStore(startingValues((section.body as { elements?: Record<string, { type?: unknown; props?: unknown }> } | null)?.elements));

/** One place's variables for a section; its parts read them through BriefSectionBody. */
export function BriefStateScope({ section, children }: { section: Section; children: ReactNode }) {
  const identity = identityOf(section);
  // The body is fixed for a version: the store is new only with another version.
  const scope = useMemo(() => ({ identity, store: storeFor(section) }), [identity]);
  return <BriefStateContext.Provider value={scope}>{children}</BriefStateContext.Provider>;
}

/**
 * The store a section's body draws with: its place's, when that place shows
 * this version; else one of its own, for a body drawn alone (the team's
 * details), new with each version.
 */
export function useSectionStore(section: Section): StateStore {
  const scope = useContext(BriefStateContext);
  const identity = identityOf(section);
  const shared = scope?.identity === identity ? scope.store : null;
  const own = useMemo(() => (shared ? null : storeFor(section)), [identity, shared]);
  return shared ?? own!;
}
