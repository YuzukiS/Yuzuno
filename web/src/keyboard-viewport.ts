/**
 * A phone's on-screen keyboard (T-170). The phone shell is 100dvh tall, and
 * the keyboard does not change that. Measured in Mobile Safari (iOS 26.5
 * Simulator, run 40061280002; T-170 comments 6605 and 6610), focusing the
 * composer scrolled the whole document by 337 px, so the toolbar left the
 * screen. After a rotation sideways and back with the keyboard still open,
 * the focused composer stayed below the 377 px the keyboard leaves.
 *
 * While the phone layout is shown, this sets --visual-height on the root to
 * the visual viewport's height and marks the root data-keyboard; the shell's
 * CSS then fits what is left. It does that only while the keyboard is
 * plainly up:
 * - a text field has focus;
 * - the page is not zoomed;
 * - the visual viewport is shorter than 100dvh by more than a browser's own
 *   bars take.
 * Heights that are not finite and positive (sideways Safari reported -12)
 * are ignored, and the last valid one is kept. In that state it also scrolls
 * the document back to its top, where the shell is, at most once per change
 * of the visual viewport's size, so a scroll Safari makes again to keep the
 * caret in view is not fought. Otherwise nothing is set and the shell is
 * 100dvh as before.
 */
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
// A keyboard takes far more than this; Safari's bars take less.
const KEYBOARD_MIN = 120;

export function followVisualViewport(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const doc = win.document;
  const root = doc.documentElement;
  // 100dvh in pixels, as the shell would be without a keyboard.
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
  doc.body.append(probe);
  let visible = 0;
  let frame = 0;
  let stopped = false;
  // Visual viewport size changes seen, and the one the last scroll back was for.
  let resizes = 0;
  let scrolledFor = -1;
  const editing = () => {
    const active = doc.activeElement;
    return !!active && active !== doc.body && active.matches(EDITABLE);
  };
  const clear = () => {
    root.style.removeProperty("--visual-height");
    root.removeAttribute("data-keyboard");
  };
  const update = () => {
    if (stopped) return;
    const height = viewport.height;
    if (Number.isFinite(height) && height > 0) visible = Math.round(height);
    const full = probe.getBoundingClientRect().height;
    const keyboard = visible > 0 && editing() && Math.abs(viewport.scale - 1) <= 0.01 && full - visible > KEYBOARD_MIN;
    if (!keyboard) return clear();
    root.style.setProperty("--visual-height", `${visible}px`);
    root.setAttribute("data-keyboard", "");
    if ((win.scrollY > 0 || viewport.offsetTop > 0) && scrolledFor !== resizes) {
      scrolledFor = resizes;
      win.cancelAnimationFrame(frame);
      frame = win.requestAnimationFrame(() => win.scrollTo(0, 0));
    }
  };
  const resized = () => {
    resizes += 1;
    update();
  };
  // Focus has moved by the time a microtask runs.
  const focusMoved = () => queueMicrotask(update);
  viewport.addEventListener("resize", resized);
  viewport.addEventListener("scroll", update);
  doc.addEventListener("focusin", focusMoved);
  doc.addEventListener("focusout", focusMoved);
  update();
  return () => {
    stopped = true;
    viewport.removeEventListener("resize", resized);
    viewport.removeEventListener("scroll", update);
    doc.removeEventListener("focusin", focusMoved);
    doc.removeEventListener("focusout", focusMoved);
    win.cancelAnimationFrame(frame);
    probe.remove();
    clear();
  };
}
