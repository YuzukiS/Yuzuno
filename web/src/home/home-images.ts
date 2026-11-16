/**
 * Images the user attaches on Home (YN-134): saved to the Project's own
 * images (Core's home-images, input_images::home_dir), and copied by Core to
 * whoever the message goes to once Core has settled that. The rules are the
 * conversation's (image-input.ts); only where they are kept differs.
 */
import { useEffect, useRef, useState } from "react";
import { api, API_BASE, errorText } from "../api";
import { fitImage } from "../image-fit";
import { validateImageChoice, validateImageFiles, validDraftImages, type SavedImage } from "../image-input";
import { strings, useStrings } from "../i18n";

export type HomeImage = SavedImage;

const project = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/images`;

export const homeImageUrl = (projectId: string, id: string, thumb = false) =>
  `${API_BASE}/api${project(projectId)}/${encodeURIComponent(id)}${thumb ? "?thumb=true" : ""}`;

/** A draft's images as kept in this browser: the conversation's rules, without an Agent. */
export const validHomeImages = (value: unknown): value is HomeImage[] =>
  Array.isArray(value) &&
  validDraftImages(value.map((image) => (image && typeof image === "object" ? { ...image, agentId: "" } : image)));

/** Whether Agents of `harness` take images (Core's input_images::takes_images); a record without one is Codex's. */
export const takesImages = (harness: string | undefined) => ["codex", "claude", "opencode"].includes(harness ?? "codex");

/** The same images, in the same order. */
export const sameImages = (a?: readonly { id: string }[], b?: readonly { id: string }[]) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((image, i) => image.id === b?.[i]?.id);

const text = strings({
  wait: "Please wait for these images to finish saving before attaching more.",
}, {
  wait: "请等这些图片保存好，再添加更多。",
});

/**
 * Saving a field's images to the Project, as the conversation saves a
 * draft's (useImageUploads.ts): checked first, a photo too large made
 * smaller, then saved one at a time, each added to the draft once saved.
 * Busy and errors are per field (`slot`); leaving the page while images
 * are saving asks first.
 */
export function useHomeImages(projectId: string) {
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
  /** Saves one image to the Project's images; content-addressed, so the same image is the same ID. */
  async function upload(blob: Blob, name: string): Promise<HomeImage> {
    const saved = await api<Omit<HomeImage, "name">>(project(projectId), {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
    // Named as the conversation names them (useImageUploads.ts): the name goes to the Agent.
    return { ...saved, name: name.slice(0, 200) || "Pasted image" };
  }
  async function add(slot: string, files: readonly File[], current: () => readonly HomeImage[], append: (image: HomeImage) => void) {
    if (!files.length) return;
    try {
      if (active.current.has(slot)) throw new Error(t.wait);
      // How many and which types, before any image is read or made smaller.
      validateImageChoice(files, current());
      active.current.add(slot);
      setPending([...active.current]);
      setErrors((was) => ({ ...was, [slot]: "" }));
      try {
        const ready: File[] = [];
        for (const file of files) ready.push(await fitImage(file));
        validateImageFiles(ready, current());
        for (const file of ready) append(await upload(file, file.name));
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
    upload,
    busy: (slot: string) => pending.includes(slot),
    error: (slot: string) => errors[slot] ?? "",
    clearError: (slot: string) => setErrors((was) => (was[slot] ? { ...was, [slot]: "" } : was)),
  };
}
