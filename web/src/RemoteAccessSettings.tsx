import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, errorText, HttpError, NetworkError, post } from "./api";
import {
  loadPending,
  newRequestId,
  operationStepLabels,
  operationSteps,
  previewUrl,
  qrPath,
  running,
  savePending,
  stateLines,
  verificationStepLabels,
  type Pending,
  type RemoteAccessDraft,
  type RemoteAccessOperation,
  type RemoteAccessView,
} from "./remote-access";
import "./remote-access.css";

/** The advanced fields as typed: empty means Core's default. */
type Fields = { servePort: string; localPort: string; login: string };

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
      servePort: port(fields.servePort, "The Serve port"),
      localPort: port(fields.localPort, "Core's phone port"),
      login: fields.login.trim() || undefined,
    };
  } catch (e) {
    return errorText(e);
  }
}

function fieldsOf(draft: RemoteAccessDraft | undefined, view: RemoteAccessView): Fields {
  const saved = view.saved;
  return {
    servePort: String(draft?.servePort ?? saved?.servePort ?? ""),
    localPort: String(draft?.localPort ?? saved?.localPort ?? ""),
    login: draft?.login ?? saved?.login ?? "",
  };
}

/** Core refuses a change with `<code>: <sentence>`; the page shows the sentence. */
const refusal = (e: unknown) => (e instanceof HttpError ? /^([a-z_]+): /.exec(e.message)?.[1] : undefined);
const readable = (e: unknown) => (refusal(e) ? (e as Error).message.replace(/^[a-z_]+: /, "") : errorText(e));

/** How the latest change ended, in a sentence; null while it runs. */
function outcome(op: RemoteAccessOperation): string | null {
  const at = `“${operationStepLabels[op.step] ?? op.step}”`;
  const why = op.error ? `: ${op.error.replace(/[.。]\s*$/, "")}` : "";
  const what = op.kind === "apply" ? "Applying" : "Turning it off";
  switch (op.state) {
    case "running":
      return null;
    case "succeeded":
      return op.kind === "apply" ? "Applied. The status above is what Core reports now." : "Turned off.";
    case "failed":
      // Core's own sentence says what is set up and what was not verified.
      return op.step === "verify"
        ? op.error ? `${op.error.replace(/[.。]\s*$/, "")}.` : "Set up, but not verified."
        : `${what} stopped at ${at}${why}.`;
    case "rolledBack":
      return `${what} stopped at ${at} and was undone${why}.`;
    case "uncertain":
      return `Core could not confirm how ${at} ended${why}. Check, or apply again: Core compares with what is there first.`;
    case "interrupted":
      return `Core stopped during ${at}. Check, or apply again: Core compares with what is there first.`;
  }
}

/** Settings → Phone access (T-185): the phone's entry through Tailscale
 * Serve, for a Workspace Core in WSL with Tailscale on Windows. Opening it
 * only reads; Check reads Tailscale and Serve now; Save and apply and Turn
 * off are Core's own operations, each with a request ID kept in this browser
 * so that asking again after a lost answer is the same request. */
export function RemoteAccessSettings({ active }: { active: boolean }) {
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [fields, setFields] = useState<Fields | null>(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const pending = useRef<Pending | null>(null);
  if (pending.current === null) pending.current = loadPending();

  const accept = useCallback((next: RemoteAccessView) => {
    setView(next);
    setLoadError("");
    // The page's retry key ends with the change it named: once Core has
    // recorded how it ended, trying again is a new request.
    const op = next.operation;
    if (pending.current && op?.requestId === pending.current.requestId && !running(op)) {
      pending.current = null;
      savePending(null);
    }
    // What is typed is never replaced by a later read.
    setFields((old) => old ?? fieldsOf(pending.current?.draft.enabled ? pending.current.draft : undefined, next));
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await api<RemoteAccessView>("/remote-access", { signal });
        if (!signal?.aborted) accept(next);
      } catch (e) {
        if (!signal?.aborted) setLoadError(errorText(e));
      }
    },
    [accept],
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [active, refresh]);

  // While a change runs, its progress is read about once a second; once it
  // has ended, the whole view is read again.
  const operation = view?.operation ?? null;
  const busy = running(operation);
  useEffect(() => {
    if (!active || !operation || !busy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const op = await api<RemoteAccessOperation>(`/remote-access/operations/${encodeURIComponent(operation.id)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (running(op)) setView((old) => (old ? { ...old, operation: op } : old));
        else await refresh(controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError(errorText(e));
      }
    }, 1000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, busy, operation, refresh]);

  function edit(change: Partial<Fields>) {
    setFields((old) => (old ? { ...old, ...change } : old));
    setError("");
  }

  async function runCheck() {
    if (checking) return;
    setChecking(true);
    setError("");
    try {
      accept(await post<RemoteAccessView>("/remote-access/check", {}));
      setChecked(true);
    } catch (e) {
      setError(`Check failed: ${readable(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function send(enabled: boolean) {
    if (!fields || sending || busy) return;
    const draft: RemoteAccessDraft | string = enabled ? draftOf(fields) : { enabled: false };
    if (typeof draft === "string") return setError(draft);
    // The same change asked again is the same request; anything else is new.
    const request: Pending =
      pending.current && JSON.stringify(pending.current.draft) === JSON.stringify(draft)
        ? pending.current
        : { requestId: newRequestId(), draft };
    pending.current = request;
    savePending(request);
    setSending(true);
    setError("");
    try {
      const { operation: started } = await post<{ operation: RemoteAccessOperation }>("/remote-access/apply", {
        requestId: request.requestId,
        ...request.draft,
      });
      setView((old) => (old ? { ...old, operation: started } : old));
      // A change Core has already ended needs no retry key.
      if (!running(started)) {
        pending.current = null;
        savePending(null);
      }
    } catch (e) {
      if (refusal(e) === "remote_access_busy" || (e instanceof HttpError && e.status === 409)) {
        setError("Another phone access change is already running; its progress is shown below.");
      } else if (refusal(e) === "idempotency_conflict") {
        // This request ID names another change in Core: the next try is new.
        pending.current = null;
        savePending(null);
        setError(`${readable(e)}. Press again to send it as a new change.`);
      } else if (e instanceof NetworkError) {
        setError("Core's answer did not arrive, so whether it started is not known. What Core recorded is shown below.");
      } else setError(readable(e));
      await refresh();
    } finally {
      setSending(false);
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

  const supported = view?.support.state === "supported";
  const host = view?.support.coreHost;
  const tailscale = view?.tailscale;
  const enabledNow = !!view && (!!view.saved?.enabled || !!view.listening || view.serve.state === "ours");
  const done = operation ? outcome(operation) : null;
  const unverified = !!view?.url && !!view.verification && !view.verification.ok;
  // What Save and apply would make, from the node Check read and the typed port.
  const typed = fields ? draftOf(fields) : null;
  const preview =
    view && typed && typeof typed !== "string"
      ? previewUrl(tailscale?.dnsName, typed.servePort ?? view.defaults.servePort)
      : null;
  const stepIndex = operation ? operationSteps.indexOf(operation.step) : -1;
  return (
    <section id="settings-remote" className="settings-section remote-access" aria-label="Phone access settings">
      <header className="settings-section-heading">
        <div>
          <h3>Phone access</h3>
          <p>
            Open this Workspace from your phone through Tailscale on your private network. Yuzuno changes only its own
            Serve entry, and shows an address only once Core listens and the entry is its own.
          </p>
        </div>
        {view && (
          <span className="settings-current" title="As Core reports it now">
            {view.url ? (unverified ? "Not verified" : "On") : enabledNow ? "Incomplete" : "Off"}
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
      {view?.startupError && (
        <p className="updates-error" role="alert">
          When Core started, it could not serve the phone entry: {view.startupError}
        </p>
      )}
      {view && (
        <>
          <dl className="settings-group remote-access-hosts">
            <div>
              <dt>Core runs on</dt>
              <dd>
                {{ wsl: "WSL", linux: "Linux", macos: "macOS", other: "Other" }[host!.kind]} · {host!.name}
                {host!.networking && host!.networking !== "unknown" ? ` · ${host!.networking} networking` : ""}
              </dd>
            </div>
            <div>
              <dt>Tailscale runs on</dt>
              <dd>
                {view.support.tailscaleHost.kind === "windows"
                  ? `Windows${tailscale?.dnsName ? ` · ${tailscale.dnsName}` : ""} · ${
                      !tailscale
                        ? "not checked yet"
                        : {
                            running: tailscale.https ? "running" : "running, HTTPS certificates off",
                            stopped: "not running",
                            needsLogin: "needs you to sign in",
                            error: `could not be read${tailscale.detail ? ` (${tailscale.detail})` : ""}`,
                          }[tailscale.state]
                    }`
                  : "Not found"}
              </dd>
            </div>
            <div>
              <dt>Allowed login</dt>
              <dd>{view.saved?.login || view.listening?.login || tailscale?.ownerLogin || "Not set"}</dd>
            </div>
          </dl>
          {!supported && (
            <p className="remote-access-note" role="note">
              Phone access cannot be set up from here for this Core{view.support.reason ? `: ${view.support.reason}` : "."} Only
              a Workspace Core in WSL with Tailscale on Windows is supported.
            </p>
          )}
          {view.environment && !view.saved && (
            <p className="remote-access-note" role="note">
              This entry was set up outside Settings, from Core's environment. Save and apply with the same values takes it over
              without changing Serve.
            </p>
          )}
          {view.environment?.ignored && (
            <p className="remote-access-note" role="note">
              Core's environment also sets an entry; the saved settings decide, so it is ignored.
            </p>
          )}
          <ul className="remote-access-states" aria-label="Phone access status">
            {stateLines(view).map((line) => (
              <li key={line.label} data-tone={line.tone}>
                <span className="remote-access-state-label">{line.label}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
          {view.verification && !view.verification.ok && (
            <details className="remote-access-verification">
              <summary>Verification steps</summary>
              <ol>
                {view.verification.steps.map((step) => (
                  <li key={step.id} data-state={step.state}>
                    {verificationStepLabels[step.id] ?? step.id}: {step.state === "ok" ? "ok" : step.state}
                    {step.detail ? ` · ${step.detail}` : ""}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {view.url && (
            <div className="remote-access-result" aria-label="Phone address">
              <div>
                <a href={view.url} target="_blank" rel="noreferrer">
                  {view.url}
                </a>
                <button type="button" className="secondary-button" onClick={() => void copy(view.url!)}>
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <p className="settings-row-help">
                  {unverified
                    ? "Set up, but not verified: it may not open on your phone yet. The failed step is shown above."
                    : "Open it, or scan the code, on a phone signed in to the same tailnet."}
                </p>
              </div>
              {view.qr && (
                <svg
                  className="remote-access-qr"
                  role="img"
                  aria-label={`QR code for ${view.url}`}
                  viewBox={`0 0 ${view.qr.size + 8} ${view.qr.size + 8}`}
                  shapeRendering="crispEdges"
                >
                  <rect width="100%" height="100%" fill="#fff" />
                  <path d={qrPath(view.qr)} fill="#000" />
                </svg>
              )}
            </div>
          )}
          {operation && (
            <div className="remote-access-operation" aria-label="Latest phone access change">
              {busy && (
                <ol className="remote-access-steps">
                  {operationSteps.map((step, index) => (
                    <li key={step} data-state={index < stepIndex ? "done" : index === stepIndex ? "running" : "pending"}>
                      {operationStepLabels[step]}
                    </li>
                  ))}
                </ol>
              )}
              {done && (
                <p
                  className={operation.state === "succeeded" ? "settings-row-help" : "updates-error"}
                  role={operation.state === "succeeded" ? "status" : "alert"}
                >
                  {done}
                </p>
              )}
              {!busy && !!operation.notes?.length && (
                <ul className="remote-access-notes" aria-label="Notes from Core">
                  {operation.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {supported && !view.canChange && (
            <p className="remote-access-note" role="note">
              {view.readOnlyReason || "This page is open through the phone entry, so it cannot change it. Change it from Yuzuno on the computer."}
            </p>
          )}
          {supported && view.canChange && fields && (
            <div className="settings-group remote-access-form">
              <details className="remote-access-advanced">
                <summary>Advanced</summary>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Serve port</span>
                    <span className="settings-row-help">The HTTPS port your phone opens. Empty: {view.defaults.servePort}.</span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label="Serve port"
                    placeholder={String(view.defaults.servePort)}
                    value={fields.servePort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ servePort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Core's phone port</span>
                    <span className="settings-row-help">
                      A loopback port on the Core host, used only by Serve. Empty: {view.defaults.localPort}.
                    </span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label="Core's phone port"
                    placeholder={String(view.defaults.localPort)}
                    value={fields.localPort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ localPort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">Allowed login</span>
                    <span className="settings-row-help">The one tailnet login that may open it. Empty: Tailscale's own login.</span>
                  </span>
                  <input
                    className="settings-select"
                    aria-label="Allowed login"
                    autoComplete="off"
                    placeholder={tailscale?.ownerLogin ?? ""}
                    value={fields.login}
                    disabled={sending || busy}
                    onChange={(e) => edit({ login: e.target.value })}
                  />
                </label>
              </details>
              {preview && (
                <p className="remote-access-preview">
                  Your phone will open <strong>{preview}</strong>
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
                    title={checked ? undefined : "Check first"}
                    disabled={!checked || sending || busy}
                    onClick={() => void send(true)}
                  >
                    {sending ? "Starting…" : "Save and apply"}
                  </button>
                  {enabledNow && (
                    <button type="button" className="secondary-button" disabled={sending || busy} onClick={() => void send(false)}>
                      Turn off
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
