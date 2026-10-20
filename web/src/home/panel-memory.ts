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
