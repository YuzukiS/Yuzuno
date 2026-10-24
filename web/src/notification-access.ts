/**
 * What this device's system lets the Workspace do with notifications, read
 * from the browser itself (T-188). A preference to be notified is not this:
 * it takes effect only where the system allows it.
 */
export type NotificationAccess =
  | { state: "unsupported"; reason: UnsupportedReason }
  | { state: "not-requested" }
  | { state: "allowed" }
  | { state: "denied" };
/**
 * - `app`: the desktop or iPhone app, which has no system notifications yet.
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
/** The parts of the browser this reads: the app passes the window's, a test its own. */
export type NotificationHost = {
  Notification?: NotificationApi;
  isSecureContext: boolean;
  /** The desktop or iPhone app rather than a browser. */
  native: boolean;
  focus(): void;
};

export const browserHost = (native: boolean): NotificationHost => ({
  Notification: (window as Window & { Notification?: NotificationApi }).Notification,
  isSecureContext: window.isSecureContext,
  native,
  focus: () => window.focus(),
});

// Learned from a refused test notification; it does not change on this page.
const pageOnly = new WeakSet<NotificationApi>();

export function notificationAccess(host: NotificationHost): NotificationAccess {
  if (host.native) return { state: "unsupported", reason: "app" };
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
 * - `unconfirmed`: no report within the wait.
 * - `failed`: it reported an error.
 * - `refused`: nothing was sent: this device does not allow it (see `access`).
 */
export type TestOutcome =
  | { outcome: "shown" }
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
