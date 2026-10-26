/**
 * Replies being written on Home, kept in this browser across reloads until
 * they are sent or discarded: a store per kind of reply (cards, T-174; an
 * Ask's free text, T-182) and a slot per Workspace, project and key in each,
 * the newest 50 of the last 30 days. Saving can be refused (private browsing,
 * a full store): `save` says so, and the window still has the text.
 */
export function draftStore<T extends { at: string }>(name: string, max = 50, days = 30) {
  function load(): Record<string, T> {
    try {
      const value = JSON.parse(localStorage.getItem(name) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  function save(slot: string, draft: T | null): boolean {
    const drafts = load();
    if (draft) drafts[slot] = draft;
    else delete drafts[slot];
    const since = Date.now() - days * 86_400_000;
    const kept = Object.entries(drafts)
      .filter(([, d]) => Date.parse(d.at) >= since)
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
      .slice(0, max);
    try {
      if (kept.length) localStorage.setItem(name, JSON.stringify(Object.fromEntries(kept)));
      else localStorage.removeItem(name);
      return true;
    } catch {
      return false;
    }
  }
  return { load, save };
}
