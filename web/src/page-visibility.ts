import { useSyncExternalStore } from "react";

/** Whether the page is hidden now (`document.visibilityState`), as a
 * WebView2 that is minimized reports it (YN-199). A window covered by others
 * but not minimized still counts as shown. */
export function usePageHidden() {
  return useSyncExternalStore(subscribe, () => document.visibilityState === "hidden", () => false);
}

function subscribe(changed: () => void) {
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("pageshow", changed);
  window.addEventListener("pagehide", changed);
  return () => {
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("pageshow", changed);
    window.removeEventListener("pagehide", changed);
  };
}
