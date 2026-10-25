import { useEffect, useState } from "react";
import { desktopShell } from "./DesktopUpdate";
import type { DesktopNotifier } from "./notification-access";

/**
 * The desktop app's own system notifications (T-188), as it says it has them
 * on this system: its `desktop_notifications` answer, read once per page.
 * An older desktop app, or the iPhone app, has no such command and answers
 * nothing usable: it stays "not available in this app". Nothing is shown,
 * asked or changed by reading it.
 */
type Answer = { supported?: unknown };

let known: DesktopNotifier | null = null;
let reading: Promise<DesktopNotifier | null> | null = null;

/** What is known now: null until the app has said it can. */
export const knownDesktopNotifier = () => known;

/** Reads the app's answer, once; a browser has none to read. */
export function readDesktopNotifier(): Promise<DesktopNotifier | null> {
  const invoke = desktopShell.invoke();
  if (!invoke) return Promise.resolve(null);
  reading ??= invoke("desktop_notifications").then(
    (answer) => {
      if ((answer as Answer | null)?.supported !== true) return null;
      known = { notify: (title, body) => invoke("desktop_notify", { title, body }).then(() => undefined) };
      return known;
    },
    () => null,
  );
  return reading;
}

/** The desktop app's notifier for a component: null until (and unless) it says it has one. */
export function useDesktopNotifier(): DesktopNotifier | null {
  const [notifier, setNotifier] = useState(known);
  useEffect(() => {
    let current = true;
    void readDesktopNotifier().then((read) => current && setNotifier(read));
    return () => {
      current = false;
    };
  }, []);
  return notifier;
}
