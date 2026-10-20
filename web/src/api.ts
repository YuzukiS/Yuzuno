export const isTauri = "__TAURI_INTERNALS__" in window;
export const isNative =
  isTauri ||
  new URLSearchParams(window.location.search).get("shell") === "desktop";

export function openDesktopConnection() {
  if (!isTauri) return;
  // Navigation to the embedded page is already allowed by the native shell.
  // The remote workspace receives no additional native command permissions.
  window.location.assign(
    /^Win/i.test(navigator.platform)
      ? "http://tauri.localhost/index.html"
      : "tauri://localhost/index.html",
  );
}
export const API_BASE =
  // The desktop window loads the Core-served page. Its configured origin may
  // belong to WSL or use a different port; native presentation must not change
  // where requests, events, and artifacts go.
  import.meta.env.VITE_API_BASE || "";
export const shortcutModifier = /Mac|iPhone|iPad/.test(navigator.platform)
  ? "⌘"
  : "Ctrl";

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message || `HTTP ${status}`);
    this.name = "HttpError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Yuzuno-Client": "desktop",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    let message = body;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body);
      message = parsed.error?.message || parsed.error || parsed.message || body;
      if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      /* plain HTTP error */
    }
    throw new HttpError(
      typeof message === "string" ? message : JSON.stringify(message),
      response.status,
      code,
    );
  }
  return response.status === 204 ? ({} as T) : response.json();
}
export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}
export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
export function remove<T>(path: string): Promise<T> {
  return api<T>(path, { method: "DELETE" });
}
export function artifactUrl(agentId: string, path: string) {
  return `${API_BASE}/api/artifact?${new URLSearchParams({ agentId, path })}`;
}
export function errorText(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  if (
    typeof message === "string" &&
    /^thread [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} already has an active writer$/i.test(
      message,
    )
  ) {
    return "The original client still owns this Codex session, even if its turn has finished. Release the session there, or continue from an official Codex fork. Your message was not sent; your draft is kept.";
  }
  return message;
}
