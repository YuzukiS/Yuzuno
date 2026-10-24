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
// Automatic), applies when another window saves it, and is said as
// Appearance says it (SaveStatus): before a save, what this device holds;
// a refused save or reset, never "Saved", with Try again (of that write)
// and Restore defaults. The keyboard shortcuts help lists the shortcuts as they
// work here (Return as the preference says; the desktop app's own only
// there), and every key it lists is handled where it says.
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

/** A page; the browser may refuse writes (`refuse`: storage full; `refuseRemove`:
 * blocked) or every read (`unreadable`). `w.real` has its own methods back. */
function page({ saved, refuse, refuseRemove, unreadable } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  if (saved !== undefined) w.localStorage.setItem("yuzuno.preferences", saved);
  const storage = w.Storage.prototype;
  w.real = { setItem: storage.setItem, removeItem: storage.removeItem, getItem: storage.getItem };
  const blocked = () => {
    throw new w.DOMException("The operation is insecure.", "SecurityError");
  };
  if (refuse)
    storage.setItem = function () {
      throw new w.DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  if (refuseRemove) storage.removeItem = blocked;
  if (unreadable) storage.getItem = blocked;
  w.eval(bundle);
  return w;
}
const button = (w, label) => [...w.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
// By value: a choice's note can name another choice ("Return sends").
const choose = (w, value) => w.document.querySelector(`input[name="input-send-key"][value="${value}"]`).click();
const checked = (w) => w.document.querySelector('input[name="input-send-key"]:checked')?.value;
const current = (w) => w.document.querySelector(".settings-current").textContent.trim();
const status = (w) => w.document.querySelector(".save-status [role=status]")?.textContent.trim() ?? null;
const alert = (w) => w.document.querySelector(".save-status [role=alert]")?.textContent.trim() ?? null;
// A button's update is drawn in a microtask, after its click returns.
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
// The page's objects are its realm's; deepEqual compares prototypes too.
const here = (value) => JSON.parse(JSON.stringify(value));

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

test("a chosen send key is saved on this device and said so; Restore defaults removes it", async () => {
  const w = page();
  try {
    w.showEditor();
    assert.equal(checked(w), "auto");
    assert.equal(current(w), "Return: Send");
    assert.equal(status(w), "Using the defaults; nothing is saved on this device yet");
    choose(w, "modEnter");
    await tick();
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), '{"sendKey":"modEnter"}');
    assert.equal(checked(w), "modEnter");
    assert.equal(current(w), "Return: New line");
    assert.equal(status(w), "Saved on this device");
    assert.equal(alert(w), null);
    // Restore defaults removes this device's choice: Automatic again.
    button(w, "Restore defaults").click();
    await tick();
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), null);
    assert.equal(checked(w), "auto");
    assert.equal(current(w), "Return: Send");
    assert.equal(status(w), "Defaults restored on this device");
    assert.equal(w.store.readPreferences().sendKey, "auto");
  } finally {
    w.close();
  }
});

test("another window's saved choice applies here too", async () => {
  const w = page();
  try {
    w.showEditor();
    await tick();
    assert.equal(checked(w), "auto");
    // As another window of this site saves it; this one hears a storage event.
    w.localStorage.setItem("yuzuno.preferences", '{"sendKey":"enter"}');
    w.dispatchEvent(new w.StorageEvent("storage", { key: "yuzuno.preferences" }));
    await tick();
    assert.equal(checked(w), "enter");
    assert.equal(status(w), "Using the choice saved on this device");
  } finally {
    w.close();
  }
});

test("a save the browser refuses is said, never 'Saved', and the choice holds for this visit", async () => {
  const w = page({ refuse: true });
  try {
    assert.deepEqual(here(w.store.savePreferences({ sendKey: "modEnter" })), { saved: false, reason: "full", detail: "this browser’s storage for Yuzuno is full" });
    w.showEditor();
    choose(w, "enter");
    await tick();
    assert.equal(alert(w), "Not saved on this device: this browser’s storage for Yuzuno is full. Your choice applies in this window until you close or reload it.");
    assert.equal(status(w), null, "no Saved");
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), null, "nothing was kept");
    // Held for this window: the editor shows the choice in effect.
    assert.equal(checked(w), "enter");
    assert.equal(current(w), "Return: Send");
    // Storage back: Try again saves it.
    w.Storage.prototype.setItem = w.real.setItem;
    button(w, "Try again").click();
    await tick();
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), '{"sendKey":"enter"}');
    assert.equal(status(w), "Saved on this device");
    assert.equal(alert(w), null);
  } finally {
    w.close();
  }
});

test("a reset the browser refuses is said; Try again resets, not saves the defaults", async () => {
  const w = page({ saved: '{"sendKey":"modEnter"}', refuseRemove: true });
  try {
    w.showEditor();
    assert.equal(checked(w), "modEnter");
    assert.equal(status(w), "Using the choice saved on this device");
    button(w, "Restore defaults").click();
    await tick();
    assert.equal(alert(w), "Not saved on this device: this browser doesn’t let Yuzuno store settings here. Your choice applies in this window until you close or reload it.");
    // The defaults apply in this window; the saved choice is still there.
    assert.equal(checked(w), "auto");
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), '{"sendKey":"modEnter"}');
    w.Storage.prototype.removeItem = w.real.removeItem;
    button(w, "Try again").click();
    await tick();
    assert.equal(w.localStorage.getItem("yuzuno.preferences"), null, "removed, not the defaults saved");
    assert.equal(status(w), "Defaults restored on this device");
    assert.equal(alert(w), null);
  } finally {
    w.close();
  }
});

test("before a save, the editor says what this device holds, never Saved", () => {
  const unread = "The choice saved on this device couldn’t be read, so the defaults apply. Choosing again saves a new one.";
  for (const [saved, said, sendKey] of [
    [undefined, "Using the defaults; nothing is saved on this device yet", "auto"],
    ['{"sendKey":"enter"}', "Using the choice saved on this device", "enter"],
    ['{"sendKey":"Return"}', unread, "auto"],
    ["[]", unread, "auto"],
    ["not json", unread, "auto"],
  ]) {
    const w = page({ saved });
    try {
      w.showEditor();
      assert.deepEqual([status(w), alert(w), checked(w)], [said, null, sendKey], String(saved));
    } finally {
      w.close();
    }
  }
  // Storage this browser won't read: the defaults, and not saved.
  const w = page({ saved: '{"sendKey":"enter"}', unreadable: true });
  try {
    w.showEditor();
    assert.equal(status(w), null);
    assert.equal(alert(w), "Not saved on this device: this browser doesn’t let Yuzuno store settings here. Your choice applies in this window until you close or reload it.");
    assert.equal(checked(w), "auto");
  } finally {
    w.close();
  }
});

test("the help lists Return as the send key makes it, and the desktop app's shortcut only there", () => {
  const rows = (groups, title) => Array.from(groups.find((g) => g.title === title).shortcuts, (s) => `${s.keys.join("+")}: ${s.action}`);
  const w = page();
  try {
    const at = (sendKey, touch, desktopApp = false) => w.shortcutGroups({ modifier: "Ctrl", sendKey, touch, desktopApp });
    assert.deepEqual(rows(at("auto", false), "Writing a message").slice(0, 3), ["Return: Send", "Ctrl+Return: Send", "Shift+Return: New line"]);
    assert.deepEqual(rows(at("auto", true), "Writing a message").slice(0, 3), ["Return: New line", "Ctrl+Return: Send", "Shift+Return: New line"]);
    assert.equal(rows(at("enter", true), "Writing a message")[0], "Return: Send");
    assert.equal(rows(at("modEnter", false), "Writing a message")[0], "Return: New line");
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
  "←": ['"ArrowLeft"'], "→": ['"ArrowRight"'],
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
  let counted = 0;
  for (const group of groups)
    for (const shortcut of group.shortcuts) {
      // The browser's own (a button pressed, a dialog closed) has no handler to find.
      if (shortcut.native) continue;
      const files = await Promise.all(shortcut.source.split(", ").map(read));
      for (const key of shortcut.keys) {
        const wanted = tokens[key];
        assert.ok(wanted, `a token for ${key}`);
        assert.ok(files.some((code) => wanted.some((token) => code.includes(token))), `${key} (${shortcut.action}) in ${shortcut.source}`);
        counted++;
      }
    }
  assert.ok(counted > 30, `${counted} keys checked`);
});
