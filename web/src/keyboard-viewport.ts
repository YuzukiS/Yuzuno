/**
 * A phone's on-screen keyboard (T-170). The phone shell is 100dvh tall, and
 * the keyboard does not change that. Measured in Mobile Safari (iOS 26.5
 * Simulator, run 40061280002; T-170 comment 6610), focusing the composer
 * scrolled the whole document by 337 px, so the toolbar went above the
 * screen. After a rotation with the keyboard still open, the focused
 * composer stayed under the keyboard.
 *
 * While the phone layout is shown, and the visual viewport is shorter than
 * 100dvh (the keyboard, or anything else covering the bottom), this sets
 * --visual-height on the root to the visual viewport's height and marks the
 * root data-keyboard. The shell's CSS then fits what is left. It also
 * scrolls the document back to its top, where the shell is, at most once per
 * change of the visual viewport's size, so a scroll Safari makes again to
 * keep the caret in view is not fought. Otherwise neither is set, and the
 * shell is 100dvh as before. A pinch zoom shrinks the visual viewport too;
 * then nothing is changed.
 */
export function followVisualViewport(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const root = win.document.documentElement;
  // 100dvh in pixels, as the shell would be without a keyboard.
  const probe = win.document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:100dvh;visibility:hidden;pointer-events:none";
  win.document.body.append(probe);
  let frame = 0;
  // Visual viewport size changes seen, and the one the last scroll back was for.
  let resizes = 0;
  let scrolledFor = -1;
  const clear = () => {
    root.style.removeProperty("--visual-height");
    root.removeAttribute("data-keyboard");
  };
  const update = () => {
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    const full = probe.getBoundingClientRect().height;
    const visible = Math.max(0, Math.round(viewport.height));
    if (visible >= full - 1) return clear();
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
  viewport.addEventListener("resize", resized);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", resized);
    viewport.removeEventListener("scroll", update);
    win.cancelAnimationFrame(frame);
    probe.remove();
    clear();
  };
}
