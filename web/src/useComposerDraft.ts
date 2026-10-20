import { useRef, useState } from "react";
import { DraftStorage, emptyDraft, type ComposerDraft } from "./composer-draft";

export function useComposerDraft(agentId: string) {
  const storage = useRef<DraftStorage | null>(null);
  const drafts = useRef(new Map<string, ComposerDraft>());
  const unsaved = useRef(new Set<string>());
  const errors = useRef(new Map<string, string>());
  const broken = useRef(new Set<string>());
  const [, render] = useState(0);
  if (!drafts.current.has(agentId)) {
    try {
      storage.current ||= new DraftStorage(localStorage);
      drafts.current.set(
        agentId,
        agentId ? storage.current.load(agentId) : emptyDraft(),
      );
    } catch {
      drafts.current.set(agentId, emptyDraft());
      broken.current.add(agentId);
      errors.current.set(
        agentId,
        "This saved draft is damaged or unavailable. It has not been overwritten. Recover it from another open window, or reset this saved draft to start again.",
      );
    }
  }
  function setDraft(id: string, update: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) {
    const draft = typeof update === "function" ? update(drafts.current.get(id) || storage.current?.load(id) || emptyDraft()) : update;
    if (broken.current.has(id)) return;
    drafts.current.set(id, draft);
    unsaved.current.add(id);
    try {
      storage.current ||= new DraftStorage(localStorage);
      storage.current.save(id, draft);
      unsaved.current.delete(id);
      errors.current.delete(id);
    } catch {
      errors.current.set(
        id,
        "This draft is kept in this window, but could not be saved. Copy it before reloading.",
      );
    }
    render((n) => n + 1);
  }
  function clearIfUnchanged(id: string, sent: ComposerDraft) {
    if (drafts.current.get(id) === sent) setDraft(id, emptyDraft());
  }
  function preserveDrafts() {
    if (broken.current.size)
      throw new Error(
        "Recover or reset the damaged saved draft before updating or reloading.",
      );
    storage.current ||= new DraftStorage(localStorage);
    // Retry only local edits that failed to save. A clean cached snapshot may
    // be older than another window's edit or send; Apply/Reload must not
    // publish it again. External storage changes do not make local edits dirty.
    for (const id of unsaved.current) {
      const draft = drafts.current.get(id)!;
      try {
        storage.current.save(id, draft);
        unsaved.current.delete(id);
        errors.current.delete(id);
      } catch (error) {
        errors.current.set(
          id,
          "This draft is kept in this window, but could not be saved. Copy it before reloading.",
        );
        render((n) => n + 1);
        throw error;
      }
    }
    render((n) => n + 1);
  }
  function removeDraft(id: string) {
    broken.current.delete(id);
    setDraft(id, emptyDraft());
  }
  function discardSavedDraft(id: string) {
    try {
      storage.current ||= new DraftStorage(localStorage);
      storage.current.discard(id);
      drafts.current.set(id, emptyDraft());
      unsaved.current.delete(id);
      broken.current.delete(id);
      errors.current.delete(id);
      render((n) => n + 1);
      return true;
    } catch {
      errors.current.set(
        id,
        "The saved draft could not be reset. Check browser storage access and try again. It has not been discarded.",
      );
      render((n) => n + 1);
      return false;
    }
  }
  function copyDraft(source: string, target: string) {
    try {
      const current =
        drafts.current.get(target) ||
        storage.current?.load(target) ||
        emptyDraft();
      const original = drafts.current.get(source);
      if (original && (original.parts.length || original.images?.length) && !current.parts.length && !current.images?.length)
        setDraft(target, original);
    } catch {
      errors.current.set(
        target,
        "This saved draft could not be loaded. It has not been overwritten.",
      );
      broken.current.add(target);
    }
  }
  return {
    draft: drafts.current.get(agentId)!,
    getDraft: (id: string) => drafts.current.get(id) || storage.current?.load(id) || emptyDraft(),
    setDraft,
    clearIfUnchanged,
    preserveDrafts,
    removeDraft,
    discardSavedDraft,
    copyDraft,
    draftError: errors.current.get(agentId),
    draftBlocked: broken.current.has(agentId),
  };
}
