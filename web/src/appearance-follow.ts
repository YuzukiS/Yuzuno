import { useEffect, useSyncExternalStore } from "react";
import { errorText, NetworkError } from "./api";
import { appearanceInEffect, importAppearance, onAppearanceEdit } from "./appearance";
import { appearanceFields, importedAppearance } from "./appearance-file";
import { fetchPreset, type PresetRead } from "./appearance-preset";
import { clearDeviceValue, onDeviceValueChange, readDeviceValue, saveDeviceValue, type SaveOutcome } from "./device-storage";

/**
 * This device following its Workspace's shared Appearance preset (T-194):
 * one way, off until the user turns it on after a preview, and kept on this
 * device for each Workspace apart. While on, a newer revision of that
 * Workspace's preset is applied here when Core announces a save, when the
 * live events reset, and when they reconnect; nothing is polled, and
 * following never sends this device's Appearance anywhere. It applies only
 * once the Appearance is saved on this device. Another Workspace, a preset
 * this version can't read, a revision that went back or a refused save on
 * this device pause it, keeping what is in effect; changing Appearance here
 * (an import too) stops it. Stopping keeps this device's Appearance and
 * changes nothing on Core.
 */
const KEY = "yuzuno.appearanceFollow";

type Followed = Record<string, { revision: number }>;

/** The Workspaces this device follows and the revision it last applied of
 * each, as saved; anything else under the key is not a choice to follow. */
function followed(): Followed {
  const value = readDeviceValue(KEY);
  const workspaces = value && typeof value === "object" && !Array.isArray(value) ? (value as { workspaces?: unknown }).workspaces : null;
  const out: Followed = {};
  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces))
    for (const [id, entry] of Object.entries(workspaces as Record<string, unknown>)) {
      const revision = entry && typeof entry === "object" ? (entry as { revision?: unknown }).revision : null;
      if (id && Number.isInteger(revision) && (revision as number) >= 1) out[id] = { revision: revision as number };
    }
  return out;
}
const write = (workspaces: Followed): SaveOutcome =>
  Object.keys(workspaces).length ? saveDeviceValue(KEY, { workspaces }) : clearDeviceValue(KEY);

/** Stopped in this window though its storage refused to say so. */
const stoppedHere = new Set<string>();

/** The revision of `workspaceId`'s preset this device last applied while
 * following it; null when it doesn't follow it. */
export function followedRevision(workspaceId: string): number | null {
  if (!workspaceId || stoppedHere.has(workspaceId)) return null;
  return followed()[workspaceId]?.revision ?? null;
}

/** How following goes in this window, for each Workspace it follows. */
export type FollowCondition =
  | { kind: "following"; appliedAt: string | null; note?: string }
  | { kind: "offline" }
  | { kind: "paused"; reason: string };
/** Why following stopped in this visit, said once beside the preset. */
export type FollowStop = { why: "edited" | "chosen"; unsaved?: string };
const conditions = new Map<string, FollowCondition>();
const stops = new Map<string, FollowStop>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((listener) => listener());
};
const set = (workspaceId: string, condition: FollowCondition) => {
  conditions.set(workspaceId, condition);
  changed();
};

/** Turns following on for `workspaceId`, at the revision the user just
 * applied here. */
export function startFollowing(workspaceId: string, revision: number): SaveOutcome {
  const outcome = write({ ...followed(), [workspaceId]: { revision } });
  if (outcome.saved) {
    stoppedHere.delete(workspaceId);
    stops.delete(workspaceId);
    conditions.set(workspaceId, { kind: "following", appliedAt: new Date().toISOString() });
  }
  changed();
  return outcome;
}

/** Turns following off for `workspaceId`; this device keeps its Appearance. */
export function stopFollowing(workspaceId: string, why: FollowStop["why"]): void {
  const { [workspaceId]: _, ...rest } = followed();
  const outcome = write(rest);
  if (!outcome.saved) stoppedHere.add(workspaceId);
  conditions.delete(workspaceId);
  stops.set(workspaceId, outcome.saved ? { why } : { why, unsaved: outcome.detail });
  changed();
}

/** Reads the preset and applies a newer revision of the same Workspace, once
 * saved here. Runs one at a time; a call meanwhile runs once more after,
 * for the Workspace it names. */
let running: Promise<void> | null = null;
let queued: string | null = null;
export function catchUp(workspaceId: string): Promise<void> {
  if (running) {
    queued = workspaceId;
    return running;
  }
  running = (async () => {
    let next: string | null = workspaceId;
    while (next) {
      queued = null;
      await once(next);
      next = queued;
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

async function once(workspaceId: string) {
  if (followedRevision(workspaceId) === null) return;
  let read: PresetRead;
  try {
    read = await fetchPreset();
  } catch (error) {
    set(workspaceId, error instanceof NetworkError ? { kind: "offline" } : { kind: "paused", reason: `the preset couldn’t be read (${errorText(error)})` });
    return;
  }
  // Stopped, or applied by another window, while it was read.
  const applied = followedRevision(workspaceId);
  if (applied === null) return;
  const was = conditions.get(workspaceId);
  const kept = was?.kind === "following" ? was : { kind: "following" as const, appliedAt: null };
  if (read.workspaceId !== workspaceId) {
    set(workspaceId, { kind: "paused", reason: `this page now reaches another Workspace (${read.workspaceId.slice(0, 8)}), whose preset this device doesn’t follow` });
    return;
  }
  if (read.kind === "refused") {
    set(workspaceId, { kind: "paused", reason: `revision ${read.revision} can’t be applied here: ${read.reason}` });
    return;
  }
  if (read.kind === "none" || read.revision === applied) {
    set(workspaceId, kept);
    return;
  }
  if (read.revision < applied) {
    set(workspaceId, {
      kind: "paused",
      reason: `the preset is at revision ${read.revision}, before the revision ${applied} this device applied, so it isn’t applied by itself`,
    });
    return;
  }
  const fields = appearanceFields.filter((field) => read.contents.values[field] !== undefined);
  const outcome = importAppearance(importedAppearance(appearanceInEffect(), read.contents, fields), { followed: true });
  if (!outcome.saved) {
    set(workspaceId, { kind: "paused", reason: `revision ${read.revision} wasn’t applied: ${outcome.detail}, so nothing changed here` });
    return;
  }
  const noted = write({ ...followed(), [workspaceId]: { revision: read.revision } });
  set(workspaceId, {
    kind: "following",
    appliedAt: new Date().toISOString(),
    note: noted.saved ? undefined : `this device couldn’t note that it applied revision ${read.revision} (${noted.detail}), so it may apply it again`,
  });
}

/** What following is for `workspaceId` in this window now. */
export function useFollow(workspaceId: string | null): {
  revision: number | null;
  condition: FollowCondition | null;
  stop: FollowStop | null;
} {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      // Another window turned it on or off, or applied a revision.
      const off = onDeviceValueChange(KEY, changed);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
    () => version,
  );
  if (!workspaceId) return { revision: null, condition: null, stop: null };
  const revision = followedRevision(workspaceId);
  return {
    revision,
    condition: revision === null ? null : (conditions.get(workspaceId) ?? null),
    stop: revision === null ? (stops.get(workspaceId) ?? null) : null,
  };
}

/** Keeps this window following `workspaceId`'s preset when this device
 * does: `connected` is the live events being open, `nudge` a count of
 * announced saves and resets. An edit of Appearance here stops it. */
export function useAppearanceFollow(workspaceId: string, connected: boolean, nudge: number) {
  useEffect(() => {
    if (!workspaceId) return;
    return onAppearanceEdit(() => {
      if (followedRevision(workspaceId) !== null) stopFollowing(workspaceId, "edited");
    });
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || followedRevision(workspaceId) === null) return;
    if (!connected) {
      set(workspaceId, { kind: "offline" });
      return;
    }
    void catchUp(workspaceId);
  }, [workspaceId, connected, nudge]);
}
