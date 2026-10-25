import { useRef, useState } from "react";
import { DraftStorage, copiedDraft, draftIdentity, emptyDraft, type ComposerDraft } from "./composer-draft";

/**
 * The composer's drafts, per Workspace and Agent (T-195).
 *
 * Both the saved draft and this window's own cache were keyed by Agent
 * alone, so two Workspaces at one address whose Agents share an id handed
 * each other their unsent drafts. Everything here is keyed by the Workspace
 * and the Agent together instead.
 *
 * While `workspaceId` is empty -- `App.tsx` has `""` until `/api/workspace`
 * answers -- nothing is read or written: no draft is loaded, none is saved,
 * and the older unattributed shapes are not read in its place. What is typed
 * is still kept in this window, under a cache key of its own, so the Agents
 * do not share it either; it reaches storage once the Workspace is known and
 * the draft is next changed.
 */
export function useComposerDraft(workspaceId: string, agentId: string) {
  const storage = useRef<DraftStorage | null>(null);
  const drafts = useRef(new Map<string, ComposerDraft>());
  const unsaved = useRef(new Set<string>());
  const errors = useRef(new Map<string, string>());
  const broken = useRef(new Set<string>());
  const [, render] = useState(0);
  /** This window's key for an Agent's draft. Distinct per Workspace, and
   * distinct again while the Workspace is unknown, so nothing is shared. */
  const cache = (agent: string) => JSON.stringify([workspaceId, agent]);
  /** The key storage holds it under, or `null` while there is no Workspace to
   * attribute it to or no Agent open. */
  const disk = (agent: string) => (workspaceId && agent ? draftIdentity(workspaceId, agent) : null);
  const here = cache(agentId);
  if (!drafts.current.has(here)) {
    try {
      const key = disk(agentId);
      storage.current ||= new DraftStorage(localStorage);
      drafts.current.set(here, key ? storage.current.load(key) : emptyDraft());
    } catch {
      drafts.current.set(here, emptyDraft());
      broken.current.add(here);
      errors.current.set(
        here,
        "This saved draft is damaged or unavailable. It has not been overwritten. Recover it from another open window, or reset this saved draft to start again.",
      );
    }
  }
  function saved(agent: string): ComposerDraft | null {
    const key = disk(agent);
    if (!key) return null;
    storage.current ||= new DraftStorage(localStorage);
    return storage.current.load(key);
  }
  function setDraft(id: string, update: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) {
    const at = cache(id);
    const draft = typeof update === "function" ? update(drafts.current.get(at) || saved(id) || emptyDraft()) : update;
    if (broken.current.has(at)) return;
    drafts.current.set(at, draft);
    unsaved.current.add(at);
    try {
      const key = disk(id);
      // No Workspace to attribute it to yet: it stays in this window, and is
      // not written to the key an Agent alone would name.
      if (key) {
        storage.current ||= new DraftStorage(localStorage);
        storage.current.save(key, draft);
        unsaved.current.delete(at);
        errors.current.delete(at);
      }
    } catch {
      errors.current.set(
        at,
        "This draft is kept in this window, but could not be saved. Copy it before reloading.",
      );
    }
    render((n) => n + 1);
  }
  function clearIfUnchanged(id: string, sent: ComposerDraft) {
    if (drafts.current.get(cache(id)) === sent) setDraft(id, emptyDraft());
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
    for (const at of unsaved.current) {
      const draft = drafts.current.get(at)!;
      const parts = JSON.parse(at) as [string, string];
      const key = disk(parts[1]);
      // A draft typed before the Workspace was known is left in this window
      // rather than written somewhere it cannot be attributed.
      if (!key || parts[0] !== workspaceId) continue;
      try {
        storage.current.save(key, draft);
        unsaved.current.delete(at);
        errors.current.delete(at);
      } catch (error) {
        errors.current.set(
          at,
          "This draft is kept in this window, but could not be saved. Copy it before reloading.",
        );
        render((n) => n + 1);
        throw error;
      }
    }
    render((n) => n + 1);
  }
  function removeDraft(id: string) {
    broken.current.delete(cache(id));
    setDraft(id, emptyDraft());
  }
  function discardSavedDraft(id: string) {
    const at = cache(id);
    try {
      const key = disk(id);
      if (key) {
        storage.current ||= new DraftStorage(localStorage);
        storage.current.discard(key);
      }
      drafts.current.set(at, emptyDraft());
      unsaved.current.delete(at);
      broken.current.delete(at);
      errors.current.delete(at);
      render((n) => n + 1);
      return true;
    } catch {
      errors.current.set(
        at,
        "The saved draft could not be reset. Check browser storage access and try again. It has not been discarded.",
      );
      render((n) => n + 1);
      return false;
    }
  }
  function copyDraft(source: string, target: string) {
    try {
      const current =
        drafts.current.get(cache(target)) ||
        saved(target) ||
        emptyDraft();
      const original = drafts.current.get(cache(source));
      if (original && (original.parts.length || original.images?.length) && !current.parts.length && !current.images?.length)
        setDraft(target, copiedDraft(original));
    } catch {
      errors.current.set(
        cache(target),
        "This saved draft could not be loaded. It has not been overwritten.",
      );
      broken.current.add(cache(target));
    }
  }
  return {
    draft: drafts.current.get(here)!,
    getDraft: (id: string) => drafts.current.get(cache(id)) || saved(id) || emptyDraft(),
    setDraft,
    clearIfUnchanged,
    preserveDrafts,
    removeDraft,
    discardSavedDraft,
    copyDraft,
    draftError: errors.current.get(here),
    draftBlocked: broken.current.has(here),
  };
}
