// T-185: Settings → Phone access. What Core says about the phone's entry,
// as `GET /api/remote-access` answers (T-185 interface v1, comment 6798),
// and the few rules the page keeps itself. Saved settings, what Core listens
// on, Tailscale Serve and the last verification are four separate facts: the
// page never shows one for another.

import { strings, type Language } from "./i18n";

export type VerificationStep = {
  id: "host" | "tailscale" | "https" | "listener" | "hop" | "serve" | "endToEnd";
  state: "ok" | "failed" | "skipped";
  detail: string;
};

export type RemoteAccessOperation = {
  id: string;
  requestId: string;
  kind: "apply" | "disable";
  state: "running" | "succeeded" | "failed" | "rolledBack" | "uncertain" | "interrupted";
  step: "validate" | "save" | "listen" | "serve" | "verify" | "done";
  error?: string;
  /** Sentences Core adds about what it did, such as an entry it took over. */
  notes?: string[];
  startedAt: string;
  finishedAt?: string;
  url?: string;
};

export type RemoteAccessView = {
  support: {
    state: "supported" | "unsupported";
    reason?: string | null;
    coreHost: { kind: "wsl" | "linux" | "macos" | "other"; name: string; networking?: "mirrored" | "nat" | "unknown" };
    tailscaleHost: { kind: "windows" | "none"; cli?: string; version?: string };
  };
  saved: null | {
    enabled: boolean;
    login: string;
    servePort: number;
    localPort: number;
    origin: string | null;
    savedAt: string;
    /** false: saved, but its last apply failed or is still running. */
    applied: boolean;
  };
  environment: null | { port: number; origin: string; login: string; ignored: boolean };
  listening: null | { port: number; origin: string; login: string; since: string; source: "settings" | "environment" };
  serve: {
    state: "unchecked" | "absent" | "ours" | "sameTargetNotRecorded" | "conflict" | "error";
    port?: number;
    target?: string;
    otherEntries: number;
    detail?: string;
    observedAt?: string;
  };
  tailscale: null | {
    state: "running" | "stopped" | "needsLogin" | "error";
    dnsName?: string;
    ownerLogin?: string;
    https: boolean;
    detail?: string;
    observedAt: string;
  };
  verification: null | { ok: boolean; at: string; steps: VerificationStep[] };
  operation: RemoteAccessOperation | null;
  /** Only when Core listens and the Serve entry is Yuzuno's. */
  url: string | null;
  /** Why Core could not serve the applied entry when it started, if so. */
  startupError?: string | null;
  /** The QR code's modules for `url`, '1' dark, when Core gives them. */
  qr?: { size: number; rows: string[] } | null;
  defaults: { servePort: number; localPort: number };
  /** false on the phone entry itself: a phone cannot lock itself out. */
  canChange: boolean;
  /** Why it cannot be changed here, when `canChange` is false. */
  readOnlyReason?: string | null;
  /** Phone previews (T-5); a Core from before them sends none. */
  preview?: RemoteAccessPreview;
};

/** Phone previews (T-5): single-file HTML previews opened through the
 * phone entry are served by an entry of their own, another Serve port of
 * the same tailnet name. The same four facts as the phone entry's. */
export type PreviewStep = { id: "listener" | "hop" | "serve" | "endToEnd"; state: "ok" | "failed" | "skipped"; detail: string };
export type RemoteAccessPreview = {
  saved: null | { enabled: boolean; servePort: number; localPort: number; savedAt: string; applied: boolean };
  listening: null | { port: number; servePort: number; since: string };
  serve: { state: RemoteAccessView["serve"]["state"]; port?: number; target?: string; detail?: string; observedAt?: string };
  verification: null | { ok: boolean; at: string; steps: PreviewStep[] };
  operation: RemoteAccessOperation | null;
  /** Only while they listen, their Serve entry is Yuzuno's and phone access is on. */
  url: string | null;
  startupError?: string | null;
  defaults: { servePort: number; localPort: number };
  /** Whether phone access is on, which previews go through. */
  available: boolean;
};
/** What turning previews on or off sends besides its request ID. */
export type PreviewDraft = { enabled: boolean; servePort?: number; localPort?: number };

/** What Save and apply sends besides its request ID. */
export type RemoteAccessDraft = { enabled: boolean; login?: string; servePort?: number; localPort?: number };

export function running(operation: RemoteAccessOperation | null | undefined): boolean {
  return operation?.state === "running";
}

export const operationSteps: RemoteAccessOperation["step"][] = ["validate", "save", "listen", "serve", "verify"];

// What these facts are called, in the interface language (T-189). What Core
// says (a detail, a reason, an address, a login, a target) is shown as it
// comes. Each helper is in English unless the page passes its language.
const words = strings({
  operationSteps: {
    validate: "Check the settings",
    save: "Save them",
    listen: "Core listens on the phone's port",
    serve: "Tailscale Serve points to it",
    verify: "Reach it from the tailnet",
    done: "Done",
  } as Record<RemoteAccessOperation["step"], string>,
  verificationSteps: {
    host: "Core's host",
    tailscale: "Tailscale on Windows",
    https: "HTTPS certificates",
    listener: "Core's phone port",
    hop: "From Windows to Core",
    serve: "Tailscale Serve",
    endToEnd: "The whole way",
  } as Record<VerificationStep["id"], string>,
  badge: { on: "On", notVerified: "Not verified", notApplied: "Not applied", notChecked: "Not checked", incomplete: "Incomplete", off: "Off" },
  savedLabel: "Saved settings",
  nothingSaved: "Nothing saved",
  savedOff: "Saved as off",
  savedOn: (origin: string | null, login: string, applied: boolean) =>
    `On · ${origin ?? "no address yet"} · ${login}${applied ? "" : " · not applied"}`,
  listeningLabel: "Core listening",
  listeningOn: (port: number, origin: string, environment: boolean) =>
    `On, port ${port} for ${origin}${environment ? " · from Core's environment" : ""}`,
  notListening: "Not listening for the phone",
  serveLabel: "Tailscale Serve",
  others: (n: number) => ` · ${n} other ${n === 1 ? "entry left as it is" : "entries left as they are"}`,
  conflict: (port: string) => `Port ${port} is used by another Serve entry; Yuzuno leaves it as it is`,
  notChecked: "Not checked yet",
  absent: "No Yuzuno entry",
  ours: (port: string, target: string | undefined) => `Yuzuno's entry on port ${port}${target ? ` → ${target}` : ""}`,
  sameTarget: (port: string) => `An entry on port ${port} points to Core, but Settings did not make it`,
  serveError: (detail: string | undefined) => `Could not be read${detail ? ` (${detail})` : ""}`,
  verificationLabel: "Verification",
  portTaken: (port: string) => `Not ready: port ${port} is taken; choose another Serve port under Advanced`,
  notReady: (step: string, detail: string) => `Not ready: “${step}”${detail ? `: ${detail}` : ""}`,
  readyNotSetUp: "Not set up; Core's host, Tailscale and HTTPS are ready",
  notSetUp: "Not set up",
  reached: "Reached from the tailnet",
  failedAt: (step: string | null, detail: string) => `Failed at “${step ?? "a step"}”${detail ? `: ${detail}` : ""}`,
}, {
  operationSteps: {
    validate: "检查设置",
    save: "保存设置",
    listen: "Core 在手机端口上监听",
    serve: "Tailscale Serve 指向它",
    verify: "从 tailnet 访问它",
    done: "完成",
  },
  verificationSteps: {
    host: "Core 的主机",
    tailscale: "Windows 上的 Tailscale",
    https: "HTTPS 证书",
    listener: "Core 的手机端口",
    hop: "从 Windows 到 Core",
    serve: "Tailscale Serve",
    endToEnd: "完整链路",
  },
  badge: { on: "开启", notVerified: "未验证", notApplied: "未应用", notChecked: "未检查", incomplete: "未完成", off: "关闭" },
  savedLabel: "已保存的设置",
  nothingSaved: "未保存任何设置",
  savedOff: "已保存为关闭",
  savedOn: (origin, login, applied) => `开启 · ${origin ?? "尚无地址"} · ${login}${applied ? "" : " · 未应用"}`,
  listeningLabel: "Core 监听",
  listeningOn: (port, origin, environment) => `开启，端口 ${port}，用于 ${origin}${environment ? " · 来自 Core 的环境变量" : ""}`,
  notListening: "未为手机监听",
  serveLabel: "Tailscale Serve",
  others: (n) => ` · 另有 ${n} 个入口保持原样`,
  conflict: (port) => `端口 ${port} 被另一个 Serve 入口占用；Yuzuno 保持它原样`,
  notChecked: "尚未检查",
  absent: "没有 Yuzuno 的入口",
  ours: (port, target) => `Yuzuno 的入口，端口 ${port}${target ? ` → ${target}` : ""}`,
  sameTarget: (port) => `端口 ${port} 上有一个指向 Core 的入口，但它不是由设置创建的`,
  serveError: (detail) => `无法读取${detail ? `（${detail}）` : ""}`,
  verificationLabel: "验证",
  portTaken: (port) => `尚未就绪：端口 ${port} 已被占用；请在“高级”中选择另一个 Serve 端口`,
  notReady: (step, detail) => `尚未就绪：“${step}”${detail ? `：${detail}` : ""}`,
  readyNotSetUp: "尚未设置；Core 的主机、Tailscale 和 HTTPS 已就绪",
  notSetUp: "尚未设置",
  reached: "已从 tailnet 访问到",
  failedAt: (step, detail) => `在“${step ?? "某一步"}”失败${detail ? `：${detail}` : ""}`,
});

/** What each step is called, in `language`; English unless a page passes one. */
export const stepLabels = (language: Language = "en") => {
  const w = words(language);
  return { operation: w.operationSteps, verification: w.verificationSteps };
};
export const operationStepLabels = stepLabels().operation;
export const verificationStepLabels = stepLabels().verification;

/** One line per fact, as the page shows it; `tone` says how it reads. */
export type StateLine = { label: string; text: string; tone: "on" | "off" | "warn" | "unknown" };

/** Whether the entry is set up: Core listens for it, or an applied saving says so. */
export function setUp(view: RemoteAccessView): boolean {
  return !!view.listening || (!!view.saved?.enabled && view.saved.applied);
}

/** The steps that say whether the host is ready, before anything is set up:
 * the host, Tailscale and HTTPS, and Serve when another entry holds the port. */
const readiness: VerificationStep["id"][] = ["host", "tailscale", "https", "serve"];

/** What the badge beside the title says, from the view alone. */
export function badge(view: RemoteAccessView, language: Language = "en"): string {
  const b = words(language).badge;
  if (view.url) return view.verification && !view.verification.ok ? b.notVerified : b.on;
  if (view.saved?.enabled && !view.saved.applied && !view.listening) return b.notApplied;
  if (view.listening && view.serve.state === "unchecked") return b.notChecked;
  return view.saved?.enabled || view.listening || view.serve.state === "ours" ? b.incomplete : b.off;
}

export function stateLines(view: RemoteAccessView, language: Language = "en"): StateLine[] {
  const w = words(language);
  const named = (id: VerificationStep["id"]) => w.verificationSteps[id] ?? id;
  const { saved, listening, serve, verification } = view;
  const failed = verification?.steps.find((step) => step.state === "failed");
  // Before anything is set up, Core's phone port, the hop and the whole way
  // fail by design; only the readiness steps say whether it can be set up.
  // Serve is skipped while its port is free, so it need not be ok.
  const unready = verification?.steps.find((step) => readiness.includes(step.id) && step.state === "failed");
  const ready = (["host", "tailscale", "https"] as const).every((id) =>
    verification?.steps.some((step) => step.id === id && step.state === "ok"),
  );
  const notYet = !!verification && !verification.ok && !setUp(view);
  const others = serve.otherEntries > 0 ? w.others(serve.otherEntries) : "";
  const port = String(serve.port ?? "?");
  return [
    {
      label: w.savedLabel,
      text: !saved ? w.nothingSaved : !saved.enabled ? w.savedOff : w.savedOn(saved.origin, saved.login, saved.applied),
      tone: !saved || !saved.enabled ? "off" : saved.applied ? "on" : "warn",
    },
    {
      label: w.listeningLabel,
      text: listening ? w.listeningOn(listening.port, listening.origin, listening.source === "environment") : w.notListening,
      tone: listening ? "on" : "off",
    },
    {
      label: w.serveLabel,
      // For a conflict Core's detail is the whole sentence, with where the
      // other entry sends requests; for an error it is the reason. For
      // Yuzuno's own entry it would repeat the line.
      text:
        serve.state === "conflict"
          ? serve.detail ?? w.conflict(port)
          : {
              unchecked: w.notChecked,
              absent: w.absent,
              ours: w.ours(port, serve.target),
              sameTargetNotRecorded: w.sameTarget(port),
              error: w.serveError(serve.detail),
            }[serve.state] + others,
      tone:
        serve.state === "ours" ? "on" : serve.state === "absent" ? "off" : serve.state === "unchecked" ? "unknown" : "warn",
    },
    notYet
      ? {
          label: w.verificationLabel,
          // A Serve port taken by another entry is said on the Serve line;
          // here, what to do about it.
          text: unready?.id === "serve" && serve.state === "conflict"
            ? w.portTaken(port)
            : unready
              ? w.notReady(named(unready.id), unready.detail)
              : ready
                ? w.readyNotSetUp
                : w.notSetUp,
          tone: unready ? "warn" : "off",
        }
      : {
          label: w.verificationLabel,
          text: !verification
            ? w.notChecked
            : verification.ok
              ? w.reached
              : w.failedAt(failed ? named(failed.id) : null, failed?.detail ?? ""),
          tone: !verification ? "unknown" : verification.ok ? "on" : "warn",
        },
  ];
}

const previewWords = strings({
  steps: {
    listener: "Core's previews port",
    hop: "From Windows to Core",
    serve: "Tailscale Serve",
    endToEnd: "The whole way",
  } as Record<PreviewStep["id"], string>,
  savedOn: (servePort: number, applied: boolean) => `On · Serve port ${servePort}${applied ? "" : " · not applied"}`,
  listeningOn: (port: number, servePort: number) => `On, port ${port} for Serve port ${servePort}`,
  notListening: "Not listening for previews",
}, {
  steps: {
    listener: "Core 的预览端口",
    hop: "从 Windows 到 Core",
    serve: "Tailscale Serve",
    endToEnd: "完整链路",
  },
  savedOn: (servePort, applied) => `开启 · Serve 端口 ${servePort}${applied ? "" : " · 未应用"}`,
  listeningOn: (port, servePort) => `开启，端口 ${port}，用于 Serve 端口 ${servePort}`,
  notListening: "未为预览监听",
});

export const previewStepLabels = (language: Language = "en") => previewWords(language).steps;

/** Phone previews' facts, one per line, as the phone entry's are shown. */
export function previewLines(preview: RemoteAccessPreview, language: Language = "en"): StateLine[] {
  const w = words(language);
  const p = previewWords(language);
  const { saved, listening, serve, verification } = preview;
  const failed = verification?.steps.find((step) => step.state === "failed");
  const setUp = !!listening || (!!saved?.enabled && saved.applied);
  const port = String(serve.port ?? "?");
  return [
    {
      label: w.savedLabel,
      text: !saved ? w.nothingSaved : !saved.enabled ? w.savedOff : p.savedOn(saved.servePort, saved.applied),
      tone: !saved || !saved.enabled ? "off" : saved.applied ? "on" : "warn",
    },
    {
      label: w.listeningLabel,
      text: listening ? p.listeningOn(listening.port, listening.servePort) : p.notListening,
      tone: listening ? "on" : "off",
    },
    {
      label: w.serveLabel,
      text:
        serve.state === "conflict"
          ? serve.detail ?? w.conflict(port)
          : {
              unchecked: w.notChecked,
              absent: w.absent,
              ours: w.ours(port, serve.target),
              sameTargetNotRecorded: w.sameTarget(port),
              error: w.serveError(serve.detail),
            }[serve.state],
      tone: serve.state === "ours" ? "on" : serve.state === "absent" ? "off" : serve.state === "unchecked" ? "unknown" : "warn",
    },
    {
      label: w.verificationLabel,
      // Before they are set up, the listener and the whole way fail by
      // design; only a Serve port someone else holds is worth saying.
      text: !verification
        ? w.notChecked
        : verification.ok
          ? w.reached
          : !setUp
            ? serve.state === "conflict" ? w.portTaken(port) : w.notSetUp
            : w.failedAt(failed ? p.steps[failed.id] ?? failed.id : null, failed?.detail ?? ""),
      tone: !verification ? "unknown" : verification.ok ? "on" : !setUp && serve.state !== "conflict" ? "off" : "warn",
    },
  ];
}

/** The QR code's dark modules as one SVG path, with a four-module margin. */
export function qrPath(qr: { size: number; rows: string[] }): string {
  let d = "";
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") d += `M${x + 4},${y + 4}h1v1h-1z`;
    }
  });
  return d;
}

/** What the page keeps across a reload: the change it asked for and its
 * request, so asking again after a lost answer is the same request. Kept per
 * Workspace (T-195): the Core at this address may later answer as another
 * Workspace, and one Workspace's request is never asked of another's Core.
 * An empty Workspace (not known yet) keeps none. A request saved before
 * requests were kept per Workspace, under `yuzuno.remoteAccess.pending`
 * alone, is left where it is and never asked again. */
const store = (workspace: string, kind: PendingKind) => `yuzuno.remoteAccess.${kind}:${encodeURIComponent(workspace)}`;
export type Pending = { requestId: string; draft: RemoteAccessDraft };
/** Phone access's change, or phone previews' (T-5), kept apart. */
export type PendingKind = "pending" | "previewPending";

export function loadPending(workspace: string, kind: PendingKind = "pending"): Pending | null {
  if (!workspace) return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(store(workspace, kind)) || "null");
    return value && typeof value.requestId === "string" && value.draft ? value : null;
  } catch {
    return null;
  }
}

export function savePending(workspace: string, pending: Pending | null, kind: PendingKind = "pending") {
  if (!workspace) return;
  try {
    if (pending) window.localStorage.setItem(store(workspace, kind), JSON.stringify(pending));
    else window.localStorage.removeItem(store(workspace, kind));
  } catch {
    // Storage may be unavailable; the operation itself is Core's record.
  }
}

export function newRequestId(prefix = "remote"): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The address a phone would open for these settings: the Tailscale node's
 * HTTPS name and the Serve port, with no port for 443, as Core makes it. */
export function previewUrl(dnsName: string | undefined, servePort: number): string | null {
  if (!dnsName) return null;
  const host = dnsName.replace(/\.$/, "");
  return servePort === 443 ? `https://${host}` : `https://${host}:${servePort}`;
}
