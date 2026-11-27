import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useStrings } from "../i18n";
import { homeText } from "./home-text";
import { Tip, TipText } from "../Tip";
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
    <Tip content={<TipText title={collapsed ? t.expand : t.collapse} />} describe={false}>
      <button
        type="button"
        className="icon-button home-fold"
        aria-expanded={!collapsed}
        aria-controls={controls}
        aria-label={label}
        onClick={onToggle}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
    </Tip>
  );
}

/**
 * Unfolds the collapsed cards that hold `target`, and its own, by their fold
 * buttons, so a jump to it (Needs you, Open in…, a reply's Open on Home)
 * shows it rather than a header; those cards stay expanded. An answered
 * Ask's card opens its answer record. A closed
 * `<details>` that holds it, as a project's team details hold the sections
 * kept out of view, opens too: its content is drawn already. Whether any
 * card was unfolded: the target is drawn on the next frame.
 */
export function unfoldAround(target: HTMLElement) {
  const revealed = revealAround(target);
  for (
    let details = target.parentElement?.closest<HTMLDetailsElement>("details:not([open])");
    details;
    details = details.parentElement?.closest<HTMLDetailsElement>("details:not([open])")
  )
    details.open = true;
  const hidden: HTMLElement[] = [];
  const own = target.querySelector<HTMLElement>(":scope > .home-card-body[hidden]");
  if (own) hidden.push(own);
  for (let body = target.closest<HTMLElement>(".home-card-body[hidden]"); body; body = body.parentElement?.closest<HTMLElement>(".home-card-body[hidden]") ?? null)
    hidden.push(body);
  const folds = [...document.querySelectorAll<HTMLButtonElement>(".home-fold")];
  for (const body of hidden) folds.find((fold) => fold.getAttribute("aria-controls") === body.id)?.click();
  // An answered Ask's card (YN-230): a jump to it is to what it holds, so its answer record opens, by its one toggle.
  // Coming back to Home shows it closed; only such a jump, or the user, opens it.
  const record = target.querySelector<HTMLButtonElement>(":scope > .home-answer .home-answer-toggle[aria-expanded='false']");
  record?.click();
  return revealed || hidden.length > 0 || !!record;
}

/**
 * Shows what keeps `target` off a request's unfolded block (YN-237 ②, review 4324938d): the Details it is under, by
 * that Details' own toggle, as the user would, and no other; the block's other folds stay as they are. A jump does
 * this whether or not it keeps the card folded (`keepFolded` is the card's own fold, the user's): hidden, the target
 * is nowhere to land. Whether it opened one: the target is drawn on the next frame.
 */
export function revealAround(target: HTMLElement) {
  const hidden: HTMLElement[] = [];
  for (
    let panel = target.closest<HTMLElement>(".request-block-details[hidden]");
    panel;
    panel = panel.parentElement?.closest<HTMLElement>(".request-block-details[hidden]") ?? null
  )
    hidden.push(panel);
  const toggles = [...document.querySelectorAll<HTMLButtonElement>(".request-details-toggle[aria-expanded='false']")];
  for (const panel of hidden) toggles.find((toggle) => toggle.getAttribute("aria-controls") === panel.id)?.click();
  return hidden.length > 0;
}
