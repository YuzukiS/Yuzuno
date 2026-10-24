import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, errorText, HttpError, NetworkError, post } from "./api";
import {
  loadPending,
  newRequestId,
  qrPath,
  running,
  savePending,
  servedThroughEntry,
  stateLines,
  stepLabels,
  type Pending,
  type RemoteAccessCheck,
  type RemoteAccessDraft,
  type RemoteAccessStatus,
} from "./remote-access";
import "./remote-access.css";

/** The advanced fields as typed: empty means Core's default. */
type Fields = { httpsPort: string; remotePort: string; login: string };

function draftOf(fields: Fields): RemoteAccessDraft | string {
  const port = (value: string, name: string) => {
    if (!value.trim()) return undefined;
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port from 1 to 65535.`);
    return n;
  };
  try {
    return {
      enabled: true,
      httpsPort: port(fields.httpsPort, "The Serve port"),
      remotePort: port(fields.remotePort, "Core's phone port"),
      login: fields.login.trim() || undefined,
    };
  } catch (e) {
    return errorText(e);
  }
}

function fieldsOf(draft: RemoteAccessDraft | undefined, status: RemoteAccessStatus): Fields {
  const saved = status.saved;
  return {
    httpsPort: String(draft?.httpsPort ?? saved?.httpsPort ?? ""),
    remotePort: String(draft?.remotePort ?? saved?.remotePort ?? ""),
    login: draft?.login ?? saved?.login ?? "",
  };
}

/** Settings → Phone & remote access (T-185): the phone's entry through
 * Tailscale Serve, for a Workspace Core in WSL with Tailscale on Windows.
 * Loading only reads. Check reads too; Save and apply and Turn off are Core's
 * own operations, each with a request ID kept in this browser so that asking
 * again after a lost answer or a restart is the same operation. */
export function RemoteAccessSettings({ active }: { active: boolean }) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [fields, setFields] = useState<Fields | null>(null);
  const [check, setCheck] = useState<RemoteAccessCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"apply" | "disable" | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<Pending | null>(loadPending());

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<RemoteAccessStatus>("/remote-access", { signal });
      if (signal?.aborted) return;
      setStatus(next);
      setLoadError("");
      // The page's own retry key ends with the operation it named: once Core
      // has recorded how it ended (or that it cannot tell), trying again is a
      // new request, which Core checks against what is there now.
      const op = next.operation;
      if (pending.current && op?.requestId === pending.current.requestId && !running(op)) {
        pending.current = null;
        savePending(null);
      }
      // What is typed is never replaced by a later read.
      setFields((old) => old ?? fieldsOf(pending.current?.kind === "apply" ? pending.current.draft : undefined, next));
    } catch (e) {
      if (!signal?.aborted) setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [active, refresh]);

  // While an operation runs, its progress is read about once a second.
  const operation = status?.operation ?? null;
  const busy = running(operation);
  useEffect(() => {
    if (!active || !busy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void refresh(controller.signal), 1000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, busy, status, refresh]);

  function edit(change: Partial<Fields>) {
    setFields((old) => (old ? { ...old, ...change } : old));
    setCheck(null);
    setError("");
  }

  async function runCheck() {
    if (!fields || checking) return;
    const draft = draftOf(fields);
    if (typeof draft === "string") return setError(draft);
    setChecking(true);
    setError("");
    try {
      setCheck(await post<RemoteAccessCheck>("/remote-access/check", { draft }));
    } catch (e) {
      setError(`Check failed: ${errorText(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function send(kind: "apply" | "disable") {
    if (!fields || sending || busy || !status) return;
    const draft = draftOf(fields);
    if (kind === "apply" && typeof draft === "string") return setError(draft);
    if (servedThroughEntry(status) && confirm !== kind) return setConfirm(kind);
    setConfirm(null);
    // The same draft asked again is the same request; anything else is new.
    const same =
      pending.current?.kind === kind &&
      (kind === "disable" || JSON.stringify(pending.current.draft) === JSON.stringify(draft));
    const request: Pending = same && pending.current
      ? pending.current
      : { requestId: newRequestId(), kind, draft: typeof draft === "string" ? { enabled: false } : draft };
    pending.current = request;
    savePending(request);
    setSending(true);
    setError("");
    try {
      await post(`/remote-access/${kind}`, kind === "apply" ? { requestId: request.requestId, draft: request.draft } : { requestId: request.requestId });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        setError("Another phone access change is already running; its progress is shown below.");
      } else if (e instanceof NetworkError) {
        setError("Core's answer did not arrive, so whether it started is not known. What Core recorded is shown below.");
      } else {
        setError(errorText(e));
      }
    } finally {
      setSending(false);
      await refresh();
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copying is not allowed here; select the address instead.");
    }
  }

  const supported = status?.support.state === "supported";
  const host = status?.support.coreHost;
  const tailscale = status?.support.tailscaleHost;
  const enabledNow = !!status?.saved?.enabled || status?.listening.state === "on" || status?.serve.state === "ours";
  return (
    <section id="settings-remote" className="settings-section remote-access" aria-label="Phone and remote access settings">
      <header className="settings-section-heading">
        <div>
          <h3>Phone &amp; remote access</h3>
          <p>
            Open this Workspace from your phone through Tailscale on your private network. Yuzuno changes only its own
            Serve entry, and shows an address only after it has reached it.
          </p>
        </div>
        {status && (
          <span className="settings-current" title="As Core reports it now">
            {status.url ? "On" : enabledNow ? "Incomplete" : "Off"}
          </span>
        )}
      </header>
      {loadError && (
        <p className="updates-error" role="alert">
          Could not read phone access: {loadError}{" "}
          <button type="button" className="inline-link" onClick={() => void refresh()}>
            Try again
          </button>
        </p>
      )}
      {status && (
        <>
          <dl className="settings-group remote-access-hosts">
            <div>
              <dt>Core runs on</dt>
              <dd>{host?.kind === "wsl" ? `WSL · ${host.distro}${host.installDir ? ` · ${host.installDir}` : ""}` : host?.label}</dd>
            </div>
            <div>
              <dt>Tailscale runs on</dt>
              <dd>{tailscale ? `Windows · ${tailscale.node}` : "Not found"}</dd>
            </div>
            <div>
              <dt>Allowed login</dt>
              <dd>{status.saved?.login || tailscale?.login || "Not set"}</dd>
            </div>
          </dl>
          {!supported && (
            <p className="remote-access-note" role="note">
              Phone access cannot be set up from here for this Core{status.support.reason ? `: ${status.support.reason}` : "."} Only a
              Workspace Core in WSL with Tailscale on Windows is supported.
            </p>
          )}
          <ul className="remote-access-states" aria-label="Phone access status">
            {stateLines(status).map((line) => (
              <li key={line.label} data-tone={line.tone}>
                <span className="remote-access-state-label">{line.label}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
          {status.url && (
            <div className="remote-access-result" aria-label="Phone address">
              <div>
                <a href={status.url} target="_blank" rel="noreferrer">
                  {status.url}
                </a>
                <button type="button" className="secondary-button" onClick={() => void copy(status.url!)}>
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <p className="settings-row-help">Open it, or scan the code, on a phone signed in to the same tailnet.</p>
              </div>
              {status.qr && (
                <svg
                  className="remote-access-qr"
                  role="img"
                  aria-label={`QR code for ${status.url}`}
                  viewBox={`0 0 ${status.qr.size + 8} ${status.qr.size + 8}`}
                  shapeRendering="crispEdges"
                >
                  <rect width="100%" height="100%" fill="#fff" />
                  <path d={qrPath(status.qr)} fill="#000" />
                </svg>
              )}
            </div>
          )}
          {operation && (
            <div className="remote-access-operation" aria-label="Last phone access change">
              <ol className="remote-access-steps">
                {operation.steps.map((step) => (
                  <li key={step.id} data-state={step.state}>
                    {stepLabels[step.id] ?? step.id}
                    {step.detail ? <span className="settings-row-help"> · {step.detail}</span> : null}
                  </li>
                ))}
              </ol>
              {operation.phase === "failed" && (
                <p className="updates-error" role="alert">
                  {operation.kind === "apply" ? "Applying" : "Turning off"} stopped at “
                  {stepLabels[operation.error?.step as keyof typeof stepLabels] ?? operation.error?.step ?? "a step"}”:{" "}
                  {operation.error?.message ?? "no reason was given"}.
                </p>
              )}
              {operation.phase === "uncertain" && (
                <p className="updates-error" role="alert">
                  Core did not confirm how this change ended.{" "}
                  <button type="button" className="inline-link" onClick={() => void refresh()}>
                    Check again
                  </button>
                </p>
              )}
              {operation.phase === "complete" && (
                <p className="settings-row-help" role="status">
                  {operation.kind === "apply" ? "Applied" : "Turned off"}. The status above is what Core reports now.
                </p>
              )}
            </div>
          )}
          {supported && fields && (
            <div className="settings-group remote-access-form">
              <details className="remote-access-advanced">
                <summary>Advanced</summary>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Serve port</span>
                    <span className="settings-row-help">The HTTPS port your phone opens. Empty: Core's default.</span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label="Serve port"
                    value={fields.httpsPort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ httpsPort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Core's phone port</span>
                    <span className="settings-row-help">A loopback port on the Core host, used only by Serve. Empty: Core's default.</span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label="Core's phone port"
                    value={fields.remotePort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ remotePort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Allowed login</span>
                    <span className="settings-row-help">The one tailnet login that may open it. Empty: the login Tailscale runs as.</span>
                  </span>
                  <input
                    className="settings-select"
                    aria-label="Allowed login"
                    autoComplete="off"
                    value={fields.login}
                    disabled={sending || busy}
                    onChange={(e) => edit({ login: e.target.value })}
                  />
                </label>
              </details>
              {check && (
                <div className="remote-access-check" role="status">
                  {check.ok ? (
                    <p>
                      Ready: your phone would open <strong>{check.preview.url}</strong>, for {check.preview.login}.
                    </p>
                  ) : (
                    <ul>
                      {check.problems.map((problem, index) => (
                        <li key={index}>
                          {problem.message}
                          {problem.step ? <span className="settings-row-help"> · {problem.step}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {confirm && (
                <p className="updates-error" role="alert">
                  This page is open through the phone entry. {confirm === "apply" ? "Applying changes it" : "Turning it off ends it"}, and
                  this page will lose its connection; open Yuzuno again{confirm === "apply" ? " at the address shown afterwards" : " on the computer"}.
                </p>
              )}
              <div className="settings-row settings-row-end remote-access-actions">
                <div className="settings-row-action">
                  <button type="button" className="secondary-button" disabled={checking || sending || busy} onClick={() => void runCheck()}>
                    {checking ? "Checking…" : "Check"}
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!check?.ok || sending || busy}
                    onClick={() => void send("apply")}
                  >
                    {confirm === "apply" ? "Apply anyway" : sending ? "Starting…" : "Save and apply"}
                  </button>
                  {enabledNow && (
                    <button type="button" className="secondary-button" disabled={sending || busy} onClick={() => void send("disable")}>
                      {confirm === "disable" ? "Turn off anyway" : "Turn off"}
                    </button>
                  )}
                  {confirm && (
                    <button type="button" className="inline-link" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {error && (
            <p className="updates-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
