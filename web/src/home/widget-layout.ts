/**
 * The user's widget column, kept on this device for each workspace: which
 * widgets show and in what order, and which Brief sections are pinned
 * there. Only the layout lives here. A pinned section's content is always
 * the one Home reads from Core for its project, drawn by the same
 * renderer, so an Agent's update never changes the layout and the user's
 * layout never changes the content.
 */
import { createContext, useCallback, useState } from "react";
import type { HomeData, Section } from "./types";

/** A status or report section, named by project, key and Core's id for it. */
export type Pin = {
  projectId: string;
  key: string;
  /** Home's id for the section (types.ts Section.id): a section removed and
   * written again under the same key has another, so the pin never follows it. */
  id: number;
  /** As last seen, to name a pin whose source is gone. */
  title: string;
  projectName: string;
};

export type WidgetLayout = { order: string[]; hidden: string[]; pins: Pin[] };

/** Before layouts were kept per workspace (T-116): read once, never written. */
const LEGACY_KEY = "yuzuno.homeWidgets";
const storageKey = (workspaceId: string) => `yuzuno.homeWidgets.${workspaceId}`;
const MAX_PINS = 12;

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const isPin = (value: unknown): value is Pin => {
  const pin = value as Partial<Pin> | null;
  return (
    !!pin &&
    typeof pin.projectId === "string" &&
    typeof pin.key === "string" &&
    Number.isSafeInteger(pin.id) &&
    typeof pin.title === "string" &&
    typeof pin.projectName === "string"
  );
};

export const pinWidgetId = (pin: Pick<Pin, "projectId" | "key" | "id">) => `pin:${pin.projectId}:${pin.id}:${pin.key}`;

export function readWidgetLayout(workspaceId: string): WidgetLayout {
  try {
    const own = localStorage.getItem(storageKey(workspaceId));
    const saved = JSON.parse(own ?? localStorage.getItem(LEGACY_KEY) ?? "null");
    return {
      order: strings(saved?.order),
      hidden: strings(saved?.hidden),
      pins: own && Array.isArray(saved?.pins) ? saved.pins.filter(isPin).slice(0, MAX_PINS) : [],
    };
  } catch {
    return { order: [], hidden: [], pins: [] };
  }
}

function saveWidgetLayout(workspaceId: string, layout: WidgetLayout) {
  // Never under no workspace: it would be lost once the workspace is read.
  if (!workspaceId) return;
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(layout));
  } catch {
    // Without storage the choice still holds for this visit.
  }
}

/** A section may be pinned when Core names it and it is not an ask: asks are
 * answered in Needs you and in their project, never twice. */
export const pinnable = (section: Section) =>
  !section.history && section.kind !== "ask" && Number.isSafeInteger(section.id);

/**
 * The one check every pin passes: the section, as Home reads it now, is one
 * of its project's shown sections (not history, and not content Home keeps
 * out of the default view) and may be pinned. Returns that live section.
 */
export function pinSource(data: HomeData | null, projectId: string, section: Pick<Section, "key" | "id">) {
  const panel = data?.projects.find((p) => p.project.id === projectId);
  const live = panel?.brief.sections.find((s) => s.key === section.key && s.id === section.id);
  return panel && live && pinnable(live) ? { section: live, projectName: panel.project.name } : null;
}

/** What a section card needs to pin itself; null where nothing can be pinned
 * (the design preview, or before the workspace is known). */
export type PinControl = {
  isPinned: (projectId: string, section: Section) => boolean;
  canPin: (projectId: string, section: Section) => boolean;
  toggle: (projectId: string, section: Section) => void;
};
export const PinsContext = createContext<PinControl | null>(null);

/**
 * The layout of one workspace, saved on every change. Until the workspace is
 * known there is none (null): nothing is read or saved, and no change is
 * taken, so none can seem made and then be lost when the workspace is read.
 */
export function useWidgetLayout(workspaceId: string) {
  const read = (id: string) => (id ? readWidgetLayout(id) : null);
  const [state, setState] = useState(() => ({ workspaceId, layout: read(workspaceId) }));
  // Another workspace opened in this window reads its own layout.
  const layout = state.workspaceId === workspaceId ? state.layout : read(workspaceId);
  if (state.workspaceId !== workspaceId) setState({ workspaceId, layout });
  const change = useCallback(
    (next: (current: WidgetLayout) => WidgetLayout) =>
      setState((current) => {
        if (!current.workspaceId || !current.layout) return current;
        const updated = next(current.layout);
        saveWidgetLayout(current.workspaceId, updated);
        return { workspaceId: current.workspaceId, layout: updated };
      }),
    [],
  );
  const pin = useCallback(
    (projectId: string, projectName: string, section: Section) =>
      change((current) =>
        current.pins.some((p) => p.projectId === projectId && p.id === section.id) || current.pins.length >= MAX_PINS
          ? current
          : {
              ...current,
              pins: [...current.pins, { projectId, key: section.key, id: section.id!, title: section.title, projectName }],
            },
      ),
    [change],
  );
  const unpin = useCallback(
    (target: Pin) =>
      change((current) => {
        const id = pinWidgetId(target);
        return {
          order: current.order.filter((other) => other !== id),
          hidden: current.hidden.filter((other) => other !== id),
          pins: current.pins.filter((p) => pinWidgetId(p) !== id),
        };
      }),
    [change],
  );
  return { layout, change, pin, unpin };
}

/** What a pin shows now: its section, or why it can't. */
export type PinSource =
  | { state: "reading" }
  /** `seen`: a report the user marked seen, shown as last written until its owner writes it again. */
  | { state: "shown"; section: Section; projectName: string; current: boolean; seen: boolean }
  | { state: "project-gone" }
  | { state: "removed" }
  | { state: "replaced"; section: Section; projectName: string }
  | { state: "now-ask" };

/**
 * The pinned section in Home's reading, by its id. A report the user marked
 * seen is history until its owner writes it again (Core keeps its id); it
 * shows as last written, said to be seen. A section no longer on Home
 * (removed, resolved, its source no longer shown, or its project gone) and
 * another section under the same key are shown as such, never as current.
 * `current` is false while Home's last read failed.
 */
export function resolvePin(pin: Pin, data: HomeData | null, readFailed: boolean): PinSource {
  if (!data) return { state: "reading" };
  const panel = data.projects.find((p) => p.project.id === pin.projectId);
  if (!panel) return { state: "project-gone" };
  const projectName = panel.project.name;
  // The key's newest record decides, whatever its id: a live section Home
  // shows, then one it keeps out of view, then the newest history entry.
  const section = panel.brief.sections.find((s) => s.key === pin.key && !s.history);
  if (section) {
    if (section.id !== pin.id) return { state: "replaced", section, projectName };
    if (section.kind === "ask") return { state: "now-ask" };
    return { state: "shown", section, projectName, current: !readFailed, seen: false };
  }
  if ((panel.brief.teamSections ?? []).some((s) => s.key === pin.key)) return { state: "removed" };
  const last = panel.brief.history.find((s) => s.key === pin.key);
  if (last?.id === pin.id && last.historyReason === "seen" && last.currentSource && last.kind !== "ask")
    return { state: "shown", section: last, projectName, current: !readFailed, seen: true };
  return { state: "removed" };
}
