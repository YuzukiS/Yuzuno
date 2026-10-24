import { useSyncExternalStore } from "react";
import { clearLocal, saveLocal, storageReadable, type SaveOutcome } from "./preference-save.ts";

export type ThemePreference = "light" | "dark" | "system";
/** Text size in px, any whole number from MIN_FONT_SIZE to MAX_FONT_SIZE. */
export type FontSize = number;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 24;
/** Labels and controls stop shrinking at this size so they stay legible;
 * below it only conversation text gets smaller. */
const SMALLEST_CONTROLS = 14;
export const palettes = [
  "garden",
  "yuzu",
  "graphite",
  "pine",
  "sunroom",
] as const;
export type Palette = (typeof palettes)[number];
/** The Agent list in the left rail: each Agent's latest report or update
 * under its name, or the name and status only. */
export type AgentListDensity = "detailed" | "compact";
/** How the Agent list sets projects apart when it shows All projects. */
export const projectGroupStyles = ["headers", "cards", "bands", "none"] as const;
export type ProjectGroupStyle = (typeof projectGroupStyles)[number];
/** The most of each kind the conversation's left dock shows; 0 hides that
 * group there (the Jobs panel and the conversation still list them all). */
export type DockLimits = { jobs: number; actions: number; subAgents: number };
export const MAX_DOCK_LIMIT = 10;
/** The conversation's right dock: how many Turns show their number (0 hides
 * the dock) and how many shorter bars lead on to further Turns each side. */
export type TurnDock = { numbers: number; bars: number };
export const MAX_TURN_NUMBERS = 12;
export const MAX_TURN_BARS = 10;
export type Appearance = {
  theme: ThemePreference;
  fontSize: FontSize;
  palette: Palette;
  agentList: AgentListDensity;
  projectGroups: ProjectGroupStyle;
  dock: DockLimits;
  turnDock: TurnDock;
};

const STORAGE_KEY = "yuzuno.appearance";
export const defaultAppearance: Appearance = {
  theme: "light",
  fontSize: 16,
  palette: "garden",
  agentList: "detailed",
  projectGroups: "headers",
  dock: { jobs: 5, actions: 2, subAgents: 5 },
  turnDock: { numbers: 5, bars: 5 },
};
/** A saved count from 0 to `max`, or the default when it is anything else. */
const count = (value: unknown, max: number, fallback: number) =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
    ? (value as number)
    : fallback;
const dockLimit = (value: unknown, fallback: number) =>
  count(value, MAX_DOCK_LIMIT, fallback);

export function readAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return {
      palette: palettes.includes(saved?.palette)
        ? saved.palette
        : defaultAppearance.palette,
      theme: ["light", "dark", "system"].includes(saved?.theme)
        ? saved.theme
        : defaultAppearance.theme,
      fontSize:
        Number.isInteger(saved?.fontSize) &&
        saved.fontSize >= MIN_FONT_SIZE &&
        saved.fontSize <= MAX_FONT_SIZE
          ? saved.fontSize
          : defaultAppearance.fontSize,
      agentList: ["detailed", "compact"].includes(saved?.agentList)
        ? saved.agentList
        : defaultAppearance.agentList,
      projectGroups: projectGroupStyles.includes(saved?.projectGroups)
        ? saved.projectGroups
        : defaultAppearance.projectGroups,
      dock: {
        jobs: dockLimit(saved?.dock?.jobs, defaultAppearance.dock.jobs),
        actions: dockLimit(saved?.dock?.actions, defaultAppearance.dock.actions),
        subAgents: dockLimit(
          saved?.dock?.subAgents,
          defaultAppearance.dock.subAgents,
        ),
      },
      turnDock: {
        numbers: count(
          saved?.turnDock?.numbers,
          MAX_TURN_NUMBERS,
          defaultAppearance.turnDock.numbers,
        ),
        bars: count(
          saved?.turnDock?.bars,
          MAX_TURN_BARS,
          defaultAppearance.turnDock.bars,
        ),
      },
    };
  } catch {
    return defaultAppearance;
  }
}

export function applyAppearance(appearance: Appearance) {
  const theme =
    appearance.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : appearance.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.palette = appearance.palette;
  document.documentElement.dataset.themePreference = appearance.theme;
  document.documentElement.dataset.fontSize = String(appearance.fontSize);
  document.documentElement.dataset.agentList = appearance.agentList;
  document.documentElement.dataset.projectGroups = appearance.projectGroups;
  // Controls grow with the text, by the same number of pixels. They are
  // sized as an offset from it, so below 14 px they would become unreadable
  // long before the conversation does: there they keep their 14 px size.
  document.documentElement.style.setProperty(
    "--font-adjust",
    `${Math.max(appearance.fontSize, SMALLEST_CONTROLS) - 13}px`,
  );
  document.documentElement.style.setProperty(
    "--reading-size",
    `${appearance.fontSize}px`,
  );
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      getComputedStyle(document.documentElement)
        .getPropertyValue("--cream")
        .trim() || (theme === "dark" ? "#252c26" : "#f5f4ed"),
    );
  const native = (
    window as Window & {
      __TAURI__?: {
        core?: {
          invoke?: (
            command: string,
            args: { theme: string },
          ) => Promise<unknown>;
        };
      };
    }
  ).__TAURI__?.core?.invoke;
  if (native)
    void native("set_appearance", { theme }).catch(() => {
      // The web UI also works with older desktop shells that lack this command.
    });
}

// The choice in effect for React views that change what they render with
// it, not only how it looks: read once, then again whenever it is chosen
// here or saved in another window. A choice this device refused to save is
// still the one in effect here, until this window closes (T-187).
const listeners = new Set<() => void>();
let current: Appearance | null = null;
// What this visit's last save or reset did; null before one.
let lastSave: SaveOutcome | null = null;
function changed() {
  current = null;
  // Another window saved: what is in effect here is what is saved now.
  lastSave = null;
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => (current ??= readAppearance()));
}

/** What this visit's last save or reset of Appearance did, or null. */
export function useAppearanceSave(): SaveOutcome | null {
  return useSyncExternalStore(subscribe, () => lastSave);
}

/** Whether this device can read its saved Appearance at all. */
export function appearanceReadable(): boolean {
  return storageReadable(STORAGE_KEY);
}

/** Applies `appearance` and saves it on this device. A refused write is
 * reported, not hidden: the choice still applies in this window. */
export function saveAppearance(appearance: Appearance): SaveOutcome {
  applyAppearance(appearance);
  const outcome = saveLocal(STORAGE_KEY, appearance);
  current = appearance;
  lastSave = outcome;
  listeners.forEach((listener) => listener());
  return outcome;
}

/** Back to the defaults on this device: its saved choice is removed. */
export function restoreDefaultAppearance(): SaveOutcome {
  applyAppearance(defaultAppearance);
  const outcome = clearLocal(STORAGE_KEY);
  current = defaultAppearance;
  lastSave = outcome;
  listeners.forEach((listener) => listener());
  return outcome;
}

/** Runs before React mounts, so the workspace appears with its saved settings. */
export function initializeAppearance() {
  applyAppearance(readAppearance());
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", () => {
    const appearance = readAppearance();
    if (appearance.theme === "system") applyAppearance(appearance);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      applyAppearance(readAppearance());
      changed();
    }
  });
}
