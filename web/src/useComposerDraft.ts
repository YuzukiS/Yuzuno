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
  /**
   * The Workspace can arrive after this window has already been typed in
   * (T-195, found by review of #347). Not on an ordinary failed cold read --
   * there is no composer then -- but on an older Core that answers with
   * agents and no `workspace.id`, and when `onCreated` puts an Agent on
   * screen before the metadata read returns.
   *
   * What was typed here while this window had no identity is its own work,
   * and it belongs to the first Workspace this turns out to be. It is taken
   * over once, only for the Agents actually edited -- their whole draft,
   * pasted bodies and unsaved state -- and the first identity consumes that
   * step. An Agent that was only read keeps reading this Workspace's own
   * saved draft. Afterwards nothing is claimed: going to another Workspace,
   * or losing the identity and getting a different one, leaves what was
   * typed under the one before it where it is.
   */
  const named = useRef(false);
  if (workspaceId && !named.current) {
    named.current = true;
    for (const was of [...unsaved.current]) {
      const parts = JSON.parse(was) as [string, string];
      if (parts[0] !== "") continue;
      const draft = drafts.current.get(was);
      unsaved.current.delete(was);
      drafts.current.delete(was);
      const problem = errors.current.get(was);
      errors.current.delete(was);
      if (!draft) continue;
      const to = cache(parts[1]);
      drafts.current.set(to, draft);
      unsaved.current.add(to);
      if (problem) errors.current.set(to, problem);
      // It has somewhere to be saved now. A refusal still says it is not
      // saved, as a refusal while typing does.
      try {
        storage.current ||= new DraftStorage(localStorage);
        storage.current.save(draftIdentity(workspaceId, parts[1]), draft);
        unsaved.current.delete(to);
        errors.current.delete(to);
      } catch {
        errors.current.set(
          to,
          "This draft is kept in this window, but could not be saved. Copy it before reloading.",
        );
      }
    }
  }
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
  /**
   * Write a draft under the identity it is filed as, which is not always the
   * one this render has. A send that started before the Workspace was known
   * is settled by the render that started it, while the draft itself has
   * since moved to the Workspace that arrived. So the storage key comes from
   * `at`, never from the current `workspaceId`.
   */
  function write(at: string, id: string, draft: ComposerDraft) {
    if (broken.current.has(at)) return;
    const [workspace] = JSON.parse(at) as [string, string];
    drafts.current.set(at, draft);
    unsaved.current.add(at);
    try {
      const key = workspace && id ? draftIdentity(workspace, id) : null;
      // No Workspace to attribute it to: it stays in this window, and is not
      // written to the key an Agent alone would name. Said rather than
      // quietly not saved -- against a Core that does not say which
      // Workspace this is, that is where the draft stays.
      if (!key) {
        if (id)
          errors.current.set(
            at,
            "This draft is kept in this window only: Core has not said which Workspace this is, so there is nothing to save it under. Copy it before reloading.",
          );
      } else {
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
  function setDraft(id: string, update: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) {
    const at = cache(id);
    const draft = typeof update === "function" ? update(drafts.current.get(at) || saved(id) || emptyDraft()) : update;
    write(at, id, draft);
  }
  /**
   * Clear what was sent, where it is filed now. The draft object decides, not
   * the key: a send that started before the Workspace was known is settled by
   * a render whose key is still the unattributed one, while the draft has
   * moved to the Workspace that arrived. Looking only under this render's key
   * misses it, and the composer keeps text Core has already taken -- which
   * the next Enter sends a second time, under a new clientMessageId.
   */
  function clearIfUnchanged(id: string, sent: ComposerDraft) {
    for (const [at, draft] of drafts.current)
      if (draft === sent && (JSON.parse(at) as [string, string])[1] === id) {
        write(at, id, emptyDraft());
        return;
      }
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
