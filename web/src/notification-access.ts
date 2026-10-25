/**
 * What this device's system lets the Workspace do with notifications, read
 * from the browser itself (T-188). A preference to be notified is not this:
 * it takes effect only where the system allows it.
 */
export type NotificationAccess =
  | { state: "unsupported"; reason: UnsupportedReason }
  | { state: "not-requested" }
  | { state: "allowed" }
  | { state: "denied" }
  /** The desktop app hands them to the system (T-188, Windows). Whether the
   * system then shows them is its own notification settings', which the app
   * cannot read: not "allowed", and nothing to ask. */
  | { state: "through-app" };
/**
 * - `app`: the desktop or iPhone app, where it has no system notifications
 *   (the iPhone app, the desktop app on a system not yet checked, or an
 *   older desktop app).
 * - `insecure`: browsers notify only from an https:// or localhost page.
 * - `no-api`: this browser has no notifications for web pages (Safari on an
 *   iPhone, outside a Home Screen app).
 * - `page-only`: the browser refused to show one from the page itself; it
 *   would need a service worker, which the Workspace does not have.
 */
export type UnsupportedReason = "app" | "insecure" | "no-api" | "page-only";

type NotificationApi = {
  readonly permission: string;
  requestPermission(callback?: (answer: string) => void): Promise<string> | undefined;
  new (title: string, options?: NotificationOptions): ShownNotification;
};
type ShownNotification = {
  onshow: (() => void) | null;
  onerror: (() => void) | null;
  onclick: (() => void) | null;
  close(): void;
};
/** The desktop app's way to the system's notifications, where it has one
 * (desktop-notifier.ts). It hands one on and says only whether it took it. */
export type DesktopNotifier = { notify(title: string, body: string): Promise<void> };

/** The parts of the browser this reads: the app passes the window's, a test its own. */
export type NotificationHost = {
  Notification?: NotificationApi;
  isSecureContext: boolean;
  /** The desktop or iPhone app rather than a browser. */
  native: boolean;
  /** In the desktop app, when it says it can notify on this system. */
  desktop?: DesktopNotifier | null;
  focus(): void;
};

export const browserHost = (native: boolean, desktop: DesktopNotifier | null = null): NotificationHost => ({
  Notification: (window as Window & { Notification?: NotificationApi }).Notification,
  isSecureContext: window.isSecureContext,
  native,
  desktop,
  focus: () => window.focus(),
});

/** Whether notifications go to the system now, by the browser's permission or through the app. */
export const reachesSystem = (access: NotificationAccess) => access.state === "allowed" || access.state === "through-app";

/** The desktop app takes at most this much (desktop/src/notification_text.rs). */
export const DESKTOP_TITLE_MAX = 120;
export const DESKTOP_BODY_MAX = 400;
/** Text the desktop app takes: shortened to its bound by characters, with
 * an ellipsis, and no control characters (a body keeps its line breaks). */
export function desktopText(text: string, max: number, lines = false): string {
  const plain = Array.from(text, (c) => (c === "\n" && lines ? c : /\p{Cc}/u.test(c) ? " " : c));
  return plain.length <= max ? plain.join("") : plain.slice(0, max - 1).join("") + "…";
}

// Learned from a refused test notification; it does not change on this page.
const pageOnly = new WeakSet<NotificationApi>();

export function notificationAccess(host: NotificationHost): NotificationAccess {
  if (host.native) return host.desktop ? { state: "through-app" } : { state: "unsupported", reason: "app" };
  if (!host.isSecureContext) return { state: "unsupported", reason: "insecure" };
  const api = host.Notification;
  if (!api || typeof api.requestPermission !== "function") return { state: "unsupported", reason: "no-api" };
  if (pageOnly.has(api)) return { state: "unsupported", reason: "page-only" };
  switch (api.permission) {
    case "granted":
      return { state: "allowed" };
    case "denied":
      return { state: "denied" };
    default:
      return { state: "not-requested" };
  }
}

/**
 * Asks the system, from the user's own click only. Once answered, it is not
 * asked again: a denial is changed in the browser's settings for this site.
 */
export async function requestNotificationAccess(host: NotificationHost): Promise<NotificationAccess> {
  const before = notificationAccess(host);
  if (before.state !== "not-requested") return before;
  const api = host.Notification as NotificationApi;
  await new Promise<void>((answered) => {
    try {
      // Older Safari answers only through the callback.
      const asked = api.requestPermission(() => answered());
      if (asked && typeof asked.then === "function") asked.then(() => answered(), () => answered());
    } catch {
      answered();
    }
  });
  return notificationAccess(host);
}

/**
 * What the browser reported about a notification it was asked to show:
 * - `shown`: it showed it. The system can still keep it out of sight (a
 *   Focus or do-not-disturb mode), which a page cannot see.
 * - `handed`: the desktop app handed it to the system, which reports
 *   nothing back: whether it was shown is not known.
 * - `unconfirmed`: no report within the wait.
 * - `failed`: it reported an error.
 * - `refused`: nothing was sent: this device does not allow it (see `access`).
 */
export type TestOutcome =
  | { outcome: "shown" }
  | { outcome: "handed" }
  | { outcome: "unconfirmed" }
  | { outcome: "failed"; message: string }
  | { outcome: "refused"; access: NotificationAccess };

export function showSystemNotification(
  title: string,
  options: NotificationOptions,
  host: NotificationHost,
  { waitMs = 5_000, opened }: { waitMs?: number; opened?: () => void } = {},
): Promise<TestOutcome> {
  const access = notificationAccess(host);
  if (access.state === "through-app" && host.desktop) {
    // No click reaches the page from there: `opened` is not used (T-188).
    return host.desktop
      .notify(desktopText(title, DESKTOP_TITLE_MAX), desktopText(options.body ?? "", DESKTOP_BODY_MAX, true))
      .then(
        (): TestOutcome => ({ outcome: "handed" }),
        (error): TestOutcome => ({ outcome: "failed", message: error instanceof Error ? error.message : String(error) }),
      );
  }
  if (access.state !== "allowed") return Promise.resolve({ outcome: "refused", access });
  const api = host.Notification as NotificationApi;
  return new Promise((resolve) => {
    let shown: ShownNotification;
    try {
      shown = new api(title, options);
    } catch (error) {
      // Chrome on Android, for one, allows notifications but not from a page.
      if (error instanceof TypeError) {
        pageOnly.add(api);
        resolve({ outcome: "refused", access: notificationAccess(host) });
      } else resolve({ outcome: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => resolve({ outcome: "unconfirmed" }), waitMs);
    shown.onshow = () => {
      clearTimeout(timer);
      resolve({ outcome: "shown" });
    };
    shown.onerror = () => {
      clearTimeout(timer);
      resolve({ outcome: "failed", message: "The browser reported an error showing it." });
    };
    shown.onclick = () => {
      host.focus();
      opened?.();
      shown.close();
    };
  });
}
