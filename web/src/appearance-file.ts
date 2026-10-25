import { appearanceFrom, type Appearance } from "./appearance";

/**
 * This device's Appearance as a file (T-194), to keep or to take to another
 * device: a versioned JSON export, read back as a preview the user picks
 * from before anything is applied. Only the fields listed here are written
 * or read; Appearance holds no accounts, native permissions, folders or
 * conversations, and nothing else in a file is used.
 */
export const APPEARANCE_FILE = "yuzuno-appearance";
export const APPEARANCE_FILE_VERSION = 1;
/** An export is well under 1 KiB; a larger file is not read. */
export const MAX_APPEARANCE_FILE_BYTES = 16 * 1024;

export const appearanceFields = [
  "palette",
  "theme",
  "fontSize",
  "agentList",
  "projectGroups",
  "dock.jobs",
  "dock.actions",
  "dock.subAgents",
  "turnDock.numbers",
  "turnDock.bars",
] as const;
export type AppearanceField = (typeof appearanceFields)[number];
type FieldValue = string | number;

const TOP = ["format", "version", "exportedAt", "appearance"];
const GROUPS: Record<string, string[] | null> = {
  palette: null,
  theme: null,
  fontSize: null,
  agentList: null,
  projectGroups: null,
  dock: ["jobs", "actions", "subAgents"],
  turnDock: ["numbers", "bars"],
};
/** At most this many unknown names are listed, each cut to NAME_LENGTH. */
const LISTED = 20;
const NAME_LENGTH = 40;

export function fieldValue(appearance: Appearance, field: AppearanceField): FieldValue {
  const [group, key] = field.split(".") as [keyof Appearance, string | undefined];
  const value = appearance[group];
  return key ? (value as Record<string, number>)[key] : (value as FieldValue);
}

function withField(appearance: Appearance, field: AppearanceField, value: FieldValue): Appearance {
  const [group, key] = field.split(".") as [keyof Appearance, string | undefined];
  return key
    ? { ...appearance, [group]: { ...(appearance[group] as object), [key]: value } }
    : { ...appearance, [group]: value };
}

/** The export of `appearance`: each listed field, named, and nothing else. */
export function exportAppearance(appearance: Appearance, now = new Date()): string {
  const { palette, theme, fontSize, agentList, projectGroups, dock, turnDock } = appearance;
  return `${JSON.stringify(
    {
      format: APPEARANCE_FILE,
      version: APPEARANCE_FILE_VERSION,
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
    },
    null,
    2,
  )}\n`;
}

/** What a file offers: each listed field with a value this device accepts,
 * those whose value it does not, and the names it does not know. */
export type AppearanceFileContents = {
  values: Partial<Record<AppearanceField, FieldValue>>;
  invalid: { field: AppearanceField; value: string }[];
  unknown: string[];
  exportedAt: string | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shown = (value: unknown) => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > NAME_LENGTH ? `${text.slice(0, NAME_LENGTH - 1)}…` : text;
};
const named = (name: string) => (name.length > NAME_LENGTH ? `${name.slice(0, NAME_LENGTH - 1)}…` : name);

/** Reads an Appearance export. A file that is not one, or of a version this
 * device does not read, is refused as a whole; otherwise each field is taken
 * only when this device would read its value back as saved. */
export function readAppearanceFile(text: string): { contents: AppearanceFileContents } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "This file isn’t JSON, so it isn’t an Appearance export" };
  }
  if (!isObject(data) || data.format !== APPEARANCE_FILE) {
    return { error: "This file isn’t a Yuzuno Appearance export" };
  }
  if (data.version !== APPEARANCE_FILE_VERSION) {
    return {
      error:
        Number.isInteger(data.version) && (data.version as number) > APPEARANCE_FILE_VERSION
          ? `This file is from a newer Yuzuno (Appearance file version ${data.version}); this version reads version ${APPEARANCE_FILE_VERSION}`
          : "This file’s version isn’t one Yuzuno knows",
    };
  }
  const saved = data.appearance;
  if (!isObject(saved)) return { error: "This file holds no Appearance settings" };
  const contents: AppearanceFileContents = {
    values: {},
    invalid: [],
    unknown: [],
    exportedAt: typeof data.exportedAt === "string" && data.exportedAt.length <= NAME_LENGTH ? data.exportedAt : null,
  };
  const unknown = Object.keys(data).filter((name) => !TOP.includes(name));
  for (const [name, value] of Object.entries(saved)) {
    if (!(name in GROUPS)) unknown.push(`appearance.${name}`);
    else if (GROUPS[name] && isObject(value)) {
      for (const key of Object.keys(value)) if (!GROUPS[name]!.includes(key)) unknown.push(`appearance.${name}.${key}`);
    }
  }
  contents.unknown = unknown.slice(0, LISTED).map(named);
  for (const field of appearanceFields) {
    const [group, key] = field.split(".") as [string, string | undefined];
    if (!(group in saved)) continue;
    const holder = key ? saved[group] : saved;
    if (key && !isObject(holder)) {
      contents.invalid.push({ field, value: shown(holder) });
      continue;
    }
    const name = key ?? group;
    if (!(name in (holder as Record<string, unknown>))) continue;
    const value = (holder as Record<string, unknown>)[name];
    const read = appearanceFrom(key ? { [group]: { [key]: value } } : { [group]: value });
    if (fieldValue(read, field) === value) contents.values[field] = value as FieldValue;
    else contents.invalid.push({ field, value: shown(value) });
  }
  return { contents };
}

/** `current` with the chosen fields taken from the file's accepted values. */
export function importedAppearance(
  current: Appearance,
  contents: AppearanceFileContents,
  chosen: readonly AppearanceField[],
): Appearance {
  return chosen.reduce((next, field) => {
    const value = contents.values[field];
    return value === undefined ? next : withField(next, field, value);
  }, current);
}
