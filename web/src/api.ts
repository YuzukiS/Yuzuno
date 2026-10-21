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
/** How long a message or an answer waits for Core's reply. A phone's request
 * can hang after sleep or a network change; past this it is unconfirmed, as
 * after any lost connection. Core may still have it: nothing is sent again by
 * itself (T-170). */
export const DELIVERY_WAIT_MS = 60_000;
export class NoReplyError extends Error {
  constructor(message = `No reply from Core within ${DELIVERY_WAIT_MS / 1000} seconds. It may have arrived; nothing is sent again by itself.`) {
    super(message);
    this.name = "NoReplyError";
  }
}
/** post, but a request with no reply within DELIVERY_WAIT_MS is given up as a NoReplyError. */
export async function postWithin<T>(path: string, body: unknown = {}): Promise<T> {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), DELIVERY_WAIT_MS);
  try {
    return await api<T>(path, { method: "POST", body: JSON.stringify(body), signal: giveUp.signal });
  } catch (error) {
    if (giveUp.signal.aborted) throw new NoReplyError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
/** An answer to a native approval or question. Core refuses a second answer
 * to the same request, so answering again after no reply is safe. */
export async function respondToRequest(requestId: string, response: unknown) {
  try {
    return await postWithin(`/requests/${encodeURIComponent(requestId)}/respond`, { response });
  } catch (error) {
    if (error instanceof NoReplyError)
      throw new NoReplyError(`No reply from Core within ${DELIVERY_WAIT_MS / 1000} seconds. Your answer may have arrived; if you answer again, Core refuses a second answer.`);
    throw error;
  }
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
