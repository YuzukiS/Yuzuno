// Appearance says whether its choice is saved on this device (T-187): a
// write the browser refuses is not "Saved"; the choice and its preview stay,
// with Try again and Restore defaults, also after Settings is reopened.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "appearance-save-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AppearanceSection} from ${src("AppearanceSettings.tsx")};
const root = createRoot(document.getElementById('root'));
// Settings shows a category only while it is open.
window.show = open => flushSync(() => root.render(open ? <AppearanceSection/> : null));`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AppearanceSaveUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const KEY = "yuzuno.appearance";
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function mount() {
  const dom = new JSDOM('<!doctype html><html><head><meta name="theme-color" content=""></head><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const storage = window.Storage.prototype;
  const original = { getItem: storage.getItem, setItem: storage.setItem, removeItem: storage.removeItem };
  window.eval(bundle);
  const document = window.document;
  return {
    window, document,
    storage: window.localStorage,
    // The browser refuses writes, as when its storage is full or blocked.
    refuse(name, only) {
      const error = () => { throw new window.DOMException("refused", name); };
      if (only !== "remove") storage.setItem = error;
      if (only !== "save") storage.removeItem = error;
    },
    unreadable() {
      storage.getItem = () => { throw new window.DOMException("refused", "SecurityError"); };
    },
    allow() {
      Object.assign(storage, original);
    },
    status: () => document.querySelector(".save-status [role=status]")?.textContent.trim() ?? null,
    alert: () => document.querySelector(".save-status [role=alert]")?.textContent.trim() ?? null,
    button: (name) => [...document.querySelectorAll(".save-status button")].find((b) => b.textContent.trim() === name),
    choose: (name, value) => document.querySelector(`input[name="${name}"][value="${value}"]`).click(),
    checked: (name) => document.querySelector(`input[name="${name}"]:checked`)?.value,
    close: () => window.close(),
  };
}
const FULL = "Not saved on this device: this browser’s storage for Yuzuno is full. Your choice applies in this window until you close or reload it.";

test("a choice the browser saves says so; before it, nothing was called saved", async () => {
  const page = mount();
  page.window.show(true);
  await tick();
  assert.equal(page.status(), "Using the defaults; nothing is saved on this device yet");
  page.choose("appearance-palette", "pine");
  await tick();
  assert.equal(JSON.parse(page.storage.getItem(KEY)).palette, "pine");
  assert.equal(page.status(), "Saved on this device");
  assert.equal(page.alert(), null);
  page.close();
});

test("a choice the browser refuses to save is not called saved; it stays chosen and previewed, also after reopening, until Try again saves it", async () => {
  const page = mount();
  page.window.show(true);
  await tick();
  page.refuse("QuotaExceededError");
  page.choose("appearance-palette", "graphite");
  await tick();
  assert.equal(page.alert(), FULL);
  assert.equal(page.status(), null, "no Saved beside it");
  assert.equal(page.checked("appearance-palette"), "graphite", "the choice is kept");
  assert.equal(page.document.documentElement.dataset.palette, "graphite", "and in effect here");
  assert.equal(page.storage.getItem(KEY), null, "nothing was saved");
  // Settings closed and opened again: the same choice, still not saved.
  page.window.show(false);
  page.window.show(true);
  await tick();
  assert.equal(page.checked("appearance-palette"), "graphite");
  assert.equal(page.alert(), FULL);
  page.button("Try again").click();
  await tick();
  assert.equal(page.alert(), FULL, "still refused");
  page.allow();
  page.button("Try again").click();
  await tick();
  assert.equal(page.status(), "Saved on this device");
  assert.equal(JSON.parse(page.storage.getItem(KEY)).palette, "graphite");
  page.close();
});

test("restore defaults removes this device's choice and says whether it could", async () => {
  const page = mount();
  page.storage.setItem("yuzuno.selected", JSON.stringify("a"));
  page.window.show(true);
  await tick();
  page.choose("appearance-palette", "pine");
  page.choose("appearance-theme", "dark");
  await tick();
  page.button("Restore defaults").click();
  await tick();
  assert.equal(page.storage.getItem(KEY), null);
  assert.equal(page.storage.getItem("yuzuno.selected"), JSON.stringify("a"), "nothing else is removed");
  assert.equal(page.checked("appearance-palette"), "garden");
  assert.equal(page.checked("appearance-theme"), "light");
  assert.equal(page.status(), "Defaults restored on this device");
  page.choose("appearance-palette", "pine");
  await tick();
  page.refuse("SecurityError");
  page.button("Restore defaults").click();
  await tick();
  assert.match(page.alert(), /^Not saved on this device: this browser doesn’t let Yuzuno store settings here\./);
  assert.equal(page.checked("appearance-palette"), "garden", "the defaults apply here");
  page.allow();
  assert.equal(JSON.parse(page.storage.getItem(KEY)).palette, "pine", "the saved choice is still there");
  page.close();
});

test("storage this browser won't read: what is shown is not called saved", async () => {
  const page = mount();
  page.unreadable();
  page.window.show(true);
  await tick();
  assert.equal(page.alert(), "Not saved on this device: this browser doesn’t let Yuzuno store settings here. Your choice applies in this window until you close or reload it.");
  assert.equal(page.status(), null);
  page.close();
});

test("before a save in this visit it says what this device holds, and never that it saved", async () => {
  const opened = async (stored) => {
    const page = mount();
    page.storage.setItem(KEY, stored);
    page.window.show(true);
    await tick();
    const seen = { status: page.status(), palette: page.checked("appearance-palette") };
    page.close();
    return seen;
  };
  assert.deepEqual(await opened(JSON.stringify({ palette: "pine" })),
    { status: "Using the choice saved on this device", palette: "pine" });
  const unreadable = "The choice saved on this device couldn’t be read, so the defaults apply. Choosing again saves a new one.";
  for (const stored of ["{not json", "[1,2]", "null", "\"pine\""])
    assert.deepEqual(await opened(stored), { status: unreadable, palette: "garden" }, `saved as ${stored}`);
});

test("Try again after a refused reset retries the reset: the choice is removed, not the defaults saved; nothing else changes", async () => {
  const page = mount();
  page.storage.setItem("yuzuno.selected", JSON.stringify("a"));
  page.storage.setItem("yuzuno.requestDrafts.w", JSON.stringify({ q: "draft" }));
  page.window.show(true);
  await tick();
  page.choose("appearance-palette", "pine");
  await tick();
  page.refuse("SecurityError", "remove");
  page.button("Restore defaults").click();
  await tick();
  assert.match(page.alert(), /^Not saved on this device: this browser doesn’t let Yuzuno store settings here\./);
  page.button("Try again").click();
  await tick();
  assert.equal(JSON.parse(page.storage.getItem(KEY)).palette, "pine", "still refused: the saved choice is there");
  page.allow();
  page.button("Try again").click();
  await tick();
  assert.equal(page.storage.getItem(KEY), null, "the reset was tried again: no choice saved, not the defaults");
  assert.equal(page.status(), "Defaults restored on this device");
  assert.equal(page.checked("appearance-palette"), "garden");
  assert.equal(page.storage.getItem("yuzuno.selected"), JSON.stringify("a"));
  assert.equal(page.storage.getItem("yuzuno.requestDrafts.w"), JSON.stringify({ q: "draft" }), "drafts are untouched");
  page.close();
});
