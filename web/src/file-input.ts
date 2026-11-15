import type { Language } from "./i18n.ts";
import { strings } from "./i18n.ts";
import type { ComposerDraft } from "./composer-draft.ts";
import { IMAGE_TYPES } from "./image-input.ts";
import type { SavedFile } from "./file-ref.ts";

export type { SavedFile } from "./file-ref.ts";

/** A file in an Agent's draft, saved to that Agent's own files. */
export type DraftFile = SavedFile & { agentId: string };
export const fileIdPattern = /^[a-f0-9]{64}$/;

// The limits Core enforces (core/src/input_files.rs, YN-145 §2.2).
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_FILE_TOTAL = 40 * 1024 * 1024;

/** Whether Agents of `harness` take files (core/src/input_files.rs,
 * `takes_files`); a record without one is Codex's, as Core reads it. */
export const takesFiles = (harness: string | undefined) =>
  ["codex", "claude", "opencode"].includes(harness ?? "codex");

/** Whether `agent` takes files now: its harness reads them, and on another
 * machine only Codex and Claude carry them there (core/src/workspace.rs and
 * project_brief/home.rs, YN-145 F4). A remote OpenCode or dsh Agent still
 * cannot, so the entry is refused before Core sees it. */
export const agentTakesFiles = (agent: { harness?: string; remote?: unknown } | undefined) => {
  const harness = agent?.harness ?? "codex";
  return !!agent && takesFiles(harness) && (!agent.remote || harness === "codex" || harness === "claude");
};

// What can be checked before a file is sent, in the interface language.
const text = strings({
  tooMany: "Attach at most 8 files per message.",
  empty: (name: string) => `${name} is empty.`,
  tooLarge: (name: string, size: string) =>
    `${name}: ${size}, over the 40 MiB a message can carry.`,
  draftFull: "The draft already contains the maximum file count or size.",
}, {
  tooMany: "每条消息最多 8 个文件。",
  empty: (name) => `${name} 是空文件。`,
  tooLarge: (name, size) =>
    `${name}：${size}，超过每条消息合计 40 MiB 的上限。`,
  draftFull: "草稿里的文件已达到数量或大小上限。",
});

/** Bytes in decimal units, one decimal place, as the Agent's notice says
 * them (core/src/input_files.rs). */
export function fileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}

/** The name asked of Core for an upload: its first 200 UTF-16 units, never
 * ending in half a surrogate pair (`encodeURIComponent` throws on one). Core
 * cleans and shortens it again (core/src/input_files.rs, `safe_name`). */
export function uploadFileName(name: string) {
  const cut = (name || "").slice(0, 200);
  const kept = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
  return kept || "Pasted file";
}

/** What can be checked before any file is read: how many, and how large. */
export function validateFileChoice(
  files: readonly File[],
  current: readonly { bytes: number }[],
  language: Language = "en",
) {
  const t = text(language);
  if (files.length + current.length > MAX_FILES) throw new Error(t.tooMany);
  let running = total(current);
  for (const file of files) {
    const name = file.name || "File";
    if (!file.size) throw new Error(t.empty(name));
    if (file.size > MAX_FILE_BYTES || running + file.size > MAX_FILE_TOTAL)
      throw new Error(t.tooLarge(name, fileSize(file.size)));
    running += file.size;
  }
}

export function validDraftFiles(value: unknown): value is DraftFile[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FILES &&
    value.every(
      (file) =>
        !!file &&
        typeof file === "object" &&
        typeof file.id === "string" &&
        fileIdPattern.test(file.id) &&
        typeof file.agentId === "string" &&
        !!file.agentId &&
        typeof file.name === "string" &&
        !!file.name &&
        file.name.length <= 200 &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= MAX_FILE_BYTES,
    ) &&
    total(value) <= MAX_FILE_TOTAL
  );
}
function total(files: readonly { bytes: number }[]) {
  return files.reduce((n, file) => n + file.bytes, 0);
}

export function appendFile(
  draft: ComposerDraft,
  file: DraftFile,
  language: Language = "en",
): ComposerDraft {
  if (
    draft.files?.some(
      (saved) =>
        saved.id === file.id &&
        saved.agentId === file.agentId &&
        saved.name === file.name,
    )
  )
    return draft;
  if (
    (draft.files?.length || 0) >= MAX_FILES ||
    total(draft.files || []) + file.bytes > MAX_FILE_TOTAL
  )
    throw new Error(text(language).draftFull);
  return { ...draft, files: [...(draft.files || []), file] };
}

/** The files one drop or paste brought, split the way the composer takes
 * them: PNG, JPEG and WebP are images, everything else is a file (D11). The
 * two views of a clipboard payload are never added together. */
export function splitDropped(data: DataTransfer | null): {
  images: File[];
  files: File[];
} {
  if (!data) return { images: [], files: [] };
  const items = Array.from(data.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
  const all = items.length ? items : Array.from(data.files || []);
  return {
    images: all.filter((file) => IMAGE_TYPES.includes(file.type)),
    files: all.filter((file) => !IMAGE_TYPES.includes(file.type)),
  };
}

