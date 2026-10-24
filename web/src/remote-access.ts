// T-185: Settings → Phone & remote access. What Core says about the phone's
// entry, as `GET /api/remote-access` answers, and the few rules the page
// keeps itself. Saved settings, what Core listens on, Tailscale Serve and the
// last check are four separate facts: the page never shows one for another.

export type RemoteAccessDraft = {
  enabled: boolean;
  httpsPort?: number;
  remotePort?: number;
  login?: string;
};

export type RemoteAccessStep = {
  id: "check" | "save" | "listen" | "serve" | "verify";
  state: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
};

export type RemoteAccessOperation = {
  id: string;
  requestId: string;
  kind: "apply" | "disable";
  phase: "pending" | "running" | "complete" | "failed" | "uncertain";
  steps: RemoteAccessStep[];
  error?: { step: string; message: string };
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type RemoteAccessStatus = {
  support: {
    state: "supported" | "unsupported";
    reason?: string;
    coreHost: { kind: "wsl"; distro: string; installDir?: string } | { kind: "other"; label: string };
    tailscaleHost: { kind: "windows"; node: string; login?: string } | null;
  };
  saved: null | {
    enabled: boolean;
    httpsPort: number;
    remotePort: number;
    origin: string;
    login: string;
    savedAt: string;
  };
  listening: { state: "on" | "off" | "unknown"; port?: number; origin?: string; login?: string };
  serve: {
    state: "ours" | "absent" | "foreign" | "changed" | "unknown";
    httpsPort?: number;
    target?: string;
    detail?: string;
    observedAt: string;
  };
  verified: null | { state: "ok" | "failed"; at: string; url: string; step?: string; detail?: string };
  url: string | null;
  qr: null | { size: number; rows: string[] };
  operation: RemoteAccessOperation | null;
};

export type RemoteAccessCheck = {
  ok: boolean;
  problems: { field?: "httpsPort" | "remotePort" | "login"; step: string; message: string }[];
  preview: { url: string; origin: string; httpsPort: number; remotePort: number; login: string };
};

export const runningPhases: RemoteAccessOperation["phase"][] = ["pending", "running"];

export function running(operation: RemoteAccessOperation | null | undefined): boolean {
  return !!operation && runningPhases.includes(operation.phase);
}

export const stepLabels: Record<RemoteAccessStep["id"], string> = {
  check: "Check the hosts and settings",
  save: "Save the settings",
  listen: "Core listens on the phone's port",
  serve: "Tailscale Serve points to it",
  verify: "Check it from the tailnet",
};

/** One line per fact, as the page shows it; `tone` says how it reads. */
export type StateLine = { label: string; text: string; tone: "on" | "off" | "warn" | "unknown" };

export function stateLines(status: RemoteAccessStatus): StateLine[] {
  const saved = status.saved;
  const listening = status.listening;
  const serve = status.serve;
  const verified = status.verified;
  return [
    {
      label: "Saved settings",
      text: !saved
        ? "Nothing saved"
        : saved.enabled
          ? `On · ${saved.origin} · ${saved.login}`
          : "Saved as off",
      tone: !saved ? "off" : saved.enabled ? "on" : "off",
    },
    {
      label: "Core listening",
      text:
        listening.state === "on"
          ? `On, port ${listening.port ?? "?"}${listening.origin ? ` for ${listening.origin}` : ""}`
          : listening.state === "off"
            ? "Not listening for the phone"
            : "Not known",
      tone: listening.state === "on" ? "on" : listening.state === "off" ? "off" : "unknown",
    },
    {
      label: "Tailscale Serve",
      text: {
        ours: `Yuzuno's entry on port ${serve.httpsPort ?? "?"}${serve.target ? ` → ${serve.target}` : ""}`,
        absent: "No Yuzuno entry",
        foreign: `Port ${serve.httpsPort ?? "?"} is used by another Serve entry; Yuzuno leaves it as it is`,
        changed: "Yuzuno's entry was changed outside Yuzuno; it is left as it is",
        unknown: "Not known",
      }[serve.state] + (serve.detail ? ` (${serve.detail})` : ""),
      tone: serve.state === "ours" ? "on" : serve.state === "absent" ? "off" : serve.state === "unknown" ? "unknown" : "warn",
    },
    {
      label: "Last check",
      text: !verified
        ? "Not checked yet"
        : verified.state === "ok"
          ? `Reached ${verified.url}`
          : `Failed at “${verified.step ?? "a step"}”${verified.detail ? `: ${verified.detail}` : ""}`,
      tone: !verified ? "unknown" : verified.state === "ok" ? "on" : "warn",
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

/** Whether this page itself is open through the phone's entry: changing or
 * turning that entry off would cut this page off. */
export function servedThroughEntry(status: RemoteAccessStatus, origin = window.location.origin): boolean {
  const entry = status.listening.origin || status.saved?.origin;
  return !!entry && entry.replace(/\/$/, "") === origin.replace(/\/$/, "");
}

/** What the page keeps across a reload or a Core restart: the draft being
 * applied and its request, so a retry is the same operation. */
const STORE = "yuzuno.remoteAccess.pending";
export type Pending = { requestId: string; draft: RemoteAccessDraft; kind: "apply" | "disable" };

export function loadPending(): Pending | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORE) || "null");
    return value && typeof value.requestId === "string" ? value : null;
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
