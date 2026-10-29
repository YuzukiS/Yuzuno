import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import {
  appendImage,
  validateImageChoice,
  validateImageFiles,
  type DraftImage,
} from "./image-input";
import { fitImage } from "./image-fit";
import type { ComposerDraft } from "./composer-draft";

export function useImageUploads(
  agentId: string,
  supported: boolean,
  getDraft: (id: string) => ComposerDraft,
  setDraft: (
    id: string,
    update: (draft: ComposerDraft) => ComposerDraft,
  ) => void,
) {
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
  async function add(files: readonly File[]) {
    if (!files.length) return;
    const target = agentId;
    try {
      if (!supported)
        throw new Error(
          "Images are supported by Codex, Claude and OpenCode Agents.",
        );
      if (active.current.has(target))
        throw new Error(
          "Please wait for these images to finish saving before attaching more.",
        );
      // How many and which types, before any image is read or made smaller.
      validateImageChoice(files, getDraft(target).images || []);
      active.current.add(target);
      setPending([...active.current]);
      setErrors((previous) => ({ ...previous, [target]: "" }));
      try {
        // A photo too large for Core, as a phone takes them, is made smaller
        // here first; anything Core takes as it is goes unchanged (image-fit).
        // The bytes are checked on what will be sent.
        const ready: File[] = [];
        for (const file of files) ready.push(await fitImage(file));
        validateImageFiles(ready, getDraft(target).images || []);
        // Upload sequentially; only the small durable references enter draft storage.
        for (const file of ready) {
          const saved = await api<Omit<DraftImage, "agentId" | "name">>(
            `/agents/${encodeURIComponent(target)}/images`,
            {
              method: "POST",
              headers: { "Content-Type": file.type },
              body: file,
            },
          );
          setDraft(target, (current) =>
            appendImage(current, {
              ...saved,
              agentId: target,
              name: file.name.slice(0, 200) || "Pasted image",
            }),
          );
        }
      } finally {
        active.current.delete(target);
        setPending([...active.current]);
      }
    } catch (error) {
      setErrors((previous) => ({ ...previous, [target]: errorText(error) }));
    }
  }
  return {
    add,
    hasPending: () => active.current.size > 0,
    busy: pending.includes(agentId),
    error: errors[agentId],
  };
}
