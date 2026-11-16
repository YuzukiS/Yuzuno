/**
 * Files the user attaches on Home (YN-145 F7): saved to the Project's own
 * files (Core's home-files, input_files::home_dir), and copied by Core to
 * whoever the message goes to once Core has settled that. The rules are the
 * conversation's (file-input.ts); only where they are kept differs, as with
 * Home's images (home-images.ts).
 */
import { useEffect, useRef, useState } from "react";
import { api, API_BASE, errorText } from "../api";
import {
  fileIdPattern,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_FILE_TOTAL,
  uploadFileName,
  validateFileChoice,
  type SavedFile,
} from "../file-input";
import { useLanguage, useStrings, strings } from "../i18n";

/** A file saved to the Project's files: Core's content-addressed reference. */
export type HomeFile = SavedFile;

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/files`;

/** Where a sent message's file is read from Core: through the Project's own route. */
export const homeFileUrl = (projectId: string, id: string, name: string) =>
  `${API_BASE}/api${project(projectId)}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;

/** Whether Agents of `harness` take files (Core's input_files::takes_files); a record without one is Codex's. */
export { takesFiles, agentTakesFiles } from "../file-input";

/** The same files, in the same order, as Core named them. */
export const sameFiles = (a?: readonly HomeFile[], b?: readonly HomeFile[]) =>
  (a?.length ?? 0) === (b?.length ?? 0) &&
  (a ?? []).every((file, i) => file.id === b?.[i]?.id && file.name === b?.[i]?.name && file.bytes === b?.[i]?.bytes);

/** A draft's files as kept in this browser: what this page keeps, and nothing else. */
export function validHomeFiles(value: unknown): value is HomeFile[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) return false;
  let total = 0;
  for (const file of value) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.id !== "string" ||
      !fileIdPattern.test(file.id) ||
      typeof file.name !== "string" ||
      !file.name ||
      file.name.length > 200 ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > MAX_FILE_BYTES
    )
      return false;
    total += file.bytes;
  }
  return total <= MAX_FILE_TOTAL;
}

const text = strings(
  {
    wait: "Please wait for these files to finish saving before attaching more.",
  },
  {
    wait: "请等这些文件保存好，再添加更多。",
  },
);

/**
 * Saving a field's files to the Project, as the conversation saves a draft's
 * (useFileUploads.ts): checked first, then saved one at a time, each added to
 * the draft once saved, under the name Core kept. Busy and errors are per
 * field (`slot`); leaving the page while files are saving asks first.
 */
export function useHomeFiles(projectId: string) {
  const language = useLanguage();
  const t = useStrings(text);
  const active = useRef(new Set<string>());
  const [pending, setPending] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (active.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  /** Saves one file to the Project's files; Core cleans the name and answers with the one it kept. */
  async function upload(file: File): Promise<HomeFile> {
    return api<HomeFile>(`${project(projectId)}?name=${encodeURIComponent(uploadFileName(file.name))}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
  }
  async function add(
    slot: string,
    files: readonly File[],
    current: () => readonly HomeFile[],
    append: (file: HomeFile) => void,
  ) {
    if (!files.length) return;
    try {
      if (active.current.has(slot)) throw new Error(t.wait);
      // How many and how large, before a byte is sent.
      validateFileChoice(files, current(), language);
      active.current.add(slot);
      setPending([...active.current]);
      setErrors((was) => ({ ...was, [slot]: "" }));
      try {
        for (const file of files) append(await upload(file));
      } finally {
        active.current.delete(slot);
        setPending([...active.current]);
      }
    } catch (error) {
      setErrors((was) => ({ ...was, [slot]: errorText(error) }));
    }
  }
  return {
    add,
    busy: (slot: string) => pending.includes(slot),
    error: (slot: string) => errors[slot] ?? "",
    clearError: (slot: string) => setErrors((was) => (was[slot] ? { ...was, [slot]: "" } : was)),
  };
}
