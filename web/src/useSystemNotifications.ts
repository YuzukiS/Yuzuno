import { useEffect, useRef, useSyncExternalStore } from "react";
import { isNative } from "./api";
import type { NeedsYouItem } from "./home/types";
import { browserHost, notificationAccess, showSystemNotification } from "./notification-access";
import { agentNotices, askNotices, merged, type AgentState, type Notice } from "./notification-events";
import { NOTIFICATION_PREFS_KEY, notifies, parseNotificationPrefs, type NotificationPrefs } from "./notification-prefs";

// This device's choices, read once, then again when another window saves them.
const listeners = new Set<() => void>();
let current: NotificationPrefs | null = null;
function readPrefs(): NotificationPrefs {
  try {
    return parseNotificationPrefs(JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY) ?? "null"));
  } catch {
    return parseNotificationPrefs(null);
  }
}
window.addEventListener("storage", (event) => {
  if (event.key !== NOTIFICATION_PREFS_KEY && event.key !== null) return;
  current = null;
  listeners.forEach((listener) => listener());
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useNotificationPrefs = () => useSyncExternalStore(subscribe, () => (current ??= readPrefs()));

/** Only while the user is looking elsewhere: in view, the Workspace shows it itself. */
const away = () => document.visibilityState === "hidden" || !document.hasFocus();

/**
 * Shows this device's system notifications for what changed between the
 * Workspace's reads (T-188): the Agent list, and the Asks in Home's Needs
 * you. It shows them only where this device chose them and its system
 * allows them, and asks the system nothing; it sends nothing to Core.
 */
export function useSystemNotifications(
  workspaceId: string,
  agents: AgentState[] | undefined,
  asks: NeedsYouItem[] | null,
  open: (notice: Notice) => void,
) {
  const chosen = useNotificationPrefs();
  const prefs = useRef(chosen);
  prefs.current = chosen;
  const opener = useRef(open);
  opener.current = open;
  // The last reads compared with, per Workspace: another one starts afresh.
  const last = useRef<{ workspaceId: string; agents: AgentState[] | null; asks: NeedsYouItem[] | null }>({ workspaceId, agents: null, asks: null });
  const before = () => {
    if (last.current.workspaceId !== workspaceId) last.current = { workspaceId, agents: null, asks: null };
    return last.current;
  };
  const show = (notices: Notice[]) => {
    const now = prefs.current;
    if (!now.enabled || now.muted || !notices.length) return;
    const host = browserHost(isNative);
    const access = notificationAccess(host);
    const wanted = notices.filter((notice) => notifies(now, access, notice.kind));
    if (!wanted.length || !away()) return;
    for (const notice of merged(wanted))
      void showSystemNotification(notice.title, { body: notice.body, tag: notice.tag }, host, { opened: () => opener.current(notice) });
  };
  useEffect(() => {
    if (!agents) return;
    const seen = before();
    const notices = agentNotices(seen.agents, agents, prefs.current.preview);
    seen.agents = agents;
    show(notices);
    // Each read of the list, and only that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, agents]);
  useEffect(() => {
    if (!asks) return;
    const seen = before();
    const notices = askNotices(seen.asks, asks, prefs.current.preview);
    seen.asks = asks;
    show(notices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, asks]);
}
