/** A smooth scroll that never says it ended (already in view) lands by then. */
const SCROLL_FALLBACK_MS = 400;

/**
 * Where a jump landed, shown once (T-19 M4). `attribute` goes on `target`
 * when the scroll there has ended: at once after an instant one, on
 * scrollend (or after 400 ms) after a smooth one, so the settle it starts
 * plays in view. It stays until the next press anywhere ("press"), or until
 * that animation ends ("animation"). The returned function takes it off at
 * once, for a new jump or the view going.
 */
export function settleWhenLanded(target: HTMLElement, attribute: string, smooth: boolean, until: "press" | "animation" = "press") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let landed = false;
  const ended = (event: AnimationEvent) => {
    if (event.target === target) remove();
  };
  const remove = () => {
    target.removeAttribute(attribute);
    document.removeEventListener("pointerdown", remove, true);
    target.removeEventListener("animationend", ended);
  };
  const land = () => {
    if (landed) return;
    landed = true;
    window.removeEventListener("scrollend", land, true);
    clearTimeout(timer);
    target.setAttribute(attribute, "");
    if (until === "press") document.addEventListener("pointerdown", remove, true);
    else target.addEventListener("animationend", ended);
  };
  // Waiting is only so the animation plays in view: without Web Animations (jsdom) none plays.
  if (smooth && typeof Element.prototype.animate === "function") {
    // scrollend does not bubble; a capturing listener on the window hears it from any scroller.
    window.addEventListener("scrollend", land, true);
    timer = setTimeout(land, SCROLL_FALLBACK_MS);
  } else land();
  return () => {
    window.removeEventListener("scrollend", land, true);
    clearTimeout(timer);
    remove();
  };
}
