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
/** A 65-byte VAPID public key, as Core answers it (T-200). */
const PUSH_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
/** What Core answers the push routes (T-200), unless a test says otherwise. */
function pushAnswer(push, method, route, body) {
  if (route === "/api/push") return push.oldCore ? { status: 404, body: { error: "Not found" } } : { body: { publicKey: null } };
  if (route === "/api/push/key") return { body: { publicKey: PUSH_KEY } };
  if (route === "/api/push/subscriptions") return push.subscribeError
    ? { status: 400, body: { error: "Only Apple's push service is accepted", code: "push_service_unsupported" } }
    : { body: { state: "active", kinds: body.kinds } };
  if (route === "/api/push/subscriptions/state") return { body: push.state ?? { state: "active", kinds: ["needsYou", "failed", "finished"] } };
  if (route === "/api/push/subscriptions/remove") return { body: { removed: true } };
  return { status: 500, body: { error: `unexpected ${method} ${route}` } };
}

async function mount({ permission = "default", answer = "granted", shows = "show", api = true, query = "", storage = "works", shell, push } = {}) {
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
  page.pushLog = [];
  window.fetch = async (url, init = {}) => {
    const address = String(url);
    // The push routes, on an iPhone Home Screen app only (T-200).
    if (push && address.includes("/api/push")) {
      const route = address.slice(address.indexOf("/api/push"));
      const body = init.body ? JSON.parse(init.body) : undefined;
      page.pushLog.push([init.method || "GET", route, body]);
      const { status = 200, body: answerBody } = pushAnswer(push, init.method || "GET", route, body);
      return { ok: status < 400, status, text: async () => JSON.stringify(answerBody), json: async () => answerBody };
    }
    page.requests.push(address);
    throw new Error("no request expected");
  };
  if (push) {
    // The Home Screen app on an iPhone (T-200): its service worker, push
    // subscription and display mode, recorded in `pushLog` in order.
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });
    window.matchMedia = (media) => ({ media, matches: push.standalone !== false && media === "(display-mode: standalone)", addEventListener() {}, removeEventListener() {} });
    window.PushManager = class {};
    const subscriptionAt = (endpoint) => ({
      endpoint,
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "fixture-p256dh", auth: "fixture-auth" } }),
      unsubscribe: async () => {
        page.pushLog.push(["unsubscribe", endpoint]);
        if (subscription?.endpoint === endpoint) subscription = null;
        return true;
      },
    });
    let subscription = push.subscription ? subscriptionAt(push.subscription) : null;
    let registered = !!push.subscription;
    const registration = {
      scope: "https://isolated.test/",
      pushManager: {
        getSubscription: async () => subscription,
        subscribe: async (options) => {
          page.pushLog.push(["subscribe", options.applicationServerKey.length, options.userVisibleOnly]);
          subscription = subscriptionAt("https://web.push.apple.com/fixture-new");
          return subscription;
        },
      },
    };
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async (url, options) => {
          page.pushLog.push(["register", url, options.scope, options.updateViaCache]);
          registered = true;
          return registration;
        },
        get ready() { return Promise.resolve(registration); },
        getRegistration: async () => (registered ? registration : undefined),
        addEventListener() {},
        removeEventListener() {},
      },
    });
  }
  if (!window.isSecureContext) Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {
    page.scrolls += 1;
  };
  class Recorder {
    static permission = permission;
    static requestPermission() {
      page.asked += 1;
      page.pushLog.push(["ask"]);
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
          // Copied out of the page's realm, to compare with this one's values.
          page.invoked.push(args === undefined ? [command] : [command, JSON.parse(JSON.stringify(args))]);
          if (command === "desktop_notifications") {
            if (shell.answer === "missing") throw "Command desktop_notifications not found";
            return shell.answer;
          }
          // On macOS: what macOS says once asked (T-188).
          if (command === "desktop_notifications_request") {
            if (shell.request === "fails") throw "macOS rejected the notification request";
            shell.answer = shell.request;
            return shell.answer;
          }
          if (command === "desktop_notify" && shell.notify === "refused") throw "The system didn't take the notification: fixture";
          if (command === "desktop_notify") return { handed: true };
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
    [{ permission: "granted", query: "?shell=desktop" }, /Not available in this app.*the iPhone app, the desktop app on Linux, and older desktop apps/],
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
  assert.deepEqual(page.invoked.slice(1), [["desktop_notify", { title: "Yuzuno", body: "A test notification from your Workspace.", whenAway: false }]], "one, to the app, also while looking");
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

// T-188: in the desktop app on macOS, the app says what macOS allows it. It
// asks macOS once, from the user's click; a denial is not asked again but
// keeps this device's choices; only an allowed one is sent.
const macos = (authorization, extra = {}) => ({ supported: authorization === "allowed" || authorization === "quiet", system: "macos", authorization, ...extra });

test("on macOS, not asked yet: turning it on asks macOS once, and an allow is then said and used", async () => {
  const page = await mount({ permission: "granted", shell: { answer: macos("not-requested"), request: macos("allowed") } });
  await until(() => /asks macOS once/.test(page.text()), "macOS's state");
  assert.match(page.text(), /System notifications\s*Not asked yet/);
  assert.match(page.text(), /Turning this on asks macOS first\./);
  assert.deepEqual(page.invoked, [["desktop_notifications"]], "opening Settings asks nothing");
  page.box("Notify me on this device").click();
  await until(() => page.saved()?.enabled === true, "the choice saved");
  assert.deepEqual(page.invoked, [["desktop_notifications"], ["desktop_notifications_request"]], "asked once, from the click");
  assert.equal(page.asked, 0, "never the web view's own permission");
  assert.match(page.text(), /System notifications\s*Allowed\s*macOS allows this app’s notifications\./);
  assert.equal(page.box("Notify me on this device").checked, true);
  page.button("Send a test").click();
  await until(() => page.doc.querySelector(".notification-test-result"), "a result");
  assert.match(page.doc.querySelector(".notification-test-result").textContent, /^Accepted by macOS\. If you didn’t see it, check this app in System Settings → Notifications, and Focus\.$/);
  assert.deepEqual(page.invoked.slice(2), [["desktop_notify", { title: "Yuzuno", body: "A test notification from your Workspace.", whenAway: false }]], "sent through the app, not asked again");
  assert.deepEqual(page.shown, [], "not through the webview's own Notification");
  page.close();
});

test("on macOS, a no keeps the choices without asking again or sending; allowing it in System Settings is read on coming back", async () => {
  const shell = { answer: macos("not-requested"), request: macos("denied") };
  const page = await mount({ shell });
  await until(() => !!page.box("Notify me on this device"), "the switch");
  page.box("Notify me on this device").click();
  await until(() => /Off in macOS/.test(page.text()), "denied");
  assert.equal(page.window.localStorage.getItem("yuzuno.notifications"), null, "a no saves nothing");
  assert.match(page.text(), /this app won’t ask again\. To allow them: System Settings → Notifications → Yuzuno/);
  assert.equal(page.hasButton("Send a test"), false, "no test, and nothing to ask with");
  assert.equal(page.box("Notify me on this device").checked, false);
  assert.match(page.text(), /Kept for when macOS allows this app’s notifications\./);
  // The choices are still this device's to make.
  page.box("Notify me on this device").click();
  await until(() => page.saved()?.enabled === true, "the choice saved");
  page.box("Mute on this device").click();
  await until(() => page.saved()?.muted === true, "muted saved");
  assert.deepEqual(page.invoked, [["desktop_notifications"], ["desktop_notifications_request"]], "never asked again, nothing sent");
  assert.match(page.text(), /Needs you and unread updates always show/);
  // Allowed in System Settings meanwhile, then back to this window.
  shell.answer = macos("allowed");
  page.window.dispatchEvent(new page.window.Event("focus"));
  await until(() => /System notifications\s*Allowed/.test(page.text()), "read again");
  assert.equal(page.invoked.filter(([command]) => command === "desktop_notifications_request").length, 1);
  assert.equal(page.hasButton("Send a test"), true);
  page.close();
});

test("on macOS, quiet delivery is said; a state the app couldn't read is not a denial; a failed ask says so", async () => {
  const quiet = await mount({ shell: { answer: macos("quiet") } });
  await until(() => /Allowed quietly/.test(quiet.text()), "quiet");
  assert.match(quiet.text(), /to Notification Center, without a banner or sound/);
  quiet.button("Send a test").click();
  await until(() => quiet.doc.querySelector(".notification-test-result"), "a result");
  assert.match(quiet.doc.querySelector(".notification-test-result").textContent, /^Accepted by macOS, which delivers this app’s notifications quietly/);
  quiet.close();

  const refused = await mount({ shell: { answer: macos("allowed"), notify: "refused" } });
  await until(() => !!refused.button("Send a test"), "the test");
  refused.button("Send a test").click();
  await until(() => refused.doc.querySelector(".notification-test-result"), "a result");
  assert.match(refused.doc.querySelector(".notification-test-result").textContent, /^This app couldn’t hand it to macOS: The system didn't take the notification: fixture$/);
  await until(() => refused.invoked.filter(([command]) => command === "desktop_notifications").length === 2, "macOS read again after a refusal");
  refused.close();

  for (const [answer, help] of [
    [macos("unknown", { reason: "this app isn't running from its app bundle" }), /couldn’t tell whether macOS allows its notifications: this app isn't running from its app bundle\./],
    [macos("unknown"), /macOS gave an answer this app doesn’t know\./],
  ]) {
    const page = await mount({ shell: { answer } });
    await until(() => /Not available now/.test(page.text()), "not available");
    assert.match(page.text(), help);
    assert.doesNotMatch(page.text(), /Off in macOS|Blocked/, "not a denial");
    assert.equal(page.hasBox("Notify me on this device"), false);
    assert.equal(page.hasButton("Send a test"), false);
    page.close();
  }

  const failing = await mount({ shell: { answer: macos("not-requested"), request: "fails" } });
  await until(() => !!failing.box("Notify me on this device"), "the switch");
  failing.box("Notify me on this device").click();
  await until(() => failing.doc.querySelector(".notification-ask-result"), "the failure");
  assert.equal(failing.doc.querySelector(".notification-ask-result").textContent, "macOS didn’t ask: macOS rejected the notification request.");
  assert.match(failing.text(), /Not asked yet/, "still not asked");
  assert.equal(failing.window.localStorage.getItem("yuzuno.notifications"), null);
  failing.close();
});

// Push on the iPhone or iPad Home Screen app (T-200): one switch per device.
const PUSH = "Push notifications on this device";
// A recorded step without its empty parts (a GET has no body).
const step = (entry) => entry.filter((part) => part !== undefined);

test("push: asked from the click first, then registered, keyed and subscribed for the chosen kinds; kinds follow the switches; off removes only this device", async () => {
  const page = await mount({ push: {} });
  await until(() => page.hasBox(PUSH), "the push switch");
  await until(() => page.pushLog.length === 1, "whether Core pushes");
  assert.equal(page.box(PUSH).checked, false);
  assert.deepEqual(page.pushLog.map(step), [["GET", "/api/push"]], "opening Settings only asks Core whether it pushes");
  assert.equal(page.asked, 0, "nothing is asked before the click");
  assert.equal(page.hasBox("A Turn finished"), true, "the kinds are offered for push");
  page.box(PUSH).click();
  await until(() => page.box(PUSH).checked, "on");
  const endpoint = "https://web.push.apple.com/fixture-new";
  const keys = { p256dh: "fixture-p256dh", auth: "fixture-auth" };
  assert.deepEqual(page.pushLog.slice(1).map(step), [
    ["ask"],
    ["register", "/sw.js", "/", "none"],
    ["POST", "/api/push/key", {}],
    ["subscribe", 65, true],
    ["POST", "/api/push/subscriptions", { endpoint, expirationTime: null, keys, kinds: ["needsYou", "failed", "finished"] }],
  ]);
  assert.match(page.text(), /On for this device, for what you choose below/);
  const before = page.pushLog.length;
  page.box("A Turn finished").click();
  await until(() => page.pushLog.length > before, "the new kinds sent");
  assert.deepEqual(page.pushLog.slice(before).map(step), [["POST", "/api/push/subscriptions", { endpoint, expirationTime: null, keys, kinds: ["needsYou", "failed"] }]]);
  const on = page.pushLog.length;
  page.box(PUSH).click();
  await until(() => !page.box(PUSH).checked, "off");
  assert.deepEqual(page.pushLog.slice(on).map(step), [["POST", "/api/push/subscriptions/remove", { endpoint }], ["unsubscribe", endpoint]]);
  page.close();
});

test("push: a no from iOS registers and subscribes nothing, and says where to allow it", async () => {
  const page = await mount({ push: {}, answer: "denied" });
  await until(() => page.hasBox(PUSH), "the push switch");
  page.box(PUSH).click();
  await until(() => /Settings → Notifications → Yuzuno/.test(page.text()), "denied");
  assert.deepEqual(page.pushLog.map(step), [["GET", "/api/push"], ["ask"]]);
  assert.equal(page.hasBox(PUSH), false, "no switch while iOS refuses");
  page.close();
});

test("push: refused in iOS after subscribing, the subscription Core still holds can be turned off here", async () => {
  const endpoint = "https://web.push.apple.com/fixture-held";
  const page = await mount({ push: { subscription: endpoint }, permission: "denied" });
  await until(() => page.hasBox(PUSH) && page.box(PUSH).checked, "the switch, on");
  assert.match(page.text(), /iOS doesn’t allow Yuzuno’s notifications/);
  page.box(PUSH).click();
  await until(() => !page.hasBox(PUSH), "off, and nothing to turn on again while iOS refuses");
  assert.deepEqual(page.pushLog.map(step).slice(-2), [["POST", "/api/push/subscriptions/remove", { endpoint }], ["unsubscribe", endpoint]]);
  assert.equal(page.asked, 0, "turning it off asks nothing");
  page.close();
});

test("push: outside the Home Screen app, or with an older Core, said why, with nothing to switch on", async () => {
  const tab = await mount({ push: { standalone: false } });
  assert.match(tab.text(), /Add to Home Screen/);
  assert.equal(tab.hasBox(PUSH), false);
  assert.deepEqual(tab.pushLog, [], "Core is not asked");
  tab.close();
  const desktop = await mount();
  assert.match(desktop.text(), /Only in the Yuzuno app on an iPhone or iPad Home Screen/);
  assert.equal(desktop.hasBox(PUSH), false);
  desktop.close();
  const old = await mount({ push: { oldCore: true } });
  await until(() => /This Core can’t send push notifications/.test(old.text()), "an older Core");
  assert.equal(old.hasBox(PUSH), false);
  old.close();
});

test("push: one Core stopped sending to says so; turning it on asks first, then replaces it", async () => {
  const stale = "https://web.push.apple.com/fixture-old";
  const page = await mount({ push: { subscription: stale, state: { state: "expired", reason: "The push service no longer knows this device" } } });
  await until(() => /Stopped: The push service no longer knows this device/.test(page.text()), "stopped");
  assert.equal(page.box(PUSH).checked, false);
  assert.deepEqual(page.pushLog.map(step), [["GET", "/api/push"], ["POST", "/api/push/subscriptions/state", { endpoint: stale }]]);
  page.box(PUSH).click();
  await until(() => page.box(PUSH).checked, "on again");
  assert.deepEqual(page.pushLog.slice(2).map(([what, route]) => (route === undefined ? what : `${what} ${route}`)), [
    "ask", `unsubscribe ${stale}`, "register /sw.js", "POST /api/push/key", "subscribe 65", "POST /api/push/subscriptions",
  ]);
  page.close();
});

test("push: Core refusing this device's push service is said as it is", async () => {
  const page = await mount({ push: { subscribeError: true } });
  await until(() => page.hasBox(PUSH), "the push switch");
  page.box(PUSH).click();
  await until(() => /only through Apple’s push service/.test(page.text()), "the refusal");
  assert.equal(page.box(PUSH).checked, false);
  page.close();
});
