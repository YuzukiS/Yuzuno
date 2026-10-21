/** A Project panel the user expanded or collapsed by hand stays that way. */
export type PanelChoice = "expanded" | "collapsed";

export const panelMemoryKey = (workspaceId: string, projectId: string) =>
  `yuzuno.home-panel.v1:${JSON.stringify([workspaceId, projectId])}`;

export function readPanelChoice(workspaceId: string, projectId: string): PanelChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(panelMemoryKey(workspaceId, projectId)) || "null");
    return value === "expanded" || value === "collapsed" ? value : null;
  } catch {
    return null;
  }
}

export function savePanelChoice(workspaceId: string, projectId: string, choice: PanelChoice) {
  try {
    localStorage.setItem(panelMemoryKey(workspaceId, projectId), JSON.stringify(choice));
  } catch {
    /* Private storage can be unavailable; the choice lasts for this window. */
  }
}

/** Home cards the user collapsed (T-115), per Workspace by stable card ID:
 * `section:<project>:<key>`, `repos:<project>`, `approvals:<project>`,
 * `needs-you`, `widget:<id>`. Only collapsed cards are kept, the most recent
 * last; a new card shows expanded. */
export const CARD_FOLD_LIMIT = 300;
export const cardFoldKey = (workspaceId: string) => `yuzuno.home-cards.v1:${JSON.stringify([workspaceId])}`;

function collapsedCards(workspaceId: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(cardFoldKey(workspaceId)) || "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function readCardCollapsed(workspaceId: string, cardId: string) {
  return collapsedCards(workspaceId).includes(cardId);
}

export function saveCardCollapsed(workspaceId: string, cardId: string, collapsed: boolean) {
  const others = collapsedCards(workspaceId).filter((id) => id !== cardId);
  const next = collapsed ? [...others, cardId].slice(-CARD_FOLD_LIMIT) : others;
  try {
    if (next.length) localStorage.setItem(cardFoldKey(workspaceId), JSON.stringify(next));
    else localStorage.removeItem(cardFoldKey(workspaceId));
  } catch {
    /* Private storage can be unavailable; the choice lasts for this window. */
  }
}
