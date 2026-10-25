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

const KEYS = { appearance: "yuzuno.appearance", sending: "yuzuno.preferences", time: "yuzuno.time" };
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

function mount({ saved = {}, settings = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
    window, document, exported,
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
  assert.deepEqual(Object.keys(data).sort(), ["appearance", "exportedAt", "format", "sending", "time", "version"]);
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

  page.pick(JSON.stringify(deviceFile({ sending: { sendKey: "shout" }, time: { clock: "h24", extra: 1 } }, { language: "ja" })));
  await until(() => page.group("Time display"), "the preview");
  assert.match(page.group("Sending messages").textContent, /Can’t be applied: the file holds a send key this version doesn’t have: "shout"\. Kept as now\./);
  assert.ok(!page.button(page.group("Sending messages"), "Apply Sending messages"), "it offers no Apply");
  assert.match(page.section().textContent, /Not preferences this version knows, so left out: language, time\.extra/);
  page.button(page.group("Time display"), "Apply Time display").click();
  await until(() => page.stored("time"), "time display saved");
  assert.deepEqual(JSON.parse(page.stored("time")), { clock: "h24", timeZone: null });
  assert.equal(page.stored("sending"), null, "the unusable group took nothing");
  page.close();
});

test("Settings → Appearance & interaction offers it, and its editor opens in place", async () => {
  const page = mount({ settings: true });
  (await until(() => page.document.querySelector("#settings-tab-appearance"), "the Settings categories")).click();
  const open = await until(() => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open Move preferences to another device"), "the card");
  open.click();
  await until(() => page.document.querySelector("#settings-editor-transfer:not([hidden]) #settings-transfer"), "the editor");
  page.close();
});
