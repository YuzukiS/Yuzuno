/**
 * Push notifications on this device (T-200): the iPhone or iPad Home Screen
 * app subscribes through its service worker (public/sw.js), and Core sends
 * to that subscription when an Agent needs you or a Turn ends, while Yuzuno
 * is closed. One switch per device; what to be told about follows the
 * notification choices (notification-prefs.ts). Core accepts Apple's push
 * service only, so other browsers and the desktop apps are never subscribed.
 */
import { api, HttpError } from "./api";
import type { NotificationCategory, NotificationPrefs } from "./notification-prefs";

/** What Core pushes: a Turn ended (finished or failed), or an Agent needs you. */
export type PushKind = "needsYou" | "finished" | "failed";
export const pushKinds: PushKind[] = ["needsYou", "failed", "finished"];

/** Whether this device can have them:
 * - `available`: the Home Screen app on an iPhone or iPad, from a secure page.
 * - `home-screen`: Safari on an iPhone or iPad, outside the Home Screen app.
 * - `iphone-only`: anywhere else (other browsers, the desktop apps).
 * - `insecure`: not an https:// page. */
export type PushSupport = "available" | "home-screen" | "iphone-only" | "insecure";

/** The parts of the browser this uses: the app passes the window's, a test its own. */
export type PushHost = {
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  serviceWorker?: ServiceWorkerContainer;
  hasPushManager: boolean;
  Notification?: { readonly permission: string; requestPermission(): Promise<string> };
};

export const browserPushHost = (): PushHost => ({
  isSecureContext: window.isSecureContext,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints || 0,
  standalone: window.matchMedia?.("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  serviceWorker: navigator.serviceWorker,
  hasPushManager: "PushManager" in window,
  Notification: (window as Window & { Notification?: PushHost["Notification"] }).Notification,
});

/** An iPhone or iPad (an iPad reports itself as a Mac with touch). */
const appleTouch = (host: PushHost) =>
  /iPhone|iPad|iPod/.test(host.userAgent) || (/Macintosh/.test(host.userAgent) && host.maxTouchPoints > 1);

export function pushSupport(host: PushHost): PushSupport {
  if (!appleTouch(host)) return "iphone-only";
  if (!host.isSecureContext) return "insecure";
  if (!host.standalone || !host.serviceWorker || !host.hasPushManager || !host.Notification) return "home-screen";
  return "available";
}

/** The kinds this device is told about: the chosen notification kinds that
 * Core can push, none while this device is muted. ("Notify me on this
 * device" is for notifications from the open page, which the Home Screen app
 * cannot show: push has its own switch.) */
export function chosenPushKinds(prefs: NotificationPrefs): PushKind[] {
  if (prefs.muted) return [];
  return pushKinds.filter((kind) => prefs.categories[kind as NotificationCategory]);
}

/** What Core says of this device's subscription. */
export type PushState =
  | { state: "active"; kinds: PushKind[] }
  | { state: "expired" | "failed"; stoppedAt?: string; reason?: string }
  | { state: "none" };

/** This device's subscription, if its service worker has one. */
export async function deviceSubscription(host: PushHost): Promise<PushSubscription | null> {
  const registration = await host.serviceWorker?.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

const base64url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

/** Whether this Core can push at all: an older Core has no such route. */
export async function corePushes(): Promise<boolean> {
  try {
    await api<{ publicKey: string | null }>("/push");
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return false;
    throw error;
  }
}

/** Turns them on, from a click: asks the system first (before anything else
 * waits, so iOS still counts it as the click's), then drops a subscription
 * Core stopped sending to (`stale`), registers the worker, has Core make its
 * key, subscribes and tells Core what to send. Answers the permission when it
 * is not granted, and does nothing more. */
export async function enablePush(host: PushHost, kinds: PushKind[], stale?: PushSubscription | null): Promise<{ permission: string; state?: PushState }> {
  const permission = await host.Notification!.requestPermission();
  if (permission !== "granted") return { permission };
  if (stale) await stale.unsubscribe();
  const worker = host.serviceWorker!;
  await worker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  const registration = await worker.ready;
  const { publicKey } = await api<{ publicKey: string }>("/push/key", { method: "POST", body: "{}" });
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64url(publicKey) });
  const state = await api<PushState>("/push/subscriptions", { method: "POST", body: JSON.stringify({ ...subscription.toJSON(), kinds }) });
  return { permission, state };
}

/** Tells Core what this device wants now (the same subscription, new kinds). */
export async function updatePushKinds(subscription: PushSubscription, kinds: PushKind[]): Promise<PushState> {
  return api<PushState>("/push/subscriptions", { method: "POST", body: JSON.stringify({ ...subscription.toJSON(), kinds }) });
}

/** What Core says of this device's subscription. */
export async function pushState(subscription: PushSubscription): Promise<PushState> {
  return api<PushState>("/push/subscriptions/state", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
}

/** Turns them off on this device only: Core forgets this subscription, and
 * the browser drops it. Other devices keep theirs. */
export async function disablePush(subscription: PushSubscription): Promise<void> {
  await api<{ removed: boolean }>("/push/subscriptions/remove", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}
