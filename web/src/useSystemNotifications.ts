import { useEffect, useRef, useState } from "react";
import { api, isNative } from "./api";
import type { NeedsYouItem } from "./home/types";
import { knownDesktopNotifier, readDesktopNotifier } from "./desktop-notifier";
import { browserHost, notificationAccess, reachesSystem, showSystemNotification } from "./notification-access";
import { agentNotices, askNotices, backupNotice, merged, type AgentState, type BackupRun, type Notice } from "./notification-events";
import { notifies } from "./notification-prefs";
import { useNotificationPrefs } from "./notification-store";

/** Only while the user is looking elsewhere: in view, the Workspace shows it itself. */
const away = () => document.visibilityState === "hidden" || !document.hasFocus();

/**
 * The daily backup's last run, read when Core says it changed (`revision`),
 * only while a failure of it would be notified on this device (T-196): the
 * kind chosen, not muted, and allowed. Otherwise nothing is read, and
 * `undefined` is returned, so the next read starts afresh.
 */
export function useBackupRun(revision: number, enabled = true): BackupRun | null | undefined {
  const prefs = useNotificationPrefs();
  const wanted =
    enabled && prefs.enabled && !prefs.muted && prefs.categories.backupFailed && reachesSystem(notificationAccess(browserHost(isNative, knownDesktopNotifier())));
  const [run, setRun] = useState<BackupRun | null | undefined>(undefined);
  useEffect(() => {
    if (!wanted) {
      setRun(undefined);
      return;
    }
    let current = true;
    api<{ lastRun: BackupRun | null }>("/workspace/backup/last-run").then(
      (read) => current && setRun(read.lastRun ?? null),
      // A read that fails changes nothing: the next one compares with the last.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted, revision]);
  return wanted ? run : undefined;
}

/**
 * Shows this device's system notifications for what changed between the
 * Workspace's reads (T-188): the Agent list, the Asks in Home's Needs you,
 * and the daily backup's last run (T-196). It shows them only where this
 * device chose them and its system allows them, and asks the system
 * nothing; it sends nothing to Core.
 */
export function useSystemNotifications(
  workspaceId: string,
  agents: AgentState[] | undefined,
  asks: NeedsYouItem[] | null,
  open: (notice: Notice) => void,
  backup?: BackupRun | null,
) {
  const chosen = useNotificationPrefs();
  const prefs = useRef(chosen);
  prefs.current = chosen;
  const opener = useRef(open);
  opener.current = open;
  // The desktop app says once whether it can notify here (T-188).
  useEffect(() => void readDesktopNotifier(), []);
  // The last reads compared with, per Workspace: another one starts afresh.
  // `backup` is undefined until a read; `shown` holds the backup notices
  // this page showed, each once, whatever the reads after.
  type Seen = { workspaceId: string; agents: AgentState[] | null; asks: NeedsYouItem[] | null; backup: BackupRun | null | undefined; shown: Set<string> };
  const fresh = (): Seen => ({ workspaceId, agents: null, asks: null, backup: undefined, shown: new Set() });
  const last = useRef<Seen>(fresh());
  const before = () => {
    if (last.current.workspaceId !== workspaceId) last.current = fresh();
    return last.current;
  };
  /** `inView`: also while the user is looking, for what the Workspace in
   * view does not show itself (a backup's failure shows only in Settings). */
  const show = (notices: Notice[], inView = false) => {
    const now = prefs.current;
    if (!now.enabled || now.muted || !notices.length) return;
    const host = browserHost(isNative, knownDesktopNotifier());
    const access = notificationAccess(host);
    const wanted = notices.filter((notice) => notifies(now, access, notice.kind));
    if (!wanted.length || (!inView && !away())) return;
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
  useEffect(() => {
    const seen = before();
    const notice = backup === undefined ? null : backupNotice(workspaceId, seen.backup, backup);
    seen.backup = backup;
    if (!notice || seen.shown.has(notice.tag)) return;
    seen.shown.add(notice.tag);
    show([notice], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, backup]);
}
