import type { Appearance } from "./appearance";
import {
  APPEARANCE_FILE,
  APPEARANCE_FILE_VERSION,
  LISTED,
  NAME_LENGTH,
  isObject,
  named,
  readAppearanceGroup,
  shown,
  type AppearanceFileContents,
  type FileRefusal,
} from "./appearance-file";
import { sendKeys, type DevicePreferences, type SendKey } from "./device-preferences";
import { languageChoices, type LanguageChoice, type LanguagePreferences } from "./i18n";
import { notificationCategories, type NotificationCategory, type NotificationPrefs } from "./notification-prefs";
import { clockFormats, knownTimeZone, type ClockFormat, type TimePreferences } from "./time-preferences";

/**
 * This device's preferences as one file (T-194): Appearance, how messages are
 * sent, how times are shown, the interface language and the notification
 * choices, to keep or to take to another device. Each group is read back on
 * its own and applied on its own, once saved on this device; nothing makes
 * several groups one change. The file holds only these fields: no Core
 * settings, native permissions, accounts, folders, conversations or drafts.
 * An Appearance export (#199) reads as a file with the Appearance group only.
 *
 * The language is the choice (system, en or zh-Hans), never the language
 * "system" resolved to on the device that exported it. Notifications are the
 * kinds, previews and mute only: whether a device notifies at all, and its
 * browser's permission, are that device's own and never in the file. A
 * version of Yuzuno before these two groups reads the same file and lists
 * them as preferences it doesn't know, taking nothing from them.
 */
export const DEVICE_FILE = "yuzuno-device-preferences";
export const DEVICE_FILE_VERSION = 1;
/** An export is about 1 KiB; a larger file is not read. */
export const MAX_DEVICE_FILE_BYTES = 16 * 1024;

export type DeviceGroup = "appearance" | "sending" | "time" | "language" | "notifications";
export const deviceGroups: readonly DeviceGroup[] = ["appearance", "sending", "time", "language", "notifications"];
const TOP = ["format", "version", "exportedAt", ...deviceGroups];

/** Why a group can't be applied: its English (`refused`), and the same as
 * a code with the file's value as shown, for the interface language (T-189). */
export type GroupRefusal = {
  refused: string;
  reason: "notSettings" | "sendKey" | "clock" | "timeZone" | "language" | "onOff";
  value: string;
};
const refuse = (reason: GroupRefusal["reason"], english: string, value: string): GroupRefusal => ({
  refused: `${english}: ${value}`,
  reason,
  value,
});

/** One group as a file holds it: what this device accepts, or why it can't
 * be applied at all. Appearance is read field by field, as its own file is;
 * the other groups are taken whole or not at all. */
export type DeviceFileContents = {
  appearance?: Omit<AppearanceFileContents, "exportedAt" | "unknown"> | GroupRefusal;
  sending?: { value: Partial<DevicePreferences> } | GroupRefusal;
  time?: { value: Partial<TimePreferences> } | GroupRefusal;
  language?: { value: Partial<LanguagePreferences> } | GroupRefusal;
  notifications?: { value: NotificationChoices } | GroupRefusal;
  unknown: string[];
  exportedAt: string | null;
  /** "appearance" when the file is an Appearance export. */
  kind: "device" | "appearance";
};

/** The notification choices a file can hold: not whether this device
 * notifies at all (`enabled`), which stays the device's own. */
export type NotificationChoices = {
  categories?: Partial<Record<NotificationCategory, boolean>>;
  preview?: boolean;
  muted?: boolean;
};

/** The export: each group's settings in effect, and nothing else. */
export function exportDevicePreferences(
  { appearance, sending, time, language, notifications }: {
    appearance: Appearance;
    sending: DevicePreferences;
    time: TimePreferences;
    language: LanguagePreferences;
    notifications: NotificationPrefs;
  },
  now = new Date(),
): string {
  const { palette, theme, fontSize, agentList, projectGroups, dock, turnDock } = appearance;
  return `${JSON.stringify(
    {
      format: DEVICE_FILE,
      version: DEVICE_FILE_VERSION,
      exportedAt: now.toISOString(),
      appearance: {
        palette,
        theme,
        fontSize,
        agentList,
        projectGroups,
        dock: { jobs: dock.jobs, actions: dock.actions, subAgents: dock.subAgents },
        turnDock: { numbers: turnDock.numbers, bars: turnDock.bars },
      },
      sending: { sendKey: sending.sendKey },
      time: { clock: time.clock, timeZone: time.timeZone },
      language: { language: language.language },
      notifications: {
        categories: Object.fromEntries(notificationCategories.map((kind) => [kind, notifications.categories[kind]])),
        preview: notifications.preview,
        muted: notifications.muted,
      },
    },
    null,
    2,
  )}\n`;
}

function readSending(saved: unknown, unknown: string[]): DeviceFileContents["sending"] {
  if (!isObject(saved)) return refuse("notSettings", "not settings", shown(saved));
  for (const name of Object.keys(saved)) if (name !== "sendKey") unknown.push(`sending.${name}`);
  if (!("sendKey" in saved)) return { value: {} };
  return sendKeys.includes(saved.sendKey as SendKey)
    ? { value: { sendKey: saved.sendKey as SendKey } }
    : refuse("sendKey", "a send key this version doesn’t have", shown(saved.sendKey));
}

function readTime(saved: unknown, unknown: string[]): DeviceFileContents["time"] {
  if (!isObject(saved)) return refuse("notSettings", "not settings", shown(saved));
  for (const name of Object.keys(saved)) if (name !== "clock" && name !== "timeZone") unknown.push(`time.${name}`);
  const value: Partial<TimePreferences> = {};
  if ("clock" in saved) {
    if (!clockFormats.includes(saved.clock as ClockFormat))
      return refuse("clock", "a clock format this version doesn’t have", shown(saved.clock));
    value.clock = saved.clock as ClockFormat;
  }
  if ("timeZone" in saved) {
    if (saved.timeZone !== null && !knownTimeZone(saved.timeZone))
      return refuse("timeZone", "a time zone this browser doesn’t know", shown(saved.timeZone));
    value.timeZone = saved.timeZone as string | null;
  }
  return { value };
}

function readLanguage(saved: unknown, unknown: string[]): DeviceFileContents["language"] {
  if (!isObject(saved)) return refuse("notSettings", "not settings", shown(saved));
  for (const name of Object.keys(saved)) if (name !== "language") unknown.push(`language.${name}`);
  if (!("language" in saved)) return { value: {} };
  return languageChoices.includes(saved.language as LanguageChoice)
    ? { value: { language: saved.language as LanguageChoice } }
    : refuse("language", "a language choice this version doesn’t have", shown(saved.language));
}

/** Only true or false: not the lenient reading of this device's own saved
 * choices, where anything else falls back to the default. */
function readNotifications(saved: unknown, unknown: string[]): DeviceFileContents["notifications"] {
  if (!isObject(saved)) return refuse("notSettings", "not settings", shown(saved));
  const value: NotificationChoices = {};
  for (const name of Object.keys(saved)) {
    // `enabled` among them: whether a device notifies is never taken from a file.
    if (name !== "categories" && name !== "preview" && name !== "muted") unknown.push(`notifications.${name}`);
  }
  if ("categories" in saved) {
    if (!isObject(saved.categories)) return refuse("notSettings", "not settings", shown(saved.categories));
    const categories: Partial<Record<NotificationCategory, boolean>> = {};
    for (const [kind, on] of Object.entries(saved.categories)) {
      if (!notificationCategories.includes(kind as NotificationCategory)) {
        unknown.push(`notifications.categories.${kind}`);
        continue;
      }
      if (typeof on !== "boolean") return refuse("onOff", `not on or off for ${kind}`, shown(on));
      categories[kind as NotificationCategory] = on;
    }
    value.categories = categories;
  }
  for (const name of ["preview", "muted"] as const) {
    if (!(name in saved)) continue;
    if (typeof saved[name] !== "boolean") return refuse("onOff", `not on or off for ${name}`, shown(saved[name]));
    value[name] = saved[name] as boolean;
  }
  return { value };
}

/** Reads a device-preferences file, or an Appearance export. A file that is
 * neither, or of a version this device does not read, is refused as a
 * whole; otherwise each group is read on its own. */
export function readDeviceFile(text: string): { contents: DeviceFileContents } | FileRefusal {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "This file isn’t JSON, so it isn’t a preferences export", code: "notJson" };
  }
  if (!isObject(data) || (data.format !== DEVICE_FILE && data.format !== APPEARANCE_FILE)) {
    return { error: "This file isn’t a Yuzuno preferences or Appearance export", code: "notExport" };
  }
  const appearanceOnly = data.format === APPEARANCE_FILE;
  const version = appearanceOnly ? APPEARANCE_FILE_VERSION : DEVICE_FILE_VERSION;
  if (data.version !== version) {
    return Number.isInteger(data.version) && (data.version as number) > version
      ? {
          error: `This file is from a newer Yuzuno (file version ${data.version}); this version reads version ${version}`,
          code: "newer",
          version: data.version as number,
          reads: version,
        }
      : { error: "This file’s version isn’t one Yuzuno knows", code: "unknownVersion" };
  }
  const known = appearanceOnly ? ["format", "version", "exportedAt", "appearance"] : TOP;
  const unknown = Object.keys(data).filter((name) => !known.includes(name));
  const contents: DeviceFileContents = {
    unknown: [],
    exportedAt: typeof data.exportedAt === "string" && data.exportedAt.length <= NAME_LENGTH ? data.exportedAt : null,
    kind: appearanceOnly ? "appearance" : "device",
  };
  if ("appearance" in data) {
    if (isObject(data.appearance)) {
      const group = readAppearanceGroup(data.appearance);
      contents.appearance = { values: group.values, invalid: group.invalid };
      unknown.push(...group.unknown);
    } else contents.appearance = refuse("notSettings", "not settings", shown(data.appearance));
  }
  if (!appearanceOnly && "sending" in data) contents.sending = readSending(data.sending, unknown);
  if (!appearanceOnly && "time" in data) contents.time = readTime(data.time, unknown);
  if (!appearanceOnly && "language" in data) contents.language = readLanguage(data.language, unknown);
  if (!appearanceOnly && "notifications" in data) contents.notifications = readNotifications(data.notifications, unknown);
  if (!deviceGroups.some((group) => contents[group])) return { error: "This file holds none of these preferences", code: "empty" };
  contents.unknown = unknown.slice(0, LISTED).map(named);
  return { contents };
}
