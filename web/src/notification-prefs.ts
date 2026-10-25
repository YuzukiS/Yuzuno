import type { NotificationAccess } from "./notification-access";

/**
 * This device's choices about system notifications (T-188). They are kept
 * on this device only: another device, or another browser here, has its own,
 * as it has its own permission from its system.
 *
 * They decide only what this device shows. Muting it, or turning a kind off,
 * changes nothing the Workspace delivers: Agents' mail, Needs you and the
 * conversations are the same.
 */
export type NotificationCategory = "needsYou" | "failed" | "finished" | "backupFailed";
export type NotificationPrefs = {
  /** Notify through the system on this device. Off until the user turns it on. */
  enabled: boolean;
  /** Which kinds: an Agent needs you (a request or an Ask), a Turn failed,
   * a Turn finished, the daily backup failed (T-196; off until chosen, also
   * where the others are on). */
  categories: Record<NotificationCategory, boolean>;
  /** Show what was written, or only who and why. Off: the system can show a
   * notification on a locked screen. */
  preview: boolean;
  /** Muted on this device until turned back on; the choices above are kept. */
  muted: boolean;
};

export const NOTIFICATION_PREFS_KEY = "yuzuno.notifications";
export const notificationCategories: NotificationCategory[] = ["needsYou", "failed", "finished", "backupFailed"];
export const defaultNotificationPrefs: NotificationPrefs = {
  enabled: false,
  categories: { needsYou: true, failed: true, finished: true, backupFailed: false },
  preview: false,
  muted: false,
};

const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** A saved value as choices: each one it holds as a choice, the default for the rest. */
export function parseNotificationPrefs(saved: unknown): NotificationPrefs {
  const value = saved && typeof saved === "object" ? (saved as Partial<Record<keyof NotificationPrefs, unknown>>) : {};
  const kinds = value.categories && typeof value.categories === "object" ? (value.categories as Record<string, unknown>) : {};
  return {
    enabled: flag(value.enabled, defaultNotificationPrefs.enabled),
    categories: Object.fromEntries(
      notificationCategories.map((kind) => [kind, flag(kinds[kind], defaultNotificationPrefs.categories[kind])]),
    ) as Record<NotificationCategory, boolean>,
    preview: flag(value.preview, defaultNotificationPrefs.preview),
    muted: flag(value.muted, defaultNotificationPrefs.muted),
  };
}

/** Whether this kind goes to the system now: chosen, not muted, and allowed. */
export const notifies = (prefs: NotificationPrefs, access: NotificationAccess, kind: NotificationCategory) =>
  prefs.enabled && !prefs.muted && prefs.categories[kind] && access.state === "allowed";
