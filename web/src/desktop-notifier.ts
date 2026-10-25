import { useEffect, useState } from "react";
import { desktopShell } from "./DesktopUpdate";
import type { DesktopAuthorization, DesktopNotifier } from "./notification-access";

/**
 * The desktop app's own system notifications (T-188), as it says it has them
 * on this system: its `desktop_notifications` answer. On Windows it is read
 * once per page. On macOS it holds what macOS allows the app, so it is read
 * again when this window comes back (the user may have changed it in System
 * Settings meanwhile), after asking macOS, and after macOS refused one; the
 * app reads it again itself before sending any. An older desktop app, or the
 * iPhone app, has no such command and answers nothing usable: it stays "not
 * available in this app". Nothing is shown, asked or changed by reading it.
 */
type Answer = { supported?: unknown; system?: unknown; authorization?: unknown; reason?: unknown };
type Invoke = NonNullable<ReturnType<typeof desktopShell.invoke>>;

const authorizations: DesktopAuthorization[] = ["not-requested", "allowed", "quiet", "denied", "unknown"];

let known: DesktopNotifier | null = null;
let reading: Promise<DesktopNotifier | null> | null = null;
const listeners = new Set<(notifier: DesktopNotifier | null) => void>();
let watching = false;

/** What is known now: null until the app has said it can. */
export const knownDesktopNotifier = () => known;

function settle(invoke: Invoke, answer: unknown): DesktopNotifier | null {
  known = notifier(invoke, answer as Answer | null);
  if (known?.macos) watch();
  for (const listener of listeners) listener(known);
  return known;
}

function notifier(invoke: Invoke, answer: Answer | null): DesktopNotifier | null {
  const macos = answer?.system === "macos";
  if (!macos && answer?.supported !== true) return null;
  // Whether it handed it on: `handed: false` is one held back while the window is in front.
  const notify: DesktopNotifier["notify"] = (title, body, whenAway) =>
    invoke("desktop_notify", { title, body, whenAway }).then(
      (answer) => (answer as { handed?: unknown } | null)?.handed !== false,
      (error) => {
        // macOS may no longer allow them.
        if (macos) void refreshDesktopNotifier();
        throw error;
      },
    );
  if (!macos) return { notify };
  return {
    notify,
    macos: {
      authorization: authorizations.find((word) => word === answer?.authorization) ?? "unknown",
      reason: typeof answer?.reason === "string" ? answer.reason : undefined,
      request: () => invoke("desktop_notifications_request").then((answer) => settle(invoke, answer)),
    },
  };
}

function watch() {
  if (watching) return;
  watching = true;
  const again = () => {
    if (document.visibilityState === "visible") void refreshDesktopNotifier();
  };
  window.addEventListener("focus", again);
  document.addEventListener("visibilitychange", again);
}

/** Reads the app's answer, once; a browser has none to read. */
export function readDesktopNotifier(): Promise<DesktopNotifier | null> {
  return (reading ??= refreshDesktopNotifier());
}

/** Reads the app's answer again. */
export function refreshDesktopNotifier(): Promise<DesktopNotifier | null> {
  const invoke = desktopShell.invoke();
  if (!invoke) return Promise.resolve(null);
  reading = invoke("desktop_notifications").then(
    (answer) => settle(invoke, answer),
    () => settle(invoke, null),
  );
  return reading;
}

/** The desktop app's notifier for a component, as it last said: null until (and unless) it says it has one. */
export function useDesktopNotifier(): DesktopNotifier | null {
  const [notifier, setNotifier] = useState(known);
  useEffect(() => {
    let current = true;
    const listener = (read: DesktopNotifier | null) => current && setNotifier(read);
    listeners.add(listener);
    void readDesktopNotifier().then(listener);
    return () => {
      current = false;
      listeners.delete(listener);
    };
  }, []);
  return notifier;
}
