import { useEffect, useState } from "react";

/**
 * What the app actually has to lay out in: its own content box, so a system
 * control area at the side (`--safe-*`, styles.css, which `.app` carries as
 * padding) is already out of it.
 *
 * Reading `window.innerWidth` instead counts that area as usable, and every
 * width decided from it is then too large by it — on the folded-out Duo the
 * window says 951 where the app has 867. The Portal has read the content box
 * since T-15; the panel widths did not, and chose their rail and their
 * minimum for the conversation from a window 84px wider than the room.
 *
 * Before the app has been laid out there is no content box to read, and a
 * width of zero would read as no room for anything; the window is what the
 * insets are taken from, so it is the estimate to fall back to.
 */
export function appRoom(element?: HTMLElement | null): number {
  if (typeof window === "undefined") return 0;
  const app = element ?? document.querySelector<HTMLElement>(".app");
  if (!app) return window.innerWidth;
  const style = getComputedStyle(app);
  const side = (value: string) => {
    const px = parseFloat(value);
    return Number.isFinite(px) ? px : 0;
  };
  const inset = side(style.paddingLeft) + side(style.paddingRight);
  return (app.clientWidth > 0 ? app.clientWidth : window.innerWidth) - inset;
}

/**
 * The same, kept current, with the window beside it. A window resize is not
 * the only way the room changes: the insets themselves change when a device
 * is folded or turned, and that moves `.app`'s padding without the window
 * changing at all, so the element is watched as well where the browser can.
 *
 * Both are returned because the two answer different questions. How wide a
 * panel is, and the least the conversation keeps, are about the room. Whether
 * the app shows one thing at a time at all is about the window: that handover
 * is shared with `phone-layout.ts` and with the `max-width: 520px` rules
 * spread through the stylesheets, and a shell that crossed it on its own
 * would disagree with every one of them.
 */
export function useAppRoom(): { room: number; viewport: number } {
  const [size, setSize] = useState(() => ({ room: appRoom(), viewport: window.innerWidth }));
  useEffect(() => {
    const read = () =>
      setSize((was) => {
        const next = { room: appRoom(), viewport: window.innerWidth };
        return was.room === next.room && was.viewport === next.viewport ? was : next;
      });
    read();
    window.addEventListener("resize", read);
    const app = document.querySelector<HTMLElement>(".app");
    // Somewhere without one, the resize is the only signal, as the
    // conversation's own layout does (ConversationWindow, useAutoRead).
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null;
    if (app && watch) watch.observe(app);
    return () => {
      window.removeEventListener("resize", read);
      watch?.disconnect();
    };
  }, []);
  return size;
}
