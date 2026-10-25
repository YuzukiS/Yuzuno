import { useEffect, useSyncExternalStore } from "react";
import type { EventConnection } from "./useWorkspaceEvents";
import { NetworkError } from "./api";
import { appearanceInEffect, importAppearance, onAppearanceEdit } from "./appearance";
import { appearanceFields, importedAppearance } from "./appearance-file";
import { fetchPreset, presetErrorText, refusedText, type PresetRead, type RefusedWhy } from "./appearance-preset";
import { clearDeviceValue, onDeviceValueChange, readDeviceValue, saveDeviceValue, type SaveOutcome } from "./device-storage";
import { strings, type Language } from "./i18n";
import { saveRefusalReason } from "./SaveStatus";

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

/** A write this device's storage refused. */
type Refused = Extract<SaveOutcome, { saved: false }>;
/** Why following is paused, kept as what happened and worded when shown
 * (T-189): Core's and the browser's own words are kept as they came. */
export type PauseWhy =
  | { code: "unreadable"; error: unknown }
  | { code: "otherWorkspace"; workspace: string }
  | { code: "refused"; revision: number; why: RefusedWhy }
  | { code: "wentBack"; revision: number; applied: number }
  | { code: "notApplied"; revision: number; refused: Refused };
/** How following goes in this window, for each Workspace it follows; `note`:
 * a revision applied but not noted as applied. */
export type FollowCondition =
  | { kind: "following"; appliedAt: string | null; note?: { revision: number; refused: Refused } }
  | { kind: "offline" }
  | { kind: "paused"; why: PauseWhy };
/** Why following stopped in this visit, said once beside the preset. */
export type FollowStop = { why: "edited" | "chosen"; unsaved?: Refused };

const words = strings({
  unreadable: (error: string) => `the preset couldn’t be read (${error})`,
  otherWorkspace: (workspace: string) => `this page now reaches another Workspace (${workspace}), whose preset this device doesn’t follow`,
  refused: (revision: number, why: string) => `revision ${revision} can’t be applied here: ${why}`,
  wentBack: (revision: number, applied: number) =>
    `the preset is at revision ${revision}, before the revision ${applied} this device applied, so it isn’t applied by itself`,
  notApplied: (revision: number, why: string) => `revision ${revision} wasn’t applied: ${why}, so nothing changed here`,
  unnoted: (revision: number, why: string) => `this device couldn’t note that it applied revision ${revision} (${why}), so it may apply it again`,
}, {
  unreadable: (error) => `无法读取预设（${error}）`,
  otherWorkspace: (workspace) => `此页面现在连到另一个 Workspace（${workspace}），此设备不跟随它的预设`,
  refused: (revision, why) => `修订 ${revision} 无法在这里应用：${why}`,
  wentBack: (revision, applied) => `预设处于修订 ${revision}，早于此设备已应用的修订 ${applied}，因此不会自动应用`,
  notApplied: (revision, why) => `修订 ${revision} 未应用：${why}，因此这里没有任何变化`,
  unnoted: (revision, why) => `此设备无法记下它已应用修订 ${revision}（${why}），因此可能会再次应用它`,
});

/** Why following is paused, in `language`. */
export function pauseText(why: PauseWhy, language: Language = "en"): string {
  const w = words(language);
  switch (why.code) {
    case "unreadable":
      return w.unreadable(presetErrorText(why.error, language));
    case "otherWorkspace":
      return w.otherWorkspace(why.workspace);
    case "refused":
      return w.refused(why.revision, refusedText(why.why, language));
    case "wentBack":
      return w.wentBack(why.revision, why.applied);
    case "notApplied":
      return w.notApplied(why.revision, saveRefusalReason(why.refused, language));
  }
}
/** A revision applied but not noted, in `language`. */
export const noteText = (note: { revision: number; refused: Refused }, language: Language = "en") =>
  words(language).unnoted(note.revision, saveRefusalReason(note.refused, language));
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
  stops.set(workspaceId, outcome.saved ? { why } : { why, unsaved: outcome });
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
    set(workspaceId, error instanceof NetworkError ? { kind: "offline" } : { kind: "paused", why: { code: "unreadable", error } });
    return;
  }
  // Stopped, or applied by another window, while it was read.
  const applied = followedRevision(workspaceId);
  if (applied === null) return;
  const was = conditions.get(workspaceId);
  const kept = was?.kind === "following" ? was : { kind: "following" as const, appliedAt: null };
  if (read.workspaceId !== workspaceId) {
    set(workspaceId, { kind: "paused", why: { code: "otherWorkspace", workspace: read.workspaceId.slice(0, 8) } });
    return;
  }
  if (read.kind === "refused") {
    set(workspaceId, { kind: "paused", why: { code: "refused", revision: read.revision, why: read.why } });
    return;
  }
  if (read.kind === "none" || read.revision === applied) {
    set(workspaceId, kept);
    return;
  }
  if (read.revision < applied) {
    set(workspaceId, { kind: "paused", why: { code: "wentBack", revision: read.revision, applied } });
    return;
  }
  const fields = appearanceFields.filter((field) => read.contents.values[field] !== undefined);
  const outcome = importAppearance(importedAppearance(appearanceInEffect(), read.contents, fields), { followed: true });
  if (!outcome.saved) {
    set(workspaceId, { kind: "paused", why: { code: "notApplied", revision: read.revision, refused: outcome } });
    return;
  }
  const noted = write({ ...followed(), [workspaceId]: { revision: read.revision } });
  set(workspaceId, {
    kind: "following",
    appliedAt: new Date().toISOString(),
    note: noted.saved ? undefined : { revision: read.revision, refused: noted },
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another window turned it on or off, or applied a revision.
  const off = onDeviceValueChange(KEY, changed);
  return () => {
    listeners.delete(listener);
    off();
  };
};

/** What following is for `workspaceId` in this window now. */
export function useFollow(workspaceId: string | null): {
  revision: number | null;
  condition: FollowCondition | null;
  stop: FollowStop | null;
} {
  useSyncExternalStore(subscribe, () => version);
  if (!workspaceId) return { revision: null, condition: null, stop: null };
  const revision = followedRevision(workspaceId);
  return {
    revision,
    condition: revision === null ? null : (conditions.get(workspaceId) ?? null),
    stop: revision === null ? (stops.get(workspaceId) ?? null) : null,
  };
}

/** Keeps this window following `workspaceId`'s preset when this device
 * does: `connection` is the live events' state, `nudge` a count of
 * announced saves and resets. Only a lost connection ("reconnecting") is
 * offline; the first "connecting" of a page load is not. An edit of
 * Appearance here stops it. */
export function useAppearanceFollow(workspaceId: string, connection: EventConnection, nudge: number) {
  useEffect(() => {
    if (!workspaceId) return;
    return onAppearanceEdit(() => {
      if (followedRevision(workspaceId) !== null) stopFollowing(workspaceId, "edited");
    });
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId || followedRevision(workspaceId) === null) return;
    if (connection === "reconnecting") {
      set(workspaceId, { kind: "offline" });
      return;
    }
    if (connection === "open") void catchUp(workspaceId);
  }, [workspaceId, connection, nudge]);
}
