import { pathKey } from "./artifact-groups";
import type { NativeItem, NativeTurn } from "./types";

// `/changes` (T-29): Yuzuno's record of the file edits Codex made in a turn,
// from the turn's `fileChange` Items. Codex 0.162.1 fills each change's
// `diff` by kind: an added file's content, a deleted file's last content, or
// a unified diff for an update (with "Moved to: …" after a move). Nothing
// here runs Git or reads the folder.

/** Bounds of what the dialog draws for one file edit, adjustable by tests. */
export const changesLimits = {
  /** Lines and characters added by each "Show more". */
  segmentLines: 400,
  segmentChars: 64 * 1024,
  /** The most it ever draws for one file edit; the rest stays in the conversation. */
  maxLines: 4000,
  maxChars: 640 * 1024,
};

export type ChangeKind = "add" | "delete" | "update" | "unknown";

/** A change's kind as Codex reports it (`{type, move_path}`; a bare string from an older record). */
export function changeKind(kind: unknown): { type: ChangeKind; movePath: string | null } {
  const type = typeof kind === "string" ? kind : (kind as { type?: unknown } | undefined)?.type;
  const movePath = (kind as { move_path?: unknown } | undefined)?.move_path;
  return {
    type: type === "add" || type === "delete" || type === "update" ? type : "unknown",
    movePath: typeof movePath === "string" && movePath ? movePath : null,
  };
}

/** One file's part of one edit (a `fileChange` Item). */
export interface FileEdit {
  item: NativeItem;
  /** Its place among the turn's edits, from 1. */
  editNumber: number;
  /** The change's index in the Item's changes. */
  index: number;
  path: string;
  kind: ChangeKind;
  movePath: string | null;
  text: string;
  /** False when the text is a shortened preview. */
  complete: boolean;
}

export interface FileGroup {
  key: string;
  path: string;
  edits: FileEdit[];
}

export interface TurnChanges {
  files: FileGroup[];
  /** The turn's edits, in order. */
  edits: NativeItem[];
  /** Edits whose preview leaves out some of their files. */
  hidden: { item: NativeItem; editNumber: number; count: number }[];
}

export const isEdit = (item: NativeItem) => item.type === "fileChange";

/**
 * The turn's edits grouped by file, files in the order they were first
 * edited and each file's edits in turn order. `items` are the edits as
 * shown: full where loaded, else Core's previews.
 */
export function turnChanges(items: NativeItem[], cwd: string): TurnChanges {
  const files = new Map<string, FileGroup>();
  const hidden: TurnChanges["hidden"] = [];
  items.forEach((item, position) => {
    const editNumber = position + 1;
    const preview = item._yuzunoTruncated?.changes;
    (item.changes || []).forEach((change, index) => {
      if (typeof change?.path !== "string") return;
      const key = pathKey(change.path, cwd);
      let group = files.get(key);
      if (!group) files.set(key, (group = { key, path: change.path, edits: [] }));
      const { type, movePath } = changeKind(change.kind);
      group.edits.push({
        item, editNumber, index, path: change.path, kind: type, movePath,
        text: typeof change.diff === "string" ? change.diff : "",
        complete: !preview || !preview.cutDiffs?.includes(index),
      });
    });
    if (preview?.omitted) hidden.push({ item, editNumber, count: preview.omitted });
  });
  return { files: [...files.values()], edits: items, hidden };
}

/** The latest of `turns` with an edit, newest first. */
export function latestTurnWithEdits(turns: NativeTurn[]): NativeTurn | undefined {
  for (let index = turns.length - 1; index >= 0; index--)
    if (turns[index].items.some(isEdit)) return turns[index];
  return undefined;
}

/** A path as recorded, shortened to the Agent's folder when inside it. */
export function displayPath(path: string, cwd: string) {
  const key = pathKey(path, cwd);
  const base = pathKey(".", cwd);
  return key.startsWith(`${base}/`) ? key.slice(base.length + 1) : path;
}

export type LineKind = "add" | "del" | "hunk" | "meta" | "ctx";

/**
 * At most `maxLines` lines and about `maxChars` characters from the start
 * of `text`, and how many lines are left. Only what is shown is split, so a
 * very long text costs no more than its shown part. `cut`: a single line
 * longer than `maxChars` was shortened to fit.
 */
export function headLines(text: string, maxLines: number, maxChars: number) {
  const lines: string[] = [];
  let at = 0;
  let used = 0;
  let cut = false;
  while (at < text.length && lines.length < maxLines) {
    const end = text.indexOf("\n", at);
    const line = end < 0 ? text.slice(at) : text.slice(at, end);
    if (used + line.length > maxChars && lines.length) break;
    if (line.length > maxChars) cut = true;
    lines.push(line.length > maxChars ? line.slice(0, maxChars) : line);
    used += line.length + 1;
    at = end < 0 ? text.length : end + 1;
  }
  let more = 0;
  for (let next = at; next < text.length; ) {
    more++;
    const end = text.indexOf("\n", next);
    next = end < 0 ? text.length : end + 1;
  }
  return { lines, more, cut };
}

/**
 * How each line of the start of a change reads. An added file's content is
 * all added and a deleted file's all removed. In a unified diff, headers
 * come only before the first hunk, so a removed line that reads "--- x" is
 * still a removed line; Codex's "Moved to: …" note after a move is meta.
 */
export function lineKinds(lines: string[], kind: ChangeKind): LineKind[] {
  if (kind === "add" || kind === "delete") return lines.map(() => (kind === "add" ? "add" : "del"));
  let inHunk = false;
  return lines.map((line) => {
    if (line.startsWith("@@")) {
      inHunk = true;
      return "hunk";
    }
    if (!inHunk) return /^(\+\+\+|---|diff --git|index )/.test(line) ? "meta" : "ctx";
    if (line.startsWith("Moved to: ") || line.startsWith("\\")) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "ctx";
  });
}
