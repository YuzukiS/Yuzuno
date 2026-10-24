// T-185: Settings → Phone access. What Core says about the phone's entry,
// as `GET /api/remote-access` answers (T-185 interface v1, comment 6798),
// and the few rules the page keeps itself. Saved settings, what Core listens
// on, Tailscale Serve and the last verification are four separate facts: the
// page never shows one for another.

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
};

/** What Save and apply sends besides its request ID. */
export type RemoteAccessDraft = { enabled: boolean; login?: string; servePort?: number; localPort?: number };

export function running(operation: RemoteAccessOperation | null | undefined): boolean {
  return operation?.state === "running";
}

export const operationSteps: RemoteAccessOperation["step"][] = ["validate", "save", "listen", "serve", "verify"];
export const operationStepLabels: Record<RemoteAccessOperation["step"], string> = {
  validate: "Check the settings",
  save: "Save them",
  listen: "Core listens on the phone's port",
  serve: "Tailscale Serve points to it",
  verify: "Reach it from the tailnet",
  done: "Done",
};
export const verificationStepLabels: Record<VerificationStep["id"], string> = {
  host: "Core's host",
  tailscale: "Tailscale on Windows",
  https: "HTTPS certificates",
  listener: "Core's phone port",
  hop: "From Windows to Core",
  serve: "Tailscale Serve",
  endToEnd: "The whole way",
};

/** One line per fact, as the page shows it; `tone` says how it reads. */
export type StateLine = { label: string; text: string; tone: "on" | "off" | "warn" | "unknown" };

export function stateLines(view: RemoteAccessView): StateLine[] {
  const { saved, listening, serve, verification } = view;
  const failed = verification?.steps.find((step) => step.state === "failed");
  const others = serve.otherEntries > 0 ? ` · ${serve.otherEntries} other ${serve.otherEntries === 1 ? "entry" : "entries"} left as they are` : "";
  return [
    {
      label: "Saved settings",
      text: !saved
        ? "Nothing saved"
        : !saved.enabled
          ? "Saved as off"
          : `On · ${saved.origin ?? "no address yet"} · ${saved.login}${saved.applied ? "" : " · not applied"}`,
      tone: !saved || !saved.enabled ? "off" : saved.applied ? "on" : "warn",
    },
    {
      label: "Core listening",
      text: listening
        ? `On, port ${listening.port} for ${listening.origin}${listening.source === "environment" ? " · from Core's environment" : ""}`
        : "Not listening for the phone",
      tone: listening ? "on" : "off",
    },
    {
      label: "Tailscale Serve",
      text:
        {
          unchecked: "Not checked yet",
          absent: "No Yuzuno entry",
          ours: `Yuzuno's entry on port ${serve.port ?? "?"}${serve.target ? ` → ${serve.target}` : ""}`,
          sameTargetNotRecorded: `An entry on port ${serve.port ?? "?"} points to Core, but Settings did not make it`,
          conflict: `Port ${serve.port ?? "?"} is used by another Serve entry; Yuzuno leaves it as it is`,
          error: "Could not be read",
        }[serve.state] +
        // For Yuzuno's own entry the detail repeats the line; for a conflict
        // or an error it is the reason.
        (serve.detail && (serve.state === "conflict" || serve.state === "error") ? ` (${serve.detail})` : "") +
        others,
      tone:
        serve.state === "ours" ? "on" : serve.state === "absent" ? "off" : serve.state === "unchecked" ? "unknown" : "warn",
    },
    {
      label: "Verification",
      text: !verification
        ? "Not checked yet"
        : verification.ok
          ? "Reached from the tailnet"
          : `Failed at “${failed ? verificationStepLabels[failed.id] ?? failed.id : "a step"}”${failed?.detail ? `: ${failed.detail}` : ""}`,
      tone: !verification ? "unknown" : verification.ok ? "on" : "warn",
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
 * request, so asking again after a lost answer is the same request. */
const STORE = "yuzuno.remoteAccess.pending";
export type Pending = { requestId: string; draft: RemoteAccessDraft };

export function loadPending(): Pending | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORE) || "null");
    return value && typeof value.requestId === "string" && value.draft ? value : null;
  } catch {
    return null;
  }
}

export function savePending(pending: Pending | null) {
  try {
    if (pending) window.localStorage.setItem(STORE, JSON.stringify(pending));
    else window.localStorage.removeItem(STORE);
  } catch {
    // Storage may be unavailable; the operation itself is Core's record.
  }
}

export function newRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `remote-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
