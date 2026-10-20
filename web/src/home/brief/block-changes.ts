import type { Section } from "../types";
import { isBriefSpec, type BriefElement } from "./brief-catalog";

/** How a block differs from the version the user marked seen. */
export type BlockChange = "new" | "updated";
export type BlockChanges = ReadonlyMap<string, BlockChange>;

/** What this device saw of a section: each block's fingerprint at the seen version. */
type Baseline = { version: number; blocks: Record<string, string> };

// Layout only: their own change is where their blocks sit, which each block
// shows for itself.
const LAYOUT = new Set(["BriefBody", "Columns"]);

export const blockMemoryKey = (workspaceId: string, projectId: string, section: Section) =>
  `yuzuno.home-seen-blocks.v1:${JSON.stringify([workspaceId, projectId, section.key, section.id ?? null])}`;

/** JSON with object keys sorted, so the same block always prints the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a, 32 bits: enough to tell one version of a block from the next. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function strings(value: unknown, into: Set<string>) {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, into));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, into));
}

/**
 * A block's type and props, without its children, which are blocks of their
 * own. An attachment it names counts as part of it, by what Core sends of
 * the file (its time of copy changes with every write, so it is left out).
 */
function fingerprint(element: BriefElement, section: Section) {
  const named = new Set<string>();
  strings(element.props, named);
  const files = (section.attachments ?? [])
    .filter((file) => named.has(file.name))
    .map(({ name, kind, mime, size, caption, url, path }) => ({ name, kind, mime, size, caption, url, path }));
  return hash(canonical({ type: element.type, props: element.props, files }));
}

/** The blocks the section shows: those reached from its root. One a body
 * holds but does not show was never seen, and counts as new once shown. */
function fingerprints(section: Section): Record<string, string> | null {
  if (!isBriefSpec(section.body)) return null;
  const elements = section.body.elements;
  const shown: Record<string, string> = {};
  const walk = (id: string) => {
    const element = elements[id];
    if (!element || id in shown) return;
    shown[id] = fingerprint(element, section);
    (element.children ?? []).forEach(walk);
  };
  walk(section.body.root);
  return shown;
}

function readBaseline(key: string): Baseline | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value.version === "number" && value.blocks && typeof value.blocks === "object"
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Keeps what the section shows now as the user's seen version: when they
 * mark it seen here (seenVersion), and whenever the version shown is the
 * one they marked seen. Core keeps only a section's live version, so the
 * comparison is made from what this device showed.
 */
export function rememberSeenBlocks(
  workspaceId: string,
  projectId: string,
  section: Section,
  seenVersion = section.seen?.version,
) {
  if (!workspaceId || seenVersion !== section.version) return;
  const key = blockMemoryKey(workspaceId, projectId, section);
  if (readBaseline(key)?.version === section.version) return;
  const blocks = fingerprints(section);
  if (!blocks) return;
  try {
    localStorage.setItem(key, JSON.stringify({ version: section.version, blocks } satisfies Baseline));
  } catch {
    /* Private storage can be unavailable: only the card's own mark shows. */
  }
}

/**
 * The blocks a newer version added or changed, compared with what this
 * device showed of the version the user marked seen. Null when that is not
 * known here (never seen, or seen elsewhere at a version not shown here):
 * then only the card says it changed. A block under a new one is not
 * marked again.
 */
export function changedBlocks(workspaceId: string, projectId: string, section: Section): BlockChanges | null {
  const seen = section.seen?.version;
  if (!workspaceId || seen === undefined || seen >= section.version || !isBriefSpec(section.body)) return null;
  const baseline = readBaseline(blockMemoryKey(workspaceId, projectId, section));
  if (!baseline || baseline.version !== seen) return null;
  const now = fingerprints(section) ?? {};
  const elements = section.body.elements;
  const changes = new Map<string, BlockChange>();
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const element = elements[id];
    if (!element) return;
    const before = baseline.blocks[id];
    if (!LAYOUT.has(element.type)) {
      if (before === undefined) {
        changes.set(id, "new");
        return;
      }
      if (before !== now[id]) changes.set(id, "updated");
    }
    (element.children ?? []).forEach(walk);
  };
  walk(section.body.root);
  return changes;
}
