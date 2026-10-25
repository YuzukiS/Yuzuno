import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// The app's system notifications (T-188) through the hook App uses, in an
// isolated page with the browser's Notification API replaced by a recorder:
// what this device chose, what its system allows and whether the user is
// looking decide what is shown; nothing asks the system, nothing reaches Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "system-notifications-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {useSystemNotifications, useBackupRun} from ${JSON.stringify(path.join(root, "src/useSystemNotifications.ts"))};
const root = createRoot(document.getElementById('root'));
window.opened = [];
function Probe({ workspaceId, agents, asks }) {
  useSystemNotifications(workspaceId, agents, asks, (notice) => window.opened.push(notice.home ? 'home' : notice.agentId || 'workspace'));
  return null;
}
window.read = (workspaceId, agents, asks = null) => root.render(<Probe workspaceId={workspaceId} agents={agents} asks={asks} />);
function BackupProbe({ revision }) {
  window.backupRun = useBackupRun(revision);
  return null;
}
window.readBackup = (revision) => root.render(<BackupProbe revision={revision} />);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "SystemNotificationsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

/** A page whose system allows `permission`, with this device's saved choices. */
function mount({ permission = "granted", saved = { enabled: true }, looking = false, shell, answers = {} } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const page = { dom, errors, requests: [], asked: 0, shown: [], looking, invoked: [] };
  const { window } = dom;
  window.fetch = (url) => {
    page.requests.push(String(url));
    const answer = answers[new URL(String(url), "https://isolated.test").pathname];
    if (answer) return Promise.resolve({ ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) });
    return Promise.reject(new Error("no request expected"));
  };
  if (!window.isSecureContext) Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.document, "visibilityState", { get: () => (page.looking ? "visible" : "hidden"), configurable: true });
  window.document.hasFocus = () => page.looking;
  class Recorder {
    static permission = permission;
    static requestPermission() {
      page.asked += 1;
      return Promise.resolve(Recorder.permission);
    }
    constructor(title, options) {
      this.onshow = this.onerror = this.onclick = null;
      this.close = () => {};
      page.shown.push({ title, body: options.body, tag: options.tag, notification: this });
      setTimeout(() => this.onshow?.(), 0);
    }
  }
  window.Notification = Recorder;
  window.focus = () => {};
  // The desktop app's command bridge (T-188), as in notification-settings-ui.
  if (shell) {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          // Copied out of the page's realm, to compare with this one's values.
          page.invoked.push(args === undefined ? [command] : [command, JSON.parse(JSON.stringify(args))]);
          if (command === "desktop_notifications") return shell.answer;
          if (command === "desktop_notify") return { handed: true };
          throw `unexpected ${command}`;
        },
      },
    };
  }
  if (saved) window.localStorage.setItem("yuzuno.notifications", JSON.stringify(saved));
  window.eval(bundle);
  page.read = async (agents, asks = null, workspaceId = "ws-1") => {
    window.read(workspaceId, JSON.parse(JSON.stringify(agents)), asks && JSON.parse(JSON.stringify(asks)));
    await tick();
  };
  // window.opened is the page's own array: compared through Array.from (another realm).
  page.titles = () => page.shown.map((n) => n.title);
  page.close = (requests = []) => {
    assert.deepEqual(errors, []);
    assert.deepEqual(page.requests, requests, "nothing else reaches Core");
    assert.equal(page.asked, 0, "the system is never asked from here");
    window.close();
  };
  return page;
}
const agent = (id, extra = {}) => ({ id, name: { a: "Mori", b: "Hana", c: "Sora", d: "Yuki" }[id], status: "idle", pendingCount: 0, closedAt: null, workSummary: null, ...extra });
const result = (id) => agent(id, { workSummary: { kind: "result", text: `Secret details from ${id}`, source: "agent" } });

test("a finished Turn, read while the user looks elsewhere, is one notification without what was written", async () => {
  const page = mount();
  await page.read([agent("a", { status: "working" })]);
  assert.deepEqual(page.shown, [], "a first read is no change");
  await page.read([result("a")]);
  assert.deepEqual(page.shown.map(({ title, body, tag }) => ({ title, body, tag })), [{ title: "Mori finished", body: "The Turn finished.", tag: "yuzuno:finished:a" }]);
  // A click opens that conversation.
  page.shown[0].notification.onclick();
  assert.deepEqual(Array.from(page.dom.window.opened), ["a"]);
  // The same state read again: nothing more.
  await page.read([result("a")]);
  assert.equal(page.shown.length, 1);
  page.close();
});

test("while the user is looking, nothing is shown, and the change is not shown later either", async () => {
  const page = mount({ looking: true });
  await page.read([agent("a", { status: "working" })]);
  await page.read([result("a")]);
  assert.deepEqual(page.shown, []);
  page.looking = false;
  await page.read([result("a")]);
  assert.deepEqual(page.shown, []);
  page.close();
});

test("nothing without this device's choice, while muted, or where the system has not allowed it; asking is left to the user", async () => {
  for (const options of [{ saved: null }, { saved: { enabled: true, muted: true } }, { permission: "default" }, { permission: "denied" }]) {
    const page = mount(options);
    await page.read([agent("a", { status: "working" }), agent("b", { status: "working" })]);
    await page.read([result("a"), agent("b", { status: "waiting", pendingCount: 1 })]);
    assert.deepEqual(page.shown, [], JSON.stringify(options));
    page.close();
  }
});

test("each kind as chosen; preview shows what was written; a request before a finished Turn", async () => {
  const page = mount({ saved: { enabled: true, preview: true, categories: { finished: false } } });
  await page.read([agent("a", { status: "working" }), agent("b", { status: "working" }), agent("c", { status: "working" })]);
  await page.read([
    result("a"),
    agent("b", { status: "error", error: "Codex exited unexpectedly" }),
    agent("c", { status: "waiting", pendingCount: 1, workSummary: { kind: "pending", text: "Approve npm ci?", source: "runtime" } }),
  ]);
  assert.deepEqual(page.shown.map(({ title, body }) => ({ title, body })), [
    { title: "Sora needs you", body: "Approve npm ci?" },
    { title: "Hana: the Turn failed", body: "Codex exited unexpectedly" },
  ]);
  page.close();
});

test("a new Ask notifies once and opens Home; many changes at once are one notification", async () => {
  const page = mount();
  const ask = { kind: "ask", projectId: "p1", agentId: "a", agentName: "Mori", sectionKey: "release/ship", title: "Ship 0.4 today?", since: "" };
  await page.read([], []);
  await page.read([], [ask]);
  await page.read([], [ask]);
  assert.deepEqual(page.titles(), ["Mori asks you"]);
  page.shown[0].notification.onclick();
  assert.deepEqual(Array.from(page.dom.window.opened), ["home"]);

  const working = ["a", "b", "c", "d"].map((id) => agent(id, { status: "working" }));
  await page.read(working, [ask]);
  await page.read(["a", "b", "c", "d"].map(result), [ask]);
  assert.deepEqual(page.titles(), ["Mori asks you", "4 updates in your Workspace"]);
  page.close();
});

test("another Workspace starts afresh: its first read is no change", async () => {
  const page = mount();
  await page.read([agent("a", { status: "working" })], null, "ws-1");
  await page.read([result("a")], null, "ws-2");
  assert.deepEqual(page.shown, []);
  page.close();
});

// T-188: the desktop app that can notify here takes them instead of the webview.
test("in the desktop app that can notify, a change read while away is handed to the app, not the webview; off, muted or an app that can't stays silent", async () => {
  const windows = { supported: true, system: "windows" };
  const page = mount({ shell: { answer: windows } });
  await page.read([agent("a", { status: "working" })]);
  await page.read([result("a")]);
  assert.deepEqual(page.invoked, [["desktop_notifications"], ["desktop_notify", { title: "Mori finished", body: "The Turn finished.", whenAway: true }]], "for while away: the app decides from its window");
  assert.deepEqual(page.shown, [], "not through the webview's own Notification");
  await page.read([result("a")]);
  assert.equal(page.invoked.length, 2, "the same state read again: nothing more");
  page.close();
  // The page says it is looked at, as a minimized window's page does in the Windows app: still
  // handed to the app, which holds it back only while its window really is in front.
  const front = mount({ shell: { answer: windows }, looking: true });
  await front.read([agent("a", { status: "working" })]);
  await front.read([result("a")]);
  assert.deepEqual(front.invoked, [["desktop_notifications"], ["desktop_notify", { title: "Mori finished", body: "The Turn finished.", whenAway: true }]]);
  front.close();
  for (const options of [{ saved: null, shell: { answer: windows } }, { saved: { enabled: true, muted: true }, shell: { answer: windows } }, { shell: { answer: { supported: false, system: null } } }]) {
    const other = mount(options);
    await other.read([agent("a", { status: "working" })]);
    await other.read([result("a")]);
    assert.deepEqual(other.invoked, [["desktop_notifications"]], JSON.stringify(options));
    assert.deepEqual(other.shown, []);
    other.close();
  }
});

test("in the desktop app that can notify, a daily backup's last run is read once the app says so, with nothing else rendering again", async () => {
  const page = mount({
    shell: { answer: { supported: true, system: "windows" } },
    saved: { enabled: true, categories: { backupFailed: true } },
    answers: { "/api/workspace/backup/last-run": { lastRun: null } },
  });
  page.dom.window.readBackup(1);
  for (let i = 0; i < 40 && page.requests.length === 0; i++) await tick();
  assert.deepEqual(page.invoked, [["desktop_notifications"]]);
  assert.deepEqual(page.requests, ["/api/workspace/backup/last-run"], "read without another render");
  page.close(["/api/workspace/backup/last-run"]);
});
