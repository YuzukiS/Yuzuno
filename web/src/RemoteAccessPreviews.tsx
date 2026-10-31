import { useEffect, useRef, useState } from "react";
import { api, errorText, HttpError, NetworkError, post } from "./api";
import { strings, useLanguage, type Language } from "./i18n";
import {
  loadPending,
  newRequestId,
  operationSteps,
  previewLines,
  previewStepLabels,
  running,
  savePending,
  type Pending,
  type PreviewDraft,
  type RemoteAccessOperation,
  type RemoteAccessPreview,
} from "./remote-access";

type Fields = { servePort: string; localPort: string };
type PortField = keyof Fields;
type Said =
  | { kind: "port"; field: PortField }
  | { kind: "busy" }
  | { kind: "newRequest"; detail: string }
  | { kind: "lost" }
  | { kind: "progress"; detail: string }
  | { kind: "core"; detail: string };

// The section's own words (T-189); ports, addresses and what Core says are shown as they come.
const text = strings({
  title: "Previews on the phone",
  intro:
    "A single HTML file opened from the phone runs as an isolated preview at an address of its own: another Serve port of this computer's tailnet name, for previews only. Off until you turn it on.",
  section: "Phone previews settings",
  status: "Phone previews status",
  address: "Previews open at ",
  needsPhone: "Turn on phone access first: previews open through it.",
  startup: (error: string) => `When Core started, it could not serve phone previews: ${error}`,
  verificationSteps: "Verification steps",
  stepLine: (step: string, state: string) => `${step}: ${state}`,
  stepStates: { ok: "ok", failed: "failed", skipped: "skipped" } as Record<"ok" | "failed" | "skipped", string>,
  latest: "Latest phone previews change",
  notes: "Notes from Core",
  advanced: "Previews' ports",
  servePort: "Previews' Serve port",
  servePortHelp: (port: number) => `The HTTPS port previews open on, beside the phone entry's. Empty: ${port}.`,
  localPort: "Core's previews port",
  localPortHelp: (port: number) => `A loopback port on the Core host, used only by Serve. Empty: ${port}.`,
  badPort: (field: PortField) => `${field === "servePort" ? "The previews' Serve port" : "Core's previews port"} must be a port from 1 to 65535.`,
  busy: "Another phone access change is already running; its progress is shown above.",
  newRequest: (detail: string) => `${detail}. Press again to send it as a new change.`,
  lost: "Core's answer did not arrive, so whether it started is not known. What Core recorded is shown here.",
  progress: (detail: string) => `The change's progress could not be read (${detail}); trying again.`,
  turnOn: "Turn on previews",
  turnOff: "Turn off previews",
  starting: "Starting…",
  operationSteps: {
    validate: "Check the settings and the Serve port",
    save: "Save them",
    listen: "Core listens on the previews' port",
    serve: "Tailscale Serve points to it",
    verify: "Reach it from the tailnet",
    done: "Done",
  } as Record<RemoteAccessOperation["step"], string>,
  on: "Turning previews on",
  off: "Turning previews off",
  applied: "Previews are on. An HTML file opened from the phone now shows working.",
  turnedOff: "Previews are off.",
  sentence: (said: string) => `${said}.`,
  notVerified: "On, but not verified.",
  stopped: (what: string, at: string, why: string) => `${what} stopped at ${at}${why}.`,
  undone: (what: string, at: string, why: string) => `${what} stopped at ${at} and was undone${why}.`,
  uncertain: (at: string, why: string) => `Core could not confirm how ${at} ended${why}. Check, or turn previews on again: Core compares with what is there first.`,
  interrupted: (at: string) => `Core stopped during ${at}. Check, or turn previews on again: Core compares with what is there first.`,
  why: (error: string) => `: ${error}`,
}, {
  title: "手机上的预览",
  intro: "从手机打开的单个 HTML 文件，会在自己的地址上作为隔离预览运行：此电脑 tailnet 名称上的另一个 Serve 端口，只用于预览。打开前保持关闭。",
  section: "手机预览设置",
  status: "手机预览状态",
  address: "预览地址 ",
  needsPhone: "请先开启手机访问：预览通过它打开。",
  startup: (error) => `Core 启动时无法提供手机预览：${error}`,
  verificationSteps: "验证步骤",
  stepLine: (step, state) => `${step}：${state}`,
  stepStates: { ok: "正常", failed: "失败", skipped: "已跳过" },
  latest: "最近一次手机预览更改",
  notes: "Core 的说明",
  advanced: "预览的端口",
  servePort: "预览的 Serve 端口",
  servePortHelp: (port) => `预览打开的 HTTPS 端口，与手机入口的端口不同。留空：${port}。`,
  localPort: "Core 的预览端口",
  localPortHelp: (port) => `Core 主机上的回环端口，只供 Serve 使用。留空：${port}。`,
  badPort: (field) => `${field === "servePort" ? "预览的 Serve 端口" : "Core 的预览端口"}必须是 1 到 65535 之间的端口。`,
  busy: "另一项手机访问更改正在进行；它的进度显示在上方。",
  newRequest: (detail) => `${detail}。再按一次即可作为新的更改发送。`,
  lost: "Core 的回答没有送达，因此不知道它是否已开始。这里显示的是 Core 记录的情况。",
  progress: (detail) => `无法读取这项更改的进度（${detail}）；正在重试。`,
  turnOn: "开启预览",
  turnOff: "关闭预览",
  starting: "正在开始…",
  operationSteps: {
    validate: "检查设置和 Serve 端口",
    save: "保存设置",
    listen: "Core 在预览端口上监听",
    serve: "Tailscale Serve 指向它",
    verify: "从 tailnet 访问它",
    done: "完成",
  },
  on: "开启预览",
  off: "关闭预览",
  applied: "预览已开启。现在从手机打开的 HTML 文件会以可运行的方式显示。",
  turnedOff: "预览已关闭。",
  sentence: (said) => `${said}。`,
  notVerified: "已开启，但未验证。",
  stopped: (what, at, why) => `${what}在${at}停止${why}。`,
  undone: (what, at, why) => `${what}在${at}停止并已撤销${why}。`,
  uncertain: (at, why) => `Core 无法确认${at}的结果${why}。请检查，或再次开启预览：Core 会先与现有配置比较。`,
  interrupted: (at) => `Core 在${at}期间停止。请检查，或再次开启预览：Core 会先与现有配置比较。`,
  why: (error) => `：${error}`,
});

function draftOf(fields: Fields): PreviewDraft | { badPort: PortField } {
  const port = (value: string) => {
    if (!value.trim()) return undefined;
    const n = Number(value.trim());
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  };
  const servePort = port(fields.servePort);
  if (servePort === null) return { badPort: "servePort" };
  const localPort = port(fields.localPort);
  if (localPort === null) return { badPort: "localPort" };
  return { enabled: true, servePort, localPort };
}

const refusal = (e: unknown) => (e instanceof HttpError ? /^([a-z_]+): /.exec(e.message)?.[1] : undefined);
const readable = (e: unknown) => (refusal(e) ? (e as Error).message.replace(/^[a-z_]+: /, "") : errorText(e));

function saidText(said: Said, language: Language): string {
  const t = text(language);
  switch (said.kind) {
    case "port":
      return t.badPort(said.field);
    case "busy":
      return t.busy;
    case "newRequest":
      return t.newRequest(said.detail);
    case "lost":
      return t.lost;
    case "progress":
      return t.progress(said.detail);
    case "core":
      return said.detail;
  }
}

/** How the latest change ended, in a sentence; null while it runs. */
function outcome(op: RemoteAccessOperation, language: Language): string | null {
  const t = text(language);
  const at = `“${t.operationSteps[op.step] ?? op.step}”`;
  const error = op.error?.replace(/[.。]\s*$/, "");
  const why = error ? t.why(error) : "";
  const what = op.kind === "apply" ? t.on : t.off;
  switch (op.state) {
    case "running":
      return null;
    case "succeeded":
      return op.kind === "apply" ? t.applied : t.turnedOff;
    case "failed":
      return op.step === "verify" ? (op.error ? t.sentence(error!) : t.notVerified) : t.stopped(what, at, why);
    case "rolledBack":
      return t.undone(what, at, why);
    case "uncertain":
      return t.uncertain(at, why);
    case "interrupted":
      return t.interrupted(at);
  }
}

/** Settings → Phone access → Previews on the phone (T-5). Opening it only
 * reads; turning previews on or off is Core's own operation, with a request
 * ID kept in this browser for this Workspace, as phone access's is. Core
 * checks the previews' Serve port before it changes anything, and a change
 * here never touches the phone entry. Check (above) reads both. */
export function RemoteAccessPreviews({
  preview,
  canChange,
  workspaceId,
  phoneBusy,
  refresh,
}: {
  preview: RemoteAccessPreview;
  canChange: boolean;
  workspaceId: string;
  /** A phone access change is running: Core takes one change at a time. */
  phoneBusy: boolean;
  refresh: () => Promise<void>;
}) {
  const language = useLanguage();
  const t = text(language);
  const steps = previewStepLabels(language);
  const pending = useRef<Pending | null>(null);
  if (pending.current === null) pending.current = loadPending(workspaceId, "previewPending");
  const [fields, setFields] = useState<Fields>(() => {
    const kept = pending.current?.draft.enabled ? pending.current.draft : undefined;
    return {
      servePort: String(kept?.servePort ?? preview.saved?.servePort ?? ""),
      localPort: String(kept?.localPort ?? preview.saved?.localPort ?? ""),
    };
  });
  // The change this page started, while Core runs it; then the view's own.
  const [started, setStarted] = useState<RemoteAccessOperation | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Said | null>(null);
  // Bumped when a progress read fails, so the next read is tried.
  const [retries, setRetries] = useState(0);
  const operation = started ?? preview.operation;
  const busy = running(operation);

  // The retry key ends with the change it named, once Core recorded how it ended.
  const last = preview.operation;
  useEffect(() => {
    if (pending.current && last?.requestId === pending.current.requestId && !running(last)) {
      pending.current = null;
      savePending(workspaceId, null, "previewPending");
    }
  }, [last, workspaceId]);
  // Once a read of the whole view (Check, say) has the change ended, it is the view's.
  useEffect(() => {
    if (started && last?.id === started.id && !running(last)) setStarted(null);
  }, [last, started]);

  // While a change runs, its progress is read about once a second, and again
  // after a read that fails; once it has ended, the whole view is read again.
  useEffect(() => {
    if (!operation || !busy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const op = await api<RemoteAccessOperation>(`/remote-access/preview/operations/${encodeURIComponent(operation.id)}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setError((said) => (said?.kind === "progress" ? null : said));
        if (running(op)) setStarted(op);
        else {
          await refresh();
          if (!controller.signal.aborted) setStarted(null);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setError({ kind: "progress", detail: errorText(e) });
        setRetries((n) => n + 1);
      }
    }, 1000);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [busy, operation, refresh, retries]);

  function edit(change: Partial<Fields>) {
    setFields((old) => ({ ...old, ...change }));
    setError(null);
  }

  async function send(enabled: boolean) {
    if (sending || busy || phoneBusy || !workspaceId) return;
    const draft = enabled ? draftOf(fields) : { enabled: false };
    if ("badPort" in draft) return setError({ kind: "port", field: draft.badPort });
    const request: Pending =
      pending.current && JSON.stringify(pending.current.draft) === JSON.stringify(draft)
        ? pending.current
        : { requestId: newRequestId("previews"), draft };
    pending.current = request;
    savePending(workspaceId, request, "previewPending");
    setSending(true);
    setError(null);
    try {
      const { operation: op } = await post<{ operation: RemoteAccessOperation }>("/remote-access/preview", {
        requestId: request.requestId,
        ...request.draft,
      });
      if (running(op)) setStarted(op);
      else {
        pending.current = null;
        savePending(workspaceId, null, "previewPending");
        await refresh();
      }
    } catch (e) {
      if (refusal(e) === "remote_access_busy") setError({ kind: "busy" });
      else if (refusal(e) === "idempotency_conflict") {
        pending.current = null;
        savePending(workspaceId, null, "previewPending");
        setError({ kind: "newRequest", detail: readable(e) });
      } else if (e instanceof NetworkError) setError({ kind: "lost" });
      else setError({ kind: "core", detail: readable(e) });
      await refresh();
    } finally {
      setSending(false);
    }
  }

  const { saved, listening, verification, defaults } = preview;
  const on = !!saved?.enabled || !!listening;
  // A turning off that could not remove their Serve entry leaves it Core's,
  // to remove on the next try: it can be turned off until it is gone.
  const unfinished = operation?.kind === "disable" && ["failed", "uncertain", "interrupted"].includes(operation.state);
  const removable = on || preview.serve.state === "ours" || unfinished;
  const done = operation ? outcome(operation, language) : null;
  const stepIndex = operation ? operationSteps.indexOf(operation.step) : -1;
  const locked = sending || busy || phoneBusy || !workspaceId;
  return (
    <div className="remote-access-previews" role="group" aria-label={t.section}>
      <div>
        <h4>{t.title}</h4>
        <p className="settings-row-help">{t.intro}</p>
      </div>
      {preview.startupError && (
        <p className="updates-error" role="alert">
          {t.startup(preview.startupError)}
        </p>
      )}
      <ul className="remote-access-states" aria-label={t.status}>
        {previewLines(preview, language).map((line) => (
          <li key={line.label} data-tone={line.tone}>
            <span className="remote-access-state-label">{line.label}</span>
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
      {verification && !verification.ok && (on || preview.serve.state === "conflict") && (
        <details className="remote-access-verification">
          <summary>{t.verificationSteps}</summary>
          <ol>
            {verification.steps.map((step) => (
              <li key={step.id} data-state={step.state}>
                {t.stepLine(steps[step.id] ?? step.id, t.stepStates[step.state] ?? step.state)}
                {step.detail ? ` · ${step.detail}` : ""}
              </li>
            ))}
          </ol>
        </details>
      )}
      {preview.url && (
        <p className="remote-access-note">
          {t.address}
          <strong>{preview.url}</strong>
        </p>
      )}
      {operation && (
        <div className="remote-access-operation" aria-label={t.latest}>
          {busy && (
            <ol className="remote-access-steps">
              {operationSteps.map((step, index) => (
                <li key={step} data-state={index < stepIndex ? "done" : index === stepIndex ? "running" : "pending"}>
                  {t.operationSteps[step]}
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
      {canChange && !preview.available && !removable && (
        <p className="remote-access-note" role="note">
          {t.needsPhone}
        </p>
      )}
      {canChange && (preview.available || removable) && (
        <div className="settings-group remote-access-form">
          {preview.available && (
            <details className="remote-access-advanced">
              <summary>{t.advanced}</summary>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.servePort}</span>
                  <span className="settings-row-help">{t.servePortHelp(defaults.servePort)}</span>
                </span>
                <input
                  className="settings-select"
                  inputMode="numeric"
                  aria-label={t.servePort}
                  placeholder={String(defaults.servePort)}
                  value={fields.servePort}
                  disabled={locked}
                  onChange={(e) => edit({ servePort: e.target.value })}
                />
              </label>
              <label className="settings-row">
                <span className="settings-row-main">
                  <span className="settings-row-title">{t.localPort}</span>
                  <span className="settings-row-help">{t.localPortHelp(defaults.localPort)}</span>
                </span>
                <input
                  className="settings-select"
                  inputMode="numeric"
                  aria-label={t.localPort}
                  placeholder={String(defaults.localPort)}
                  value={fields.localPort}
                  disabled={locked}
                  onChange={(e) => edit({ localPort: e.target.value })}
                />
              </label>
            </details>
          )}
          <div className="settings-row settings-row-end remote-access-actions">
            <div className="settings-row-action">
              {preview.available && (
                <button type="button" className="primary-button" disabled={locked} onClick={() => void send(true)}>
                  {sending ? t.starting : t.turnOn}
                </button>
              )}
              {removable && (
                <button type="button" className="secondary-button" disabled={locked} onClick={() => void send(false)}>
                  {t.turnOff}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {error && (
        <p className="updates-error" role="alert">
          {saidText(error, language)}
        </p>
      )}
    </div>
  );
}
