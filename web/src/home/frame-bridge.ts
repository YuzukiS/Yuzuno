import { useCallback, useEffect, useRef, type RefObject } from "react";
import { readFrameMessage, themeMessage } from "../intelligent-ui/page-bridge";

// The page bridge's messages and limits are in intelligent-ui/page-bridge.ts.

/**
 * Connects one frame while it shows the page it first loaded (`live`): reads
 * its messages, and gives it the theme as it changes. Returns what the frame's
 * first load calls to give it the theme then.
 */
export function useFrameBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  live: boolean,
  on: { send(text: string): void; height?(px: number): void },
) {
  const handlers = useRef(on);
  handlers.current = on;
  const last = useRef("");
  const give = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    const message = themeMessage();
    last.current = JSON.stringify(message);
    // An opaque origin can only be named "*"; the theme is no secret.
    target.postMessage(message, "*");
  }, [frame]);
  useEffect(() => {
    if (!live) return;
    let pending: number | null = null;
    let scheduled = 0;
    const listen = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own || event.origin !== "null") return;
      const message = readFrameMessage(event.data);
      if (!message) return;
      if (message.kind === "send") {
        handlers.current.send(message.text);
        return;
      }
      if (!handlers.current.height) return;
      // The newest height wins, applied once per frame: a page that answers
      // its own resize cannot shake the card faster than it draws.
      pending = message.px;
      scheduled ||= requestAnimationFrame(() => {
        scheduled = 0;
        if (pending !== null) handlers.current.height?.(pending);
      });
    };
    window.addEventListener("message", listen);
    const watch = new MutationObserver(() => {
      if (JSON.stringify(themeMessage()) !== last.current) give();
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    return () => {
      window.removeEventListener("message", listen);
      watch.disconnect();
      if (scheduled) cancelAnimationFrame(scheduled);
    };
  }, [live, frame, give]);
  return give;
}
