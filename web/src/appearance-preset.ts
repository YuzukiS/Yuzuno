import { api, HttpError } from "./api";
import type { Appearance } from "./appearance";
import { appearanceSettings, isObject, readAppearanceGroup, shown, type AppearanceFileContents } from "./appearance-file";

/**
 * One Appearance preset shared in this Workspace (T-194), kept by its Core
 * (core/src/appearance_preset.rs). A device saves its Appearance there, and
 * another reads it to preview and apply on itself, each only when the user
 * presses it: nothing follows along, and this is not preference sync. A save
 * names the Workspace and the revision this device read, and Core refuses
 * it when either is no longer its own; the refusal is said, never retried.
 */
export const PRESET_VERSION = 1;

/** The preset as this device read it from one Workspace: none saved yet
 * (revision 0), one it can preview, or one it can't use, with why. */
export type PresetRead = { workspaceId: string; revision: number } & (
  | { kind: "none" }
  | { kind: "preset"; savedAt: string | null; savedVia: "local" | "remote" | null; contents: AppearanceFileContents }
  | { kind: "refused"; reason: string }
);

/** Core's answer, read as this version can: a later preset version, or a
 * preset that is not settings, is refused rather than read as this one. */
export function readPresetAnswer(answer: unknown): PresetRead {
  if (!isObject(answer) || typeof answer.workspaceId !== "string" || !answer.workspaceId)
    throw new Error("Core’s answer names no Workspace");
  const workspaceId = answer.workspaceId;
  const preset = answer.preset;
  if (preset === null || preset === undefined) return { workspaceId, revision: 0, kind: "none" };
  if (!isObject(preset) || !Number.isInteger(preset.revision) || (preset.revision as number) < 1)
    throw new Error("Core’s answer holds no preset revision");
  const revision = preset.revision as number;
  if (preset.version !== PRESET_VERSION)
    return {
      workspaceId,
      revision,
      kind: "refused",
      reason:
        Number.isInteger(preset.version) && (preset.version as number) > PRESET_VERSION
          ? `it is from a newer Yuzuno (preset version ${preset.version}); this version reads version ${PRESET_VERSION}`
          : "its version isn’t one Yuzuno knows",
    };
  if (!isObject(preset.appearance))
    return { workspaceId, revision, kind: "refused", reason: `it holds no Appearance settings: ${shown(preset.appearance)}` };
  const savedAt = typeof preset.savedAt === "string" && !Number.isNaN(Date.parse(preset.savedAt)) ? preset.savedAt : null;
  const savedVia = preset.savedVia === "local" || preset.savedVia === "remote" ? preset.savedVia : null;
  return {
    workspaceId,
    revision,
    kind: "preset",
    savedAt,
    savedVia,
    contents: { ...readAppearanceGroup(preset.appearance), exportedAt: savedAt },
  };
}

export async function fetchPreset(signal?: AbortSignal): Promise<PresetRead> {
  return readPresetAnswer(await api<unknown>("/appearance-preset", { signal }));
}

/** Why Core did not keep a save: another device saved since this one read,
 * or this page read the preset from another Workspace. */
export type PresetConflict = "preset_changed" | "other_workspace";

/** Saves `appearance` over the preset `read`, once. Core keeps it only if
 * its Workspace and revision are still those; otherwise the conflict is
 * returned. Any other failure is thrown, and is not retried here. */
export async function savePreset(read: PresetRead, appearance: Appearance): Promise<PresetRead | { conflict: PresetConflict }> {
  try {
    const answer = await api<unknown>("/appearance-preset", {
      method: "PUT",
      body: JSON.stringify({
        workspaceId: read.workspaceId,
        expectedRevision: read.revision,
        version: PRESET_VERSION,
        appearance: appearanceSettings(appearance),
      }),
    });
    return readPresetAnswer(answer);
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && (error.code === "preset_changed" || error.code === "other_workspace"))
      return { conflict: error.code };
    throw error;
  }
}
