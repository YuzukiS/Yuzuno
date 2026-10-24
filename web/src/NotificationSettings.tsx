import { useCallback, useEffect, useState } from "react";
import { isNative } from "./api";
import {
  browserHost,
  notificationAccess,
  requestNotificationAccess,
  showSystemNotification,
  type NotificationAccess,
  type TestOutcome,
} from "./notification-access";
import { notificationCategories, type NotificationCategory, type NotificationPrefs } from "./notification-prefs";
import {
  changeNotificationPrefs,
  notificationPrefsStored,
  restoreDefaultNotificationPrefs,
  retryNotificationPrefsWrite,
  useNotificationPrefs,
  useNotificationPrefsWrite,
} from "./notification-store";
import { SaveStatus } from "./SaveStatus";
import "./notification-settings.css";

const kinds: Record<NotificationCategory, { title: string; help: string }> = {
  needsYou: { title: "An Agent needs you", help: "A request to approve or answer, or a new Ask on Home." },
  failed: { title: "A Turn failed", help: "An Agent stopped with an error." },
  finished: { title: "A Turn finished", help: "An Agent finished what it was doing." },
};

/** What this browser allows, in the user's words, with what to do about it. */
export function accessText(access: NotificationAccess): { label: string; help: string } {
  switch (access.state) {
    case "allowed":
      return { label: "Allowed", help: "This browser lets Yuzuno notify you from this site." };
    case "not-requested":
      return {
        label: "Not asked yet",
        help: "Turning notifications on, or sending a test, asks this browser. Nothing is asked before you do.",
      };
    case "denied":
      return {
        label: "Blocked",
        help: "This browser blocks notifications from this site. To allow them, change this site’s notification permission in the browser’s site settings, then come back here.",
      };
  }
  switch (access.reason) {
    case "app":
      return { label: "Not available in this app", help: "The desktop and iPhone apps can’t show system notifications yet. Yuzuno in a browser can." };
    case "insecure":
      return {
        label: "Not available on this page",
        help: "Browsers notify only from a secure page: an https:// address, or localhost. This page’s address isn’t one.",
      };
    case "page-only":
      return { label: "Not available in this browser", help: "This browser shows notifications only through a service worker, which Yuzuno doesn’t use." };
    case "no-api":
      return { label: "Not available in this browser", help: "This browser has no notifications for web pages." };
  }
}

const testText = (result: TestOutcome) => {
  switch (result.outcome) {
    case "shown":
      return "Your browser reports it was shown. If you didn’t see it, your system may be holding notifications back (Focus or Do Not Disturb).";
    case "unconfirmed":
      return "Sent, but your browser didn’t report it as shown within 5 seconds.";
    case "failed":
      return `Your browser couldn’t show it: ${result.message}`;
    case "refused":
      return `Not sent. ${accessText(result.access).help}`;
  }
};

/** What this browser allows now, read again when this window comes back
 * (the user may have changed it in the browser's settings meanwhile). */
function useNotificationAccess() {
  const read = useCallback(() => notificationAccess(browserHost(isNative)), []);
  const [access, setAccess] = useState(read);
  useEffect(() => {
    const again = () => setAccess(read());
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [read]);
  return [access, setAccess] as const;
}

/**
 * Notifications, one category of Settings (T-188): this device's system
 * notifications. What the browser allows is shown as it is and asked only
 * from the user's own click; the choices are this device's, and change
 * nothing the Workspace shows or delivers.
 */
export function NotificationSettings() {
  const prefs = useNotificationPrefs();
  const write = useNotificationPrefsWrite();
  const [access, setAccess] = useNotificationAccess();
  const [asking, setAsking] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const usable = access.state === "allowed" || access.state === "not-requested";
  const save = (next: Partial<NotificationPrefs>) => changeNotificationPrefs((now) => ({ ...now, ...next }));
  /** Asks the browser, from this click, when it has not been asked. */
  const ask = async () => {
    if (access.state !== "not-requested") return access;
    setAsking(true);
    try {
      const answer = await requestNotificationAccess(browserHost(isNative));
      setAccess(answer);
      return answer;
    } finally {
      setAsking(false);
    }
  };
  const turn = async (on: boolean) => {
    if (on && (await ask()).state !== "allowed") return;
    save({ enabled: on });
  };
  const sendTest = async () => {
    setTest(null);
    const allowed = await ask();
    const host = browserHost(isNative);
    const result =
      allowed.state === "allowed"
        ? await showSystemNotification("Yuzuno", { body: "A test notification from your Workspace.", tag: "yuzuno:test" }, host)
        : ({ outcome: "refused", access: allowed } as const);
    // A browser can turn out to refuse a page's notifications only now.
    setAccess(notificationAccess(host));
    setTest(result);
  };
  const state = accessText(access);
  const current = !usable ? state.label : !prefs.enabled ? "Off" : prefs.muted ? "Muted" : "On";
  return (
    <section id="settings-notifications" className="settings-section notification-settings" aria-label="Notification settings">
      <header className="settings-section-heading">
        <div>
          <h3>Notifications</h3>
          <p>
            System notifications on this device, while Yuzuno is open in a tab or window you aren’t looking at. Each
            device and browser has its own choices and its own permission.
          </p>
        </div>
        <span className="settings-current" title="In effect now">
          {current}
        </span>
      </header>
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">
              This browser’s permission <span className="notification-access" data-state={access.state}>{state.label}</span>
            </span>
            <span className="settings-row-help">{state.help}</span>
          </span>
        </div>
        {usable && (
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Notify me on this device</span>
              <span className="settings-row-help">
                {access.state === "not-requested"
                  ? "Turning this on asks this browser for permission first."
                  : "Only for what you choose below."}
              </span>
            </span>
            <input type="checkbox" checked={prefs.enabled && access.state === "allowed"} disabled={asking} onChange={(event) => void turn(event.target.checked)} />
          </label>
        )}
      </div>
      {usable && (
        <div className="settings-group" aria-label="What to notify about">
          {notificationCategories.map((kind) => (
            <label className="settings-row" key={kind}>
              <span className="settings-row-main">
                <span className="settings-row-title">{kinds[kind].title}</span>
                <span className="settings-row-help">{kinds[kind].help}</span>
              </span>
              <input
                type="checkbox"
                checked={prefs.categories[kind]}
                onChange={(event) => {
                  const on = event.target.checked;
                  changeNotificationPrefs((now) => ({ ...now, categories: { ...now.categories, [kind]: on } }));
                }}
              />
            </label>
          ))}
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Show what was written</span>
              <span className="settings-row-help">
                Off: only who and why. A notification can show on a locked screen.
              </span>
            </span>
            <input type="checkbox" checked={prefs.preview} onChange={(event) => save({ preview: event.target.checked })} />
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Mute on this device</span>
              <span className="settings-row-help">Keeps your choices. Agents, their mail and the Workspace are unchanged.</span>
            </span>
            <input type="checkbox" checked={prefs.muted} onChange={(event) => save({ muted: event.target.checked })} />
          </label>
        </div>
      )}
      {usable && (
        <div className="settings-group">
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">Test notification</span>
              <span className="settings-row-help">Sends one now, even while you’re looking, and shows what your browser reported.</span>
              {test && (
                <span className="settings-row-help notification-test-result" role="status" data-outcome={test.outcome}>
                  {testText(test)}
                </span>
              )}
            </span>
            <span className="settings-row-action">
              <button type="button" className="secondary-button" disabled={asking} onClick={() => void sendTest()}>
                Send a test
              </button>
            </span>
          </div>
        </div>
      )}
      <SaveStatus
        outcome={write?.outcome ?? null}
        action={write?.action}
        stored={notificationPrefsStored()}
        scope="this device"
        onRetry={() => retryNotificationPrefsWrite()}
        onRestoreDefaults={() => restoreDefaultNotificationPrefs()}
      />
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">Inside Yuzuno</span>
            <span className="settings-row-help">
              Needs you and unread updates always show in the Workspace, whatever you choose here. Messages between
              Agents are their own mail, not notifications to you.
            </span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">Not available</span>
            <span className="settings-row-help">
              Notifications while Yuzuno is closed, push notifications, and notification sounds or quiet hours of
              its own.
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
