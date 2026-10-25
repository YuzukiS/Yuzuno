// This device's preferences to and from one file (T-194): the export holds
// Appearance, the send key and time display as in effect, and nothing else;
// an import shows each group beside yours and applies one group at a time,
// only once saved on this device. A refused save leaves that group as it is,
// and no other group changes. An Appearance export reads as its Appearance
// group; a newer file, an unusable group and unknown fields are said.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "device-transfer-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {DeviceTransferSection} from ${src("DeviceTransfer.tsx")};
import {WorkspaceUpdatesHost} from ${src("WorkspaceUpdates.tsx")};
import {initializeAppearance} from ${src("appearance.ts")};
const root = createRoot(document.getElementById('root'));
window.show = () => { initializeAppearance(); flushSync(() => root.render(<DeviceTransferSection/>)); };
const navigation = { agents: [], projects: [], onNavigate: () => {} };
window.showSettings = () => { initializeAppearance(); root.render(<WorkspaceUpdatesHost enabled open onOpenChange={() => {}}
  onNeedsReloadChange={() => {}} preserveDrafts={() => {}} navigation={navigation}/>); };`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "DeviceTransferUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const KEYS = { appearance: "yuzuno.appearance", sending: "yuzuno.preferences", time: "yuzuno.time", language: "yuzuno.language", notifications: "yuzuno.notifications" };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await tick(10);
  }
  assert.fail(`Expected state did not appear: ${what}`);
}
const deviceFile = (groups, over = {}) => ({ format: "yuzuno-device-preferences", version: 1, exportedAt: "2026-10-25T01:00:00.000Z", ...groups, ...over });

function mount({ saved = {}, settings = false, browserLanguages = ["en-US"] } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(window.navigator, "languages", { configurable: true, value: browserLanguages });
  // Nothing here may ask for permission or show a notification (T-194).
  const notified = [];
  window.Notification = class {
    static permission = "default";
    static requestPermission() {
      notified.push("requestPermission");
      return Promise.resolve("default");
    }
    constructor(title) {
      notified.push(`notification: ${title}`);
    }
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  for (const [key, value] of Object.entries(saved)) window.localStorage.setItem(KEYS[key], JSON.stringify(value));
  window.fetch = async (url) => {
    const where = new URL(url, "http://isolated.test").pathname;
    const value = where === "/api/updates" ? unmanagedUpdates : undefined;
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '{"error":"not in this fixture"}' };
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  const exported = [];
  window.URL.createObjectURL = (blob) => {
    exported.push(blob);
    return "blob:isolated.test/preferences";
  };
  window.URL.revokeObjectURL = () => {};
  const storage = window.Storage.prototype;
  const original = storage.setItem;
  window.eval(bundle);
  if (settings) window.showSettings();
  else window.show();
  const document = window.document;
  const section = () => document.querySelector("#settings-transfer");
  const group = (title) => section()?.querySelector(`.device-transfer-group[aria-label="${title}"]`);
  return {
    window, document, exported, notified,
    stored: (key) => window.localStorage.getItem(KEYS[key]),
    /** The browser refuses to save `key` only. */
    refuse(key) {
      storage.setItem = function (name, value) {
        if (name === KEYS[key]) throw new window.DOMException("refused", "QuotaExceededError");
        return original.call(this, name, value);
      };
    },
    allow() {
      storage.setItem = original;
    },
    section, group,
    button: (scope, name) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === name),
    row: (title, label) => [...(group(title)?.querySelectorAll("li") ?? [])].find((li) => li.querySelector(".appearance-file-name")?.textContent.trim() === label),
    pick(text, name = "preferences.json") {
      const input = section().querySelector('input[type="file"]');
      const picked = new window.File([text], name, { type: "application/json" });
      Object.defineProperty(input, "files", { configurable: true, value: [picked] });
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    },
    read: (blob) => new Promise((resolve) => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    }),
    close: () => window.close(),
  };
}

test("the export is one versioned file of Appearance, the send key and time display in effect, and nothing else", async () => {
  const page = mount({ saved: { sending: { sendKey: "enter" }, time: { clock: "h24", timeZone: "UTC" } } });
  page.button(page.section(), "Export to a file").click();
  await until(() => page.exported.length === 1, "an export");
  const data = JSON.parse(await page.read(page.exported[0]));
  assert.deepEqual(Object.keys(data).sort(), ["appearance", "exportedAt", "format", "language", "notifications", "sending", "time", "version"]);
  assert.deepEqual([data.format, data.version], ["yuzuno-device-preferences", 1]);
  assert.deepEqual(data.sending, { sendKey: "enter" });
  assert.deepEqual(data.time, { clock: "h24", timeZone: "UTC" });
  assert.deepEqual(Object.keys(data.appearance).sort(), ["agentList", "dock", "fontSize", "palette", "projectGroups", "theme", "turnDock"]);
  page.close();
});

test("each group is applied on its own, only once saved on this device; a refused save leaves that group, and the others, as they are", async () => {
  const page = mount();
  page.pick(JSON.stringify(deviceFile({
    appearance: { palette: "yuzu" },
    sending: { sendKey: "modEnter" },
    time: { clock: "h12", timeZone: "Asia/Tokyo" },
  })));
  await until(() => page.group("Time display"), "the preview");
  assert.deepEqual([page.stored("appearance"), page.stored("sending"), page.stored("time")], [null, null, null], "a preview saves nothing");
  assert.match(page.row("Appearance", "Palette").textContent, /Now: Garden.*File: Yuzu/);
  assert.match(page.row("Sending messages", "Send key").textContent, /Now: Automatic.*File: .*\+Return sends/);
  assert.match(page.row("Time display", "Clock").textContent, /Now: System.*File: 12-hour/);
  assert.match(page.row("Time display", "Time zone").textContent, /Now: This device’s own.*File: Asia\/Tokyo/);

  // One group: only its own preferences change.
  page.button(page.group("Sending messages"), "Apply Sending messages").click();
  await until(() => page.stored("sending"), "the send key saved");
  assert.deepEqual(JSON.parse(page.stored("sending")), { sendKey: "modEnter" });
  assert.deepEqual([page.stored("appearance"), page.stored("time")], [null, null], "the other groups stay");
  assert.match(page.group("Sending messages").textContent, /Sending messages applied and saved on this device\./);
  assert.ok(page.button(page.group("Sending messages"), "Nothing to apply").disabled);

  // A refused save: that group is not applied, and nothing else changes.
  page.refuse("time");
  page.button(page.group("Time display"), "Apply Time display").click();
  await until(() => page.group("Time display").querySelector("[role=alert]"), "the refusal");
  assert.match(page.group("Time display").querySelector("[role=alert]").textContent, /Time display not applied: .*It stays as it is\./);
  assert.equal(page.stored("time"), null);
  assert.match(page.row("Time display", "Clock").textContent, /Now: System/, "what is in effect stays");
  assert.ok(page.button(page.group("Time display"), "Apply Time display"), "it can be applied again");
  page.allow();

  page.button(page.group("Appearance"), "Apply Appearance").click();
  await until(() => page.stored("appearance"), "Appearance saved");
  assert.equal(JSON.parse(page.stored("appearance")).palette, "yuzu");
  assert.equal(page.document.documentElement.dataset.palette, "yuzu");
  assert.equal(page.stored("time"), null, "time display still as it was");
  page.close();
});

test("an Appearance export reads as its Appearance group; a newer file, an unusable group and unknown fields are said, and nothing is taken from them", async () => {
  const page = mount();
  page.pick(JSON.stringify({ format: "yuzuno-appearance", version: 1, appearance: { theme: "dark" } }), "appearance.json");
  await until(() => page.group("Appearance"), "the Appearance group");
  assert.match(page.section().querySelector('[aria-label="Import preview"]').textContent, /an Appearance export: only Appearance is in it/);
  assert.ok(!page.group("Sending messages") && !page.group("Time display"), "no other group");
  page.button(page.group("Appearance"), "Apply Appearance").click();
  await until(() => page.stored("appearance"), "Appearance saved");
  assert.equal(JSON.parse(page.stored("appearance")).theme, "dark");

  page.pick(JSON.stringify(deviceFile({ sending: { sendKey: "enter" } }, { version: 2 })));
  await until(() => page.section().querySelector("[role=alert]"), "the newer file refused");
  assert.match(page.section().querySelector("[role=alert]").textContent, /newer Yuzuno \(file version 2\).*Nothing was changed/);
  assert.equal(page.stored("sending"), null);

  page.pick(JSON.stringify(deviceFile({ sending: { sendKey: "shout" }, time: { clock: "h24", extra: 1 } }, { keybindings: "ja" })));
  await until(() => page.group("Time display"), "the preview");
  assert.match(page.group("Sending messages").textContent, /Can’t be applied: the file holds a send key this version doesn’t have: "shout"\. Kept as now\./);
  assert.ok(!page.button(page.group("Sending messages"), "Apply Sending messages"), "it offers no Apply");
  assert.match(page.section().textContent, /Not preferences this version knows, so left out: keybindings, time\.extra/);
  page.button(page.group("Time display"), "Apply Time display").click();
  await until(() => page.stored("time"), "time display saved");
  assert.deepEqual(JSON.parse(page.stored("time")), { clock: "h24", timeZone: null });
  assert.equal(page.stored("sending"), null, "the unusable group took nothing");
  page.close();
});

test("Settings → Appearance & interaction offers it, and its editor opens in place", async () => {
  const page = mount({ settings: true });
  (await until(() => page.document.querySelector("#settings-tab-appearance"), "the Settings categories")).click();
  const open = await until(() => [...page.document.querySelectorAll(".settings-entries button")].find((b) => b.textContent === "Move preferences"), "its entry");
  open.click();
  await until(() => page.document.querySelector("#settings-editor-transfer:not([hidden]) #settings-transfer"), "the editor");
  page.close();
});


test("the language goes as chosen and notifications without whether the device notifies; each is applied on its own, and nothing asks for permission", async () => {
  // A Chinese browser, the language left at System: the file says System, not Chinese.
  const saved = { notifications: { enabled: false, categories: { needsYou: true, failed: true, finished: true, backupFailed: false }, preview: false, muted: false } };
  const page = mount({ saved, browserLanguages: ["zh-CN"] });
  const exportedFrom = mount({ saved: { notifications: { enabled: true, categories: { finished: false }, preview: true, muted: false } }, browserLanguages: ["zh-CN"] });
  exportedFrom.button(exportedFrom.section(), "导出到文件").click();
  await until(() => exportedFrom.exported.length === 1, "an export");
  const data = JSON.parse(await exportedFrom.read(exportedFrom.exported[0]));
  assert.deepEqual(data.language, { language: "system" }, "the choice, not what System resolved to");
  assert.deepEqual(data.notifications, { categories: { needsYou: true, failed: true, finished: false, backupFailed: false }, preview: true, muted: false });
  assert.ok(!("enabled" in data.notifications), "whether a device notifies is never in the file");
  exportedFrom.close();

  page.pick(JSON.stringify(deviceFile({
    language: { language: "en" },
    notifications: { enabled: true, categories: { finished: false, backupFailed: true, madeUp: true }, preview: true, muted: true },
  })));
  await until(() => page.group("通知"), "the preview");
  assert.match(page.row("界面语言", "界面语言").textContent, /当前：系统.*文件：English/);
  assert.match(page.row("通知", "Turn 完成").textContent, /当前：开.*文件：关/);
  assert.match(page.row("通知", "每日备份失败").textContent, /当前：关.*文件：开/);
  assert.match(page.row("通知", "显示所写的内容").textContent, /当前：关.*文件：开/);
  assert.match(page.row("通知", "在此设备上静音").textContent, /当前：关.*文件：开/);
  assert.match(page.group("通知").textContent, /此设备是否发送通知，以及此浏览器的权限，都保持不变/);
  assert.match(page.section().textContent, /此版本不认识的偏好，因此未包含：notifications\.enabled, notifications\.categories\.madeUp/);
  assert.equal(page.stored("language"), null, "a preview saves nothing");

  // A refused save: not applied, and what is in effect stays.
  page.refuse("notifications");
  page.button(page.group("通知"), "应用通知").click();
  await until(() => page.group("通知").querySelector("[role=alert]"), "the refusal");
  assert.match(page.group("通知").querySelector("[role=alert]").textContent, /通知未应用：.*它保持不变。/);
  assert.deepEqual(JSON.parse(page.stored("notifications")), saved.notifications, "nothing of it saved");
  assert.match(page.row("通知", "Turn 完成").textContent, /当前：开/, "still in effect as it was");
  page.allow();

  page.button(page.group("通知"), "应用通知").click();
  await until(() => JSON.parse(page.stored("notifications")).muted, "notifications saved");
  assert.deepEqual(JSON.parse(page.stored("notifications")), {
    enabled: false,
    categories: { needsYou: true, failed: true, finished: false, backupFailed: true },
    preview: true,
    muted: true,
  }, "the kinds, previews and mute; whether this device notifies stays its own");
  assert.equal(page.stored("language"), null, "the language group stays");

  // The language: applied on its own, and the page is then shown in it.
  page.refuse("language");
  page.button(page.group("界面语言"), "应用界面语言").click();
  await until(() => page.group("界面语言").querySelector("[role=alert]"), "the language refusal");
  assert.equal(page.stored("language"), null);
  assert.match(page.row("界面语言", "界面语言").textContent, /当前：系统/, "still Chinese, as System gives");
  page.allow();
  page.button(page.group("界面语言"), "应用界面语言").click();
  await until(() => page.group("Language"), "the page in English");
  assert.deepEqual(JSON.parse(page.stored("language")), { language: "en" });
  assert.match(page.group("Language").textContent, /Language applied and saved on this device\./);
  assert.deepEqual(page.notified, [], "no permission asked, no notification shown");
  page.close();
});

test("language and notification values must be ones this version has: anything else leaves the group as it is", async () => {
  const page = mount();
  page.pick(JSON.stringify(deviceFile({
    language: { language: "fr" },
    notifications: { categories: { failed: 1 }, preview: true },
    time: { clock: "h24" },
  })));
  await until(() => page.group("Notifications"), "the preview");
  assert.match(page.group("Language").textContent, /Can’t be applied: the file holds a language choice this version doesn’t have: "fr"\. Kept as now\./);
  assert.match(page.group("Notifications").textContent, /Can’t be applied: the file holds not on or off for failed: 1\. Kept as now\./);
  assert.ok(!page.button(page.group("Language"), "Apply Language") && !page.button(page.group("Notifications"), "Apply Notifications"), "no Apply for them");
  page.pick(JSON.stringify(deviceFile({ notifications: { muted: "true" } })));
  await until(() => page.group("Notifications")?.textContent.includes('"true"'), "a string is not on or off");
  page.pick(JSON.stringify(deviceFile({ notifications: ["muted"] })));
  await until(() => page.group("Notifications")?.textContent.includes("not settings"), "a list is not settings");
  assert.deepEqual([page.stored("language"), page.stored("notifications")], [null, null], "nothing taken from them");
  assert.deepEqual(page.notified, []);
  page.close();
});
