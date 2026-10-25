import { api, errorText, HttpError } from "./api";
import type { Appearance } from "./appearance";
import { appearanceSettings, isObject, readAppearanceGroup, shown, type AppearanceFileContents } from "./appearance-file";
import { strings, type Language } from "./i18n";

/**
 * One Appearance preset shared in this Workspace (T-194), kept by its Core
 * (core/src/appearance_preset.rs). A device saves its Appearance there, and
 * another reads it to preview and apply on itself, each only when the user
 * presses it: nothing follows along, and this is not preference sync. A save
 * names the Workspace and the revision this device read, and Core refuses
 * it when either is no longer its own; the refusal is said, never retried.
 */
export const PRESET_VERSION = 1;

/** Why a preset can't be used here, kept as what it is and worded when
 * shown, so it follows the interface language (T-189). */
export type RefusedWhy =
  | { code: "newer"; version: number; reads: number }
  | { code: "unknownVersion" }
  | { code: "notSettings"; value: string };

/** The preset as this device read it from one Workspace: none saved yet
 * (revision 0), one it can preview, or one it can't use, with why: its
 * English (`reason`) and the same as a code (`why`). */
export type PresetRead = { workspaceId: string; revision: number } & (
  | { kind: "none" }
  | { kind: "preset"; savedAt: string | null; savedVia: "local" | "remote" | null; contents: AppearanceFileContents }
  | { kind: "refused"; reason: string; why: RefusedWhy }
);

// What this file says itself (T-189). Values from the preset are shown as
// they are.
const words = strings({
  newer: (version: number, reads: number) => `it is from a newer Yuzuno (preset version ${version}); this version reads version ${reads}`,
  unknownVersion: "its version isn’t one Yuzuno knows",
  notSettings: (value: string) => `it holds no Appearance settings: ${value}`,
  noWorkspace: "Core’s answer names no Workspace",
  noRevision: "Core’s answer holds no preset revision",
}, {
  newer: (version, reads) => `它来自较新的 Yuzuno（预设版本 ${version}）；此版本读取版本 ${reads}`,
  unknownVersion: "它的版本不是 Yuzuno 认识的版本",
  notSettings: (value) => `它没有外观设置：${value}`,
  noWorkspace: "Core 的回答没有指明 Workspace",
  noRevision: "Core 的回答没有预设修订",
});

/** Why a preset can't be used here, in `language`. */
export function refusedText(why: RefusedWhy, language: Language = "en"): string {
  const w = words(language);
  return why.code === "newer" ? w.newer(why.version, why.reads) : why.code === "unknownVersion" ? w.unknownVersion : w.notSettings(why.value);
}
const refused = (workspaceId: string, revision: number, why: RefusedWhy): PresetRead => ({
  workspaceId,
  revision,
  kind: "refused",
  reason: refusedText(why),
  why,
});

/** Core answered in a form this version can't read. */
export class PresetAnswerError extends Error {
  constructor(readonly code: "noWorkspace" | "noRevision") {
    super(words("en")[code]);
  }
}
/** What a failed read or save says, in `language`: this file's own words,
 * else Core's or the browser's as they came. */
export const presetErrorText = (error: unknown, language: Language = "en") =>
  error instanceof PresetAnswerError ? words(language)[error.code] : errorText(error);

/** Core's answer, read as this version can: a later preset version, or a
 * preset that is not settings, is refused rather than read as this one. */
export function readPresetAnswer(answer: unknown): PresetRead {
  if (!isObject(answer) || typeof answer.workspaceId !== "string" || !answer.workspaceId)
    throw new PresetAnswerError("noWorkspace");
  const workspaceId = answer.workspaceId;
  const preset = answer.preset;
  if (preset === null || preset === undefined) return { workspaceId, revision: 0, kind: "none" };
  if (!isObject(preset) || !Number.isInteger(preset.revision) || (preset.revision as number) < 1)
    throw new PresetAnswerError("noRevision");
  const revision = preset.revision as number;
  if (preset.version !== PRESET_VERSION)
    return refused(
      workspaceId,
      revision,
      Number.isInteger(preset.version) && (preset.version as number) > PRESET_VERSION
        ? { code: "newer", version: preset.version as number, reads: PRESET_VERSION }
        : { code: "unknownVersion" },
    );
  if (!isObject(preset.appearance)) return refused(workspaceId, revision, { code: "notSettings", value: shown(preset.appearance) });
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
