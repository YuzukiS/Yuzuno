import { createContext, useContext, useSyncExternalStore } from "react";
import { readDeviceValue, saveDeviceValue, type SaveOutcome } from "../device-storage";

/**
 * How much each Home card shows (T-9), chosen on this device for each
 * Workspace apart: `low` (spacious) shows a card's main point (a plan's
 * steps as a short timeline, a metric's value with its trend, a
 * deliverable's preview), `high` (compact) every field and row. It is a way
 * of showing the same content: the Agent writes one body, nothing is sent to
 * it or kept in the Workspace, and the Workspace's own Home presentation
 * preference (what Agents are told) is a different setting.
 */
export const densities = ["low", "high"] as const;
export type Density = (typeof densities)[number];
/** Home's default until the user chooses: the low form the approved Home
 * board shows. */
export const HOME_DENSITY: Density = "low";
const storageKey = (workspaceId: string) => `yuzuno.homeDensity.${workspaceId}`;

const read = (workspaceId: string): Density => {
  if (!workspaceId) return HOME_DENSITY;
  const saved = readDeviceValue(storageKey(workspaceId));
  return densities.includes(saved as Density) ? (saved as Density) : HOME_DENSITY;
};

// The choice in effect for each Workspace: read once, then again whenever
// chosen here or saved in another window. A choice this device refused to
// keep still applies in this window (refusals say why), and so does one
// made where no Workspace is known (the design preview): never saved.
const listeners = new Set<() => void>();
const current = new Map<string, Density>();
const refusals = new Map<string, SaveOutcome>();
const notify = () => listeners.forEach((listener) => listener());
const onStorage = (event: StorageEvent) => {
  if (event.key !== null && !event.key.startsWith(storageKey(""))) return;
  // Only saved choices are read again; the preview's stays.
  for (const id of [...current.keys()]) if (id) current.delete(id);
  refusals.clear();
  notify();
};
// What is read is kept for this window's life, so another window's choice
// is watched for as long: Home closed here (a conversation open) must not
// miss it and show the old one when it opens again.
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  window.addEventListener("storage", onStorage);
}
function subscribe(listener: () => void) {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const inEffect = (workspaceId: string) => {
  watch();
  let density = current.get(workspaceId);
  if (!density) current.set(workspaceId, (density = read(workspaceId)));
  return density;
};

/** Home's density for `workspaceId` on this device ("" where none is known). */
export function useHomeDensity(workspaceId: string): Density {
  return useSyncExternalStore(subscribe, () => inEffect(workspaceId));
}

/** Why this window's last choice for `workspaceId` was not kept, or null. */
export function useHomeDensityRefusal(workspaceId: string): SaveOutcome | null {
  return useSyncExternalStore(subscribe, () => refusals.get(workspaceId) ?? null);
}

/** Applies the choice now and keeps it on this device for `workspaceId`;
 * with no Workspace ("") it holds for this window only. */
export function chooseHomeDensity(workspaceId: string, density: Density): SaveOutcome | null {
  watch();
  const outcome = workspaceId ? saveDeviceValue(storageKey(workspaceId), density) : null;
  current.set(workspaceId, density);
  if (outcome && !outcome.saved) refusals.set(workspaceId, outcome);
  else refusals.delete(workspaceId);
  notify();
  return outcome;
}

/**
 * The density Brief parts draw at. Outside Home (no provider) every part is
 * drawn as it always was, which is the high form.
 */
export const BriefDensity = createContext<Density>("high");
export const useBriefDensity = () => useContext(BriefDensity);
