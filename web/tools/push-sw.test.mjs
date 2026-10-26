// The service worker (public/sw.js, T-200) in a sandbox: what a push shows,
// where a click goes, and that it does nothing else. No browser, no Core.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const scope = "https://phone.example.ts.net/";

/** The worker as a browser runs it: its listeners, and what they did. */
function worker() {
  const listeners = {};
  const done = [];
  const shown = [];
  const self = {
    registration: { scope, showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); } },
    clients: { claim: () => Promise.resolve(), matchAll: async () => [], openWindow: async () => null },
    skipWaiting: () => {},
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  vm.runInNewContext(source, { self, URL, URLSearchParams });
  const fire = (type, event = {}) => listeners[type]({ ...event, waitUntil: (promise) => done.push(promise) });
  return { listeners, done, shown, fire, self };
}
/** The worker's functions, without its listeners. */
function functions() {
  const exported = {};
  vm.runInNewContext(source, { URL, URLSearchParams, __yuzunoPushWorker: exported });
  return exported;
}

test("it listens for install, activate, push and a click only: no fetch handler, no cache", () => {
  const { listeners } = worker();
  assert.deepEqual(Object.keys(listeners).sort(), ["activate", "install", "notificationclick", "push"]);
  assert.doesNotMatch(source, /\bcaches\b|addEventListener\(\s*["']fetch/);
});

test("a push shows Core's words, bounded; one it can't read still shows something", async () => {
  const w = worker();
  const payload = { v: 1, kind: "finished", workspaceId: "w-1", agentId: "a-1", open: "agent", title: "Mori finished", body: "The Turn finished.", tag: "yuzuno:finished:a-1" };
  w.fire("push", { data: { json: () => payload } });
  await Promise.all(w.done);
  assert.deepEqual(JSON.parse(JSON.stringify(w.shown)), [{ title: "Mori finished", options: { body: "The Turn finished.", tag: "yuzuno:finished:a-1", data: { workspaceId: "w-1", agentId: "a-1", open: "agent" } } }]);
  for (const data of [
    { json: () => { throw new SyntaxError("not JSON"); } },
    { json: () => ({ ...payload, v: 2 }) },
    { json: () => ({ ...payload, kind: "anything" }) },
    { json: () => ({ ...payload, open: "https://elsewhere.example/" }) },
    { json: () => ({ ...payload, workspaceId: "w 1" }) },
    null,
  ]) {
    const again = worker();
    again.fire("push", { data });
    await Promise.all(again.done);
    assert.equal(again.shown.length, 1, "always shows one");
    assert.equal(again.shown[0].title, "Yuzuno");
    assert.deepEqual(JSON.parse(JSON.stringify(again.shown[0].options.data)), {});
  }
  const { notificationFor } = functions();
  const long = notificationFor({ ...payload, title: "x".repeat(500), body: "y".repeat(900) });
  assert.equal(long.title.length, 200);
  assert.equal(long.options.body.length, 400);
});

test("a click goes only where this worker's own scope leads: the Agent, the Home, or the app", () => {
  const { linkFor } = functions();
  assert.equal(linkFor(scope, { workspaceId: "w-1", agentId: "a 1", open: "agent" }), scope, "an ID a link can't hold opens the app");
  assert.equal(linkFor(scope, { workspaceId: "w-1", agentId: "a-1", open: "agent" }), `${scope}#/agent?w=w-1&a=a-1`);
  assert.equal(linkFor(`${scope}?shell=desktop#/x`, { workspaceId: "w/1", open: "home" }), `${scope}#/home?w=w%2F1`);
  assert.equal(linkFor(scope, { workspaceId: "w-1", open: "https://elsewhere.example/" }), scope);
  assert.equal(linkFor(scope, { url: "https://elsewhere.example/", open: "agent" }), scope, "an address in a push is never opened");
  assert.equal(linkFor(scope, undefined), scope);
});

test("a click brings an open Yuzuno window forward and tells it where to go, or opens one", async () => {
  const { openOrFocus } = functions();
  const href = `${scope}#/agent?w=w-1&a=a-1`;
  const told = [];
  const other = { url: "https://elsewhere.example/", focused: true, focus: async () => assert.fail("not another site's"), postMessage: () => assert.fail("not another site's") };
  const mine = { url: `${scope}#/home`, focused: false, focus: async function () { return this; }, postMessage: (message) => told.push(message) };
  let opened = null;
  await openOrFocus({ matchAll: async () => [other, mine], openWindow: async () => assert.fail("a window is open") }, href);
  // Made in the worker's realm: compared by value.
  assert.deepEqual(JSON.parse(JSON.stringify(told)), [{ type: "yuzuno:open", href }]);
  await openOrFocus({ matchAll: async () => [other], openWindow: async (url) => { opened = url; } }, href);
  assert.equal(opened, href);
});

test("a click closes the notification and opens what it names", async () => {
  const w = worker();
  let closed = false;
  let opened = null;
  w.self.clients.openWindow = async (url) => { opened = url; };
  w.fire("notificationclick", { notification: { close: () => { closed = true; }, data: { workspaceId: "w-1", open: "home" } } });
  await Promise.all(w.done);
  assert.equal(closed, true);
  assert.equal(opened, `${scope}#/home?w=w-1`);
});
