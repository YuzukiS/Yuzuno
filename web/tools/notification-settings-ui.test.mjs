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
async function mount({ permission = "default", answer = "granted", shows = "show", api = true, query = "", storage = "works", shell } = {}) {
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
  const page = { dom, window, doc: window.document, errors, requests: [], asked: 0, shown: [], scrolls: 0, invoked: [] };
  window.fetch = (url) => {
    page.requests.push(String(url));
    return Promise.reject(new Error("no request expected"));
  };
  if (!window.isSecureContext) Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {
    page.scrolls += 1;
  };
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
  // The desktop app's command bridge (T-188): what it says it can do here,
  // and what it does with a notification handed to it.
  if (shell) {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          page.invoked.push(args === undefined ? [command] : [command, args]);
          if (command === "desktop_notifications") {
            if (shell.answer === "missing") throw "Command desktop_notifications not found";
            return shell.answer;
          }
          if (command === "desktop_notify" && shell.notify === "refused") throw "The system didn't take the notification: fixture";
          if (command === "desktop_notify") return null;
          throw `unexpected ${command}`;
        },
      },
    };
  }
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
    [{ permission: "granted", query: "?shell=desktop" }, /Not available in this app.*the iPhone app, the desktop app on macOS or Linux, and older desktop apps/],
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
  assert.deepEqual(page.saved(), { enabled: true, categories: { needsYou: true, failed: true, finished: false, backupFailed: false }, preview: true, muted: true });
  assert.match(page.doc.querySelector(".settings-current").textContent, /Muted/);
  page.box("Mute on this device").click();
  await until(() => !page.saved().muted, "unmuted");
  assert.equal(page.saved().categories.finished, false, "the choices were kept");
  page.close();
});

test("a daily backup's failure is off until ticked, with an Agent's failure on; it says when it can't arrive (T-196)", async () => {
  const page = await mount({ permission: "granted" });
  page.box("Notify me on this device").click();
  await until(() => page.saved()?.enabled, "on");
  assert.equal(page.box("A Turn failed").checked, true);
  assert.equal(page.box("A daily backup failed").checked, false, "not turned on with the others");
  const row = [...page.doc.querySelectorAll("label.settings-row")].find((r) => r.textContent.includes("A daily backup failed")).textContent;
  assert.match(row, /never while the page is closed, and possibly late after the computer sleeps/);
  assert.match(row, /names no folder or error; Settings → Backup shows the last run and why/);
  page.box("A daily backup failed").click();
  await until(() => page.saved().categories.backupFailed === true, "chosen");
  assert.deepEqual(page.saved().categories, { needsYou: true, failed: true, finished: true, backupFailed: true });
  page.close();
});

test("storage that refuses the save says so, each time; the choice applies in this window", async () => {
  const page = await mount({ permission: "granted", storage: "blocked" });
  page.box("Notify me on this device").click();
  await until(() => page.doc.querySelector('[role="alert"]'), "the refusal");
  assert.match(page.doc.querySelector('[role="alert"]').textContent, /Not saved on this device/);
  assert.equal(page.box("Notify me on this device").checked, true, "in effect in this window");
  assert.equal(page.window.localStorage.getItem("yuzuno.notifications"), null);
  // The same refusal again is brought into view again (T-189's per-write attempt).
  const first = page.scrolls;
  assert.ok(first >= 1, "the refusal was brought into view");
  page.box("Mute on this device").click();
  await until(() => page.scrolls > first, "the second refusal brought into view");
  page.close();
});

// T-188: in the desktop app on Windows, notifications go through the app, which
// hands them to Windows and can't read whether Windows shows them.
test("in the desktop app that can notify, it says so: nothing is asked, a test is handed to Windows and said to be only that", async () => {
  const page = await mount({ permission: "granted", shell: { answer: { supported: true, system: "windows" } } });
  await until(() => /Through this app/.test(page.text()), "the app's answer");
  assert.match(page.text(), /System notifications\s*Through this app/);
  assert.match(page.text(), /hands notifications to Windows\. Whether Windows shows them is up to its notification settings and Focus, which this app can’t read\./);
  assert.doesNotMatch(page.text(), /Allowed/, "never said to be allowed by the system");
  assert.equal(page.box("Notify me on this device").checked, false, "off until turned on");
  assert.deepEqual(page.invoked, [["desktop_notifications"]], "opening Settings only asks the app what it can do");
  page.box("Notify me on this device").click();
  await until(() => page.saved()?.enabled === true, "the choice saved");
  assert.equal(page.asked, 0, "the browser is never asked");
  assert.deepEqual(page.invoked, [["desktop_notifications"]], "turning it on sends nothing");
  page.button("Send a test").click();
  await until(() => page.doc.querySelector(".notification-test-result"), "a result");
  assert.match(page.doc.querySelector(".notification-test-result").textContent, /^Handed to Windows\. Windows doesn’t tell this app whether it showed it/);
  assert.deepEqual(page.invoked.slice(1), [["desktop_notify", { title: "Yuzuno", body: "A test notification from your Workspace." }]], "one, to the app");
  assert.deepEqual(page.shown, [], "not through the webview's own Notification");
  page.close();
});

test("in the desktop app a refused hand-off says so; an app that can't notify here, or an older one, is not available", async () => {
  const refused = await mount({ shell: { answer: { supported: true, system: "windows" }, notify: "refused" } });
  await until(() => !!refused.button("Send a test"), "the test");
  refused.button("Send a test").click();
  await until(() => refused.doc.querySelector(".notification-test-result"), "a result");
  assert.match(refused.doc.querySelector(".notification-test-result").textContent, /^This app couldn’t hand it to Windows: The system didn't take the notification: fixture$/);
  refused.close();
  for (const answer of [{ supported: false, system: null }, "missing"]) {
    const page = await mount({ permission: "granted", shell: { answer } });
    await until(() => page.invoked.length > 0, "the app asked");
    await tick();
    assert.match(page.text(), /Not available in this app/, JSON.stringify(answer));
    assert.equal(page.hasBox("Notify me on this device"), false);
    assert.equal(page.hasButton("Send a test"), false);
    assert.deepEqual(page.invoked, [["desktop_notifications"]]);
    page.close();
  }
});
