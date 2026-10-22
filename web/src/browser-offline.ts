import { useEffect, useState } from "react";

/** Calls `offline` and `online` when the browser reports its network going
 * or coming back (navigator.onLine changing). Returns the function that stops
 * listening (T-170). */
export function watchBrowserNetwork(handlers: { offline?: () => void; online?: () => void }) {
  const offline = () => handlers.offline?.();
  const online = () => handlers.online?.();
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  return () => {
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", online);
  };
}

/** Whether the browser reports being offline (navigator.onLine). A guess that
 * can be wrong either way, so it is shown and never disables anything (T-170). */
export function useBrowserOffline() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    update();
    return watchBrowserNetwork({ offline: update, online: update });
  }, []);
  return offline;
}
