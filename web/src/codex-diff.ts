// `/diff` (T-29): Git's diff of a Codex Agent's folder, read by Core where the
// Agent's Codex runs (`/agents/{id}/codex/diff`). These helpers only shape
// what Core returned for the dialog; nothing here reads the folder.

/** One part as read: the text kept, and whether it is all Git wrote. */
export interface DiffPart {
  text: string;
  complete: boolean;
  /** Bytes that are not UTF-8 show as U+FFFD. */
  notUtf8: boolean;
}

export interface StagedEntry {
  /** Git's status letter, with a rename's or copy's score (R100). */
  status: string;
  path: string;
  from: string | null;
}

export interface UntrackedFile {
  path: string;
  diff: DiffPart | null;
  /** nested_repository, limit, total, stopped, or what Git said. */
  notRead: string | null;
}

export interface DiffReport {
  state: "read" | "not_repository" | "unavailable" | "failed" | "cancelled" | "busy";
  reason: string;
  detail: string | null;
  generation: number | null;
  cwd: string | null;
  tracked: DiffPart | null;
  staged: { entries: StagedEntry[]; complete: boolean; error: string | null } | null;
  untracked: { files: UntrackedFile[]; listedAll: boolean; error: string | null } | null;
  complete: boolean;
  /** budget, total, cancelled or connection. */
  stopped: string | null;
  bytes: number;
  commands: number;
  elapsedMs: number;
}

/** What a read would read now: the Agent's folder on its current connection. */
export interface DiffTarget {
  state: "ready" | "unavailable";
  reason: string;
  generation: number | null;
  cwd: string;
}

/** One file's section of Git's unified diff. */
export interface DiffFile {
  path: string;
  text: string;
}

/**
 * Git's `diff` output split at its "diff --git " headers. Inside a hunk every
 * line starts with " ", "+", "-" or "\", so a header is never content. Only
 * the header lines are read for each file's path.
 */
export function diffFiles(text: string): DiffFile[] {
  const starts: number[] = [];
  for (let at = text.startsWith("diff --git ") ? 0 : text.indexOf("\ndiff --git "); at >= 0; at = text.indexOf("\ndiff --git ", at + 1)) {
    starts.push(at === 0 && text.startsWith("diff --git ") ? 0 : at + 1);
  }
  if (!starts.length) return text ? [{ path: "", text }] : [];
  const files: DiffFile[] = [];
  if (starts[0] > 0) files.push({ path: "", text: text.slice(0, starts[0]) });
  starts.forEach((start, index) => {
    const section = text.slice(start, index + 1 < starts.length ? starts[index + 1] : text.length);
    files.push({ path: headerPath(section), text: section });
  });
  return files;
}

/** The file a section is about, from its header lines (those before the first hunk). */
function headerPath(section: string) {
  const hunk = section.indexOf("\n@@");
  const lines = (hunk < 0 ? section : section.slice(0, hunk)).split("\n");
  const named = (prefix: string, side: string) => {
    const line = lines.find((l) => l.startsWith(prefix));
    if (!line) return null;
    // Git ends the name with a tab when it has a space.
    const name = gitPath(line.slice(prefix.length).replace(/\t$/, ""));
    return name === "/dev/null" ? null : name.startsWith(side) ? name.slice(side.length) : name;
  };
  const renamed = lines.find((l) => l.startsWith("rename to ") || l.startsWith("copy to "));
  if (renamed) return gitPath(renamed.slice(renamed.indexOf(" to ") + 4));
  const path = named("+++ ", "b/") ?? named("--- ", "a/");
  if (path !== null) return path;
  // No ---/+++ lines (a mode change, a binary file): "a/P b/P", the same P twice.
  const both = lines[0].slice("diff --git ".length);
  if (both.startsWith('"')) {
    const end = quotedEnd(both);
    const first = gitPath(both.slice(0, end));
    return first.startsWith("a/") ? first.slice(2) : first;
  }
  const half = (both.length - 1) / 2;
  if (Number.isInteger(half) && both.slice(0, half).replace(/^a\//, "") === both.slice(half + 1).replace(/^b\//, "")) {
    return both.slice(2, half);
  }
  return both;
}

/** Where a C-quoted name that starts `text` ends. */
function quotedEnd(text: string) {
  for (let at = 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === '"') return at + 1;
  }
  return text.length;
}

const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A name as Git writes it in a diff: as is, or C-quoted with octal bytes ("\343\203\246"). */
export function gitPath(name: string): string {
  if (!(name.length >= 2 && name.startsWith('"') && name.endsWith('"'))) return name;
  const bytes: number[] = [];
  const inner = name.slice(1, -1);
  for (let at = 0; at < inner.length; at++) {
    const char = inner[at];
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = inner[at + 1] ?? "";
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(inner.slice(at + 1))![0];
      bytes.push(parseInt(octal, 8) & 0xff);
      at += octal.length;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      at += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const stagedLabels: Record<string, string> = {
  A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Unmerged", X: "Unknown",
};

/** A staged change's status in words: "Renamed (100% similar)". */
export function stagedLabel(status: string) {
  const label = stagedLabels[status[0]] ?? status;
  const score = status.slice(1);
  return score && /^\d+$/.test(score) ? `${label} (${Number(score)}% similar)` : label;
}

/** A random request token: what Close and Cancel name, so only this read is stopped. */
export function readToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `diff-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
