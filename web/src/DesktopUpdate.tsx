import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronRight,
  LoaderCircle,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { errorText, isTauri, openDesktopConnection } from "./api";
import { strings, useStrings } from "./i18n";
import { updateBytes } from "./updates";
import "./desktop-update.css";

/** The desktop shell's own update state (desktop/src/update.rs). */
export type DesktopUpdateStatus = {
  version: string;
  /** "installer": installed by the Yuzuno installer, which can update it. */
  channel: "installer" | "unknown";
  /** Why this copy cannot update itself here, if it cannot. */
  unavailable: string | null;
  phase:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "installing"
    | "failed";
  error: string | null;
  receivedBytes: number;
  totalBytes: number | null;
  available: {
    version: string;
    notes: string | null;
    date: string | null;
  } | null;
};

type Invoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

/** The desktop shell's command bridge; absent in a browser. */
export const desktopShell = {
  invoke: (): Invoke | undefined =>
    (window as Window & { __TAURI__?: { core?: { invoke?: Invoke } } })
      .__TAURI__?.core?.invoke,
};

const POLL_MS = 500;

// The desktop shell's own words (why it can't update, its errors), versions
// and release notes are shown as they came.
const text = strings({
  title: "Desktop app",
  separately: "The Windows app is updated separately, from Settings in the app itself. The update above changes only the Workspace service it connects to.",
  older: "This desktop version cannot update itself. Install a newer release by hand.",
  choose: "Choose which Workspace service this window opens.",
  connection: "Connection",
  checks: "This Windows app checks the Workspace service it is connected to for a signed desktop release.",
  installedNow: "Installed now",
  version: (version: string) => `Version ${version}`,
  available: (version: string) => `Version ${version} is available`,
  current: "The desktop app is up to date.",
  checking: "Checking for a desktop release…",
  updates: "Desktop updates",
  notInstaller: "This copy was not installed by the Yuzuno installer, so it cannot update itself. Install new releases by hand.",
  whatsNew: "What’s new",
  installNote: "Installing closes this window and reopens the new version. Drafts and the Workspace connection are kept; the Workspace service and its agents keep running.",
  downloading: (received: string, total: string | null) => ` Downloading and verifying ${received}${total ? ` of ${total}` : ""}…`,
  installing: " Installing. Yuzuno will reopen.",
  check: "Check for desktop update",
  install: (version: string) => `Download and install ${version}`,
}, {
  title: "桌面应用",
  separately: "Windows 应用单独更新，需在该应用自己的设置中进行。上方的更新只会改变它所连接的 Workspace 服务。",
  older: "此桌面版本无法自行更新。请手动安装更新的发行版。",
  choose: "选择此窗口打开哪个 Workspace 服务。",
  connection: "连接",
  checks: "此 Windows 应用会向它所连接的 Workspace 服务检查已签名的桌面发行版。",
  installedNow: "当前已安装",
  version: (version) => `版本 ${version}`,
  available: (version) => `版本 ${version} 可用`,
  current: "桌面应用已是最新。",
  checking: "正在检查桌面发行版…",
  updates: "桌面更新",
  notInstaller: "此副本不是由 Yuzuno 安装程序安装的，因此无法自行更新。请手动安装新的发行版。",
  whatsNew: "新内容",
  installNote: "安装会关闭此窗口并打开新版本。草稿和 Workspace 连接会保留；Workspace 服务及其 Agent 会继续运行。",
  downloading: (received, total) => ` 正在下载并验证 ${received}${total ? ` / ${total}` : ""}…`,
  installing: " 正在安装。Yuzuno 将重新打开。",
  check: "检查桌面更新",
  install: (version) => `下载并安装 ${version}`,
});

/**
 * The Desktop app's own updates, next to the Workspace service's. The desktop
 * checks the Core it is connected to, verifies what it downloads against the
 * key built into it, and installs only when asked. Installing closes this
 * window and reopens the new version; the Workspace service keeps running.
 */
export function DesktopUpdate({
  preserveDrafts,
}: {
  preserveDrafts: () => void;
}) {
  const t = useStrings(text);
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acting = useRef(false);
  const invoke = desktopShell.invoke();

  const read = useCallback(async () => {
    if (!invoke) return;
    try {
      setStatus((await invoke("desktop_update_status")) as DesktopUpdateStatus);
      setShellError(null);
    } catch (e) {
      // An older desktop has no update commands.
      setShellError(errorText(e));
    }
  }, [invoke]);

  useEffect(() => {
    void read();
  }, [read]);

  const working =
    status?.phase === "downloading" || status?.phase === "installing";
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void read(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [working, read]);

  async function run(
    command: "desktop_update_check" | "desktop_update_install",
    args?: Record<string, unknown>,
  ) {
    if (!invoke || acting.current) return;
    acting.current = true;
    setError(null);
    try {
      const install = command === "desktop_update_install";
      // Installing ends this window; the reopened one restores saved drafts.
      if (install) preserveDrafts();
      // The command answers when it is done; until then progress is polled.
      setStatus(
        (s) =>
          s && {
            ...s,
            error: null,
            phase: install ? "downloading" : "checking",
            receivedBytes: 0,
            totalBytes: null,
          },
      );
      const next = (await invoke(command, args)) as DesktopUpdateStatus | null;
      if (next) setStatus(next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      acting.current = false;
    }
    await read();
  }

  const connection = isTauri && (
    <button className="quiet-button" onClick={openDesktopConnection}>
      {t.connection}
    </button>
  );

  if (!invoke || shellError !== null) {
    return (
      <section
        id="settings-desktop"
        className="settings-section updates-desktop"
        aria-label={t.title}
      >
        <header className="settings-section-heading">
          <div>
            <h3>{t.title}</h3>
            <p>{t.separately}</p>
          </div>
        </header>
        {(shellError !== null || connection) && (
          <div className="settings-group">
            <div className="settings-row">
              <Monitor size={18} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                {shellError !== null ? (
                  <p className="settings-row-help desktop-update-note">
                    {/not (found|allowed)/i.test(shellError) ? t.older : shellError}
                  </p>
                ) : (
                  <p className="settings-row-help">{t.choose}</p>
                )}
              </div>
              {connection && <div className="settings-row-action">{connection}</div>}
            </div>
          </div>
        )}
      </section>
    );
  }

  const blocked = status?.unavailable;
  const canInstall = status?.channel === "installer" && !blocked;
  const busy = status?.phase === "checking" || working;
  const available = status?.available;

  return (
    <section
      id="settings-desktop"
      className="settings-section updates-desktop desktop-update"
      aria-label={t.title}
    >
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.checks}</p>
        </div>
        {status && (
          <span className="settings-current desktop-update-version" title={t.installedNow}>
            {t.version(status.version)}
          </span>
        )}
      </header>
      <div className="settings-group">
        <div className="settings-row">
          <Monitor size={18} className="settings-row-icon" aria-hidden="true" />
          <div className="settings-row-main desktop-update-body">
            <span className="settings-row-title">
              {available
                ? t.available(available.version)
                : status?.phase === "current"
                  ? t.current
                  : status?.phase === "checking"
                    ? t.checking
                    : t.updates}
            </span>
            {blocked && <p className="settings-row-help desktop-update-note">{blocked}</p>}
            {status && status.channel !== "installer" && !status.unavailable && (
              <p className="settings-row-help desktop-update-note">{t.notInstaller}</p>
            )}
            {available && (
              <div className="desktop-update-available">
                {available.notes && (
                  <details className="updates-notes">
                    <summary>
                      <ChevronRight size={12} aria-hidden="true" />
                      {t.whatsNew}
                    </summary>
                    <p className="updates-release-notes">{available.notes}</p>
                  </details>
                )}
                {canInstall && (
                  <p className="settings-row-meta">{t.installNote}</p>
                )}
              </div>
            )}
            {status?.phase === "downloading" && (
              <p className="settings-row-help desktop-update-state" role="status">
                <LoaderCircle size={14} className="updates-spin" />
                {t.downloading(updateBytes(status.receivedBytes), status.totalBytes ? updateBytes(status.totalBytes) : null)}
              </p>
            )}
            {status?.phase === "installing" && (
              <p className="settings-row-help desktop-update-state" role="status">
                <LoaderCircle size={14} className="updates-spin" />
                {t.installing}
              </p>
            )}
            {(error ?? status?.error) && (
              <p className="updates-error" role="alert">
                {error ?? status?.error}
              </p>
            )}
          </div>
          <div className="settings-row-action desktop-update-actions">
            {!available && (
              <button
                className="quiet-button"
                disabled={!!blocked || busy}
                onClick={() => void run("desktop_update_check")}
              >
                {status?.phase === "checking" ? (
                  <LoaderCircle size={14} className="updates-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {t.check}
              </button>
            )}
            {available && (
              <button
                className="primary-button"
                disabled={!canInstall || busy}
                onClick={() =>
                  void run("desktop_update_install", {
                    version: available.version,
                  })
                }
              >
                <ArrowDownToLine size={14} />
                {t.install(available.version)}
              </button>
            )}
            {connection}
          </div>
        </div>
      </div>
    </section>
  );
}
