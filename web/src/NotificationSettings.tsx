import { useCallback, useEffect, useState } from "react";
import { isNative } from "./api";
import { knownDesktopNotifier, useDesktopNotifier } from "./desktop-notifier";
import {
  browserHost,
  notificationAccess,
  reachesSystem,
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
import { strings, useLanguage, type Language } from "./i18n";
import "./notification-settings.css";

type Kind = { title: string; help: string };
type Access = { label: string; help: string };
// The settings' own words (T-189). What a notification itself says, the test
// one included, stays in English (notification-events.ts).
const text = strings({
  kinds: {
    needsYou: { title: "An Agent needs you", help: "A request to approve or answer, or a new Ask on Home." },
    failed: { title: "A Turn failed", help: "An Agent stopped with an error." },
    finished: { title: "A Turn finished", help: "An Agent finished what it was doing." },
    backupFailed: {
      title: "A daily backup failed",
      help: "It failed, was cut off when Core stopped, or couldn’t start. Also while you’re looking at Yuzuno, but only while it’s open in this browser: never while the page is closed, and possibly late after the computer sleeps. It names no folder or error; Settings → Backup shows the last run and why.",
    },
  } as Record<NotificationCategory, Kind>,
  access: {
    allowed: { label: "Allowed", help: "This browser lets Yuzuno notify you from this site." },
    "not-requested": {
      label: "Not asked yet",
      help: "Turning notifications on, or sending a test, asks this browser. Nothing is asked before you do.",
    },
    denied: {
      label: "Blocked",
      help: "This browser blocks notifications from this site. To allow them, change this site’s notification permission in the browser’s site settings, then come back here.",
    },
    "through-app": {
      label: "Through this app",
      help: "This app hands notifications to Windows. Whether Windows shows them is up to its notification settings and Focus, which this app can’t read.",
    },
    app: {
      label: "Not available in this app",
      help: "This app can’t show system notifications here yet: the iPhone app, the desktop app on Linux, and older desktop apps. Yuzuno in a browser can.",
    },
    insecure: {
      label: "Not available on this page",
      help: "Browsers notify only from a secure page: an https:// address, or localhost. This page’s address isn’t one.",
    },
    "page-only": { label: "Not available in this browser", help: "This browser shows notifications only through a service worker, which Yuzuno doesn’t use." },
    "no-api": { label: "Not available in this browser", help: "This browser has no notifications for web pages." },
  } as Record<"allowed" | "not-requested" | "denied" | "through-app" | "app" | "insecure" | "page-only" | "no-api", Access>,
  // The desktop app on macOS, as macOS told it (T-188).
  macos: {
    allowed: {
      label: "Allowed",
      help: "macOS allows this app’s notifications. How they show is up to System Settings → Notifications → Yuzuno, and Focus.",
    },
    quiet: {
      label: "Allowed quietly",
      help: "macOS delivers this app’s notifications quietly: to Notification Center, without a banner or sound. To change that: System Settings → Notifications → Yuzuno.",
    },
    "not-requested": {
      label: "Not asked yet",
      help: "Turning notifications on, or sending a test, asks macOS once. Nothing is asked before you do.",
    },
    denied: {
      label: "Off in macOS",
      help: "macOS doesn’t allow this app’s notifications, and this app won’t ask again. To allow them: System Settings → Notifications → Yuzuno, then come back here. Your choices below are kept.",
    },
  } as Record<"allowed" | "quiet" | "not-requested" | "denied", Access>,
  unread: (detail?: string): Access => ({
    label: "Not available now",
    help: `This app couldn’t tell whether macOS allows its notifications: ${detail ?? "macOS gave an answer this app doesn’t know"}.`,
  }),
  shown: "Your browser reports it was shown. If you didn’t see it, your system may be holding notifications back (Focus or Do Not Disturb).",
  handed: "Handed to Windows. Windows doesn’t tell this app whether it showed it: if you didn’t see it, check Windows notification settings and Focus.",
  handedMacos: "Accepted by macOS. If you didn’t see it, check this app in System Settings → Notifications, and Focus.",
  handedQuiet: "Accepted by macOS, which delivers this app’s notifications quietly: to Notification Center, without a banner or sound.",
  held: "Not sent: this app’s window was in front.",
  unconfirmed: "Sent, but your browser didn’t report it as shown within 5 seconds.",
  failed: (message: string) => `Your browser couldn’t show it: ${message}`,
  failedApp: (system: string, message: string) => `This app couldn’t hand it to ${system}: ${message}`,
  askFailed: (message: string) => `macOS didn’t ask: ${message}.`,
  refused: (help: string) => `Not sent. ${help}`,
  off: "Off",
  muted: "Muted",
  on: "On",
  section: "Notification settings",
  title: "Notifications",
  intro:
    "System notifications on this device, while Yuzuno is open in a tab or window you aren’t looking at. Each device and browser has its own choices and its own permission.",
  current: "In effect now",
  permission: "This browser’s permission",
  systemRow: "System notifications",
  notify: "Notify me on this device",
  asksFirst: "Turning this on asks this browser for permission first.",
  asksMacos: "Turning this on asks macOS first.",
  chosenOnly: "Only for what you choose below.",
  afterMacos: "Kept for when macOS allows this app’s notifications.",
  what: "What to notify about",
  preview: "Show what was written",
  previewHelp: "Off: only who and why. A notification can show on a locked screen.",
  mute: "Mute on this device",
  muteHelp: "Keeps your choices. Agents, their mail and the Workspace are unchanged.",
  test: "Test notification",
  testHelp: "Sends one now, even while you’re looking, and shows what your browser reported.",
  testHelpApp: (system: string) => `Sends one now, even while you’re looking. This app can tell only whether ${system} took it.`,
  sendTest: "Send a test",
  inside: "Inside Yuzuno",
  insideHelp:
    "Needs you and unread updates always show in the Workspace, whatever you choose here. Messages between Agents are their own mail, not notifications to you.",
  unavailable: "Not available",
  unavailableHelp: "Notifications while Yuzuno is closed, push notifications, and notification sounds or quiet hours of its own.",
}, {
  kinds: {
    needsYou: { title: "有 Agent 需要你", help: "需要你批准或回答的请求，或 Home 上新的 Ask。" },
    failed: { title: "Turn 失败", help: "某个 Agent 因错误而停止。" },
    finished: { title: "Turn 完成", help: "某个 Agent 完成了它正在做的事。" },
    backupFailed: {
      title: "每日备份失败",
      help: "备份失败、在 Core 停止时被中断，或没能开始。你正在看 Yuzuno 时也会通知，但仅限它在此浏览器中打开时：页面关闭时从不通知，电脑睡眠后可能延迟。通知中不写文件夹或错误；设置中的“Workspace 备份与恢复”会显示上次运行及原因。",
    },
  },
  access: {
    allowed: { label: "已允许", help: "此浏览器允许 Yuzuno 从此网站向你发送通知。" },
    "not-requested": { label: "尚未询问", help: "开启通知或发送测试时，会询问此浏览器。在你这样做之前不会询问。" },
    denied: {
      label: "已阻止",
      help: "此浏览器阻止了此网站的通知。如需允许，请在浏览器的网站设置中更改此网站的通知权限，然后回到这里。",
    },
    "through-app": {
      label: "通过此应用",
      help: "此应用会把通知交给 Windows。Windows 是否显示，取决于它的通知设置和专注模式，此应用无法读取。",
    },
    app: {
      label: "此应用中不可用",
      help: "此应用在这里暂时还不能显示系统通知：iPhone 应用、Linux 上的桌面应用，以及较旧的桌面应用。在浏览器中使用 Yuzuno 可以。",
    },
    insecure: { label: "此页面不可用", help: "浏览器只会从安全页面发出通知：https:// 地址或 localhost。此页面的地址都不是。" },
    "page-only": { label: "此浏览器不可用", help: "此浏览器只通过 service worker 显示通知，而 Yuzuno 不使用 service worker。" },
    "no-api": { label: "此浏览器不可用", help: "此浏览器没有面向网页的通知。" },
  },
  macos: {
    allowed: { label: "已允许", help: "macOS 允许此应用的通知。通知如何显示，取决于“系统设置 → 通知 → Yuzuno”和专注模式。" },
    quiet: {
      label: "已允许（静默）",
      help: "macOS 以静默方式递送此应用的通知：只进入通知中心，没有横幅或声音。如需更改：系统设置 → 通知 → Yuzuno。",
    },
    "not-requested": { label: "尚未询问", help: "开启通知或发送测试时，会询问 macOS 一次。在你这样做之前不会询问。" },
    denied: {
      label: "macOS 中已关闭",
      help: "macOS 不允许此应用的通知，此应用也不会再次询问。如需允许：系统设置 → 通知 → Yuzuno，然后回到这里。你在下方的选择会保留。",
    },
  },
  unread: (detail) => ({ label: "暂不可用", help: `此应用无法确定 macOS 是否允许它的通知：${detail ?? "macOS 给出了此应用不认识的状态"}。` }),
  shown: "你的浏览器报告已显示。如果你没有看到，可能是系统暂时拦下了通知（专注模式或勿扰模式）。",
  handed: "已交给 Windows。Windows 不会告诉此应用是否显示了它：如果你没有看到，请检查 Windows 的通知设置和专注模式。",
  handedMacos: "macOS 已接收。如果你没有看到，请在“系统设置 → 通知”中检查此应用，以及专注模式。",
  handedQuiet: "macOS 已接收，它会以静默方式递送此应用的通知：只进入通知中心，没有横幅或声音。",
  held: "未发送：此应用的窗口在最前面。",
  unconfirmed: "已发送，但你的浏览器在 5 秒内没有报告已显示。",
  failed: (message) => `你的浏览器无法显示它：${message}`,
  failedApp: (system, message) => `此应用无法把它交给 ${system}：${message}`,
  askFailed: (message) => `macOS 没有询问：${message}。`,
  refused: (help) => `未发送。${help}`,
  off: "关闭",
  muted: "已静音",
  on: "开启",
  section: "通知设置",
  title: "通知",
  intro: "当 Yuzuno 在某个标签页或窗口中打开、而你没有在看它时，此设备上的系统通知。每台设备和每个浏览器都有自己的选择和自己的权限。",
  current: "当前生效",
  permission: "此浏览器的权限",
  systemRow: "系统通知",
  notify: "在此设备上通知我",
  asksFirst: "开启时会先向此浏览器请求权限。",
  asksMacos: "开启时会先询问 macOS。",
  chosenOnly: "只通知你在下方选择的内容。",
  afterMacos: "会保留，在 macOS 允许此应用的通知后生效。",
  what: "通知哪些内容",
  preview: "显示所写的内容",
  previewHelp: "关闭时只显示是谁以及原因。通知可能显示在锁定的屏幕上。",
  mute: "在此设备上静音",
  muteHelp: "保留你的选择。Agent、它们的邮件和 Workspace 都不受影响。",
  test: "测试通知",
  testHelp: "立即发送一条，即使你正在看也会发送，并显示你的浏览器报告的结果。",
  testHelpApp: (system) => `立即发送一条，即使你正在看也会发送。此应用只能知道 ${system} 是否接收了它。`,
  sendTest: "发送测试",
  inside: "Yuzuno 内",
  insideHelp: "无论你在这里如何选择，“需要你处理”和未读动态始终在 Workspace 中显示。Agent 之间的消息是它们自己的邮件，不是给你的通知。",
  unavailable: "暂不支持",
  unavailableHelp: "Yuzuno 关闭时的通知、推送通知，以及 Yuzuno 自己的通知声音或免打扰时段。",
});

/** What this browser allows, in the user's words, with what to do about it. */
export function accessText(access: NotificationAccess, language: Language = "en"): Access {
  const t = text(language);
  if (access.state === "unsupported") return access.reason === "unread" ? t.unread(access.detail) : t.access[access.reason];
  if (access.state !== "through-app" && access.system === "macos")
    return t.macos[access.state === "allowed" && access.quiet ? "quiet" : access.state];
  return t.access[access.state];
}

/** The system the desktop app hands them to, when it does (T-188). */
function appSystem(access: NotificationAccess): "Windows" | "macOS" | null {
  if (access.state === "through-app") return "Windows";
  if (access.state === "unsupported") return access.reason === "unread" ? "macOS" : null;
  return access.system === "macos" ? "macOS" : null;
}

const testText = (result: TestOutcome, language: Language, access: NotificationAccess) => {
  const t = text(language);
  const system = appSystem(access);
  switch (result.outcome) {
    case "shown":
      return t.shown;
    case "handed":
      if (system !== "macOS") return t.handed;
      return access.state === "allowed" && access.quiet ? t.handedQuiet : t.handedMacos;
    case "held":
      return t.held;
    case "unconfirmed":
      return t.unconfirmed;
    case "failed":
      return system ? t.failedApp(system, result.message) : t.failed(result.message);
    case "refused":
      return t.refused(accessText(result.access, language).help);
  }
};

/** What this browser allows now, read again when this window comes back
 * (the user may have changed it in the browser's settings meanwhile; in the
 * desktop app on macOS, the app's answer is read again then too). */
function useNotificationAccess() {
  // In the desktop app, whether it can notify on this system (T-188).
  const desktop = useDesktopNotifier();
  const read = useCallback(() => notificationAccess(browserHost(isNative, desktop)), [desktop]);
  const [access, setAccess] = useState(read);
  useEffect(() => {
    setAccess(read());
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
  const language = useLanguage();
  const t = text(language);
  const prefs = useNotificationPrefs();
  const write = useNotificationPrefsWrite();
  const [access, setAccess] = useNotificationAccess();
  const [asking, setAsking] = useState(false);
  const [askFailed, setAskFailed] = useState<string | null>(null);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const usable = reachesSystem(access) || access.state === "not-requested";
  const system = appSystem(access);
  // Turned off in macOS: the choices stay this device's to keep, for when
  // macOS allows them; nothing is asked or sent (T-188).
  const offInMacos = access.state === "denied" && access.system === "macos";
  const save = (next: Partial<NotificationPrefs>) => changeNotificationPrefs((now) => ({ ...now, ...next }));
  /** Asks the browser, or macOS, from this click, when it has not been asked. */
  const ask = async () => {
    if (access.state !== "not-requested") return access;
    setAsking(true);
    setAskFailed(null);
    try {
      const answer = await requestNotificationAccess(browserHost(isNative, knownDesktopNotifier()));
      setAccess(answer);
      return answer;
    } catch (error) {
      setAskFailed(error instanceof Error ? error.message : String(error));
      return access;
    } finally {
      setAsking(false);
    }
  };
  const turn = async (on: boolean) => {
    if (on && !offInMacos && !reachesSystem(await ask())) return;
    save({ enabled: on });
  };
  const sendTest = async () => {
    setTest(null);
    const allowed = await ask();
    // As the app said last: asking may have changed it.
    const host = browserHost(isNative, knownDesktopNotifier());
    const result =
      reachesSystem(allowed)
        ? await showSystemNotification("Yuzuno", { body: "A test notification from your Workspace.", tag: "yuzuno:test" }, host)
        : ({ outcome: "refused", access: allowed } as const);
    // A browser can turn out to refuse a page's notifications only now.
    setAccess(notificationAccess(host));
    setTest(result);
  };
  const state = accessText(access, language);
  const current = !usable ? state.label : !prefs.enabled ? t.off : prefs.muted ? t.muted : t.on;
  return (
    <section id="settings-notifications" className="settings-section notification-settings" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        <span className="settings-current" title={t.current}>
          {current}
        </span>
      </header>
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">
              {system ? t.systemRow : t.permission} <span className="notification-access" data-state={access.state}>{state.label}</span>
            </span>
            <span className="settings-row-help">{state.help}</span>
          </span>
        </div>
        {(usable || offInMacos) && (
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.notify}</span>
              <span className="settings-row-help">
                {offInMacos ? t.afterMacos : access.state !== "not-requested" ? t.chosenOnly : system ? t.asksMacos : t.asksFirst}
              </span>
              {askFailed && (
                <span className="settings-row-help notification-ask-result" role="status">
                  {t.askFailed(askFailed)}
                </span>
              )}
            </span>
            <input
              type="checkbox"
              checked={prefs.enabled && (reachesSystem(access) || offInMacos)}
              disabled={asking}
              onChange={(event) => void turn(event.target.checked)}
            />
          </label>
        )}
      </div>
      {(usable || offInMacos) && (
        <div className="settings-group" aria-label={t.what}>
          {notificationCategories.map((kind) => (
            <label className="settings-row" key={kind}>
              <span className="settings-row-main">
                <span className="settings-row-title">{t.kinds[kind].title}</span>
                <span className="settings-row-help">{t.kinds[kind].help}</span>
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
              <span className="settings-row-title">{t.preview}</span>
              <span className="settings-row-help">{t.previewHelp}</span>
            </span>
            <input type="checkbox" checked={prefs.preview} onChange={(event) => save({ preview: event.target.checked })} />
          </label>
          <label className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.mute}</span>
              <span className="settings-row-help">{t.muteHelp}</span>
            </span>
            <input type="checkbox" checked={prefs.muted} onChange={(event) => save({ muted: event.target.checked })} />
          </label>
        </div>
      )}
      {usable && (
        <div className="settings-group">
          <div className="settings-row">
            <span className="settings-row-main">
              <span className="settings-row-title">{t.test}</span>
              <span className="settings-row-help">{system ? t.testHelpApp(system) : t.testHelp}</span>
              {test && (
                <span className="settings-row-help notification-test-result" role="status" data-outcome={test.outcome}>
                  {testText(test, language, access)}
                </span>
              )}
            </span>
            <span className="settings-row-action">
              <button type="button" className="secondary-button" disabled={asking} onClick={() => void sendTest()}>
                {t.sendTest}
              </button>
            </span>
          </div>
        </div>
      )}
      <SaveStatus
        outcome={write?.outcome ?? null}
        action={write?.action}
        attempt={write?.attempt}
        stored={notificationPrefsStored()}
        scope="this device"
        onRetry={() => retryNotificationPrefsWrite()}
        onRestoreDefaults={() => restoreDefaultNotificationPrefs()}
      />
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.inside}</span>
            <span className="settings-row-help">{t.insideHelp}</span>
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-row-main">
            <span className="settings-row-title">{t.unavailable}</span>
            <span className="settings-row-help">{t.unavailableHelp}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
