/** Whether a way out is worth keeping something on screen for (T-19): not
    under reduced motion, and not without Web Animations (jsdom), where
    nothing would play and it would only linger. */
export function animates(): boolean {
  return typeof Element.prototype.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
