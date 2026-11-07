import { useSyncExternalStore } from "react";
import { HttpError, post } from "../api";
import type { ProjectService } from "../ProjectServices";
import type { PageReplyTo } from "../home/PageSend";

/**
 * What the Portal shows (T-5): a project's web service, or a single HTML file
 * kept as it was when opened. One at a time: opening another replaces it, and
 * closing unmounts it.
 */
export type PreviewSource =
  | { kind: "briefAttachment"; projectId: string; section: string; name: string; version?: number }
  | { kind: "artifact"; agentId: string; path: string };

export type PortalTarget =
  | {
      kind: "snapshot";
      source: PreviewSource;
      name: string;
      /** Where the file comes from, as the user knows it ("Mori's conversation file"). */
      from: string;
      /** A Brief section's page: who its messages may go to (YN-16 S6). Absent elsewhere: a page's message is not offered. */
      replyTo?: PageReplyTo;
    }
  | {
      kind: "service";
      service: ProjectService;
      /** The address this browser was proven to reach (ProjectServices). */
      url: string;
      /** This browser's completed proof, not Core's HTTP probe time. Older
       * entries may have no timestamp and must not invent one on opening. */
      browserCheckedAt?: string;
      browserJobId?: string | null;
      /** Where it runs, as the services list says it. */
      where: string;
    };

/** Core's reply to a preview: the snapshot's address, and the proof that
 * this browser reaches it (core/src/previews.rs). On Core's own port it is
 * the previews' port, proven by GET; through the phone entry, that entry's
 * own origin, proven by POST from this page (T-5). */
export type Minted = {
  name: string;
  size: number;
  sha256: string;
  takenAt: string;
  expiresAt: string;
  port: number;
  url: string;
  /** `method` left out (Core's own port, an older Core) means GET. */
  proof: { challenge: string; answer: string; url: string; method?: string };
};

type Shown = { target: PortalTarget; key: number; opener: HTMLElement | null };
let shown: Shown | null = null;
let keys = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
let mount: (() => void) | null = null;
/** How the Portal's own root is made (Portal.tsx); set once it loads. */
export function onPortalMount(make: () => void) {
  mount = make;
}

export function usePortal(): Shown | null {
  return useSyncExternalStore(subscribe, () => shown);
}

/** Shows `target` in the Portal, in place of whatever it showed. */
export function openInPortal(target: PortalTarget, opener?: Element | null) {
  mount?.();
  shown = { target, key: ++keys, opener: opener instanceof HTMLElement ? opener : null };
  notify();
}

/** Closes the Portal: its page is unmounted; focus goes back where it came from. */
export function closePortal() {
  const was = shown;
  shown = null;
  notify();
  if (was?.opener?.isConnected) was.opener.focus({ preventScroll: true });
}

export const mintPreview = (source: PreviewSource) => post<Minted>("/previews", source);

/** Core's refusal of a preview asked for through the phone entry while
 * phone access does not include previews (Settings → Phone access, T-5). */
export const phonePreviewsOff = (error: unknown) => error instanceof HttpError && error.message.startsWith("preview_unavailable_remote:");

/** Whether this browser reaches the address Core gave, proven by the answer
 * only that address knows (as ProjectServices proves a service's port). */
export async function reaches(url: string, answer: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
    return response.ok && (await response.text()) === answer;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** The path of a phone preview's proof on the phone entry (core/src/previews.rs). */
const PHONE_PROOF = "/__yuzuno/preview/proof/";

/** Whether this browser reaches the snapshot Core kept, proven as Core says
 * to (T-5). GET, or no `method`: as `reaches`, for the previews' port. POST:
 * the phone entry's own proof, only at this page's own origin and that path,
 * from this page with its client header, in CORS mode with the default
 * referrer policy so that the browser sends this page's Origin; never
 * redirected. Any other way fails, and is never tried another way. */
export async function provesPreview(proof: Minted["proof"]): Promise<boolean> {
  const method = proof.method ?? "GET";
  if (method === "GET") return reaches(proof.url, proof.answer);
  if (method !== "POST") return false;
  let url: URL;
  try {
    url = new URL(proof.url);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin || !url.pathname.startsWith(PHONE_PROOF) || url.search || url.hash) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url.href, {
      method: "POST",
      mode: "cors",
      cache: "no-store",
      redirect: "error",
      headers: { "X-Yuzuno-Client": "desktop" },
      signal: controller.signal,
    });
    return response.ok && !response.redirected && (await response.text()) === proof.answer;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Opens an address in the browser: a new tab on the web, the system browser
 * in the desktop app (its window hands new windows to it). With noopener the
 * page gets no handle on this one. */
export function openOutside(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Whether this page is on a loopback address, where Core's ports are this
 * computer's (or its tunnel's); otherwise (Core's remote entry) they are not. */
export const loopbackPage = () => /^(localhost|[^/]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname);
