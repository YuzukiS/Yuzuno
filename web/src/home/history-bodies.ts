/**
 * Home's history read on demand (YN-221 S2). A Core with Home's history
 * index (S1) answers Home's read, asked for with `X-Yuzuno-History: index`,
 * with each history entry without its body, attachments and refs
 * (`bodyOmitted`). An entry is read whole only where it is shown: an entry
 * opened in History, a pinned report kept there, a task's card after it
 * ended, the report page. Each is read once per Workspace, by its id and
 * version (a version never changes), the entries asked for together in one
 * read per Project, and put into Home's data (withBodies), so every place
 * that shows it, and every test of which entry it is, has the one same
 * section. An older Core sends each entry whole, and nothing here is read.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, requestScope } from "../api";
import type { HomeData, Section } from "./types";

/** How Home asks for its history as an index (S1); an older Core ignores it. */
export const HISTORY_INDEX: Readonly<Record<string, string>> = Object.freeze({ "X-Yuzuno-History": "index" });

/** At most this many entries in one read (Core's home::ENTRIES_AT_ONCE). */
const AT_ONCE = 50;

type Entry = { full: Section } | { missing: true } | { failed: true };

/** The Workspace what is kept was read from (api.ts requestScope). */
let scope = "";
const entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const queued = new Map<string, Map<string, { id: number; version: number }>>();
let flushing = false;
let version = 0;
const listeners = new Set<() => void>();

const keyOf = (projectId: string, id: number, entryVersion: number) => `${projectId}\n${id}\n${entryVersion}`;

/** What was read for another Workspace is never this one's: a Core at the same address may number its entries alike. */
function inScope() {
  const now = requestScope();
  if (now === scope) return;
  scope = now;
  entries.clear();
  inFlight.clear();
  queued.clear();
  changed();
}

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const current = () => version;

/** Bumped each time an entry was read (or could not be): what withBodies is recomputed on. */
export const useHistoryBodies = () => useSyncExternalStore(subscribe, current, current);

/** Asks for an entry whole; entries asked for in the same render are read together. */
export function wantBody(projectId: string, id: number, entryVersion: number) {
  inScope();
  const key = keyOf(projectId, id, entryVersion);
  // Read once: a failed read is read again only when the user asks (retryBody).
  if (entries.has(key) || inFlight.has(key)) return;
  inFlight.add(key);
  let project = queued.get(projectId);
  if (!project) queued.set(projectId, (project = new Map()));
  project.set(key, { id, version: entryVersion });
  if (flushing) return;
  flushing = true;
  queueMicrotask(flush);
}

/** Reads again an entry whose read failed. */
export function retryBody(projectId: string, id: number, entryVersion: number) {
  inScope();
  const key = keyOf(projectId, id, entryVersion);
  const had = entries.get(key);
  if (had && "failed" in had) {
    entries.delete(key);
    changed();
  }
  wantBody(projectId, id, entryVersion);
}

function flush() {
  flushing = false;
  const asked = scope;
  for (const [projectId, wanted] of queued) {
    const all = [...wanted];
    for (let at = 0; at < all.length; at += AT_ONCE) void read(asked, projectId, all.slice(at, at + AT_ONCE));
  }
  queued.clear();
}

type EntriesAnswer = { entries?: Section[]; missing?: { id: number; version: number }[] };

async function read(asked: string, projectId: string, batch: [string, { id: number; version: number }][]) {
  const list = batch.map(([, entry]) => `${entry.id}:${entry.version}`).join(",");
  let answer: EntriesAnswer | null = null;
  try {
    answer = await api<EntriesAnswer>(`/projects/${encodeURIComponent(projectId)}/brief/history?entries=${list}`);
  } catch {
    answer = null;
  }
  // Another Workspace since: nothing read for this one is kept.
  if (asked !== scope) return;
  const found = new Map<string, Entry>();
  for (const section of Array.isArray(answer?.entries) ? answer.entries : [])
    if (typeof section?.id === "number") found.set(keyOf(projectId, section.id, section.version), { full: section });
  for (const gone of Array.isArray(answer?.missing) ? answer.missing : [])
    found.set(keyOf(projectId, gone.id, gone.version), { missing: true });
  for (const [key] of batch) {
    inFlight.delete(key);
    entries.set(key, answer ? found.get(key) ?? { missing: true } : { failed: true });
  }
  changed();
}

// One merged section per index row and what was read for it, so a later read
// that keeps the row (keepUnchanged) keeps the merged section too.
const merged = new WeakMap<Section, { entry: Entry; section: Section }>();

function shownRow(projectId: string, row: Section): Section {
  if (!row.bodyOmitted || typeof row.id !== "number") return row;
  const entry = entries.get(keyOf(projectId, row.id, row.version));
  if (!entry || "failed" in entry) return row;
  const memo = merged.get(row);
  if (memo?.entry === entry) return memo.section;
  let section: Section;
  if ("full" in entry) {
    // Home's read is newer than the entry's: its card, source and Seen mark
    // as Home read them, its body, attachments and refs as the entry has them.
    // An Ask is both: its state as Home read it, over what only the entry
    // has of it (a reply's snapshot of the question, say).
    const { bodyOmitted: _omitted, attachmentCount: _count, ...meta } = row;
    const ask = entry.full.ask && meta.ask ? { ...entry.full.ask, ...meta.ask } : meta.ask ?? entry.full.ask;
    section = { ...entry.full, ...meta, ...(ask ? { ask } : {}), body: entry.full.body, attachments: entry.full.attachments ?? [], refs: entry.full.refs ?? {} };
  } else {
    section = { ...row, bodyMissing: true };
  }
  merged.set(row, { entry, section });
  return section;
}

/**
 * A section as it is shown: an index row read whole is the whole section
 * (the same object each time), one History no longer keeps says so, and any
 * other section is itself.
 */
export const wholeSection = <S extends Section | null | undefined>(projectId: string, section: S): S =>
  section && scope === requestScope() ? (shownRow(projectId, section) as S) : section;

/**
 * Home's data with each entry read whole put in place of its index row; the
 * same data, and each panel that had none read, as they were. `_read`, what
 * useHistoryBodies answered, is what a caller recomputes it on.
 */
export function withBodies(data: HomeData | null, _read?: number): HomeData | null {
  if (!data || scope !== requestScope() || !entries.size) return data;
  let any = false;
  const projects = data.projects.map((panel) => {
    let changedHere = false;
    const history = panel.brief.history.map((row) => {
      const shown = shownRow(panel.project.id, row);
      if (shown !== row) changedHere = true;
      return shown;
    });
    if (!changedHere) return panel;
    any = true;
    return { ...panel, brief: { ...panel.brief, history } };
  });
  return any ? { ...data, projects } : data;
}

/**
 * An index row's own shape, so code that reads a section's attachments or
 * refs before it is read whole finds them empty, never absent.
 */
export function indexRows(data: HomeData): HomeData {
  if (!Array.isArray(data?.projects)) return data;
  for (const panel of data.projects)
    for (const row of Array.isArray(panel?.brief?.history) ? panel.brief.history : [])
      if (row?.bodyOmitted) {
        row.body ??= null;
        row.attachments ??= [];
        row.refs ??= {};
      }
  return data;
}

export type BodyState = "whole" | "reading" | "failed" | "missing";

/**
 * Where a section shown has its body: whole, being read (asked for here
 * when it is shown), not readable now, or no longer kept by History.
 */
export function useHistoryBody(projectId: string, section: Section | null | undefined): BodyState {
  useHistoryBodies();
  const omitted = !!section?.bodyOmitted && !section.bodyMissing && typeof section.id === "number";
  const id = section?.id;
  const entryVersion = section?.version;
  useEffect(() => {
    if (omitted && typeof id === "number" && typeof entryVersion === "number") wantBody(projectId, id, entryVersion);
  }, [omitted, projectId, id, entryVersion]);
  if (!section?.bodyOmitted) return "whole";
  if (section.bodyMissing || typeof section.id !== "number") return "missing";
  const entry = scope === requestScope() ? entries.get(keyOf(projectId, section.id, section.version)) : undefined;
  // A row Home no longer has (wholeSection makes it whole): until then, as it was read.
  if (!entry) return "reading";
  return "failed" in entry ? "failed" : "missing" in entry ? "missing" : "whole";
}
