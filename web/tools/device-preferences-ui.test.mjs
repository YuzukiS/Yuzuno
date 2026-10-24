import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// This device's preferences (T-189): the send key is kept in this browser
// only (device-storage.ts), read back as saved (an unknown value reads as
// Automatic), and a refused save is said as Appearance says it (SaveStatus),
// never "Saved", with Try again and Restore defaults. The keyboard
// shortcuts help lists the
// shortcuts as they work here (Return as the preference says; the desktop
// app's own only there), and every key it lists is handled where it says.
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/device-preferences-ui-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';import {flushSync} from 'react-dom';import {createRoot} from 'react-dom/client';
import {readPreferences, savePreferences} from ${src("device-preferences.ts")};
import {InputPreferencesSection} from ${src("InputPreferences.tsx")};
import {ShortcutHelpSection} from ${src("ShortcutHelp.tsx")};
import {shortcutGroups} from ${src("shortcuts.ts")};
window.store = {readPreferences, savePreferences};
window.shortcutGroups = shortcutGroups;
const root = createRoot(document.getElementById('root'));
window.showEditor = () => flushSync(() => root.render(<InputPreferencesSection />));
window.showHelp = () => flushSync(() => root.render(<ShortcutHelpSection />));`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: "DevicePreferencesUiTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const realSetItem = (w) => w.Storage.prototype.setItem;
function page({ saved, refuse } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  if (saved !== undefined) w.localStorage.setItem("yuzuno.preferences", saved);
  w.realSetItem = realSetItem(w);
  if (refuse)
    w.Storage.prototype.setItem = function () {
      throw new w.DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  w.eval(bundle);
  return w;
}
const button = (w, label) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const radio = (w, label) =>
  [...w.document.querySelectorAll('input[name="input-send-key"]')].find((input) => input.closest("label").textContent.includes(label));
const choose = (w, label) => {
  const input = radio(w, label);
  input.click();
};

test("the send key reads as saved, Automatic when unset or unknown", () => {
  for (const [saved, expected] of [[undefined, "auto"], ['{"sendKey":"modEnter"}', "modEnter"], ['{"sendKey":"Return"}', "auto"], ["not json", "auto"]]) {
    const w = page({ saved });
    try {
      assert.equal(w.store.readPreferences().sendKey, expected, String(saved));
    } finally {
      w.close();
    }
  }
});

test("a chosen send key is saved on this device and said so", () => {
  const w = page();
  try {
    w.showEditor();
    assert.equal(radio(w, "Automatic").checked, true);
    choose(w, "Return sends");
    assert.deepEqual(JSON.parse(w.localStorage.getItem("yuzuno.preferences")), { sendKey: "enter" });
    const status = w.document.querySelector('[role="status"]');
    assert.equal(status?.textContent.trim(), "Saved on this device");
    assert.equal(w.document.querySelector('[role="alert"]'), null);
    assert.match(w.document.querySelector(".settings-current").textContent, /Return sends/);
    // Restore defaults removes this device's choice: Automatic again.
    button(w, "Restore defaults").click();
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), null);
    assert.equal(radio(w, "Automatic").checked, true);
    assert.equal(w.store.readPreferences().sendKey, "auto");
  } finally {
    w.close();
  }
});

test("a save the browser refuses is said, never 'Saved', and the choice holds for this visit", () => {
  const w = page({ refuse: true });
  try {
    assert.deepEqual(w.store.savePreferences({ sendKey: "modEnter" }), { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" });
    w.showEditor();
    choose(w, "Return sends");
    const alert = w.document.querySelector('[role="alert"]');
    assert.equal(alert?.textContent.trim(), "Not saved on this device: this browser’s storage for Yuzuno is full. Your choice applies in this window until you close or reload it.");
    assert.ok(!w.document.body.textContent.includes("Saved on this device"), "no Saved");
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), null, "nothing was kept");
    // Held for this window: the editor shows the choice in effect.
    assert.equal(radio(w, "Return sends").checked, true);
    // Storage back: Try again saves it.
    w.Storage.prototype.setItem = w.realSetItem;
    button(w, "Try again").click();
    assert.deepEqual(JSON.parse(w.localStorage.getItem("yuzuno.preferences")), { sendKey: "enter" });
    assert.equal(w.document.querySelector('[role="status"]')?.textContent.trim(), "Saved on this device");
  } finally {
    w.close();
  }
});

test("the help lists Return as the send key makes it, and the desktop app's shortcut only there", () => {
  const rows = (groups, title) => groups.find((g) => g.title === title).shortcuts.map((s) => `${s.keys.join("+")}: ${s.action}`);
  const w = page();
  try {
    const at = (sendKey, touch, desktopApp = false) => w.shortcutGroups({ modifier: "Ctrl", sendKey, touch, desktopApp });
    assert.deepEqual(rows(at("auto", false), "Writing a message").slice(0, 3), ["Return: Send", "Ctrl+Return: Send", "Shift+Return: New line"]);
    assert.deepEqual(rows(at("auto", true), "Writing a message").slice(0, 3), ["Return: New line", "Ctrl+Return: Send", "Shift+Return: New line"]);
    assert.deepEqual(rows(at("enter", true), "Writing a message")[0], "Return: Send");
    assert.deepEqual(rows(at("modEnter", false), "Writing a message")[0], "Return: New line");
    assert.ok(!rows(at("auto", false), "Anywhere").some((row) => row.startsWith("Ctrl+,")), "no desktop shortcut in a browser");
    assert.ok(rows(at("auto", false, true), "Anywhere").some((row) => row.startsWith("Ctrl+,")), "the desktop app's own");
    // Rendered: each group, its keys and what they do.
    w.localStorage.setItem("yuzuno.preferences", '{"sendKey":"modEnter"}');
    w.showHelp();
    const text = w.document.querySelector(".shortcut-help").textContent;
    for (const title of ["Anywhere", "Writing a message", "Reading a conversation", "Home", "Lists and dialogs"]) assert.ok(text.includes(title), title);
    assert.ok(text.includes("cannot be changed yet"), "rebinding is not offered");
    // As this device's preference says: Ctrl or Cmd+Return sends.
    const writing = [...w.document.querySelectorAll(".shortcut-group")].find((group) => group.querySelector("h4")?.textContent === "Writing a message");
    const keys = (dt) => [...dt.querySelectorAll("kbd")].map((kbd) => kbd.textContent).join("+");
    assert.deepEqual([keys(writing.querySelector("dt")), writing.querySelector("dd").textContent], ["Return", "New line"]);
  } finally {
    w.close();
  }
});

// Each key the help lists, in the code it names: a shortcut removed or moved
// must leave the help too.
const tokens = {
  Ctrl: ["ctrlKey", "metaKey"], K: ['"k"'], N: ['"n"'], ",": ['","'], F: ['"f"'], Z: ['"z"'], Esc: ['"Escape"'],
  Return: ['"Enter"'], Shift: ["shiftKey", "Shift-Enter"], Tab: ['"Tab"'], "↑": ['"ArrowUp"'], "↓": ['"ArrowDown"'],
  Home: ['"Home"'], End: ['"End"'], "/": ["export function slashToken"], $: ["export function skillToken"],
};
test("every key the help lists is handled in the file it names", async () => {
  const w = page();
  let groups;
  try {
    groups = w.shortcutGroups({ modifier: "Ctrl", sendKey: "auto", touch: false, desktopApp: true });
  } finally {
    w.close();
  }
  const sources = new Map();
  const read = async (file) => {
    if (!sources.has(file)) sources.set(file, await readFile(path.join(root, "src", file), "utf8"));
    return sources.get(file);
  };
  let checked = 0;
  for (const group of groups)
    for (const shortcut of group.shortcuts) {
      // The browser's own (a button pressed, a dialog closed) has no handler to find.
      if (shortcut.native) continue;
      const files = await Promise.all(shortcut.source.split(", ").map(read));
      for (const key of shortcut.keys) {
        const wanted = tokens[key];
        assert.ok(wanted, `a token for ${key}`);
        assert.ok(files.some((code) => wanted.some((token) => code.includes(token))), `${key} (${shortcut.action}) in ${shortcut.source}`);
        checked++;
      }
    }
  assert.ok(checked > 30, `${checked} keys checked`);
});
