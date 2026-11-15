import { useEffect, useRef, useState } from "react";
import { api, errorText } from "./api";
import { appendFile, validateFileChoice, type DraftFile } from "./file-input";
import type { ComposerDraft } from "./composer-draft";
import { strings, useLanguage, useStrings } from "./i18n";

// Said while files can't be attached yet (YN-145 §2.6).
const text = strings({
  wait: "Please wait for these files to finish saving before attaching more.",
}, {
  wait: "请等这些文件保存好，再添加更多。",
});

/**
 * The composer's files, saved one at a time to this Agent's own directory
 * (YN-145 §2.6): a file is uploaded as its bytes before it enters the draft,
 * so the draft keeps only the small reference Core answers with. Busy and
 * errors are kept per Agent, as images are.
 */
export function useFileUploads(
  agentId: string,
  supported: boolean,
  unsupported: string,
  getDraft: (id: string) => ComposerDraft,
  setDraft: (
    id: string,
    update: (draft: ComposerDraft) => ComposerDraft,
  ) => void,
) {
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
  async function add(files: readonly File[]) {
    if (!files.length) return;
    const target = agentId;
    try {
      if (!supported) throw new Error(unsupported);
      if (active.current.has(target)) throw new Error(t.wait);
      // How many and how large, before a byte is sent.
      validateFileChoice(files, getDraft(target).files || [], language);
      active.current.add(target);
      setPending([...active.current]);
      setErrors((previous) => ({ ...previous, [target]: "" }));
      try {
        for (const file of files) {
          // Core cleans the name and answers with the one it kept; the
          // draft stores that, so a download asks for the stored name.
          const saved = await api<Omit<DraftFile, "agentId">>(
            `/agents/${encodeURIComponent(target)}/files?name=${encodeURIComponent(
              file.name.slice(0, 200) || "Pasted file",
            )}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: file,
            },
          );
          setDraft(target, (current) =>
            appendFile(current, { ...saved, agentId: target }, language),
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
