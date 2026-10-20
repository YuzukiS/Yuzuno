import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronRight,
  LoaderCircle,
  Monitor,
  RefreshCw,
} from "lucide-react";
import { errorText, isTauri, openDesktopConnection } from "./api";
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
      Connection
    </button>
  );

  if (!invoke || shellError !== null) {
    return (
      <section
        id="settings-desktop"
        className="settings-section updates-desktop"
        aria-label="Desktop app"
      >
        <header className="settings-section-heading">
          <div>
            <h3>Desktop app</h3>
            <p>
              The Windows app is updated separately, from Settings in the app
              itself. The update above changes only the Workspace service it
              connects to.
            </p>
          </div>
        </header>
        {(shellError !== null || connection) && (
          <div className="settings-group">
            <div className="settings-row">
              <Monitor size={18} className="settings-row-icon" aria-hidden="true" />
              <div className="settings-row-main">
                {shellError !== null ? (
                  <p className="settings-row-help desktop-update-note">
                    {/not (found|allowed)/i.test(shellError)
                      ? "This desktop version cannot update itself. Install a newer release by hand."
                      : shellError}
                  </p>
                ) : (
                  <p className="settings-row-help">
                    Choose which Workspace service this window opens.
                  </p>
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
      aria-label="Desktop app"
    >
      <header className="settings-section-heading">
        <div>
          <h3>Desktop app</h3>
          <p>
            This Windows app checks the Workspace service it is connected to for a
            signed desktop release.
          </p>
        </div>
        {status && (
          <span className="settings-current desktop-update-version" title="Installed now">
            Version {status.version}
          </span>
        )}
      </header>
      <div className="settings-group">
        <div className="settings-row">
          <Monitor size={18} className="settings-row-icon" aria-hidden="true" />
          <div className="settings-row-main desktop-update-body">
            <span className="settings-row-title">
              {available
                ? `Version ${available.version} is available`
                : status?.phase === "current"
                  ? "The desktop app is up to date."
                  : status?.phase === "checking"
                    ? "Checking for a desktop release…"
                    : "Desktop updates"}
            </span>
            {blocked && <p className="settings-row-help desktop-update-note">{blocked}</p>}
            {status && status.channel !== "installer" && !status.unavailable && (
              <p className="settings-row-help desktop-update-note">
                This copy was not installed by the Yuzuno installer, so it cannot
                update itself. Install new releases by hand.
              </p>
            )}
            {available && (
              <div className="desktop-update-available">
                {available.notes && (
                  <details className="updates-notes">
                    <summary>
                      <ChevronRight size={12} aria-hidden="true" />
                      What’s new
                    </summary>
                    <p className="updates-release-notes">{available.notes}</p>
                  </details>
                )}
                {canInstall && (
                  <p className="settings-row-meta">
                    Installing closes this window and reopens the new version.
                    Drafts and the Workspace connection are kept; the Workspace
                    service and its agents keep running.
                  </p>
                )}
              </div>
            )}
            {status?.phase === "downloading" && (
              <p className="settings-row-help desktop-update-state" role="status">
                <LoaderCircle size={14} className="updates-spin" /> Downloading and
                verifying {updateBytes(status.receivedBytes)}
                {status.totalBytes ? ` of ${updateBytes(status.totalBytes)}` : ""}…
              </p>
            )}
            {status?.phase === "installing" && (
              <p className="settings-row-help desktop-update-state" role="status">
                <LoaderCircle size={14} className="updates-spin" /> Installing.
                Yuzuno will reopen.
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
                Check for desktop update
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
                Download and install {available.version}
              </button>
            )}
            {connection}
          </div>
        </div>
      </div>
    </section>
  );
}
