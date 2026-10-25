import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
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
  const t = useStrings(homeText);
  return (
    <button
      type="button"
      className="icon-button home-fold"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={collapsed ? t.expand : t.collapse}
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
    </button>
  );
}

/**
 * Unfolds the collapsed cards that hold `target`, and its own, by their fold
 * buttons, so a jump to it (Needs you, Open in…) shows it rather than a
 * header; those cards stay expanded. Whether any was unfolded: the target is
 * drawn on the next frame.
 */
export function unfoldAround(target: HTMLElement) {
  const hidden: HTMLElement[] = [];
  const own = target.querySelector<HTMLElement>(":scope > .home-card-body[hidden]");
  if (own) hidden.push(own);
  for (let body = target.closest<HTMLElement>(".home-card-body[hidden]"); body; body = body.parentElement?.closest<HTMLElement>(".home-card-body[hidden]") ?? null)
    hidden.push(body);
  const folds = [...document.querySelectorAll<HTMLButtonElement>(".home-fold")];
  for (const body of hidden) folds.find((fold) => fold.getAttribute("aria-controls") === body.id)?.click();
  return hidden.length > 0;
}
