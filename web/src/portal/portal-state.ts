import { useSyncExternalStore } from "react";
import { post } from "../api";
import type { ProjectService } from "../ProjectServices";

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

/** Core's reply to a preview: the snapshot's address on the previews' own
 * origin, and the proof that this browser reaches it (core/src/previews.rs). */
export type Minted = {
  name: string;
  size: number;
  sha256: string;
  takenAt: string;
  expiresAt: string;
  port: number;
  url: string;
  proof: { challenge: string; answer: string; url: string };
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

/** Opens an address in the browser: a new tab on the web, the system browser
 * in the desktop app (its window hands new windows to it). With noopener the
 * page gets no handle on this one. */
export function openOutside(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Whether this page is on a loopback address, where Core's ports are this
 * computer's (or its tunnel's); otherwise (Core's remote entry) they are not. */
export const loopbackPage = () => /^(localhost|[^/]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(window.location.hostname);
