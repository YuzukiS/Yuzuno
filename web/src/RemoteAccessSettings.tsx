import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { api, errorText, HttpError, NetworkError, post } from "./api";
import { strings, useLanguage, type Language } from "./i18n";
import {
  badge,
  loadPending,
  newRequestId,
  operationSteps,
  previewUrl,
  qrPath,
  running,
  savePending,
  stateLines,
  stepLabels,
  type Pending,
  type RemoteAccessDraft,
  type RemoteAccessOperation,
  type RemoteAccessView,
} from "./remote-access";
import { RemoteAccessPreviews } from "./RemoteAccessPreviews";
import "./remote-access.css";

/** The advanced fields as typed: empty means Core's default. */
type Fields = { servePort: string; localPort: string; login: string };
type PortField = "servePort" | "localPort";

/** What a line says, kept as what happened and worded when shown, so it
 * follows the interface language (T-189). Core's own sentence is kept as it
 * came. */
type Said =
  | { kind: "port"; field: PortField }
  | { kind: "checkFailed"; detail: string }
  | { kind: "busy" }
  | { kind: "newRequest"; detail: string }
  | { kind: "lost" }
  | { kind: "copy" }
  | { kind: "core"; detail: string };

// The page's own words (T-189). Addresses, ports, logins, request IDs, the
// QR code and what Core says (a reason, a detail, an error, a note) are shown
// as they come.
const text = strings({
  badPort: (field: PortField) => `${field === "servePort" ? "The Serve port" : "Core's phone port"} must be a port from 1 to 65535.`,
  checkFailed: (detail: string) => `Check failed: ${detail}`,
  busy: "Another phone access change is already running; its progress is shown below.",
  newRequest: (detail: string) => `${detail}. Press again to send it as a new change.`,
  lost: "Core's answer did not arrive, so whether it started is not known. What Core recorded is shown below.",
  copyRefused: "Copying is not allowed here; select the address instead.",
  applying: "Applying",
  turningOff: "Turning it off",
  applied: "Applied. The status above is what Core reports now.",
  turnedOff: "Turned off.",
  sentence: (said: string) => `${said}.`,
  notVerified: "Set up, but not verified.",
  stopped: (what: string, at: string, why: string) => `${what} stopped at ${at}${why}.`,
  undone: (what: string, at: string, why: string) => `${what} stopped at ${at} and was undone${why}.`,
  uncertain: (at: string, why: string) => `Core could not confirm how ${at} ended${why}. Check, or apply again: Core compares with what is there first.`,
  interrupted: (at: string) => `Core stopped during ${at}. Check, or apply again: Core compares with what is there first.`,
  why: (error: string) => `: ${error}`,
  section: "Phone access settings",
  title: "Phone access",
  intro:
    "Open this Workspace from your phone through Tailscale on your private network. Yuzuno changes only its own Serve entry, and shows an address only once Core listens and the entry is its own.",
  asReported: "As Core reports it now",
  couldNotRead: (error: string) => `Could not read phone access: ${error}`,
  tryAgain: "Try again",
  startup: (error: string) => `When Core started, it could not serve the phone entry: ${error}`,
  coreRunsOn: "Core runs on",
  hostKinds: { wsl: "WSL", linux: "Linux", macos: "macOS", other: "Other" } as Record<"wsl" | "linux" | "macos" | "other", string>,
  networking: (mode: string) => ` · ${mode} networking`,
  tailscaleRunsOn: "Tailscale runs on",
  tailscaleNotChecked: "not checked yet",
  tailscaleStates: (state: "running" | "stopped" | "needsLogin" | "error", https: boolean, detail: string | undefined) =>
    ({
      running: https ? "running" : "running, HTTPS certificates off",
      stopped: "not running",
      needsLogin: "needs you to sign in",
      error: `could not be read${detail ? ` (${detail})` : ""}`,
    })[state],
  notFound: "Not found",
  allowedLogin: "Allowed login",
  notSet: "Not set",
  unsupported: (reason: string | null) =>
    `Phone access cannot be set up from here for this Core${reason ? `: ${reason}` : "."} Only a Workspace Core in WSL with Tailscale on Windows is supported.`,
  fromEnvironment:
    "This entry was set up outside Settings, from Core's environment. Save and apply with the same values takes it over without changing Serve.",
  environmentIgnored: "Core's environment also sets an entry; the saved settings decide, so it is ignored.",
  status: "Phone access status",
  verificationSteps: "Verification steps",
  stepLine: (step: string, state: string) => `${step}: ${state}`,
  stepStates: { ok: "ok", failed: "failed", skipped: "skipped" } as Record<"ok" | "failed" | "skipped", string>,
  address: "Phone address",
  copied: "Copied",
  copy: "Copy",
  unverifiedHelp: "Set up, but not verified: it may not open on your phone yet. The failed step is shown above.",
  openHelp: "Open it, or scan the code, on a phone signed in to the same tailnet.",
  qr: (url: string) => `QR code for ${url}`,
  latest: "Latest phone access change",
  notes: "Notes from Core",
  readOnly: "This page is open through the phone entry, so it cannot change it. Change it from Yuzuno on the computer.",
  advanced: "Advanced",
  servePort: "Serve port",
  servePortHelp: (port: number) => `The HTTPS port your phone opens. Empty: ${port}.`,
  localPort: "Core's phone port",
  localPortHelp: (port: number) => `A loopback port on the Core host, used only by Serve. Empty: ${port}.`,
  loginHelp: "The one tailnet login that may open it. Empty: Tailscale's own login.",
  willOpen: "Your phone will open ",
  checking: "Checking…",
  check: "Check",
  checkFirst: "Check first",
  starting: "Starting…",
  apply: "Save and apply",
  turnOff: "Turn off",
}, {
  badPort: (field) => `${field === "servePort" ? "Serve 端口" : "Core 的手机端口"}必须是 1 到 65535 之间的端口。`,
  checkFailed: (detail) => `检查失败：${detail}`,
  busy: "另一项手机访问更改正在进行；它的进度显示在下方。",
  newRequest: (detail) => `${detail}。再按一次即可作为新的更改发送。`,
  lost: "Core 的回答没有送达，因此不知道它是否已开始。下方显示的是 Core 记录的情况。",
  copyRefused: "这里不允许复制；请改为选中地址。",
  applying: "应用",
  turningOff: "关闭",
  applied: "已应用。上方状态是 Core 现在报告的情况。",
  turnedOff: "已关闭。",
  sentence: (said) => `${said}。`,
  notVerified: "已设置，但未验证。",
  stopped: (what, at, why) => `${what}在${at}停止${why}。`,
  undone: (what, at, why) => `${what}在${at}停止并已撤销${why}。`,
  uncertain: (at, why) => `Core 无法确认${at}的结果${why}。请检查，或再次应用：Core 会先与现有配置比较。`,
  interrupted: (at) => `Core 在${at}期间停止。请检查，或再次应用：Core 会先与现有配置比较。`,
  why: (error) => `：${error}`,
  section: "手机访问设置",
  title: "手机访问",
  intro: "通过你私有网络上的 Tailscale，从手机打开此 Workspace。Yuzuno 只更改它自己的 Serve 入口，并且只有在 Core 正在监听且该入口属于它时才显示地址。",
  asReported: "按 Core 现在的报告",
  couldNotRead: (error) => `无法读取手机访问：${error}`,
  tryAgain: "重试",
  startup: (error) => `Core 启动时无法提供手机入口：${error}`,
  coreRunsOn: "Core 运行于",
  hostKinds: { wsl: "WSL", linux: "Linux", macos: "macOS", other: "其他" },
  networking: (mode) => ` · ${mode} 网络模式`,
  tailscaleRunsOn: "Tailscale 运行于",
  tailscaleNotChecked: "尚未检查",
  tailscaleStates: (state, https, detail) =>
    ({
      running: https ? "运行中" : "运行中，HTTPS 证书未开启",
      stopped: "未运行",
      needsLogin: "需要你登录",
      error: `无法读取${detail ? `（${detail}）` : ""}`,
    })[state],
  notFound: "未找到",
  allowedLogin: "允许的登录",
  notSet: "未设置",
  unsupported: (reason) =>
    `无法从这里为此 Core 设置手机访问${reason ? `：${reason} ` : "。"}仅支持在 WSL 中运行、且 Tailscale 在 Windows 上的 Workspace Core。`,
  fromEnvironment: "此入口是在设置之外，通过 Core 的环境变量设置的。用相同的值“保存并应用”会接管它，不更改 Serve。",
  environmentIgnored: "Core 的环境变量也设置了一个入口；以已保存的设置为准，因此它被忽略。",
  status: "手机访问状态",
  verificationSteps: "验证步骤",
  stepLine: (step, state) => `${step}：${state}`,
  stepStates: { ok: "正常", failed: "失败", skipped: "已跳过" },
  address: "手机地址",
  copied: "已复制",
  copy: "复制",
  unverifiedHelp: "已设置，但未验证：它可能暂时无法在你的手机上打开。失败的步骤显示在上方。",
  openHelp: "在登录了同一 tailnet 的手机上打开它，或扫描二维码。",
  qr: (url) => `${url} 的二维码`,
  latest: "最近一次手机访问更改",
  notes: "Core 的说明",
  readOnly: "此页面是通过手机入口打开的，因此不能更改它。请在电脑上的 Yuzuno 中更改。",
  advanced: "高级",
  servePort: "Serve 端口",
  servePortHelp: (port) => `你的手机打开的 HTTPS 端口。留空：${port}。`,
  localPort: "Core 的手机端口",
  localPortHelp: (port) => `Core 主机上的回环端口，只供 Serve 使用。留空：${port}。`,
  loginHelp: "唯一可以打开它的 tailnet 登录。留空：使用 Tailscale 自己的登录。",
  willOpen: "你的手机将打开 ",
  checking: "正在检查…",
  check: "检查",
  checkFirst: "请先检查",
  starting: "正在开始…",
  apply: "保存并应用",
  turnOff: "关闭",
});

function draftOf(fields: Fields): RemoteAccessDraft | { badPort: PortField } {
  const port = (value: string) => {
    if (!value.trim()) return undefined;
    const n = Number(value.trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  const servePort = port(fields.servePort);
  if (servePort === null) return { badPort: "servePort" };
  const localPort = port(fields.localPort);
  if (localPort === null) return { badPort: "localPort" };
  return { enabled: true, servePort, localPort, login: fields.login.trim() || undefined };
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

/** What a line the page said reads as, in `language`. */
function saidText(said: Said, language: Language): string {
  const t = text(language);
  switch (said.kind) {
    case "port":
      return t.badPort(said.field);
    case "checkFailed":
      return t.checkFailed(said.detail);
    case "busy":
      return t.busy;
    case "newRequest":
      return t.newRequest(said.detail);
    case "lost":
      return t.lost;
    case "copy":
      return t.copyRefused;
    case "core":
      return said.detail;
  }
}

/** How the latest change ended, in a sentence; null while it runs. */
function outcome(op: RemoteAccessOperation, language: Language): string | null {
  const t = text(language);
  const at = `“${stepLabels(language).operation[op.step] ?? op.step}”`;
  const error = op.error?.replace(/[.。]\s*$/, "");
  const why = error ? t.why(error) : "";
  const what = op.kind === "apply" ? t.applying : t.turningOff;
  switch (op.state) {
    case "running":
      return null;
    case "succeeded":
      return op.kind === "apply" ? t.applied : t.turnedOff;
    case "failed":
      // Core's own sentence says what is set up and what was not verified.
      return op.step === "verify" ? (op.error ? t.sentence(error!) : t.notVerified) : t.stopped(what, at, why);
    case "rolledBack":
      return t.undone(what, at, why);
    case "uncertain":
      return t.uncertain(at, why);
    case "interrupted":
      return t.interrupted(at);
  }
}

/** Settings → Phone access (T-185): the phone's entry through Tailscale
 * Serve, for a Workspace Core in WSL with Tailscale on Windows. Opening it
 * only reads; Check reads Tailscale and Serve now; Save and apply and Turn
 * off are Core's own operations, each with a request ID kept in this browser
 * so that asking again after a lost answer is the same request, kept for
 * this Workspace only (T-195). Its parent gives each Workspace its own
 * instance, so nothing typed or asked in one is carried to another. */
export function RemoteAccessSettings({ active, workspaceId }: { active: boolean; workspaceId: string }) {
  const language = useLanguage();
  const t = text(language);
  const labels = stepLabels(language);
  const [view, setView] = useState<RemoteAccessView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [fields, setFields] = useState<Fields | null>(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Said | null>(null);
  const [said, setSaid] = useState(0);
  const errorLine = useRef<HTMLParagraphElement>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<Pending | null>(null);
  if (pending.current === null) pending.current = loadPending(workspaceId);

  const accept = useCallback((next: RemoteAccessView) => {
    setView(next);
    setLoadError("");
    // The page's retry key ends with the change it named: once Core has
    // recorded how it ended, trying again is a new request.
    const op = next.operation;
    if (pending.current && op?.requestId === pending.current.requestId && !running(op)) {
      pending.current = null;
      savePending(workspaceId, null);
    }
    // What is typed is never replaced by a later read.
    setFields((old) => old ?? fieldsOf(pending.current?.draft.enabled ? pending.current.draft : undefined, next));
  }, [workspaceId]);

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

  /** Says why something did not happen, and brings that line into view: on
   * a phone's screen it can be below the buttons that were pressed. */
  function say(line: Said) {
    setError(line);
    setSaid((n) => n + 1);
  }
  useEffect(() => {
    if (said) errorLine.current?.scrollIntoView?.({ block: "nearest" });
  }, [said]);

  function edit(change: Partial<Fields>) {
    setFields((old) => (old ? { ...old, ...change } : old));
    setError(null);
  }

  async function runCheck() {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      accept(await post<RemoteAccessView>("/remote-access/check", {}));
      setChecked(true);
    } catch (e) {
      say({ kind: "checkFailed", detail: readable(e) });
    } finally {
      setChecking(false);
    }
  }

  async function send(enabled: boolean) {
    // Until this window knows its Workspace, no change is asked: its request
    // could not be kept for asking again after a lost answer.
    if (!fields || sending || busy || !workspaceId) return;
    const draft = enabled ? draftOf(fields) : { enabled: false };
    if ("badPort" in draft) return say({ kind: "port", field: draft.badPort });
    // The same change asked again is the same request; anything else is new.
    const request: Pending =
      pending.current && JSON.stringify(pending.current.draft) === JSON.stringify(draft)
        ? pending.current
        : { requestId: newRequestId(), draft };
    pending.current = request;
    savePending(workspaceId, request);
    setSending(true);
    setError(null);
    try {
      const { operation: started } = await post<{ operation: RemoteAccessOperation }>("/remote-access/apply", {
        requestId: request.requestId,
        ...request.draft,
      });
      setView((old) => (old ? { ...old, operation: started } : old));
      // A change Core has already ended needs no retry key.
      if (!running(started)) {
        pending.current = null;
        savePending(workspaceId, null);
      }
    } catch (e) {
      if (refusal(e) === "remote_access_busy" || (e instanceof HttpError && e.status === 409)) {
        say({ kind: "busy" });
      } else if (refusal(e) === "idempotency_conflict") {
        // This request ID names another change in Core: the next try is new.
        pending.current = null;
        savePending(workspaceId, null);
        say({ kind: "newRequest", detail: readable(e) });
      } else if (e instanceof NetworkError) {
        say({ kind: "lost" });
      } else say({ kind: "core", detail: readable(e) });
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
      say({ kind: "copy" });
    }
  }

  const supported = view?.support.state === "supported";
  const host = view?.support.coreHost;
  const tailscale = view?.tailscale;
  const enabledNow = !!view && (!!view.saved?.enabled || !!view.listening || view.serve.state === "ours");
  const done = operation ? outcome(operation, language) : null;
  const unverified = !!view?.url && !!view.verification && !view.verification.ok;
  // What Save and apply would make, from the node Check read and the typed port.
  const typed = fields ? draftOf(fields) : null;
  const preview =
    view && typed && !("badPort" in typed)
      ? previewUrl(tailscale?.dnsName, typed.servePort ?? view.defaults.servePort)
      : null;
  const stepIndex = operation ? operationSteps.indexOf(operation.step) : -1;
  return (
    <section id="settings-remote" className="settings-section remote-access" aria-label={t.section}>
      <header className="settings-section-heading">
        <div>
          <h3>{t.title}</h3>
          <p>{t.intro}</p>
        </div>
        {view && (
          <span className="settings-current" title={t.asReported}>
            {badge(view, language)}
          </span>
        )}
      </header>
      {loadError && (
        <p className="updates-error" role="alert">
          {t.couldNotRead(loadError)}{" "}
          <button type="button" className="inline-link" onClick={() => void refresh()}>
            {t.tryAgain}
          </button>
        </p>
      )}
      {view?.startupError && (
        <p className="updates-error" role="alert">
          {t.startup(view.startupError)}
        </p>
      )}
      {view && (
        <>
          <dl className="settings-group remote-access-hosts">
            <div>
              <dt>{t.coreRunsOn}</dt>
              <dd>
                {t.hostKinds[host!.kind]} · {host!.name}
                {host!.networking && host!.networking !== "unknown" ? t.networking(host!.networking) : ""}
              </dd>
            </div>
            <div>
              <dt>{t.tailscaleRunsOn}</dt>
              <dd>
                {view.support.tailscaleHost.kind === "windows"
                  ? `Windows${tailscale?.dnsName ? ` · ${tailscale.dnsName}` : ""} · ${
                      !tailscale ? t.tailscaleNotChecked : t.tailscaleStates(tailscale.state, tailscale.https, tailscale.detail)
                    }`
                  : t.notFound}
              </dd>
            </div>
            <div>
              <dt>{t.allowedLogin}</dt>
              <dd>{view.saved?.login || view.listening?.login || tailscale?.ownerLogin || t.notSet}</dd>
            </div>
          </dl>
          {!supported && (
            <p className="remote-access-note" role="note">
              {t.unsupported(view.support.reason || null)}
            </p>
          )}
          {view.environment && !view.saved && (
            <p className="remote-access-note" role="note">
              {t.fromEnvironment}
            </p>
          )}
          {view.environment?.ignored && (
            <p className="remote-access-note" role="note">
              {t.environmentIgnored}
            </p>
          )}
          <ul className="remote-access-states" aria-label={t.status}>
            {stateLines(view, language).map((line) => (
              <li key={line.label} data-tone={line.tone}>
                <span className="remote-access-state-label">{line.label}</span>
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
          {view.verification && !view.verification.ok && (
            <details className="remote-access-verification">
              <summary>{t.verificationSteps}</summary>
              <ol>
                {view.verification.steps.map((step) => (
                  <li key={step.id} data-state={step.state}>
                    {t.stepLine(labels.verification[step.id] ?? step.id, t.stepStates[step.state] ?? step.state)}
                    {step.detail ? ` · ${step.detail}` : ""}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {view.url && (
            <div className="remote-access-result" aria-label={t.address}>
              <div>
                <a href={view.url} target="_blank" rel="noreferrer">
                  {view.url}
                </a>
                <button type="button" className="secondary-button" onClick={() => void copy(view.url!)}>
                  {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                  {copied ? t.copied : t.copy}
                </button>
                <p className="settings-row-help">
                  {unverified ? t.unverifiedHelp : t.openHelp}
                </p>
              </div>
              {view.qr && (
                <svg
                  className="remote-access-qr"
                  role="img"
                  aria-label={t.qr(view.url)}
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
            <div className="remote-access-operation" aria-label={t.latest}>
              {busy && (
                <ol className="remote-access-steps">
                  {operationSteps.map((step, index) => (
                    <li key={step} data-state={index < stepIndex ? "done" : index === stepIndex ? "running" : "pending"}>
                      {labels.operation[step]}
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
                <ul className="remote-access-notes" aria-label={t.notes}>
                  {operation.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {supported && !view.canChange && (
            <p className="remote-access-note" role="note">
              {view.readOnlyReason || t.readOnly}
            </p>
          )}
          {supported && view.canChange && fields && (
            <div className="settings-group remote-access-form">
              <details className="remote-access-advanced">
                <summary>{t.advanced}</summary>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">{t.servePort}</span>
                    <span className="settings-row-help">{t.servePortHelp(view.defaults.servePort)}</span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label={t.servePort}
                    placeholder={String(view.defaults.servePort)}
                    value={fields.servePort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ servePort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">{t.localPort}</span>
                    <span className="settings-row-help">{t.localPortHelp(view.defaults.localPort)}</span>
                  </span>
                  <input
                    className="settings-select"
                    inputMode="numeric"
                    aria-label={t.localPort}
                    placeholder={String(view.defaults.localPort)}
                    value={fields.localPort}
                    disabled={sending || busy}
                    onChange={(e) => edit({ localPort: e.target.value })}
                  />
                </label>
                <label className="settings-row">
                  <span className="settings-row-main">
                    <span className="settings-row-title">{t.allowedLogin}</span>
                    <span className="settings-row-help">{t.loginHelp}</span>
                  </span>
                  <input
                    className="settings-select"
                    aria-label={t.allowedLogin}
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
                  {t.willOpen}
                  <strong>{preview}</strong>
                </p>
              )}
              <div className="settings-row settings-row-end remote-access-actions">
                <div className="settings-row-action">
                  <button type="button" className="secondary-button" disabled={checking || sending || busy} onClick={() => void runCheck()}>
                    {checking ? t.checking : t.check}
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    title={checked ? undefined : t.checkFirst}
                    disabled={!checked || sending || busy || !workspaceId}
                    onClick={() => void send(true)}
                  >
                    {sending ? t.starting : t.apply}
                  </button>
                  {enabledNow && (
                    <button type="button" className="secondary-button" disabled={sending || busy || !workspaceId} onClick={() => void send(false)}>
                      {t.turnOff}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {error && (
            <p className="updates-error" role="alert" ref={errorLine}>
              {saidText(error, language)}
            </p>
          )}
          {supported && view.preview && (
            <RemoteAccessPreviews
              preview={view.preview}
              canChange={view.canChange}
              workspaceId={workspaceId}
              phoneBusy={busy || sending}
              refresh={refresh}
            />
          )}
        </>
      )}
    </section>
  );
}
