/**
 * Where what the user just sent to a Project lands (YN-226): the request's
 * block, or its follow-up's, marked once in the send button's colour; or,
 * where the block is not in sight, the page's notice above the composer
 * until it is. The motion itself is surface.ts `arriveIn`.
 */

/** The mark's attribute: its colour fades over --motion-settle (request-blocks.css, project-talk.css). */
export const ARRIVING = "data-arriving";

/** --motion-settle, read as drawn ("1200ms", or "1.2s" once built), and its fallback. */
function settleMs(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-settle").trim();
  const ms = value.endsWith("ms") ? parseFloat(value) : value.endsWith("s") ? parseFloat(value) * 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 1200;
}

/**
 * Whether `element` is in sight: what is drawn at two points of its head is
 * it, not a bar stuck over it, the keyboard or anything else, and inside its
 * scroller. Without layout (jsdom) nothing is in sight.
 */
export function inSight(element: HTMLElement): boolean {
  if (!element.isConnected || typeof document.elementFromPoint !== "function") return false;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  const y = box.top + Math.min(16, box.height / 2);
  return [box.left + Math.min(40, box.width / 2), box.left + box.width / 2].every((x) => {
    const hit = document.elementFromPoint(x, y);
    return !!hit && element.contains(hit);
  });
}

/** Marks `element` as just arrived, once: again from the start if it already was; taken off after --motion-settle. */
export function markArrived(element: HTMLElement): () => void {
  element.removeAttribute(ARRIVING);
  // Its colour starts again, not from where an earlier mark had it.
  void element.offsetWidth;
  element.setAttribute(ARRIVING, "");
  const timer = window.setTimeout(() => element.removeAttribute(ARRIVING), settleMs());
  return () => {
    window.clearTimeout(timer);
    element.removeAttribute(ARRIVING);
  };
}

/**
 * Calls `seen` once, when `element` comes into sight in `root` (the user
 * scrolled to it, or showed the view it is in). Returns how to stop
 * watching. Without IntersectionObserver it never does.
 */
export function whenInSight(element: HTMLElement, root: HTMLElement | null, seen: () => void): () => void {
  if (typeof IntersectionObserver !== "function") return () => {};
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || !inSight(element)) return;
      observer.disconnect();
      seen();
    },
    { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  observer.observe(element);
  return () => observer.disconnect();
}
