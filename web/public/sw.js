// Yuzuno's service worker (T-200): push notifications on the iPhone or iPad
// Home Screen app, and their clicks. Nothing else. There is no fetch handler
// and no cache: pages, the API and sign-in are never stored or served from
// here, and an update replaces this worker at once.
"use strict";

// As deep-link.ts checks an ID in a link.
const ID = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const KINDS = new Set(["needsYou", "finished", "failed", "summary"]);
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** What a push shows: Core's own words for it (never conversation text), or
 * a plain "Yuzuno" when it can't be read. A push must always show something:
 * iOS stops a Home Screen app's pushes when one shows nothing. */
function notificationFor(data) {
  const fine = data && typeof data === "object" && data.v === 1 && KINDS.has(data.kind)
    && typeof data.workspaceId === "string" && ID.test(data.workspaceId)
    && (data.agentId === undefined || (typeof data.agentId === "string" && ID.test(data.agentId)))
    && (data.open === "agent" || data.open === "home") && text(data.title, 200);
  if (!fine) return { title: "Yuzuno", options: { body: "", data: {} } };
  return {
    title: text(data.title, 200),
    options: {
      body: text(data.body, 400),
      tag: text(data.tag, 200) || undefined,
      data: { workspaceId: data.workspaceId, agentId: data.agentId, open: data.open },
    },
  };
}

/** Where a click goes, built only from this worker's own scope: the Agent's
 * link (T-184), the Workspace's Home, or the app itself. No address in a
 * push is ever opened. */
function linkFor(scope, data) {
  const base = String(scope).split("#")[0].split("?")[0];
  const workspace = data && typeof data.workspaceId === "string" && ID.test(data.workspaceId) ? data.workspaceId : null;
  if (!workspace) return base;
  if (data.open === "agent" && typeof data.agentId === "string" && ID.test(data.agentId))
    return `${base}#/agent?${new URLSearchParams({ w: workspace, a: data.agentId })}`;
  if (data.open === "home") return `${base}#/home?${new URLSearchParams({ w: workspace })}`;
  return base;
}

/** An open Yuzuno window of this origin is brought forward and told where
 * to go, as a link it opens itself; otherwise a new one opens there. */
async function openOrFocus(clients, href) {
  const origin = new URL(href).origin;
  const open = (await clients.matchAll({ type: "window", includeUncontrolled: true }))
    .filter((client) => new URL(client.url).origin === origin);
  const client = open.find((one) => one.focused) || open[0];
  if (client) {
    const focused = await client.focus().catch(() => client);
    (focused || client).postMessage({ type: "yuzuno:open", href });
    return;
  }
  await clients.openWindow(href);
}

if (typeof self !== "undefined" && self.registration) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener("push", (event) => {
    let data = null;
    try { data = event.data ? event.data.json() : null; } catch { data = null; }
    const shown = notificationFor(data);
    event.waitUntil(self.registration.showNotification(shown.title, shown.options));
  });
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    event.waitUntil(openOrFocus(self.clients, linkFor(self.registration.scope, event.notification.data)));
  });
}

// For web/tools/push-sw.test.mjs, which loads this file in a sandbox.
// eslint-disable-next-line no-undef
if (typeof __yuzunoPushWorker === "object") Object.assign(__yuzunoPushWorker, { notificationFor, linkFor, openOrFocus });
