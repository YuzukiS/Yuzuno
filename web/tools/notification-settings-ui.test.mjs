import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Settings → Notifications (T-188), the production editor in an isolated page
// with the browser's Notification API replaced by a recorder: the browser's
// own permission as it is, asked only from the user's click; no usable
// switch where it is blocked or missing; a test notification reports what
// the browser said; this device's choices saved like Appearance's, and
// nothing reaches Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "notification-settings-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {NotificationSettings} from ${JSON.stringify(path.join(root, "src/NotificationSettings.tsx"))};
createRoot(document.getElementById('root')).render(<NotificationSettings />);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "NotificationSettingsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(read, what) {
  for (let i = 0; i < 80; i++) {
    if (read()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${what}`);
}

/** The editor in a page whose browser has `permission` (or no API), answering
 * a request with `answer` and showing notifications as `shows`. */
async function mount({ permission = "default", answer = "granted", shows = "show", api = true, query = "", storage = "works" } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: `https://isolated.test/${query}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const page = { dom, window, doc: window.document, errors, requests: [], asked: 0, shown: [] };
  window.fetch = (url) => {
    page.requests.push(String(url));
    return Promise.reject(new Error("no request expected"));
  };
  if (!window.isSecureContext) Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  class Recorder {
    static permission = permission;
    static requestPermission() {
      page.asked += 1;
      Recorder.permission = answer;
      return Promise.resolve(answer);
    }
    constructor(title, options) {
      if (shows === "page-only") throw new window.TypeError("Illegal constructor");
      this.onshow = this.onerror = this.onclick = null;
      this.close = () => {};
      page.shown.push({ title, body: options.body, tag: options.tag });
      if (shows === "show") setTimeout(() => this.onshow?.(), 0);
      if (shows === "error") setTimeout(() => this.onerror?.(), 0);
    }
  }
  if (api) window.Notification = Recorder;
  if (storage === "blocked") {
    const set = window.Storage.prototype.setItem;
    window.Storage.prototype.setItem = function (key, value) {
      if (key === "yuzuno.notifications") throw new window.DOMException("Fixture blocked", "SecurityError");
      return set.call(this, key, value);
    };
  }
  window.eval(bundle);
  await until(() => page.doc.querySelector("#settings-notifications"), "the editor");
  page.text = () => page.doc.querySelector("#settings-notifications").textContent;
  page.box = (name) => [...page.doc.querySelectorAll("label.settings-row")].find((row) => row.textContent.includes(name))?.querySelector("input");
  page.button = (name) => [...page.doc.querySelectorAll("button")].find((b) => b.textContent.trim() === name);
  // Asserted as booleans: a failed assertion on an element itself would make
  // the reporter print the whole page (run tn2 ran out of memory on one).
  page.hasBox = (name) => !!page.box(name);
  page.hasButton = (name) => !!page.button(name);
  page.saved = () => JSON.parse(window.localStorage.getItem("yuzuno.notifications"));
  page.close = () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(page.requests, [], "nothing reaches Core");
    window.close();
  };
  return page;
}

test("not asked yet: nothing is asked until the user turns it on; an allow saves it on this device", async () => {
  const page = await mount();
  assert.match(page.text(), /Not asked yet/);
  assert.equal(page.asked, 0, "opening Settings asks nothing");
  assert.equal(page.box("Notify me on this device").checked, false);
  assert.match(page.text(), /Using the defaults; nothing is saved on this device yet/);
  page.box("Notify me on this device").click();
  await until(() => page.box("Notify me on this device").checked, "on");
  assert.equal(page.asked, 1);
  assert.match(page.text(), /Allowed/);
  assert.equal(page.saved().enabled, true);
  assert.match(page.doc.querySelector('[role="status"]').textContent, /Saved on this device/);
  page.close();
});

test("a no from the browser leaves it off, unsaved, with no switch and the way to allow it", async () => {
  const page = await mount({ answer: "denied" });
  page.box("Notify me on this device").click();
  await until(() => /Blocked/.test(page.text()), "blocked");
  assert.equal(page.asked, 1);
  assert.equal(page.window.localStorage.getItem("yuzuno.notifications"), null, "nothing saved");
  assert.equal(page.hasBox("Notify me on this device"), false, "no switch");
  assert.equal(page.hasButton("Send a test"), false, "no test");
  assert.match(page.text(), /site settings/);
  assert.match(page.text(), /Needs you and unread updates always show/);
  page.close();
});

test("blocked or not available: said why, with nothing to switch on", async () => {
  for (const [options, label] of [
    [{ permission: "denied" }, /Blocked.*site’s notification permission/],
    [{ api: false }, /Not available in this browser.*no notifications for web pages/],
    [{ permission: "granted", query: "?shell=desktop" }, /Not available in this app.*desktop and iPhone apps/],
  ]) {
    const page = await mount(options);
    assert.match(page.text(), label, JSON.stringify(options));
    assert.equal(page.hasBox("Notify me on this device"), false);
    assert.equal(page.hasBox("A Turn failed"), false);
    assert.equal(page.hasButton("Send a test"), false);
    assert.equal(page.asked, 0);
    page.close();
  }
});

test("a test notification reports what the browser said, and a browser that refuses a page's is no longer offered", async () => {
  const shown = await mount({ permission: "granted" });
  shown.button("Send a test").click();
  await until(() => shown.doc.querySelector(".notification-test-result"), "a result");
  assert.deepEqual(shown.shown, [{ title: "Yuzuno", body: "A test notification from your Workspace.", tag: "yuzuno:test" }]);
  assert.match(shown.doc.querySelector(".notification-test-result").textContent, /reports it was shown/);
  shown.close();

  const failed = await mount({ permission: "granted", shows: "error" });
  failed.button("Send a test").click();
  await until(() => failed.doc.querySelector(".notification-test-result"), "a result");
  assert.match(failed.doc.querySelector(".notification-test-result").textContent, /couldn’t show it/);
  failed.close();

  // Not asked yet: the test asks first, from this click.
  const asked = await mount();
  asked.button("Send a test").click();
  await until(() => asked.doc.querySelector(".notification-test-result"), "a result");
  assert.equal(asked.asked, 1);
  assert.equal(asked.shown.length, 1);
  asked.close();

  const pageOnly = await mount({ permission: "granted", shows: "page-only" });
  pageOnly.button("Send a test").click();
  await until(() => /service worker/.test(pageOnly.text()), "page-only");
  assert.equal(pageOnly.hasButton("Send a test"), false);
  pageOnly.close();
});

test("kinds, preview and mute are this device's choices; muting keeps them", async () => {
  const page = await mount({ permission: "granted" });
  page.box("Notify me on this device").click();
  await until(() => page.saved()?.enabled, "on");
  page.box("A Turn finished").click();
  page.box("Show what was written").click();
  page.box("Mute on this device").click();
  await until(() => page.saved().muted, "muted");
  assert.deepEqual(page.saved(), { enabled: true, categories: { needsYou: true, failed: true, finished: false }, preview: true, muted: true });
  assert.match(page.doc.querySelector(".settings-current").textContent, /Muted/);
  page.box("Mute on this device").click();
  await until(() => !page.saved().muted, "unmuted");
  assert.equal(page.saved().categories.finished, false, "the choices were kept");
  page.close();
});

test("storage that refuses the save says so; the choice applies in this window", async () => {
  const page = await mount({ permission: "granted", storage: "blocked" });
  page.box("Notify me on this device").click();
  await until(() => page.doc.querySelector('[role="alert"]'), "the refusal");
  assert.match(page.doc.querySelector('[role="alert"]').textContent, /Not saved on this device/);
  assert.equal(page.box("Notify me on this device").checked, true, "in effect in this window");
  assert.equal(page.window.localStorage.getItem("yuzuno.notifications"), null);
  page.close();
});
