/** Frames the target must hold still, its scrollers quiet, to have landed. */
const STILL_FRAMES = 3;
/** A scroll of one of the target's scrollers this recent: it is still on its way. */
const QUIET_MS = 100;
/** A jump that has not come to rest by then shows nothing. */
const GIVE_UP_MS = 4000;
/** --motion-settle and a margin: a landing that plays no animation (reduced
    motion) or never says it ended is taken off by then. */
const SETTLE_MS = 1200 + 100;
/** The reader takes over: a jump still on its way shows nothing. */
const INTERVENTIONS = ["pointerdown", "wheel", "touchstart", "keydown"] as const;

/** The jump holding each attribute: a new one ends it, wherever it started. */
const current = new Map<string, () => void>();

/**
 * Where a jump landed, shown once (T-19 M4). `attribute` goes on `target`
 * once the jump has landed: at once after an instant one; after a smooth one
 * when the target has held still for a few frames and none of its own
 * scrollers has scrolled for a moment (another scroller ending, a sidebar
 * say, is not its landing). A target already in view lands that way too.
 * Until then a press, a wheel, a touch or a key ends it unshown, and passes
 * on as it came. Once shown it stays until the next press ("press"), or
 * until its animation ends ("animation"), or the settle's time is up when it
 * plays none. One jump holds an attribute: a new one ends the last. The
 * returned function ends it at once, for the view going.
 */
export function settleWhenLanded(target: HTMLElement, attribute: string, smooth: boolean, until: "press" | "animation" = "press") {
  current.get(attribute)?.();
  let ended = false;
  let landed = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playing: string[] = [];
  const started = performance.now();
  let scrolledAt = started;
  let last: DOMRect | null = null;
  let still = 0;

  const ours = (event: Event) => event.target === document || (event.target instanceof Node && event.target.contains(target));
  const scrolled = (event: Event) => {
    if (ours(event)) scrolledAt = performance.now();
  };
  const scrollEnded = (event: Event) => {
    if (ours(event)) scrolledAt = 0;
  };
  const animationEnded = (event: AnimationEvent) => {
    if (event.target === target && playing.includes(event.animationName)) end();
  };
  const stopWaiting = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener("scroll", scrolled, true);
    document.removeEventListener("scrollend", scrollEnded, true);
    for (const type of INTERVENTIONS) document.removeEventListener(type, end, true);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    stopWaiting();
    clearTimeout(timer);
    document.removeEventListener("pointerdown", end, true);
    target.removeEventListener("animationend", animationEnded);
    target.removeEventListener("animationcancel", animationEnded);
    if (landed) target.removeAttribute(attribute);
    if (current.get(attribute) === end) current.delete(attribute);
  };
  const land = () => {
    stopWaiting();
    landed = true;
    target.setAttribute(attribute, "");
    document.addEventListener("pointerdown", end, true);
    if (until === "animation") {
      playing = getComputedStyle(target).animationName.split(/,\s*/).filter((name) => name !== "none");
      target.addEventListener("animationend", animationEnded);
      target.addEventListener("animationcancel", animationEnded);
      timer = setTimeout(end, SETTLE_MS);
    }
  };
  const check = () => {
    // Gone, hidden or still moving after all this time: nothing to show.
    if (!target.isConnected || !target.getClientRects().length || performance.now() - started > GIVE_UP_MS) return end();
    const box = target.getBoundingClientRect();
    still = last && Math.abs(box.top - last.top) < 0.5 && Math.abs(box.left - last.left) < 0.5 ? still + 1 : 0;
    last = box;
    if (still >= STILL_FRAMES && performance.now() - scrolledAt >= QUIET_MS) land();
    else frame = requestAnimationFrame(check);
  };

  current.set(attribute, end);
  // Waiting is only so the settle plays in view: without Web Animations (jsdom) none plays.
  if (smooth && typeof Element.prototype.animate === "function") {
    // Scroll events do not bubble; capturing on the document hears them from every scroller,
    // and `ours` keeps those the target is in.
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    document.addEventListener("scrollend", scrollEnded, { capture: true, passive: true });
    for (const type of INTERVENTIONS) document.addEventListener(type, end, { capture: true, passive: true });
    frame = requestAnimationFrame(check);
  } else land();
  return end;
}
