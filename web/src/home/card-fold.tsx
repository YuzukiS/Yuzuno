import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { readCardCollapsed, saveCardCollapsed } from "./panel-memory";

/** The Workspace whose card choices Home keeps (T-115); "" keeps them for
 * this page only, as in the design preview. */
export const CardFoldWorkspace = createContext("");

/** Whether one Home card is collapsed, as the user last left it here.
 * Collapsing only hides the card's body: it stays mounted, so drafts and
 * other state in it are kept, and nothing is marked seen or answered. */
export function useCardFold(cardId: string) {
  const workspaceId = useContext(CardFoldWorkspace);
  const read = () => !!workspaceId && readCardCollapsed(workspaceId, cardId);
  const [collapsed, setCollapsed] = useState(read);
  // The same component may come to show another card or Workspace.
  const shown = useRef(`${workspaceId}\n${cardId}`);
  useEffect(() => {
    const now = `${workspaceId}\n${cardId}`;
    if (shown.current === now) return;
    shown.current = now;
    setCollapsed(read());
  }, [workspaceId, cardId]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (workspaceId) saveCardCollapsed(workspaceId, cardId, next);
  };
  return [collapsed, toggle] as const;
}


/** The control in a card's header; `label` names the card, the state is in
 * aria-expanded. */
export function FoldButton({
  collapsed,
  onToggle,
  label,
  controls,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
  /** The id of the body it shows and hides. */
  controls: string;
}) {
  return (
    <button
      type="button"
      className="icon-button home-fold"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
    </button>
  );
}
