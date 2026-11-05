import { useLayoutEffect, useRef } from "react";
import { animates } from "./motion";

/** The copy is gone by then even if its animation never ends. */
const FALLBACK_MS = 400;
/** Without these the copy is no form control, label, tab stop or element of an id that code finding a request's card
    (useCatchup, the conversation's links) or a radio group could count. */
const STRIPPED = ["id", "name", "for", "form", "role", "aria-labelledby", "aria-describedby", "aria-controls", "autofocus", "tabindex"];

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** A duration token in milliseconds; its value in styles.css where none is read. */
const tokenMs = (name: string, otherwise: number) => {
  const value = token(name);
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : otherwise;
};

/**
 * A pending request's card as Core records and resolves its answer (T-19 CV:Q-03). Its "Response sent" hint fades in
 * over small when it appears while the card shows; a card that opens with it shows it as it is. A resolved card leaves
 * over exit-small through a copy where it was: aria-hidden, inert and without the ids, names and tab stops of the
 * card, removed when its fade ends, so the request's card itself is gone at once, focus and all. Under reduced motion,
 * or without the Web Animations API, the hint shows and the card goes at once.
 *
 * Only a card whose answer Core has recorded (`sent`) is resolved as it goes; any other leaves at once, with no copy
 * (R1 4a8e5cfe): one taken out while its request still waits. Neither leaves one where the card is put in again (a
 * parent keyed anew: its id is in the page again), nor where the conversation it was in (its `data-agent-id`) now
 * shows another Agent, or is gone.
 *
 * `card` goes on the card's root, `hint` on the hint; `sent` is whether the hint shows; `agentId` is the request's.
 */
export function usePendingMotion(sent: boolean, agentId: string) {
  const card = useRef<HTMLElement>(null);
  const hint = useRef<HTMLParagraphElement>(null);
  const wasSent = useRef(sent);
  useLayoutEffect(() => {
    const shown = sent && !wasSent.current;
    wasSent.current = sent;
    if (shown && hint.current && animates())
      hint.current.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: tokenMs("--motion-small", 180),
        easing: token("--ease-standard") || "cubic-bezier(0.2, 0.8, 0.2, 1)",
        id: "pending-hint-in",
      });
  }, [sent]);
  const agent = useRef(agentId);
  agent.current = agentId;
  // As it last rendered: whether Core had recorded the answer, read as the card goes.
  const resolved = useRef(sent);
  resolved.current = sent;
  useLayoutEffect(() => {
    const element = card.current;
    return () => {
      if (element && resolved.current) leave(element, agent.current);
    };
  }, []);
  return { card, hint };
}

/** Puts a copy of `element` where it is as it unmounts, and fades the copy out once React has removed the card, if
    the conversation still shows `agentId`'s and no card of the same request was put in meanwhile. StrictMode's unmount
    and mount again in development leaves the card where it was: then the copy goes at once, as it does in another
    Agent's conversation. */
function leave(element: HTMLElement, agentId: string) {
  if (!element.isConnected || !animates()) return;
  const copy = element.cloneNode(true) as HTMLElement;
  const from = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  from.forEach((original, i) => {
    const node = to[i];
    for (const name of STRIPPED) node.removeAttribute(name);
    if (original instanceof HTMLInputElement && node instanceof HTMLInputElement && original.type !== "file") {
      node.value = original.value;
      node.checked = original.checked;
    } else if (original instanceof HTMLTextAreaElement && node instanceof HTMLTextAreaElement) {
      node.value = original.value;
    } else if (original instanceof HTMLSelectElement && node instanceof HTMLSelectElement) {
      node.selectedIndex = original.selectedIndex;
    }
  });
  copy.classList.add("pending-card-leaving");
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  element.after(copy);
  void Promise.resolve().then(() => {
    // Still there: not removed after all (StrictMode). Gone with its conversation, or in another Agent's (the
    // conversation's attributes change after its cards go, in the same commit): nothing to show.
    const shows = copy.closest("[data-agent-id]")?.getAttribute("data-agent-id");
    const again = !!element.id && !!document.getElementById(element.id);
    if (element.isConnected || !copy.isConnected || again || (shows != null && shows !== agentId)) {
      copy.remove();
      return;
    }
    const remove = () => {
      clearTimeout(timer);
      copy.remove();
    };
    const timer = setTimeout(remove, FALLBACK_MS);
    const fade = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: tokenMs("--motion-exit-small", 130),
      easing: token("--ease-exit") || "ease-in",
      fill: "forwards",
      id: "pending-card-exit",
    });
    fade.addEventListener?.("finish", remove);
  });
}
