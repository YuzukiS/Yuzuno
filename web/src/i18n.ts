import { createContext, useContext, useSyncExternalStore } from "react";
import {
  clearDeviceValue,
  deviceValueState,
  onDeviceValueChange,
  readDeviceValue,
  saveDeviceValue,
  type DeviceValueState,
  type SaveOutcome,
} from "./device-storage.ts";

/**
 * The interface language of this device (T-189): kept in this browser or app
 * only, for this address (device-storage.ts, as Appearance and the clock
 * format are), apart from how times are written (time-preferences.ts).
 *
 * It translates parts of Settings: the directory, its search and shared save
 * messages, and the pages translatedEditors (settings-catalog.ts) lists.
 * Everything else stays in English, and a
 * string a table doesn't have is shown in English. What people and Agents
 * wrote, code, logs, names and identifiers are never translated.
 */

/** - `system`: the browser's language when this version has it (Simplified
 *   Chinese for zh, zh-CN, zh-SG and zh-Hans), else English.
 * - `en`, `zh-Hans`: that language, whatever the browser's. */
export const languageChoices = ["system", "en", "zh-Hans"] as const;
export type LanguageChoice = (typeof languageChoices)[number];
export type Language = "en" | "zh-Hans";

export type LanguagePreferences = { language: LanguageChoice };
export const defaultLanguagePreferences: LanguagePreferences = { language: "system" };
const STORAGE_KEY = "yuzuno.language";

/** What the browser asks for, first: the language this version shows for
 * it, and the tag it asked for when this version doesn't have it (English
 * is shown instead). */
export function systemLanguage(asked: readonly string[] = browserLanguages()): { language: Language; unavailable: string | null } {
  const tag = asked.find(Boolean);
  if (!tag) return { language: "en", unavailable: null };
  const lower = tag.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-hans") || lower === "zh-cn" || lower === "zh-sg") return { language: "zh-Hans", unavailable: null };
  if (lower === "en" || lower.startsWith("en-")) return { language: "en", unavailable: null };
  return { language: "en", unavailable: tag };
}
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** The language shown for `choice`. */
export const shownLanguage = (choice: LanguageChoice): Language => (choice === "system" ? systemLanguage().language : choice);

export function readLanguagePreferences(): LanguagePreferences {
  const saved = readDeviceValue(STORAGE_KEY) as Partial<LanguagePreferences> | null;
  return {
    language: languageChoices.includes(saved?.language as LanguageChoice)
      ? (saved!.language as LanguageChoice)
      : defaultLanguagePreferences.language,
  };
}

// The choice in effect: read once, then again whenever chosen here or saved
// in another window.
const listeners = new Set<() => void>();
let current: LanguagePreferences | null = null;
/** What this visit's last write of this preference did: a save or a reset,
 * and which write it was (a new number each time). */
export type LanguageWrite = { outcome: SaveOutcome; action: "save" | "reset"; attempt: number };
// Null before one.
let lastSave: LanguageWrite | null = null;
let attempts = 0;
const notify = () => listeners.forEach((listener) => listener());
let stopWatching: (() => void) | undefined;
const subscribe = (listener: () => void) => {
  if (!listeners.size) stopWatching = onDeviceValueChange(STORAGE_KEY, changed);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopWatching?.();
  };
};
// Another window saved: what is in effect here is what is saved now.
function changed() {
  current = null;
  lastSave = null;
  notify();
}
export function useLanguagePreferences(): LanguagePreferences {
  return useSyncExternalStore(subscribe, () => (current ??= readLanguagePreferences()));
}
// Whether what renders here is a part this version translates: inside an
// editor it doesn't (Settings' Appearance, say), a shared piece such as
// SaveStatus stays in English with the rest of that editor.
const Translated = createContext(true);
export const TranslatedPart = Translated.Provider;

/** The language this part is shown in now: this device's, or English where
 * this version doesn't translate. */
export function useLanguage(): Language {
  const chosen = shownLanguage(useLanguagePreferences().language);
  return useContext(Translated) ? chosen : "en";
}

/** What this visit's last save or reset of this preference did, or null. */
export function useLanguageSave(): LanguageWrite | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** What this device holds for this preference, read now: a saved one, none
 * (the default), one it can't read (the default applies), or storage it
 * can't read. */
export function languageStored(): DeviceValueState {
  const state = deviceValueState(STORAGE_KEY);
  if (state !== "saved") return state;
  const value = readDeviceValue(STORAGE_KEY) as Partial<LanguagePreferences> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid";
  return value.language === undefined || languageChoices.includes(value.language) ? "saved" : "invalid";
}

/** Applies the choice now and saves it on this device. A refused write is
 * reported, not hidden: the choice still applies in this window. */
export function saveLanguagePreferences(preferences: LanguagePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  current = preferences;
  lastSave = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}

/** A choice taken from a preferences file (T-194): saved on this device
 * first, and in effect only once saved. A refused save changes nothing,
 * here or in this window. */
export function importLanguagePreferences(preferences: LanguagePreferences): SaveOutcome {
  const outcome = saveDeviceValue(STORAGE_KEY, preferences);
  if (!outcome.saved) return outcome;
  current = preferences;
  lastSave = { outcome, action: "save", attempt: ++attempts };
  notify();
  return outcome;
}

/** Tries this visit's last write again, as it was. */
export function retryLanguageWrite(): SaveOutcome {
  return lastSave?.action === "reset"
    ? restoreDefaultLanguage()
    : saveLanguagePreferences(current ?? readLanguagePreferences());
}

/** Back to the default on this device: its saved choice is removed. */
export function restoreDefaultLanguage(): SaveOutcome {
  const outcome = clearDeviceValue(STORAGE_KEY);
  current = defaultLanguagePreferences;
  lastSave = { outcome, action: "reset", attempt: ++attempts };
  notify();
  return outcome;
}

/** A component's strings: English, the whole set, and the Simplified
 * Chinese it has; a string it lacks is shown in English. */
export function strings<T extends object>(en: T, zh: Partial<T>) {
  const chinese = { ...en, ...zh } as T;
  return (language: Language): T => (language === "zh-Hans" ? chinese : en);
}
/** `table`'s strings in the language shown now. */
export const useStrings = <T extends object>(table: (language: Language) => T): T => table(useLanguage());

/** The `lang` of a translated part: what screen readers and fonts use. */
export const langTag = (language: Language) => (language === "zh-Hans" ? "zh-Hans" : "en");
