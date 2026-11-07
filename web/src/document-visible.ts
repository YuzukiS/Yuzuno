import { useEffect, useState } from "react";

/** Whether the page is shown: false while its tab is hidden or its window
 * minimised (`document.visibilityState`). Polls that cost Core work pause on
 * it, as MachineWidget's and JobBudget's own readings do (T-60). */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const change = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  return visible;
}
