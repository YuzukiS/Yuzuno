// T-170: the browser's own offline report (browser-offline.ts). Handlers run on
// each of its events and stop when told; the hook follows navigator.onLine and
// leaves no listener behind once unmounted.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { useBrowserOffline, watchBrowserNetwork } from "../src/browser-offline.ts";

function fixture(t, { online: initial = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: "http://127.0.0.1:4340/",
  });
  const { window } = dom;
  let online = initial;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  // Listeners now registered for each event, to show none is left behind.
  const listening = { offline: 0, online: 0 };
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  window.addEventListener = (type, ...rest) => {
    if (type in listening) listening[type]++;
    return add(type, ...rest);
  };
  window.removeEventListener = (type, ...rest) => {
    if (type in listening) listening[type]--;
    return remove(type, ...rest);
  };
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  });
  return {
    window,
    listening,
    report(next) {
      online = next;
      window.dispatchEvent(new window.Event(next ? "online" : "offline"));
    },
  };
}

test("each report reaches its handler, repeated reports each once, and none after stopping", (t) => {
  const f = fixture(t);
  const seen = [];
  const stop = watchBrowserNetwork({ offline: () => seen.push("offline"), online: () => seen.push("online") });
  assert.deepEqual(f.listening, { offline: 1, online: 1 });
  f.report(false);
  f.report(false);
  f.report(true);
  assert.deepEqual(seen, ["offline", "offline", "online"]);
  stop();
  assert.deepEqual(f.listening, { offline: 0, online: 0 });
  f.report(false);
  f.report(true);
  assert.deepEqual(seen, ["offline", "offline", "online"], "nothing after stop");
});

test("the hook follows navigator.onLine from the start and through reports, and unmounting removes its listeners", async (t) => {
  const f = fixture(t, { online: false });
  const host = f.window.document.getElementById("root");
  let renders = 0;
  function Probe() {
    renders++;
    return createElement("output", null, useBrowserOffline() ? "offline" : "online");
  }
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  assert.equal(host.textContent, "offline", "a page opened offline says so at once");
  await act(async () => f.report(true));
  assert.equal(host.textContent, "online");
  await act(async () => f.report(false));
  assert.equal(host.textContent, "offline");
  await act(async () => root.unmount());
  assert.deepEqual(f.listening, { offline: 0, online: 0 }, "no listener left");
  const after = renders;
  await act(async () => {
    f.report(true);
    f.report(false);
  });
  assert.equal(renders, after, "reports after unmount render nothing");
});
